import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'https://edunet-mcp.vercel.app/api/mcp');
assert.ok(['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password);
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const client = new Client({ name: 'edunet-remote-verification', version: expectedVersion });
const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: (url, options) => fetch(url, {
    ...options,
    signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(55_000)]),
  }),
});
const report = value => console.log(JSON.stringify(value));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 55_000 });
  assert.ok(!result.isError, `${name} failed`);
  assert.ok(result.structuredContent, `${name} has no structured output`);
  return result.structuredContent;
}

try {
  await client.connect(transport, { timeout: 20_000 });
  const server = client.getServerVersion();
  const tools = (await client.listTools({}, { timeout: 20_000 })).tools.map(tool => tool.name);
  report({ server, tools });
  assert.equal(server?.version, expectedVersion);
  for (const name of ['search_edunet', 'search_edunet_achievement', 'read_edunet_achievement']) assert.ok(tools.includes(name));
  const search = await call('search_edunet', { query: '광합성', pageSize: 2 });
  assert.ok(search.items.length > 0);
  report({ check: 'search', total: search.pagination.totalCount, returned: search.items.length });
  const discovery = await call('search_edunet_achievement', { query: '성취수준', subject: '과학', pageSize: 3 });
  report({ check: 'achievement_discovery', status: discovery.status, candidates: discovery.results.length, warnings: discovery.warnings.map(w => w.code) });
  assert.ok(['ok', 'partial'].includes(discovery.status) && discovery.results.length > 0);
  const candidate = discovery.results.find(item => item.readCapability === 'possible') ?? discovery.results[0];
  const listing = await call('read_edunet_achievement', { achievementRef: candidate.achievementRef, maxItems: 20 });
  report({ check: 'attachment_listing', status: listing.status, attachments: listing.attachments?.length ?? 0 });
  assert.equal(listing.status, 'attachment_selection_required');
  if (process.argv.includes('--read')) {
    const attachment = listing.attachments.find(item => item.format === 'pdf' && item.readCapability === 'possible')
      ?? listing.attachments.find(item => item.format === 'hwp' && item.readCapability === 'possible');
    assert.ok(attachment, 'No supported attachment in the first candidate');
    const read = await call('read_edunet_achievement', { achievementRef: candidate.achievementRef, attachmentRef: attachment.attachmentRef, maxItems: 10, maxChars: 4000 });
    report({ check: 'document_read', status: read.status, format: read.attachment?.format, records: read.records.length, rawBlocks: read.rawBlocks?.length ?? 0, warnings: read.warnings.map(w => w.code) });
    assert.ok(['verified_extraction', 'metadata_only'].includes(read.status));
    assert.ok(read.records.length || read.rawBlocks?.length);
  }
  report({ check: 'remote_mcp', passed: true });
} catch {
  // Never print SDK/upstream errors, signed references, headers, or credentials.
  report({ check: 'remote_mcp', passed: false });
  process.exitCode = 1;
} finally {
  await client.close();
}
