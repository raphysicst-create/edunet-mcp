import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../../dist/server.js';
import { ReferenceCodec } from '../../dist/achievement/references.js';
import { collectDocument, collectQuery, collectReadPages, withoutReferences } from '../achievement-product/collect.mjs';

const secret = 'achievement-product-collector-test-secret-123456';
const contentHash = 'sha256:' + 'a'.repeat(64);
const resource = { id: '123', title: '중학교 과학 성취수준', sourceUrl: 'https://www.edunet.net/clssStdDt/view/150/123' };
const config = { searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: true, hwpxReadEnabled: false,
  autoAttachmentSelectionEnabled: false, resourceReadEnabled: false, referenceSecret: secret };
const span = quote => ({ quote, sourceHash: contentHash, location: { block: 1, charStart: 0, charEnd: quote.length } });
const record = id => ({ id, achievementLevel: { rawLabel: '상', evidence: [span('상')] },
  description: { raw: `관찰 결과를 설명한다. ${id}`, evidence: [span(`관찰 결과를 설명한다. ${id}`)] },
  evidence: [span('상')], extraction: { method: 'table', confidence: 'high' } });
const profile = { profileId: 'synthetic', profileVersion: '1', matchedBy: [], headerPatterns: [],
  codePatterns: [], levelPatterns: [], tableOrientation: 'levels_in_rows', knownLimitations: [] };
function readPage(ids, overrides = {}) {
  return { kind: 'edunet_achievement_read', status: 'verified_extraction',
    source: { resourceRef: 'test-resource-ref', sourceSystem: 'edunet', retrievedAt: '2026-09-18T00:00:00Z', contentHash },
    attachment: { attachmentRef: 'test-attachment-ref', fileName: '성취수준.pdf', format: 'pdf', downloadStatus: 'downloaded', parserName: 'fixture', parserVersion: '1' },
    documentProfile: profile, records: ids.map(record), rawBlocks: [], warnings: [],
    documentExtractionComplete: true, responseTruncated: false, visualContentInterpreted: false,
    pagination: { hasMore: false }, ...overrides };
}
const continued = (ids, cursor) => readPage(ids, { responseTruncated: true, pagination: { hasMore: true, cursor } });

test('collector drains record pages and preserves duplicate predictions for precision scoring', async () => {
  const cursors = [];
  const first = continued(['r1', 'r2'], 'cursor-1');
  const result = await collectReadPages(first, async cursor => {
    cursors.push(cursor);
    return readPage(['r2', 'r3']);
  });
  assert.deepEqual(cursors, ['cursor-1']);
  assert.deepEqual(result.records.map(item => item.id), ['r1', 'r2', 'r2', 'r3']);
  assert.equal(result.pages.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.documentExtractionComplete, true);
  assert.equal(result.responsePagesComplete, true);
});

