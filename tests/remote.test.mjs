import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpHandler } from "../dist/remote.js";
import { createServer } from "../dist/server.js";

const token = "test-only-access-token-32-characters-long";
const endpoint = new URL("https://example.test/api/mcp");

test("remote endpoint fails closed and rejects bad credentials and cross-site requests", async () => {
  const missing = createHttpHandler(undefined, {});
  const secured = createHttpHandler(undefined, { MCP_ACCESS_TOKEN: token });
  try {
    assert.equal((await missing.fetch(new Request(endpoint))).status, 503);
    for (const authorization of ["", "Bearer wrong", `Basic ${token}`]) {
      const response = await secured.fetch(new Request(endpoint, { headers: { authorization } }));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await secured.fetch(new Request(endpoint, {
      headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.test" },
    }))).status, 403);
  } finally { await missing.close(); await secured.close(); }
});

for (const mode of ["bearer", "public"]) {
  test(`Streamable HTTP ${mode}: initialize, list, concurrent search and validation`, async () => {
    const handler = createHttpHandler(() => createServer(async conditions => ({
      conditions, items: [{ id: "1", title: conditions.query, content: "발췌", contentTruncated: false, url: null, category: null }],
      pagination: { page: 1, pageSize: conditions.pageSize, returnedCount: 1, totalCount: 1, hasNextPage: false, nextPage: null, pageLimitReached: false },
      source: "EDUNET_SEARCH_API", originalRead: false, attachmentsRead: false,
      integrationStatus: "live_verified", warnings: [],
    })), { MCP_AUTH_MODE: mode, MCP_ACCESS_TOKEN: token });
    const clients = [new Client({ name: "remote-a", version: "1" }), new Client({ name: "remote-b", version: "1" })];
    try {
      await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(endpoint, {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
        requestInit: { headers: mode === "bearer" ? { Authorization: `Bearer ${token}` } : {} },
      }))));
      assert.deepEqual((await clients[0].listTools()).tools.map(tool => tool.name), ["search_edunet"]);
      const results = await Promise.all(clients.map((client, i) => client.callTool({
        name: "search_edunet", arguments: { query: `과학 ${i}` },
      })));
      for (let i = 0; i < results.length; i++) {
        assert.equal(results[i].isError, undefined);
        assert.equal(results[i].structuredContent.items[0].title, `과학 ${i}`);
      }
      const invalid = await clients[0].callTool({ name: "search_edunet", arguments: { query: "과학", page: 51 } });
      assert.equal(invalid.isError, true);
      assert.equal((await handler.fetch(new Request(endpoint, {
        headers: mode === "bearer" ? { authorization: `Bearer ${token}` } : {},
      }))).status, 405);
    } finally { await Promise.all(clients.map(client => client.close())); await handler.close(); }
  });
}
