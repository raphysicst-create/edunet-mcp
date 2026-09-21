#!/usr/bin/env node

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const DEFAULT_ENDPOINT = "https://edunet-mcp.vercel.app/api/mcp";
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

// search_edunet is registered unconditionally. Achievement tools are feature-flagged,
// so they are intentionally not required by this lightweight availability check.
const REQUIRED_TOOLS = ["search_edunet"];

const endpoint = parseEndpoint(process.argv[2] ?? process.env.MCP_ENDPOINT ?? DEFAULT_ENDPOINT);
const endpointForDisplay = displayUrl(endpoint);
const failures = [];

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const result = await checkOnce(attempt);
  if (result.ok) {
    console.log("EDUNET MCP HEALTHY\n");
    console.log("connection: OK");
    console.log("initialize: OK");
    console.log("tools/list: OK");
    console.log("EDUNET search: OK");
    process.exit(0);
  }

  failures.push(result);
  console.error(`Attempt ${attempt}/${MAX_ATTEMPTS} failed at ${result.stage}: ${result.message}`);
  if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
}

const report = failureReport(failures);
if (process.env.HEALTH_REPORT_FILE) {
  try {
    await writeFile(process.env.HEALTH_REPORT_FILE, report, "utf8");
  } catch (error) {
    console.error(`Could not write health report: ${safeError(error)}`);
  }
}
console.error(`\n${report}`);
process.exit(1);

async function checkOnce(attempt) {
  const client = new Client({ name: "edunet-remote-health", version: "1.0.0" });
  const deadline = Date.now() + ATTEMPT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
  let stage = "initialize";
  let receivedHttpResponse = false;
  const token = process.env.MCP_ACCESS_TOKEN?.trim();

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      receivedHttpResponse = true;
      return response;
    },
  });

  try {
    await client.connect(transport, requestOptions(deadline, signal));

    stage = "tools/list";
    const listed = await client.listTools(undefined, {
      ...requestOptions(deadline, signal),
      cacheMode: "bypass",
    });
    const names = new Set(listed.tools.map(tool => tool.name));
    const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
    assert.deepEqual(missing, [], `Missing required tools: ${missing.join(", ")}`);

    stage = "EDUNET search";
    const result = await client.callTool({
      name: "search_edunet",
      arguments: { query: "광합성", pageSize: 1 },
    }, undefined, requestOptions(deadline, signal));
    assert.notEqual(result.isError, true, toolError(result));
    assertSearchResult(result.structuredContent);

    return { ok: true };
  } catch (error) {
    if (stage === "initialize" && !receivedHttpResponse) stage = "connection";
    return { ok: false, attempt, stage, message: safeError(error) };
  } finally {
    try {
      await client.close();
    } catch {
      // The primary check result is more useful than a cleanup error.
    }
  }
}

function requestOptions(deadline, signal) {
  const remaining = Math.max(1, deadline - Date.now());
  return { signal, timeout: remaining, maxTotalTimeout: remaining };
}

function assertSearchResult(output) {
  assert.ok(output && typeof output === "object", "search_edunet returned no structuredContent");
  assert.equal(output.source, "EDUNET_SEARCH_API", "Unexpected search source");
  assert.equal(output.integrationStatus, "live_verified", "EDUNET integration is not live_verified");
  assert.equal(output.originalRead, false, "Health check must not read original documents");
  assert.ok(Array.isArray(output.items), "Search items are missing");
  assert.ok(output.pagination && typeof output.pagination === "object", "Search pagination is missing");
  assert.equal(output.pagination.pageSize, 1, "Search did not honor the lightweight page size");
}

function toolError(result) {
  const text = Array.isArray(result.content)
    ? result.content.find(item => item?.type === "text")?.text
    : undefined;
  return typeof text === "string" ? text : "search_edunet returned an MCP error";
}

function parseEndpoint(value) {
  try {
    const url = new URL(value);
    assert.ok(["http:", "https:"].includes(url.protocol), "MCP endpoint must use HTTP or HTTPS");
    return url;
  } catch (error) {
    console.error(`Invalid MCP endpoint: ${safeError(error)}`);
    process.exit(2);
  }
}

function displayUrl(url) {
  const safe = new URL(url);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const token = process.env.MCP_ACCESS_TOKEN?.trim();
  const redacted = token ? raw.replaceAll(token, "[REDACTED]") : raw;
  return redacted.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function failureReport(attempts) {
  const last = attempts.at(-1);
  const detectedAt = new Date().toISOString();
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "Unavailable outside GitHub Actions";
  const attemptLines = attempts.map(item =>
    `- Attempt ${item.attempt}/${MAX_ATTEMPTS}: \`${markdown(item.stage)}\` — ${markdown(item.message)}`
  ).join("\n");

  return `## Remote MCP health check failed

- Detected at: ${detectedAt}
- Failed stage: \`${markdown(last.stage)}\`
- Error message: ${markdown(last.message)}
- Retry count: ${MAX_ATTEMPTS - 1} (${MAX_ATTEMPTS} attempts total)
- GitHub Actions run: ${runUrl.startsWith("http") ? `[open run](${runUrl})` : runUrl}
- MCP URL: \`${markdown(endpointForDisplay)}\`

### Attempts

${attemptLines}
`;
}

function markdown(value) {
  return String(value).replaceAll("`", "'");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
