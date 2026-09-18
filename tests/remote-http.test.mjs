import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server.js";
import { loadAchievementConfig } from "../dist/achievement/config.js";
import { createRemoteHandler } from "../dist/remote-http.js";

const search = async conditions => ({
  conditions, items: [{ id: "test", title: conditions.query, content: "", contentTruncated: false, url: null, category: null }],
  pagination: { page: 1, pageSize: conditions.pageSize, returnedCount: 1, totalCount: 1, hasNextPage: false, nextPage: null, pageLimitReached: false },
  source: "EDUNET_SEARCH_API", originalRead: false, attachmentsRead: false, integrationStatus: "live_verified", warnings: [],
});
const config = loadAchievementConfig({
  EDUNET_ACHIEVEMENT_SEARCH_ENABLED: "true", EDUNET_ACHIEVEMENT_PDF_READ_ENABLED: "true",
  EDUNET_ACHIEVEMENT_HWP_READ_ENABLED: "true", EDUNET_REFERENCE_SECRET: "r".repeat(64),
});
const makeServer = (searchImpl = search) => createServer(searchImpl, { achievement: { config } });

async function endpoint(t, factory = makeServer, options, transform) {
  const handler = createRemoteHandler(factory, options);
  const pending = new Set();
  const server = createHttpServer((req, res) => {
    if (transform) transform(req);
    const exchange = handler(req, res).catch(error => { res.destroy(error); });
    pending.add(exchange);
    void exchange.finally(() => pending.delete(exchange));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
  const post = (body, extra = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra.headers },
    body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000), ...extra,
  });
  return { url, post, settle: () => Promise.all([...pending]) };
}

test("remote MCP SDK client discovers beta tools and calls across stateless HTTP requests", async t => {
  let instances = 0;
  let closed = 0;
  const { url } = await endpoint(t, () => {
    instances++;
    const server = makeServer();
    const close = server.close.bind(server);
    server.close = async () => { closed++; await close(); };
    return server;
  });
  const client = new Client({ name: "remote-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.equal(client.getServerVersion().version, "1.1.0-beta.1");
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [
    "search_edunet", "search_edunet_achievement", "read_edunet_achievement",
  ]);
  const result = await client.callTool({ name: "search_edunet", arguments: { query: "광합성" } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.items[0].title, "광합성");
  assert.ok(instances >= 3);
  assert.equal(closed, instances);
});

test("legacy initialize, initialized notification, list and tool call need no session affinity", async t => {
  const { post } = await endpoint(t);
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy", version: "1" },
  } });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("mcp-session-id"), null);
  assert.match(initialized.headers.get("content-type"), /application\/json/);
  assert.equal((await initialized.json()).result.serverInfo.version, "1.1.0-beta.1");
  const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.status, 202);
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((await listed.json()).result.tools.length, 3);
  const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_edunet", arguments: { query: "빛" } } });
  assert.equal((await called.json()).result.structuredContent.items[0].title, "빛");
});

test("concurrent requests may reuse JSON-RPC ids without sharing transports", async t => {
  const { post } = await endpoint(t, () => makeServer(async input => {
    await new Promise(resolve => setTimeout(resolve, input.query === "first" ? 30 : 1));
    return search(input);
  }));
  const results = await Promise.all(["first", "second"].map(async query => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_edunet", arguments: { query } } });
    return (await response.json()).result.structuredContent.items[0].title;
  }));
  assert.deepEqual(results, ["first", "second"]);
});

test("HTTP rejects methods, cross-origin requests, unsupported types and oversized JSON", async t => {
  const { url, post } = await endpoint(t, makeServer, { maxBodyBytes: 128 });
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
  const origin = await post({}, { headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } });
  assert.equal(origin.status, 403);
  const contentType = await post({}, { headers: { "Content-Type": "text/plain" } });
  assert.equal(contentType.status, 415);
  const tooBig = await post({ padding: "x".repeat(256) });
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json()).error.code, -32600);
  const invalidJson = await post("{");
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, -32700);
});

test("Vercel pre-parsed body is used even when the request stream is absent", async t => {
  const payload = { jsonrpc: "2.0", id: 5, method: "tools/list" };
  const { post } = await endpoint(t, makeServer, undefined, req => { req.body = payload; });
  const response = await post("");
  const result = await response.json();
  assert.equal(result.id, 5);
  assert.equal(result.result.tools.length, 3);
});

test("oversized chunked bodies produce JSON 413 without destroying the response socket", async t => {
  const { url } = await endpoint(t, makeServer, { maxBodyBytes: 128 });
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Transfer-Encoding": "chunked",
    } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk.toString(); });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.write('{"padding":"');
    request.end(`${"x".repeat(256)}"}`);
  });
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.body).error.code, -32600);
});

test("server startup failures return a safe error without credentials or stack traces", async t => {
  const { post } = await endpoint(t, () => { throw new Error("secret-value C:/private/file.js:21"); });
  const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /Internal server error/);
  assert.doesNotMatch(body, /secret-value|private|stack|\.js:/);
});

test("disconnect closes an in-flight server and aborts the tool request", async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let cancelled;
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const { post, settle } = await endpoint(t, () => makeServer((_input, signal) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled();
      reject(new Error("cancelled"));
    }, { once: true }));
  }));
  const abort = new AbortController();
  const result = post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_edunet", arguments: { query: "cancel" } } }, { signal: abort.signal });
  await began;
  abort.abort();
  await assert.rejects(result);
  await Promise.race([stopped, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("tool not cancelled")), 1000); timer.unref(); })]);
  await Promise.race([settle(), new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("HTTP handler did not settle")), 1000); timer.unref(); })]);
});
