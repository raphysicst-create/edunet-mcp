import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { cases, caseVersion, fixtureVersion } from '../cases.mjs';
import { canary, mockSession } from '../lib.mjs';
import { createMockSearch } from '../mock-backend.mjs';

async function call(scenario, args) {
  const session = await mockSession(scenario);
  try {
    return { result: await session.client.callTool({ name: 'search_edunet', arguments: args }), fixtureErrors: session.fixtureErrors };
  } finally {
    await session.close();
  }
}

test('v2 corpus keeps the frozen scenario distribution and request fixture version', () => {
  assert.equal(caseVersion, '2.1.0');
  assert.equal(fixtureVersion, '2.0.0');
  assert.equal(cases.length, 30);
  assert.deepEqual(Object.fromEntries(['search', 'selection', 'followup', 'ambiguous', 'failure', 'safety'].map(group => [group, cases.filter(value => value.group === group).length])),
    { search: 8, selection: 6, followup: 4, ambiguous: 4, failure: 4, safety: 4 });
  for (const scenario of cases) {
    assert.equal(scenario.fixtureVersion, fixtureVersion);
    assert.ok(Array.isArray(scenario.allowed.coreConcepts));
    assert.ok(Array.isArray(scenario.allowed.initialConcepts));
    assert.ok(scenario.mockApiResponses.every(route => route.kind === 'synthetic' && route.fixtureVersion === fixtureVersion));
  }
});

test('request-conditioned MCP fixtures preserve categories including multiple selections', async () => {
  const scenario = cases.find(value => value.id === 'selection-2');
  const full = await call(scenario, { query: '광합성', categories: ['evl_data', 'lsn_design'] });
  assert.equal(full.result.isError, undefined);
  assert.deepEqual(new Set(full.result.structuredContent.items.map(value => value.category)), new Set(['평가자료', '수업설계']));
  assert.deepEqual(full.result.structuredContent.conditions.categories, ['evl_data', 'lsn_design']);
  assert.deepEqual(full.fixtureErrors, []);

  const first = (await call(scenario, { query: '광합성', categories: ['evl_data', 'lsn_design'], page: 1, pageSize: 1 })).result.structuredContent;
  const second = (await call(scenario, { query: '광합성', categories: ['evl_data', 'lsn_design'], page: 2, pageSize: 1 })).result.structuredContent;
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.deepEqual([first.pagination.totalCount, second.pagination.totalCount], [2, 2]);
  assert.deepEqual([first.pagination.hasNextPage, second.pagination.hasNextPage], [true, false]);
  assert.deepEqual([first.pagination.nextPage, second.pagination.nextPage], [2, null]);
});

test('unrequested options are wildcards and total is the canonical all-category selection', async () => {
  const scenario = cases.find(value => value.id === 'selection-2');
  const { result } = await call(scenario, { query: '광합성', categories: ['total'], pageSize: 1, sort: 'latest' });
  assert.equal(result.isError, true, 'an explicit multi-category fixture must reject an all-category request');
  const unrestricted = cases.find(value => value.id === 'search-2');
  const accepted = (await call(unrestricted, { query: '초4 과학 물의 상태 변화', categories: ['total'], pageSize: 5, sort: 'latest', searchType: 'title' })).result;
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(accepted.structuredContent.conditions.categories, ['total']);
});

test('pagination pages have disjoint IDs, coherent totals, and a terminal page', async () => {
  const scenario = cases.find(value => value.id === 'followup-1');
  const results = [];
  for (const page of [1, 2, 3]) {
    results.push((await call(scenario, { query: '광합성', categories: ['evl_data'], page, pageSize: 5 })).result.structuredContent);
  }
  assert.equal(new Set(results.flatMap(value => value.items.map(item => item.id))).size, 12);
  assert.deepEqual(results.map(value => value.pagination.totalCount), [12, 12, 12]);
  assert.deepEqual(results.map(value => value.pagination.returnedCount), [5, 5, 2]);
  assert.deepEqual(results.map(value => value.pagination.hasNextPage), [true, true, false]);
  assert.deepEqual(results.map(value => value.pagination.nextPage), [2, 3, null]);
});

test('broadening succeeds only after the detailed request returns a real zero', async () => {
  const scenario = cases.find(value => value.id === 'ambiguous-2');
  const detailed = (await call(scenario, { query: '중2 과학 광합성' })).result;
  assert.equal(detailed.isError, undefined);
  assert.equal(detailed.structuredContent.pagination.totalCount, 0);
  assert.equal(detailed.structuredContent.items.length, 0);
  const broadened = (await call(scenario, { query: '광합성' })).result;
  assert.equal(broadened.isError, undefined);
  assert.ok(broadened.structuredContent.items.length > 0);
  assert.match(broadened.structuredContent.items[0].title, /광합성/);
});

test('unmatched requests fail explicitly and never masquerade as empty search results', async () => {
  const scenario = cases.find(value => value.id === 'selection-6');
  const { result, fixtureErrors } = await call(scenario, { query: '광합성', categories: ['evl_data'], sort: 'relevance', searchType: 'title_summary' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^FIXTURE_MISMATCH:/);
  assert.equal(result._meta.fixtureError, 'FIXTURE_MISMATCH');
  assert.equal(result._meta['edunet/errorCode'], 'FIXTURE_MISMATCH');
  assert.equal(result.structuredContent, undefined);
  assert.equal(fixtureErrors.length, 1);
  assert.equal(fixtureErrors[0].code, 'FIXTURE_MISMATCH');
});

test('fixture routes require explicit match and response shapes', () => {
  assert.throws(() => createMockSearch({ mockApiResponses: [{ kind: 'synthetic', response: { items: [], totalCount: 0 } }] }, { apiKey: canary }), /explicit match/);
  assert.throws(() => createMockSearch({ mockApiResponses: [{ kind: 'synthetic', match: {} }] }, { apiKey: canary }), /exactly one response or error/);
});

test('stdio and in-memory harnesses share stable valid and fixture-mismatch semantics', async () => {
  const client = new Client({ name: 'mock-stdio-test', version: '1.0.0' });
  const serverPath = fileURLToPath(new URL('../mock-stdio-server.mjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--preflight'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const valid = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
    assert.equal(valid.isError, undefined);
    assert.equal(valid.structuredContent.pagination.totalCount, 0);
    const mismatch = await client.callTool({ name: 'search_edunet', arguments: { query: '분수' } });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.content[0].text, 'FIXTURE_MISMATCH: No synthetic fixture matched this request.');
    assert.equal(mismatch._meta.fixtureError, 'FIXTURE_MISMATCH');
    assert.equal(mismatch._meta['edunet/errorCode'], 'FIXTURE_MISMATCH');
  } finally {
    await client.close();
  }
});
