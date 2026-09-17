import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "../dist/server.js";
import { searchInputSchema } from "../dist/schema.js";

test("input defaults and limits reject invalid inputs", () => {
  const input = searchInputSchema.parse({ query: " 중2 과학 광합성 " });
  assert.equal(input.query, "중2 과학 광합성");
  assert.equal(input.pageSize, 10);
  assert.equal(input.page, 1);
  for (const args of [{ query: " " }, { query: "q", page: 51 }, { query: "q", pageSize: 21 },
    { query: "q", page: 1.1 }, { query: "q", categories: ["made-up"] }, { query: "q", grade: 2 }]) {
    assert.equal(searchInputSchema.safeParse(args).success, false);
  }
});

test("MCP structured output and summary stay separate", async () => {
  const server = createServer(async (conditions) => ({
    conditions, items: [{ id: "1", title: "광합성", content: "발췌", contentTruncated: false, url: null, category: null }],
    pagination: { page: 1, pageSize: 10, returnedCount: 1, totalCount: null, hasNextPage: null, nextPage: null, pageLimitReached: false },
    source: "EDUNET_SEARCH_API", originalRead: false, attachmentsRead: false,
    integrationStatus: "live_verified", warnings: [],
  }));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name), ["search_edunet"]);
    const result = await client.callTool({ name: "search_edunet", arguments: { query: "광합성" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.items[0].title, "광합성");
    assert.match(result.content[0].text, /전체 건수 미제공/);
    assert.doesNotMatch(result.content[0].text, /발췌/);
    const invalid = await client.callTool({ name: "search_edunet", arguments: { query: "q", page: 51 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});

test("real stdio process initializes without credentials and reports safe configuration failure", async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith("EDUNET_") && typeof value === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "stdio-check", version: "1.0.0" });
  try {
    await client.connect(transport);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(client.getServerVersion().version, pkg.version);
    assert.equal((await client.listTools()).tools[0].name, "search_edunet");
    const invalid = await client.callTool({ name: "search_edunet", arguments: { query: "광합성", pageSize: 100 } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /INVALID_INPUT.*pageSize: 20/);
    const result = await client.callTool({ name: "search_edunet", arguments: { query: "광합성" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CONFIGURATION/);
    assert.doesNotMatch(JSON.stringify(result), /Error:|node_modules|\.js:\d+:\d+|"stack"/);
    assert.equal((await client.listTools()).tools[0].name, "search_edunet");
  } finally { await client.close(); }
  assert.doesNotMatch(stderr, /Error:|node_modules|stack/);
});
