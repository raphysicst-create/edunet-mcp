import assert from "node:assert/strict";
import test from "node:test";
import { requestBytes } from "../dist/http.js";
import { EdunetError, publicError } from "../dist/errors.js";
import { loadConfig } from "../dist/config.js";

const endpoint = "https://example.invalid/search?sno=secret";
const isCode = (code) => (error) => error instanceof EdunetError && error.code === code;

test("configuration is read lazily and registration domain is opaque", () => {
  assert.throws(() => loadConfig({}), isCode("CONFIGURATION"));
  assert.deepEqual(loadConfig({ EDUNET_API_KEY: " token ", EDUNET_DOMAIN: "registered-domain" }), {
    apiKey: "token", domain: "registered-domain",
  });
  assert.throws(() => loadConfig({ EDUNET_API_KEY: "a\nb", EDUNET_DOMAIN: "x" }), isCode("CONFIGURATION"));
});

test("returns exact response bytes and disables redirect following", async () => {
  const expected = new Uint8Array([0xff, 0x01, 0xfe]);
  const result = await requestBytes(endpoint, { fetch: async (url, init) => {
    assert.equal(String(url), endpoint);
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, "GET");
    return new Response(expected, { headers: { "content-type": "application/xml" } });
  } });
  assert.deepEqual(result.body, expected);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "application/xml");
});

test("retries only specified HTTP status codes, at most twice", async () => {
  for (const status of [429, 502, 503, 504]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, { fetch: async () => {
      calls++;
      return new Response("untrusted secret", { status });
    } }), (error) => error.status === status);
    assert.equal(calls, 3, String(status));
  }
});

test("does not retry authentication, redirects, or other HTTP errors", async () => {
  for (const status of [301, 400, 401, 403, 404, 500]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, { fetch: async () => {
      calls++;
      return new Response("secret", { status, headers: { location: "https://other.invalid" } });
    } }), (error) => error.status === status && !error.message.includes("secret"));
    assert.equal(calls, 1, String(status));
  }
});

test("transient network errors retry, TLS/configuration failures do not", async () => {
  for (const [code, expectedCalls] of [["ECONNRESET", 3], ["EAI_AGAIN", 3], ["CERT_HAS_EXPIRED", 1], ["ENOTFOUND", 1]]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, { fetch: async () => {
      calls++;
      throw new TypeError("fetch failed: secret", { cause: { code } });
    } }), isCode("NETWORK"));
    assert.equal(calls, expectedCalls, code);
  }
});

test("an attempt deadline remains active while reading the body", async () => {
  let cancelled = false;
  const start = performance.now();
  await assert.rejects(requestBytes(endpoint, {
    timeoutMs: 30, totalTimeoutMs: 500, maxRetries: 0,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  }), isCode("TIMEOUT"));
  assert.ok(performance.now() - start < 400);
  assert.equal(cancelled, true);
});

test("overall deadline bounds a fetch ignoring abort and retry backoff", async () => {
  for (const fetch of [async () => new Promise(() => {}), async () => new Response("busy", { status: 503 })]) {
    const start = performance.now();
    await assert.rejects(requestBytes(endpoint, { timeoutMs: 200, totalTimeoutMs: 35, fetch }), isCode("TIMEOUT"));
    assert.ok(performance.now() - start < 400);
  }
});

test("a long Retry-After is bounded by total timeout without retrying early", async () => {
  let calls = 0;
  await assert.rejects(requestBytes(endpoint, { totalTimeoutMs: 40, fetch: async () => {
    calls++;
    return new Response("busy", { status: 429, headers: { "retry-after": "600" } });
  } }), isCode("TIMEOUT"));
  assert.equal(calls, 1);
});

test("caller cancellation cancels response body and does not retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  let cancelled = false;
  const pending = requestBytes(endpoint, { signal: controller.signal, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  setTimeout(() => controller.abort(new Error("untrusted secret")), 20);
  await assert.rejects(pending, isCode("ABORTED"));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("pre-cancelled request does not call fetch", async () => {
  let calls = 0;
  await assert.rejects(requestBytes(endpoint, { signal: AbortSignal.abort(), fetch: async () => {
    calls++;
    return new Response();
  } }), isCode("ABORTED"));
  assert.equal(calls, 0);
});

test("response byte cap checks both content-length and streamed bytes", async () => {
  for (const headers of [{ "content-length": "100" }, {}]) {
    let calls = 0;
    await assert.rejects(requestBytes(endpoint, { maxResponseBytes: 4, fetch: async () => {
      calls++;
      return new Response("12345", { headers });
    } }), isCode("RESPONSE_TOO_LARGE"));
    assert.equal(calls, 1);
  }
});

test("public errors do not forward raw network messages", () => {
  const result = publicError(new Error("sno=secret"));
  assert.equal(result.code, "INTERNAL");
  assert.match(result.message, /^검색 처리 중 오류가 발생했습니다\./);
  assert.doesNotMatch(JSON.stringify(result), /sno=|secret/);
});
