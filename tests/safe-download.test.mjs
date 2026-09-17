import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { safeDownload, safeMetadataJson, validateDownloadUrl, isPublicAddress } from "../dist/worker/safe-download.js";
import { detectFormat } from "../dist/worker/format-detect.js";

const url = "https://educon.edunet.net/CNEDU/MANUAL/clssStdDt/20260226/file/sample.pdf";
const metadataUrl = "https://api.edunet.net/main/fileRsc/downloadFile/3595179";
const publicIp = "223.130.195.95";
const pdf = Buffer.from("%PDF-1.7\nexample");
const errorCode = (code) => (error) => error.code === code && error.message === code;

function transport(replies, lookupResult = [{ address: publicIp, family: 4 }]) {
  const calls = [];
  let lookups = 0;
  return {
    calls,
    get lookups() { return lookups; },
    dependencies: {
      lookup: async () => { lookups++; return lookupResult; },
      request(target, options, callback) {
        const reply = replies[calls.length] ?? replies.at(-1);
        calls.push({ url: target.href, options });
        const req = new EventEmitter();
        req.destroy = (error) => { if (error) queueMicrotask(() => req.emit("error", error)); };
        req.end = () => {
          queueMicrotask(() => {
            options.lookup(target.hostname, {}, (error, address, family) => {
              assert.equal(error, null);
              assert.equal(address, publicIp);
              assert.equal(family, 4);
            });
            options.lookup(target.hostname, { all: true }, (error, addresses) => {
              assert.equal(error, null);
              assert.deepEqual(addresses, [{ address: publicIp, family: 4 }]);
            });
            if (reply.error) return req.emit("error", Object.assign(new Error("secret URL"), { code: reply.error }));
            if (reply.stall) {
              options.signal.addEventListener("abort", () => req.emit("error", new Error("aborted")), { once: true });
              return;
            }
            const response = Readable.from(reply.chunks ?? [reply.body ?? pdf]);
            response.statusCode = reply.status ?? 200;
            response.headers = reply.headers ?? { "content-type": "application/pdf" };
            response.socket = { remoteAddress: reply.remoteAddress ?? publicIp };
            callback(response);
          });
        };
        return req;
      },
    },
  };
}

test("document URL policy blocks credentials, ports, local hosts and unverified paths", () => {
  assert.equal(validateDownloadUrl(url).href, url);
  assert.equal(validateDownloadUrl("https://educon.edunet.net/KEDNCM/2022NEWEDU/a/sample.hwp").hostname, "educon.edunet.net");
  for (const value of [
    "http://educon.edunet.net/KEDNCM/2022NEWEDU/a.pdf",
    "https://user:password@educon.edunet.net/KEDNCM/2022NEWEDU/a.pdf",
    "https://educon.edunet.net:8443/KEDNCM/2022NEWEDU/a.pdf",
    "https://127.0.0.1/KEDNCM/2022NEWEDU/a.pdf", "https://169.254.169.254/latest/meta-data",
    "https://educon.edunet.net.attacker.test/KEDNCM/2022NEWEDU/a.pdf",
    "https://educon.edunet.net/KEDNCM/2022NEWEDU/a.exe", "https://educon.edunet.net/admin/a.pdf",
    "https://educon.edunet.net/KEDNCM/2022NEWEDU/%252e%252e/a.pdf", `${url}#secret`,
    "file:///tmp/test.pdf",
  ]) assert.throws(() => validateDownloadUrl(value), errorCode("DOWNLOAD_BLOCKED"));
});

test("public IP policy denies special IPv4 and IPv6 including metadata and transition addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254",
    "100.100.100.200", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1",
    "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:0:1234::1", "2001:db8::1", "3fff::1", "fe80::1%eth0",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of [publicIp, "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("pins lookup for the actual HTTPS socket with normal TLS verification and no pooled agent", async () => {
  const mock = transport([{}]);
  const result = await safeDownload(url, { dependencies: mock.dependencies });
  assert.deepEqual(result.bytes, pdf);
  assert.equal(mock.lookups, 1);
  assert.equal(mock.calls[0].options.agent, false);
  assert.equal(mock.calls[0].options.rejectUnauthorized, true);
  assert.equal(mock.calls[0].options.servername, "educon.edunet.net");
  assert.equal(mock.calls[0].options.headers["accept-encoding"], "identity");
});

