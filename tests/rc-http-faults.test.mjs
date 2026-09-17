import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requestBytes } from "../dist/http.js";
import { EdunetError } from "../dist/errors.js";

const endpoint = "https://example.invalid/search?sno=private-key";
const isCode = (code) => (error) => error instanceof EdunetError && error.code === code;

function random(seed) {
  let state = seed >>> 0;
  return (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
}

test("RC: late fetch responses are cancelled after caller cancellation or deadline", async () => {
  for (const cancellation of ["caller", "deadline"]) {
    const controller = new AbortController();
    let resolveFetch;
    let calls = 0;
    let cancelled = 0;
    const pending = requestBytes(endpoint, {
      signal: controller.signal, timeoutMs: 15, totalTimeoutMs: 100, maxRetries: 0,
      fetch: () => {
        calls++;
        return new Promise((resolve) => { resolveFetch = resolve; });
      },
    });
    if (cancellation === "caller") controller.abort(new Error("private cancellation reason"));
    await assert.rejects(pending, isCode(cancellation === "caller" ? "ABORTED" : "TIMEOUT"));
    resolveFetch(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await immediate();
    assert.equal(cancelled, 1, cancellation);
    assert.equal(calls, 1, cancellation);
  }
});

test("RC: cancellation between response arrival and delivery still cancels exactly once", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  await assert.rejects(requestBytes(endpoint, {
    signal: controller.signal,
    fetch: async () => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return new Response(new ReadableStream({ cancel() { cancelled++; } }));
    },
  }), isCode("ABORTED"));
  await immediate();
  assert.equal(cancelled, 1);
});

test("RC: synchronous abort rejection and failed late-body cleanup cannot cause unhandled rejection", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { requestBytes } from './dist/http.js';
    const controller = new AbortController();
    await assert.rejects(requestBytes('https://example.invalid', {
      signal: controller.signal,
      fetch: () => {
        controller.abort();
        return Promise.reject(new Error('private upstream message'));
      },
    }), (error) => error.code === 'ABORTED');
    await new Promise(setImmediate);
    for (const synchronous of [true, false]) {
      const cancellation = new AbortController();
      let deliver;
      let cancelled = 0;
      const pending = requestBytes('https://example.invalid', {
        signal: cancellation.signal,
        fetch: () => new Promise(resolve => { deliver = resolve; }),
      });
      cancellation.abort();
      await assert.rejects(pending, error => error.code === 'ABORTED');
      deliver(new Response(new ReadableStream({
        cancel() {
          cancelled++;
          if (synchronous) throw new Error('private cleanup message');
          return Promise.reject(new Error('private cleanup message'));
        },
      })));
      await new Promise(setImmediate);
      assert.equal(cancelled, 1);
    }
  `;
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("RC: huge valid Retry-After integers never retry before the total deadline", async () => {
  for (const header of ["9".repeat(400), "9".repeat(308)]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, {
      totalTimeoutMs: 330,
      fetch: async () => {
        calls++;
        return new Response("limited", { status: 429, headers: { "retry-after": header } });
      },
    }), isCode("TIMEOUT"));
    assert.equal(calls, 1, `Retry-After with ${header.length} digits`);
  }
});

test("RC: cancellation in Retry-After backoff prevents any repeated call", async () => {
  const controller = new AbortController();
  let calls = 0;
  let cancelled = 0;
  const pending = requestBytes(endpoint, {
    signal: controller.signal,
    fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: 429, headers: { "retry-after": "120" },
      });
    },
  });
  await immediate();
  controller.abort(new EdunetError("AUTHENTICATION", { retryable: true }));
  await assert.rejects(pending, isCode("ABORTED"));
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("RC: seeded cancellation during body reads always stops and releases the stream", async () => {
  const next = random(0xabad1dea);
  for (let sample = 0; sample < 48; sample++) {
    const controller = new AbortController();
    const abortAt = 1 + next(16);
    let pulls = 0;
    let calls = 0;
    let cancelled = 0;
    await assert.rejects(requestBytes(endpoint, {
      signal: controller.signal,
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({
          pull(stream) {
            pulls++;
            if (pulls === abortAt) controller.abort(new Error("private cancel reason"));
            else stream.enqueue(new Uint8Array([sample, pulls]));
          },
          cancel() { cancelled++; },
        }));
      },
    }), isCode("ABORTED"), `seed sample ${sample}`);
    assert.equal(calls, 1, `seed sample ${sample}`);
    assert.equal(cancelled, 1, `seed sample ${sample}`);
    assert.equal(pulls, abortAt, `seed sample ${sample}`);
  }
});

test("RC: seeded response chunk fuzz preserves bytes and enforces both byte caps", async () => {
  const next = random(0xc0ffee);
  for (let sample = 0; sample < 160; sample++) {
    const maximum = 1 + next(128);
    const chunks = Array.from({ length: next(10) }, () => Uint8Array.from({ length: next(48) }, () => next(256)));
    const expected = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
    const claimedLength = next(3) === 0 ? next(192) : undefined;
    let calls = 0;
    const pending = requestBytes(endpoint, {
      maxResponseBytes: maximum,
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }), { headers: claimedLength === undefined ? {} : { "content-length": String(claimedLength) } });
      },
    });
    if (expected.length > maximum || claimedLength > maximum) {
      await assert.rejects(pending, isCode("RESPONSE_TOO_LARGE"), `seed sample ${sample}`);
    } else {
      assert.deepEqual((await pending).body, expected, `seed sample ${sample}`);
    }
    assert.equal(calls, 1, `seed sample ${sample}`);
  }
});

test("RC: non-transient body failure is sanitized and cannot retry", async () => {
  let calls = 0;
  await assert.rejects(requestBytes(endpoint, {
    fetch: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("private-key upstream body")); },
      }));
    },
  }), (error) => {
    assert.equal(error.code, "NETWORK");
    assert.doesNotMatch(error.message, /private-key|upstream body/);
    return true;
  });
  assert.equal(calls, 1);
});

test("RC: transient failure midway through a body retries from fresh bytes", async () => {
  let calls = 0;
  const result = await requestBytes(endpoint, {
    maxRetries: 1,
    fetch: async () => {
      calls++;
      if (calls === 2) return new Response("fresh");
      let pulls = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("partial private bytes"));
          else controller.error(new TypeError("terminated: private-key", { cause: { code: "ECONNRESET" } }));
        },
      }));
    },
  });
  assert.equal(calls, 2);
  assert.equal(new TextDecoder().decode(result.body), "fresh");
});

test("RC: malformed or misleading Content-Length cannot bypass streamed byte limits", async () => {
  for (const header of ["NaN", "Infinity", "-1", "1e999", "0", "1", "0x1", "1, 1"]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, {
      maxResponseBytes: 4,
      fetch: async () => {
        calls++;
        return new Response("12345", { headers: { "content-length": header } });
      },
    }), isCode("RESPONSE_TOO_LARGE"), header);
    assert.equal(calls, 1, header);
  }
});

test("RC: unsafe URL schemes and credentials never reach fetch", async () => {
  const urls = ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://example.invalid", "https://user:private-key@example.invalid", "//example.invalid"];
  for (const url of urls) {
    let calls = 0;
    await assert.rejects(requestBytes(url, { fetch: async () => { calls++; return new Response(); } }), isCode("INVALID_INPUT"));
    assert.equal(calls, 0, url);
  }
});
