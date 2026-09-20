import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {fileURLToPath} from 'node:url';
import {buildIdentity} from './build-identity.mjs';

const endpoint = new URL(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'https://edunet-mcp.vercel.app/api/mcp');
assert.ok(['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password);
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const client = new Client({ name: 'edunet-remote-verification', version: expectedVersion });
const expectedIdentity = await buildIdentity(fileURLToPath(new URL('../',import.meta.url)));
let observedSource, observedManifest;
const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: async (url, options) => {const response=await fetch(url, {
    ...options,
    signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(55_000)]),
  });
    observedSource=response.headers.get('x-edunet-source-digest');observedManifest=response.headers.get('x-edunet-manifest-digest');
    assert.equal(observedSource,expectedIdentity.sourceDigest,'Remote source identity mismatch');
    return response;
  },
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
  assert.equal(observedSource,expectedIdentity.sourceDigest);
  report({check:'deployment_identity',sourceDigest:observedSource,manifestDigest:observedManifest,verified:true});
  for (const name of ['search_edunet', 'search_edunet_achievement', 'read_edunet_achievement']) assert.ok(tools.includes(name));
  const search = await call('search_edunet', { query: '광합성', pageSize: 2 });
  assert.ok(search.items.length > 0);
  report({ check: 'search', total: search.pagination.totalCount, returned: search.items.length });
  const discovery = await call('search_edunet_achievement', { query: '성취수준', subject: '과학', grade: '중학교', pageSize: 10 });
  report({ check: 'achievement_discovery', status: discovery.status, candidates: discovery.results.length, warnings: discovery.warnings.map(w => w.code) });
  assert.ok(['ok', 'partial'].includes(discovery.status) && discovery.results.length > 0);
  const candidate = discovery.results.find(item => item.sourceUrl === 'https://www.edunet.net/cmnBoard/view/57/602681');
  assert.ok(candidate,'Expected official science source was not found');
  const listing = await call('read_edunet_achievement', { achievementRef: candidate.achievementRef, maxItems: 20 });
  report({ check: 'attachment_listing', status: listing.status, attachments: listing.attachments?.length ?? 0 });
  assert.equal(listing.status, 'attachment_selection_required');
  if (process.argv.includes('--read')) {
    const attachment = listing.attachments.find(item => item.format === 'pdf' && item.fileName === '(중)2022 개정 교육과정에 따른 성취수준(과학).pdf' && item.readCapability === 'possible');
    assert.ok(attachment, 'Expected science PDF was not found');
    const read = await call('read_edunet_achievement', { achievementRef: candidate.achievementRef, attachmentRef: attachment.attachmentRef, achievementStandardCode:'[9과05-01]',maxItems: 100, maxChars: 20000 });
    report({ check: 'document_read', status: read.status, format: read.attachment?.format, records: read.records.length, rawBlocks: read.rawBlocks?.length ?? 0, warnings: read.warnings.map(w => w.code) });
    assert.equal(read.status,'verified_extraction');
    assert.equal(read.pagination?.hasMore,false);
    assert.deepEqual(read.records.map(r=>r.achievementLevel?.rawLabel),['A','B','C','D','E']);
    assert.ok(read.records.every(r=>r.achievementStandardCode?.raw==='[9과05-01]'&&r.subject?.raw==='과학'));
  }
  report({ check: 'remote_mcp', passed: true });
} catch {
  // Never print SDK/upstream errors, signed references, headers, or credentials.
  report({ check: 'remote_mcp', passed: false });
  process.exitCode = 1;
} finally {
  await client.close();
}