test("rejects any DNS answer that is private and mismatched actual peer addresses", async () => {
  for (const answers of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: publicIp, family: 4 }, { address: "::1", family: 6 }]]) {
    const mock = transport([{}], answers);
    await assert.rejects(safeDownload(url, { dependencies: mock.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
    assert.equal(mock.calls.length, 0);
  }
  for (const remoteAddress of ["127.0.0.1", "8.8.8.8", "::ffff:127.0.0.1"]) {
    const mock = transport([{ remoteAddress }]);
    await assert.rejects(safeDownload(url, { dependencies: mock.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
  }
});

test("validates every redirect and caps loops", async () => {
  for (const destination of ["http://educon.edunet.net/KEDNCM/2022NEWEDU/test.pdf", "https://127.0.0.1/test.pdf", "https://educon.edunet.net/admin/test.pdf"]) {
    const mock = transport([{ status: 302, headers: { location: destination } }]);
    await assert.rejects(safeDownload(url, { dependencies: mock.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
    assert.equal(mock.calls.length, 1);
  }
  const good = transport([{ status: 302, headers: { location: "next.pdf" } }, {}]);
  assert.deepEqual((await safeDownload(url, { dependencies: good.dependencies })).bytes, pdf);
  assert.equal(good.lookups, 2);
  const loop = transport([{ status: 302, headers: { location: url } }]);
  await assert.rejects(safeDownload(url, { dependencies: loop.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
  assert.equal(loop.calls.length, 4);
});

test("a redirect cannot reuse a prior DNS approval after the name rebinds", async () => {
  const mock = transport([{ status: 302, headers: { location: "next.pdf" } }, {}]);
  let lookups = 0;
  mock.dependencies.lookup = async () => ++lookups === 1
    ? [{ address: publicIp, family: 4 }] : [{ address: "169.254.169.254", family: 4 }];
  await assert.rejects(safeDownload(url, { dependencies: mock.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
  assert.equal(mock.calls.length, 1);
  assert.equal(lookups, 2);
});

test("bounds advertised, streamed and decompressed bytes independently", async () => {
  for (const reply of [
    { headers: { "content-length": "101" } },
    { chunks: [Buffer.alloc(60), Buffer.alloc(60)] },
    { body: gzipSync(Buffer.alloc(1000)), headers: { "content-encoding": "gzip" } },
  ]) {
    const mock = transport([reply]);
    await assert.rejects(safeDownload(url, { dependencies: mock.dependencies, maxBytes: 100, maxDecodedBytes: 100 }), errorCode("DOWNLOAD_TOO_LARGE"));
  }
  const good = transport([{ body: gzipSync(pdf), headers: { "content-encoding": "gzip" } }]);
  assert.deepEqual((await safeDownload(url, { dependencies: good.dependencies })).bytes, pdf);
  const nested = transport([{ headers: { "content-encoding": "gzip, br" } }]);
  await assert.rejects(safeDownload(url, { dependencies: nested.dependencies }), errorCode("INVALID_RESPONSE"));
});

test("one transient retry is allowed; auth, missing, partial and unsafe responses are terminal", async () => {
  const mock = transport([{ status: 503 }, {}]);
  assert.deepEqual((await safeDownload(url, { dependencies: mock.dependencies })).bytes, pdf);
  assert.equal(mock.calls.length, 2);
  const reset = transport([{ error: "ECONNRESET" }, {}]);
  await safeDownload(url, { dependencies: reset.dependencies });
  assert.equal(reset.calls.length, 2);
  for (const status of [403, 404, 206, 500]) {
    const failed = transport([{ status }]);
    await assert.rejects(safeDownload(url, { dependencies: failed.dependencies }), errorCode("DOWNLOAD_FAILED"));
    assert.equal(failed.calls.length, 1);
  }
  const retry = transport([{ status: 503 }]);
  await assert.rejects(safeDownload(url, { dependencies: retry.dependencies }), errorCode("DOWNLOAD_FAILED"));
  assert.equal(retry.calls.length, 2);
});

test("timeout includes pending DNS, request and cancellation", async () => {
  await assert.rejects(safeDownload(url, {
    timeoutMs: 10, dependencies: { lookup: () => new Promise(() => {}) },
  }), errorCode("DOWNLOAD_TIMEOUT"));
  const mock = transport([{ stall: true }]);
  await assert.rejects(safeDownload(url, { timeoutMs: 10, dependencies: mock.dependencies }), errorCode("DOWNLOAD_TIMEOUT"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(safeDownload(url, { signal: controller.signal }), errorCode("DOWNLOAD_ABORTED"));
});

test("resolves official file metadata and removes temporary storage credentials before CDN GET", async () => {
  const mock = transport([
    { body: Buffer.from(JSON.stringify({ success: true, data: "https://edunet-data.kr.object.gov-ncloudstorage.com/CNEDU/MANUAL/clssStdDt/20260226/file/sample.pdf?X-Amz-Credential=SECRET" })), headers: { "content-type": "application/json" } },
    {},
  ]);
  assert.deepEqual((await safeDownload(metadataUrl, { dependencies: mock.dependencies })).bytes, pdf);
  assert.equal(mock.calls[1].url, url);
  const malicious = transport([{ body: Buffer.from('{"success":true,"data":"https://169.254.169.254/latest/meta-data"}'), headers: { "content-type": "application/json" } }]);
  await assert.rejects(safeDownload(metadataUrl, { dependencies: malicious.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
  assert.equal(malicious.calls.length, 1);
});

test("metadata and file retrieval share one retry budget", async () => {
  const mock = transport([
    { status: 503 },
    { body: Buffer.from(JSON.stringify({ success: true, data: url })), headers: { "content-type": "application/json" } },
    { status: 503 },
    {},
  ]);
  await assert.rejects(safeDownload(metadataUrl, { dependencies: mock.dependencies }), errorCode("DOWNLOAD_FAILED"));
  assert.equal(mock.calls.length, 3);
});

test("metadata only permits verified API endpoints, JSON and bounded response bodies", async () => {
  const mock = transport([{ body: Buffer.from('{"success":true}'), headers: { "content-type": "application/json; charset=utf-8" } }]);
  assert.deepEqual(await safeMetadataJson("https://api.edunet.net/main/clssStdDt/getClssStdDtInfo/2516662", { dependencies: mock.dependencies }), { success: true });
  await assert.rejects(safeMetadataJson("https://api.edunet.net/admin", { dependencies: mock.dependencies }), errorCode("DOWNLOAD_BLOCKED"));
  const html = transport([{ body: Buffer.from("<html>sign in</html>"), headers: { "content-type": "text/html" } }]);
  await assert.rejects(safeMetadataJson(metadataUrl, { dependencies: html.dependencies }), errorCode("INVALID_RESPONSE"));
  const large = transport([{ headers: { "content-length": String(1024 * 1024 + 1) } }]);
  await assert.rejects(safeMetadataJson(metadataUrl, { dependencies: large.dependencies }), errorCode("DOWNLOAD_TOO_LARGE"));
});

test("format detection preserves PDF/HWP/HWPX identity and rejects MIME, extension and magic conflicts", () => {
  const hwp = Buffer.from("d0cf11e0a1b11ae10000000000000000", "hex");
  const hwpx = Buffer.from("504b0304000000000000000000000000", "hex");
  assert.equal(detectFormat(pdf, "document.PDF", "application/pdf"), "pdf");
  assert.equal(detectFormat(hwp, "document.hwp", "binary/octet-stream"), "hwp");
  assert.equal(detectFormat(hwpx, "document.hwpx", "application/zip"), "hwpx");
  assert.equal(detectFormat(hwp, "document.doc", "application/msword"), "unknown");
  assert.equal(detectFormat(hwpx, "document.zip"), "unknown");
  for (const [bytes, file, mime] of [
    [pdf, "document.hwp", "application/pdf"], [hwp, "document.pdf", "application/octet-stream"],
    [hwpx, "document.hwpx", "application/pdf"], [pdf, "document.pdf", "text/html"],
    [Buffer.from("<html>error</html>"), "document.pdf", "application/pdf"],
    [Buffer.from("%PDF-invalid"), "document.pdf", "application/pdf"], [pdf, "document.exe", "application/pdf"],
  ]) assert.throws(() => detectFormat(bytes, file, mime), errorCode("FORMAT_MISMATCH"));
});