test('collector drains raw text fragments without mistaking repeated text at new positions for a stall', async () => {
  const block = offset => ({ text: '같은 문장', kind: 'paragraph', location: { block: 1, charStart: offset, charEnd: offset + 5 } });
  const first = readPage([], { status: 'metadata_only', rawBlocks: [block(0)], responseTruncated: true, pagination: { hasMore: true, cursor: 'raw-1' } });
  const result = await collectReadPages(first, async () => readPage([], { status: 'metadata_only', rawBlocks: [block(5)] }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.rawBlocks.map(item => item.location.charStart), [0, 5]);
});

test('collector detects repeated cursors even when the returned record content changes', async () => {
  let calls = 0;
  const result = await collectReadPages(continued(['r1'], 'same'), async () => {
    calls++;
    return continued(['r2'], 'same');
  });
  assert.equal(calls, 1);
  assert.equal(result.error, 'pagination_missing_or_repeated_cursor');
  assert.equal(result.complete, false);
});

test('collector detects unchanged pages despite fresh signed cursor nonces', async () => {
  const references = new ReferenceCodec(secret);
  const firstCursor = references.issue('cursor', { offset: 1 });
  const nextCursor = references.issue('cursor', { offset: 1 });
  assert.notEqual(firstCursor, nextCursor);
  let calls = 0;
  const result = await collectReadPages(continued(['r1'], firstCursor), async () => {
    calls++;
    return continued(['r1'], nextCursor);
  });
  assert.equal(calls, 1);
  assert.equal(result.error, 'pagination_no_progress');
  assert.equal(result.complete, false);
});

test('collector refuses to follow an empty response that claims more content', async () => {
  let calls = 0;
  const result = await collectReadPages(continued([], 'empty'), async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(result.error, 'pagination_no_progress');
});

for (const change of ['hash', 'parserName', 'parserVersion', 'profileId', 'profileVersion']) {
  test(`collector rejects ${change} drift before mixing a second document page`, async () => {
    const second = readPage(['r2']);
    if (change === 'hash') second.source.contentHash = 'sha256:' + 'b'.repeat(64);
    else if (change.startsWith('parser')) second.attachment = { ...second.attachment, [change]: 'changed' };
    else second.documentProfile = { ...second.documentProfile, [change]: 'changed' };
    const result = await collectReadPages(continued(['r1'], 'next'), async () => second);
    assert.equal(result.error, 'document_or_parser_changed');
    assert.deepEqual(result.records.map(item => item.id), ['r1']);
    assert.equal(result.complete, false);
  });
}

for (const extractionComplete of [false, undefined]) {
  test(`collector does not promote extraction-complete=${extractionComplete} to a complete document`, async () => {
    const result = await collectReadPages(readPage(['r1'], { documentExtractionComplete: extractionComplete }), async () => assert.fail('unexpected page'));
    assert.equal(result.responsePagesComplete, true);
    assert.equal(result.documentExtractionComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.error, 'document_extraction_incomplete');
  });
}

test('collector requires pagination termination and never equates page limits with completion', async () => {
  const capped = await collectReadPages(continued(['r1'], 'next'), async () => assert.fail('over page limit'), { maxPages: 1 });
  assert.equal(capped.error, 'read_page_limit');
  assert.equal(capped.responsePagesComplete, false);
  const inconsistent = await collectReadPages(readPage(['r1'], { responseTruncated: true }), async () => assert.fail('no cursor'));
  assert.equal(inconsistent.complete, false);
  assert.equal(inconsistent.error, 'pagination_missing_or_repeated_cursor');
  const missing = await collectReadPages(readPage(['r1'], { pagination: undefined }), async () => assert.fail('no cursor'));
  assert.equal(missing.complete, false);
});

test('collector retains prior pages when a later call fails but reports the document incomplete', async () => {
  const result = await collectReadPages(continued(['r1'], 'next'), async () => { throw new Error('sensitive upstream details'); });
  assert.equal(result.error, 'read_page_failed');
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream/);
});

test('collector marks explicit read failures and missing file hashes incomplete', async () => {
  for (const status of ['parse_failed', 'worker_unavailable', 'unsupported_format', 'source_unavailable']) {
    const result = await collectReadPages(readPage([], { status }), async () => assert.fail('unexpected retry'));
    assert.equal(result.error, 'document_read_failed');
    assert.equal(result.complete, false);
  }
  const source = { ...readPage([]).source };
  delete source.contentHash;
  const missingHash = await collectReadPages(readPage([], { source }), async () => assert.fail('unexpected retry'));
  assert.equal(missingHash.error, 'document_read_failed');
  const empty = await collectReadPages(readPage([], { status: 'no_text' }), async () => assert.fail('unexpected retry'));
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.records, []);
});

test('reference removal is recursive and preserves evidence, stable IDs, warnings and completeness', () => {
  const original = { resourceRef: 'resource-token', achievementRef: 'achievement-token',
    source: { resourceId: '123', contentHash }, attachment: { attachmentRef: 'attachment-token', attachmentId: 'a' },
    pagination: { cursor: 'cursor-token', hasMore: true }, records: [record('r1')],
    warnings: [{ code: 'PARTIAL', message: '일부만 추출됨' }], documentExtractionComplete: false };
  const clean = withoutReferences(original);
  assert.doesNotMatch(JSON.stringify(clean), /resource-token|achievement-token|attachment-token|cursor-token/);
  assert.deepEqual(clean.records, original.records);
  assert.deepEqual(clean.warnings, original.warnings);
  assert.equal(clean.source.contentHash, contentHash);
  assert.equal(clean.attachment.attachmentId, 'a');
  assert.equal(clean.pagination.hasMore, true);
  assert.equal(clean.documentExtractionComplete, false);
  assert.equal(original.pagination.cursor, 'cursor-token');
});

function queryResponse(references) {
  return { kind: 'edunet_achievement_search', status: 'partial',
    results: [{ achievementRef: references.issue('achievement', { resource }), resourceRef: references.issue('resource', { resource }),
      title: resource.title, sourceUrl: resource.sourceUrl, candidateReason: ['합성 메타데이터'], readCapability: 'possible' }],
    coverage: { officialApiQueried: true, queryVariantsTried: ['중2 과학 성취수준'], attachmentMetadataChecked: false,
      registryPathsChecked: [], limitation: '원문 검증 아님' },
    warnings: [{ code: 'pagination_unknown', message: '합성 경고' }] };
}

test('query collector records verified stable identities and discovery scope without signed refs', async () => {
  const references = new ReferenceCodec(secret);
  const requests = [];
  const client = { callTool: async request => { requests.push(request); return { structuredContent: queryResponse(references) }; } };
  const result = await collectQuery({ id: 'q1', input: { query: '중2 과학 성취수준', page: 3 } }, { client, references });
  assert.equal(requests[0].name, 'search_edunet_achievement');
  assert.equal(requests[0].arguments.page, 1);
  assert.equal(requests[0].arguments.pageSize, 20);
  assert.equal(result.status, 'partial');
  assert.equal(result.candidates[0].resourceId, '123');
  assert.equal(result.discoveryCoverage.attachmentMetadataChecked, false);
  assert.equal(result.warnings[0].code, 'pagination_unknown');
  assert.doesNotMatch(JSON.stringify(result), /achievementRef|resourceRef/);
});

