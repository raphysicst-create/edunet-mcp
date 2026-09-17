import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, redact } from "../dist/logger.js";

test("redacts literal keys and encoded keys, including mixed-case percent encoding", () => {
  const key = "abc+/=: KEY";
  const encoded = encodeURIComponent(key);
  for (const representation of [key, encoded, encoded.toLowerCase().replace("key", "KEY"),
    encoded.replace("%2B", "%2b"), encoded.replace("%20", "+"), encodeURIComponent(encoded)]) {
    const result = redact(`failure: ${representation}`, [key]);
    assert.equal(result, "failure: [REDACTED]", representation);
  }
  assert.equal(redact("https://api.invalid/?sno=unknown-value&query=x"), "https://api.invalid/?sno=[REDACTED]&query=x");
  assert.equal(redact(new URLSearchParams({ value: "key!'(~" }).toString(), ["key!'(~"]), "value=[REDACTED]");
});

test("structured sensitive fields and secret-bearing messages are masked", () => {
  const lines = [];
  createLogger({ secrets: ["topsecret"], sink: (line) => lines.push(line) }).error("topsecret failed", {
    sno: 12345, nested: { apiKey: "another-secret" }, url: "https://api.invalid?sno=sensitive&x=1",
  });
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.event, "[REDACTED] failed");
  assert.equal(result.fields.sno, "[REDACTED]");
  assert.equal(result.fields.nested.apiKey, "[REDACTED]");
  assert.ok(!lines[0].includes("sensitive"));
});

test("default logger writes only to stderr", () => {
  const stderr = [];
  const stdout = [];
  const originalErr = process.stderr.write;
  const originalOut = process.stdout.write;
  try {
    process.stderr.write = (line) => { stderr.push(line); return true; };
    process.stdout.write = (line) => { stdout.push(line); return true; };
    createLogger().info("ready");
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
  }
  assert.equal(stderr.length, 1);
  assert.equal(stdout.length, 0);
  assert.equal(JSON.parse(stderr[0]).event, "ready");
});

test("logging failure does not disrupt requests or emit raw data", () => {
  const circular = {};
  circular.self = circular;
  let calls = 0;
  const logger = createLogger({ sink: () => { calls++; throw new Error("sink failure"); } });
  assert.doesNotThrow(() => logger.warn("event", circular));
  assert.equal(calls, 0);
  assert.doesNotThrow(() => logger.warn("event"));
  assert.equal(calls, 1);
});
