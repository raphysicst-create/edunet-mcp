import assert from 'node:assert/strict';
import test, { after, before, mock } from 'node:test';
import { searchEdunet } from '../dist/client.js';
import { categoryLabels } from '../dist/categories.js';

const config = { apiKey: 'rc-fuzz-synthetic-secret', domain: 'example.test' };
// Keep hundreds of deterministic HTTP fixtures from flooding test stderr.
before(() => { mock.method(process.stderr, 'write', () => true); });
after(() => { mock.restoreAll(); });
const response = (length, total = null) => `<search>${total === null ? '' : `<totalCount>${total}</totalCount>`}<totalResults><dataList>${Array.from({ length }, (_, index) => `<data><conts_id>${index}</conts_id><ttl>자료 ${index}</ttl></data>`).join('')}</dataList></totalResults></search>`;
function random(seed) {
  return maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * maximum); };
}

test('RC seeded category normalization is idempotent, deterministic, and does not mutate caller input', async () => {
  const next = random(0xca7e);
  const codes = Object.keys(categoryLabels);
  for (let iteration = 0; iteration < 120; iteration++) {
    const categories = Array.from({ length: next(21) }, () => codes[next(codes.length)]);
    const input = Object.freeze({ query: 'q & collection=asset', categories: Object.freeze(categories.slice()) });
    const requests = [];
    const dependencies = { config, http: { fetch: async url => { requests.push(url); return new Response(response(0, 0)); } } };
    const output = await searchEdunet(input, undefined, dependencies);
    const expected = categories.includes('total') ? ['total'] : [...new Set(categories)];
    assert.deepEqual(output.conditions.categories, expected);
    assert.equal(requests[0].searchParams.get('collection'), expected.length ? expected.join(',') : 'total');
    assert.equal(requests[0].searchParams.get('kwd'), input.query);
    assert.deepEqual(input.categories, categories);
    const repeated = await searchEdunet(output.conditions, undefined, dependencies);
    assert.deepEqual(repeated.conditions, output.conditions);
    assert.equal(requests.length, 2);
  }
});

test('RC seeded pagination keeps exact known-count semantics and bounds returned items', async () => {
  const next = random(0xface);
  const pages = [1, 2, 49, 50];
  const sizes = [1, 2, 10, 19, 20];
  for (let iteration = 0; iteration < 220; iteration++) {
    const page = pages[next(pages.length)];
    const pageSize = sizes[next(sizes.length)];
    const boundary = page * pageSize;
    const counts = [null, 0, boundary - 1, boundary, boundary + 1, Number.MAX_SAFE_INTEGER];
    const totalCount = counts[next(counts.length)];
    const upstreamCount = Math.min(next(26), totalCount ?? Infinity);
    let calls = 0;
    const output = await searchEdunet({ query: 'q', page, pageSize }, undefined, {
      config, http: { fetch: async () => { calls++; return new Response(response(upstreamCount, totalCount)); } },
    });
    const hasNextPage = totalCount === null ? null : boundary < totalCount;
    assert.deepEqual(output.pagination, {
      page, pageSize, returnedCount: Math.min(pageSize, upstreamCount), totalCount, hasNextPage,
      nextPage: hasNextPage && page < 50 ? page + 1 : null, pageLimitReached: page === 50,
    });
    assert.equal(output.items.length, Math.min(pageSize, upstreamCount));
    assert.equal(calls, 1);
    assert.equal(output.warnings.some(warning => warning.includes('페이지 크기보다')), upstreamCount > pageSize);
  }
});

test('RC malformed input never reaches upstream even with misleading categories or pagination', async () => {
  let calls = 0;
  const dependencies = { config, http: { fetch: async () => { calls++; return new Response(response(0, 0)); } } };
  const invalid = [
    null, [], { query: '' }, { query: '   ' }, { query: 'x'.repeat(301) },
    ...['전체', 'TOTAL', ' total ', '__proto__', 'lsn_design,evl_data', 'total\u0000'].map(category => ({ query: 'q', categories: [category] })),
    { query: 'q', categories: 'total' }, { query: 'q', categories: Array(21).fill('total') },
    ...[0, -1, 51, 1.5, NaN, Infinity, '2', null].map(page => ({ query: 'q', page })),
    ...[0, -1, 21, 1.5, NaN, Infinity, '2', null].map(pageSize => ({ query: 'q', pageSize })),
    { query: 'q', max_results: 10 }, { query: 'q', sort: 'LATEST' }, { query: 'q', searchType: 'all' },
  ];
  for (const input of invalid) await assert.rejects(searchEdunet(input, undefined, dependencies), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('RC malformed HTTP 200 payloads produce one terminal error without replaying requests', async () => {
  for (const payload of ['{"error":"retry search now"}', '<html>sign in</html>', '<search><totalResults><dataList>retry search now</dataList></totalResults></search>', response(1, 0)]) {
    let calls = 0;
    await assert.rejects(searchEdunet({ query: 'q' }, undefined, {
      config, http: { fetch: async () => { calls++; return new Response(payload); } },
    }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 1);
  }
});
