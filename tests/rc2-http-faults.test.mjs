import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { requestBytes } from "../dist/http.js";
import { EdunetError } from "../dist/errors.js";

const endpoint = "https://example.invalid/search?sno=private-http-key";
const isCode = (code) => (error) => error instanceof EdunetError && error.code === code;

function random(seed) {
  let state = seed >>> 0;
  return (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
}

test("RC2: continuously ready empty body chunks cannot starve deadlines or caller cancellation", () => {
  // Isolation is essential: a regressed reader never yields to a timer in this process.
  const script = `
    import assert from 'node:assert/strict';
    import { requestBytes } from './dist/http.js';
    for (const mode of ['deadline', 'caller']) {
      const controller = new AbortController();
      let cancelled = 0;
      let calls = 0;
      let pulls = 0;
      const pending = requestBytes('https://example.invalid', {
        signal: controller.signal, timeoutMs: 20, totalTimeoutMs: 60, maxRetries: 0,
        fetch: async () => {
          calls++;
          return new Response(new ReadableStream({
            pull(stream) { pulls++; stream.enqueue(new Uint8Array()); },
            cancel() { cancelled++; },
          }));
        },
      });
      if (mode === 'caller') setTimeout(() => controller.abort(new Error('private reason')), 5);
      await assert.rejects(pending, error => error.code === (mode === 'caller' ? 'ABORTED' : 'TIMEOUT'));
      assert.equal(calls, 1);
      assert.equal(cancelled, 1);
      assert.ok(pulls > 0);
    }
  `;
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 3_000,
  });
  assert.equal(result.error, undefined, `reader starved timers: ${result.error?.code}`);
  assert.equal(result.status, 0, result.stderr);
});

test("RC2: non-byte stream chunks fail closed instead of silently corrupting response bytes", async () => {
  const chunks = [
    new Uint16Array([0x1234, 0xabcd]), new Uint8ClampedArray([1, 2]),
    new ArrayBuffer(4), new DataView(new ArrayBuffer(2)),
    { byteLength: 0, length: 0 }, [1, 2], "private upstream body", null, undefined,
  ];
  for (const chunk of chunks) {
    let calls = 0;
    let cancelled = 0;
    await assert.rejects(requestBytes(endpoint, {
      maxRetries: 0, timeoutMs: 80,
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({
          start(stream) { stream.enqueue(chunk); },
          cancel() { cancelled++; },
        }));
      },
    }), (error) => {
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
});

test("RC2: a valid fragmented body with empty chunks preserves all bytes across scheduling yields", async () => {
  const next = random(0x512fed);
  for (let sample = 0; sample < 80; sample++) {
    const expected = Uint8Array.from({ length: 1 + next(1024) }, () => next(256));
    let offset = 0;
    const result = await requestBytes(endpoint, {
      maxResponseBytes: expected.length,
      fetch: async () => new Response(new ReadableStream({
        pull(stream) {
          if (offset === expected.length) { stream.close(); return; }
          if (next(3) === 0) { stream.enqueue(new Uint8Array()); return; }
          const count = Math.min(1 + next(5), expected.length - offset);
          stream.enqueue(expected.subarray(offset, offset + count));
          offset += count;
        },
      })),
    });
    assert.deepEqual(result.body, expected, `seed sample ${sample}`);
  }
  assert.deepEqual((await requestBytes(endpoint, {
    fetch: async () => new Response(Buffer.from([0, 0xff, 0x80])),
  })).body, Uint8Array.from([0, 0xff, 0x80]));
});

test("RC2: all retryable statuses recover once from fresh bytes; exhausted retries stay bounded", async () => {
  for (const status of [429, 502, 503, 504]) {
    let calls = 0;
    let cancelled = 0;
    const result = await requestBytes(endpoint, {
      maxRetries: 1,
      fetch: async () => {
        calls++;
        if (calls === 2) return new Response("recovered");
        return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status });
      },
    });
    assert.equal(new TextDecoder().decode(result.body), "recovered", String(status));
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
  }
  for (const retries of [0, 1, 2]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, {
      maxRetries: retries,
      fetch: async () => { calls++; throw new TypeError("fetch failed: private-http-key", { cause: { code: "ECONNRESET" } }); },
    }), isCode("NETWORK"));
    assert.equal(calls, retries + 1);
  }
});

test("RC2: Retry-After HTTP dates and enormous valid integers consume budget without repeated calls", async () => {
  for (const header of [new Date(Date.now() + 86_400_000).toUTCString(), "0".repeat(256) + "999999999999999999999999999999"]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, {
      totalTimeoutMs: 320,
      fetch: async () => {
        calls++;
        return new Response("private rate limit message", { status: 429, headers: { "retry-after": header } });
      },
    }), isCode("TIMEOUT"));
    assert.equal(calls, 1);
  }
});

test("RC2: repeated successful, failed and cancelled requests release caller listeners", async () => {
  const shared = new AbortController();
  for (let sample = 0; sample < 60; sample++) {
    const pending = requestBytes(endpoint, {
      signal: shared.signal,
      fetch: async () => new Response("body", { status: sample % 2 ? 401 : 200 }),
    });
    if (sample % 2) await assert.rejects(pending, isCode("AUTHENTICATION"));
    else assert.equal((await pending).status, 200);
    assert.equal(getEventListeners(shared.signal, "abort").length, 0, `shared signal sample ${sample}`);
  }
  for (let sample = 0; sample < 40; sample++) {
    const controller = new AbortController();
    let deliver;
    let cancelled = 0;
    let calls = 0;
    const pending = requestBytes(endpoint, {
      signal: controller.signal,
      fetch: () => { calls++; return new Promise(resolve => { deliver = resolve; }); },
    });
    controller.abort();
    await assert.rejects(pending, isCode("ABORTED"));
    deliver(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await immediate();
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("RC2: invalid numeric budgets reject without issuing a fetch", async () => {
  const options = [];
  for (const key of ["timeoutMs", "totalTimeoutMs", "maxResponseBytes"]) {
    for (const value of [NaN, Infinity, -Infinity, -1, 0, 0.1, "10", true]) options.push({ [key]: value });
  }
  for (const maxRetries of [-1, 3, 0.5, NaN, Infinity, "1", true]) options.push({ maxRetries });
  for (const option of options) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, { ...option, fetch: async () => { calls++; return new Response(); } }), isCode("INVALID_INPUT"));
    assert.equal(calls, 0);
  }
});