test('query collector cannot turn tool errors, malformed responses or invalid references into an empty successful search', async () => {
  const references = new ReferenceCodec(secret);
  const invalid = queryResponse(references);
  invalid.results[0].achievementRef = 'invalid';
  for (const response of [{ isError: true }, { structuredContent: {} }, { structuredContent: invalid }]) {
    const result = await collectQuery({ id: 'q1', input: { query: '과학' } }, { references, client: { callTool: async () => response } });
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'discovery_collection_failed');
    assert.deepEqual(result.candidates, []);
  }
});

async function withSyntheticMcp({ attachmentCount = 1, autoSelection = false, recordCount = 1 } = {}, fn) {
  const references = new ReferenceCodec(secret);
  const attachments = Array.from({ length: attachmentCount }, (_, index) => ({ id: `a${index}`, fileName: `성취수준-${index}.pdf`,
    format: 'pdf', declaredMimeType: 'application/pdf', url: `https://api.edunet.net/main/fileRsc/downloadFile/${index + 1}` }));
  const workerCalls = [];
  const achievement = { references, config: { ...config, autoAttachmentSelectionEnabled: autoSelection },
    resolveResource: async () => ({ resource, attachments, warnings: [] }),
    gateway: { run: async handle => {
      const job = references.verify(handle, 'worker');
      workerCalls.push(job.attachmentId);
      const selected = attachments.find(item => item.id === job.attachmentId);
      return { status: 'verified_extraction', contentHash, records: Array.from({ length: recordCount }, (_, index) => record(`r${index}`)),
        rawBlocks: [], warnings: [], documentExtractionComplete: true, visualContentInterpreted: false, documentProfile: profile,
        attachment: { attachmentRef: job.attachmentRef, fileName: selected.fileName, format: 'pdf', downloadStatus: 'downloaded',
          parserName: 'synthetic', parserVersion: '1' } };
    } } };
  const server = createServer(async () => { throw new Error('No live search allowed'); }, { achievement });
  const client = new Client({ name: 'product-collector-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    await fn({ client, references, attachments, workerCalls });
  } finally { await client.close(); await server.close(); }
}

test('real MCP collector lists later attachment pages, preserves abstention and explicitly reads the gold attachment', async () => {
  await withSyntheticMcp({ attachmentCount: 23, recordCount: 55 }, async ({ client, references, attachments, workerCalls }) => {
    const result = await collectDocument({ id: 'doc1', resource, attachment: attachments[22] }, { client, references });
    assert.equal(result.autoSelection.action, 'abstain');
    assert.equal(result.autoSelection.status, 'attachment_selection_required');
    assert.equal(result.attachments.length, 23);
    assert.equal(result.attachment.attachmentId, 'a22');
    assert.equal(result.status, 'verified_extraction');
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 55);
    assert.ok(result.pages.length > 1, 'record collection must cross the MCP character budget');
    assert.ok(workerCalls.length > 1);
    assert.ok(workerCalls.every(id => id === 'a22'));
    assert.doesNotMatch(JSON.stringify(result), /achievementRef|resourceRef|attachmentRef|"cursor"/);
  });
});

test('real MCP collector distinguishes automatic single-attachment selection from explicit gold selection', async () => {
  await withSyntheticMcp({ autoSelection: true }, async ({ client, references, attachments, workerCalls }) => {
    const result = await collectDocument({ id: 'doc1', resource, attachment: attachments[0] }, { client, references });
    assert.equal(result.autoSelection.action, 'select');
    assert.equal(result.autoSelection.attachmentId, 'a0');
    assert.equal(result.complete, true);
    assert.deepEqual(workerCalls, ['a0']);
  });
});

test('gold attachment metadata changes stop collection before a file is parsed', async () => {
  await withSyntheticMcp({}, async ({ client, references, attachments, workerCalls }) => {
    const result = await collectDocument({ id: 'doc1', resource, attachment: { ...attachments[0], fileName: 'changed.pdf' } }, { client, references });
    assert.equal(result.error, 'attachment_metadata_changed');
    assert.equal(result.complete, false);
    assert.deepEqual(workerCalls, []);
  });
});

test('attachment pagination limits are incomplete observations and do not trigger an arbitrary read', async () => {
  await withSyntheticMcp({ attachmentCount: 23 }, async ({ client, references, attachments, workerCalls }) => {
    const result = await collectDocument({ id: 'doc1', resource, attachment: attachments[22] }, { client, references, maxPages: 1 });
    assert.equal(result.complete, false);
    assert.equal(result.autoSelection.action, 'abstain');
    assert.ok(result.error);
    assert.deepEqual(workerCalls, []);
  });
});
