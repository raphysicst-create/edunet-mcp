import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { searchOutputSchema } from "../dist/schema.js";

const endpoint = new URL(process.argv[2]);
const client = new Client({ name: "edunet-remote-verification", version: "1.0.0" });
const token = process.env.MCP_ACCESS_TOKEN;
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["search_edunet"]);
  console.log("PASS remote initialization and tools/list");
  const result = await client.callTool({ name: "search_edunet", arguments: { query: "광합성", pageSize: 2 } }, undefined, { timeout: 55000 });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const output = searchOutputSchema.parse(result.structuredContent);
  assert.ok(output.items.length > 0, "Expected photosynthesis search results");
  if (process.env.EDUNET_API_KEY) assert.ok(!JSON.stringify(result).includes(process.env.EDUNET_API_KEY));
  console.log(`PASS remote search: ${output.items.length} results, API key not exposed`);
} finally { await client.close(); }
