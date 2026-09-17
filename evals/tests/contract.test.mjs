import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { searchEdunet } from '../../dist/client.js';
import { searchInputSchema } from '../../dist/schema.js';
import { mockSession, canary } from '../lib.mjs';
import { cases } from '../cases.mjs';

test('explicit synthetic error fixtures fail closed through the HTTP adapter', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/errors.json', import.meta.url), 'utf8'));
  assert.equal(fixture.kind, 'synthetic_error_fixtures');
  for (const c of fixture.cases) {
    await assert.rejects(searchEdunet(searchInputSchema.parse({ query: '광합성' }), undefined, {
      config: { apiKey: canary, domain: 'eval.invalid' }, http: { timeoutMs: 25, maxRetries: 0,
        fetch: async () => c.bodyDelay ? new Response(new ReadableStream()) : new Response(c.body, { status: c.status }) },
    }), { code: c.code }, c.id);
  }
});

test('query and category boundary values are required contract cases', () => {
  for (const query of ['가', '가'.repeat(300)]) assert.equal(searchInputSchema.safeParse({ query }).success, true);
  for (const input of [{ query: '가'.repeat(301) }, { query: 'x', categories: Array(21).fill('evl_data') }, { query: 'x', page: 0 }, { query: 'x', pageSize: 0 }]) assert.equal(searchInputSchema.safeParse(input).success, false);
  assert.equal(searchInputSchema.safeParse({ query: 'x', categories: Array(20).fill('evl_data'), page: 50, pageSize: 20 }).success, true);
});

test('MCP summary reports zero, one, multiple, next page and limit truthfully', async () => {
  for (const [total, page, size, expected] of [[0, 1, 5, /전체 0건.*다음 페이지 없음/], [1, 1, 5, /전체 1건/], [12, 1, 5, /다음 페이지 2/], [1000, 50, 5, /한도\(50\)/]]) {
    const count = Math.min(Math.max(total - (page - 1) * size, 0), size);
    const items = Array.from({ length: total }, (_, i) => ({ id: String(i), title: '광합성', content: '발췌', url: null, category: '평가자료' }));
    const scenario = { id: `summary-${total}-${page}-${size}`, mockApiResponses: [{
      kind: 'synthetic', fixtureVersion: '2.0.0', id: 'summary-route',
      match: { concepts: [['광합성']], categories: [], page, pageSize: size, sort: 'relevance', searchType: 'title_summary' },
      response: { items, totalCount: total },
    }] };
    const session = await mockSession(scenario);
    try {
      const result = await session.client.callTool({ name: 'search_edunet', arguments: { query: '광합성', page, pageSize: size } });
      assert.match(result.content[0].text, expected);
      assert.equal(result.structuredContent.pagination.returnedCount, count);
    } finally { await session.close(); }
  }
});

test('live fixtures are labeled, sanitized and do not retain auth fields', () => {
  const xml = readFileSync(new URL('../../tests/fixtures/edunet-search-live.xml', import.meta.url), 'utf8');
  const metadata = JSON.parse(readFileSync(new URL('../../tests/fixtures/edunet-search-live.json', import.meta.url), 'utf8'));
  assert.equal(metadata.kind, 'redacted_live_api_response');
  for (const value of xml.matchAll(/<(?:sno|svc_domain)>\s*([^<]*)</gi)) assert.match(value[1], /^(?:\[REDACTED\])?$/);
  assert.doesNotMatch(xml, /[?&](?:sno|api_key)=(?!\[REDACTED\])[^&<\s]+/i);
});

test('all request-conditioned mock routes traverse real MCP and secret echo stays redacted', async () => {
  for (const scenario of cases) {
    for (const route of scenario.mockApiResponses) {
      const match = route.match;
      const arguments_ = {
        query: (match.concepts ?? [['광합성']]).map(group => group[0]).join(' '),
        ...(match.categories !== undefined ? { categories: match.categories } : {}),
        ...Object.fromEntries(['page', 'pageSize', 'sort', 'searchType'].filter(key => match[key] !== undefined).map(key => [key, match[key]])),
      };
      const session = await mockSession({ ...scenario, mockApiResponses: [route] });
      try {
        const result = await session.client.callTool({ name: 'search_edunet', arguments: arguments_ });
        assert.equal(Boolean(result.isError), Boolean(route.error), `${scenario.id}/${route.id}`);
        assert.ok(!JSON.stringify(result).includes(canary));
        if (route.error) assert.match(result.content[0].text, new RegExp(route.error));
      } finally { await session.close(); }
    }
  }
});
