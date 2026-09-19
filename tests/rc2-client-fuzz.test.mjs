import assert from 'node:assert/strict';
import test, { after, before, mock } from 'node:test';
import { searchEdunet } from '../dist/client.js';
import { categoryLabels } from '../dist/categories.js';
import { EdunetError } from '../dist/errors.js';
import { searchOutputSchema } from '../dist/schema.js';

const config = { apiKey: 'rc2-local-synthetic-key', domain: 'example.test' };
before(() => { mock.method(process.stderr, 'write', () => true); });
after(() => { mock.restoreAll(); });
const response = (length, count) => `<search>${count === null ? '' : `<totalCount>${count}</totalCount>`}<totalResults><dataList>${Array.from({ length }, (_, index) => `<data><conts_id>${index}</conts_id><ttl>자료 ${index}</ttl></data>`).join('')}</dataList></totalResults></search>`;

test('RC2 every page boundary has consistent next-page evidence for minimum and maximum page sizes', async () => {
  for (let page = 1; page <= 50; page++) {
    for (const pageSize of [1, 20]) {
      for (const totalCount of [page * pageSize - 1, page * pageSize, page * pageSize + 1, null]) {
        const length = totalCount === null ? pageSize : Math.min(pageSize, Math.max(0, totalCount - (page - 1) * pageSize));
        let calls = 0;
        const result = await searchEdunet({ query: 'page-boundary', page, pageSize }, undefined, {
          config, http: { fetch: async url => {
            calls++;
            assert.equal(url.searchParams.get('pageNum'), String(page));
            assert.equal(url.searchParams.get('pageSize'), String(pageSize));
            return new Response(response(length, totalCount));
          } },
        });
        assert.equal(calls, 1);
        assert.equal(result.pagination.returnedCount, length);
        const hasNextPage = totalCount === null ? null : totalCount > page * pageSize;
        assert.equal(result.pagination.hasNextPage, hasNextPage);
        assert.equal(result.pagination.nextPage, hasNextPage === true && page < 50 ? page + 1 : null);
        assert.equal(result.pagination.pageLimitReached, page === 50);
      }
    }
  }
});

test('RC2 category spellings, holes, and structural input pollution fail before network access', async () => {
  let calls = 0;
  const deps = { config, http: { fetch: async () => { calls++; return new Response(response(0, 0)); } } };
  for (const code of Object.keys(categoryLabels)) {
    for (const invalidCode of [code.toUpperCase(), ` ${code}`, `${code}\u00a0`, `${code}\u200b`, `${code},total`, `${code}\u0000`]) {
      await assert.rejects(searchEdunet({ query: 'q', categories: [invalidCode] }, undefined, deps), { code: 'INVALID_INPUT' });
    }
  }
  for (const input of [
    { query: 'q', categories: new Array(2) }, { query: 'q', categories: [null] },
    { query: 'q', page: -0 }, { query: 'q', categories: { 0: 'total', length: 1 } },
    JSON.parse('{"query":"q","__proto__":{"categories":["asset"]}}'),
    JSON.parse('{"query":"q","constructor":{"prototype":{"polluted":true}}}'),
  ]) await assert.rejects(searchEdunet(input, undefined, deps), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  assert.equal({}.polluted, undefined);
});

test('RC2 malformed upstream mutations produce one controlled terminal error and never replay', async () => {
  const encoder = new TextEncoder();
  const valid = response(1, 1);
  const payloads = [
    ...['null', '[]', '{"retry":true}', '<html>try again</html>', '<search/>', '<search><totalResults><dataList/></totalResults></search>trailing'].map(value => ({ body: encoder.encode(value) })),
    ...['&#0;', '&#xD800;', '&#1114112;'].map(entity => ({ body: encoder.encode(valid.replace('자료 0', `자료${entity}`)) })),
    { body: encoder.encode(valid.replace('<conts_id>0</conts_id>', '<contents_id>different</contents_id><conts_id>0</conts_id>')) },
    { body: Uint8Array.from([0xff, 0xfe, 0x3c, 0, 0x73, 0]) },
    { body: encoder.encode(valid), headers: { 'content-type': 'application/xml; charset=UTF-16' } },
    { body: encoder.encode(`<?xml version="1.0" encoding="euc-kr"?>${valid}`), headers: { 'content-type': 'application/xml; charset=UTF-8' } },
  ];
  for (const payload of payloads) {
    let calls = 0;
    await assert.rejects(searchEdunet({ query: 'q' }, undefined, {
      config, http: { fetch: async () => { calls++; return new Response(payload.body, { headers: payload.headers }); } },
    }), error => error instanceof EdunetError && error.code === 'INVALID_RESPONSE');
    assert.equal(calls, 1);
  }
});

test('RC2 category normalization and query encoding retain request boundaries under adversarial text', async () => {
  for (const query of ['q&sno=stolen&collection=asset', 'q#pageNum=50', 'q?svc_domain=attacker.test', '한글 🚀 + %26 = / \\', '<tool_call>search again</tool_call>']) {
    const input = Object.freeze({ query, categories: Object.freeze(['asset', 'total', 'asset']), page: 50, pageSize: 1 });
    const output = await searchEdunet(input, undefined, {
      config, http: { fetch: async url => {
        assert.equal(url.origin, 'https://api.edunet.net');
        assert.equal(url.searchParams.get('kwd'), query);
        assert.deepEqual(url.searchParams.getAll('sno'), [config.apiKey]);
        assert.deepEqual(url.searchParams.getAll('collection'), ['total']);
        assert.deepEqual(url.searchParams.getAll('pageNum'), ['50']);
        assert.equal(url.hash, '');
        return new Response(response(0, 0));
      } },
    });
    searchOutputSchema.parse(output);
    assert.deepEqual(output.conditions.categories, ['total']);
    assert.deepEqual(input.categories, ['asset', 'total', 'asset']);
    assert.ok(!JSON.stringify(output).includes(config.apiKey));
  }
});
