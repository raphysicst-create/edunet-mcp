import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { EdunetError } from '../dist/errors.js';

function result(conditions, totalCount = 1, returnedCount = 1) {
  const hasNextPage = totalCount === null ? null : conditions.page * conditions.pageSize < totalCount;
  return {
    conditions, items: returnedCount ? [{ id: '1', title: '광합성', content: '합성 발췌', contentTruncated: false, url: null, category: '평가자료' }] : [],
    pagination: { page: conditions.page, pageSize: conditions.pageSize, returnedCount, totalCount, hasNextPage, nextPage: hasNextPage && conditions.page < 50 ? conditions.page + 1 : null, pageLimitReached: conditions.page === 50 },
    source: 'EDUNET_SEARCH_API', originalRead: false, attachmentsRead: false, integrationStatus: 'live_verified', warnings: [],
  };
}
async function session(search, check, options) {
  const server = createServer(search, options);
  const client = new Client({ name: 'guidance-regression', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a); await check(client);
  } finally { await client.close(); await server.close(); }
}

test('MCP exposes limits and repair examples while retaining machine-readable constraints', async () => {
  await session(async input => result(input), async client => {
    const { tools: [tool] } = await client.listTools();
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['categories', 'page', 'pageSize', 'query', 'searchType', 'sort']);
    assert.equal(tool.inputSchema.properties.pageSize.maximum, 20);
    assert.equal(tool.inputSchema.properties.page.maximum, 50);
    for (const code of ['evl_data', 'lsn_design', 'edntpd', 'asset']) assert(tool.inputSchema.properties.categories.items.enum.includes(code));
    assert.deepEqual(tool.inputSchema.properties.searchType.enum, ['title_summary', 'title']);
    assert.match(tool.inputSchema.properties.categories.description, /자료·수업자료.*전체 검색/);
    assert.match(tool.inputSchema.properties.categories.description, /사진·영상="edntpd".*제작 소재="asset"/);
    assert.match(tool.outputSchema.properties.items.items.properties.url.description, /출처 URL 미제공/);
    assert.match(tool.description, /pageSize 최대 20/);
    assert.match(tool.description, /"categories":\["evl_data"\]/);
    assert.match(tool.description, /사진·영상="edntpd".*제작 소재="asset"/);
    assert.match(client.getInstructions(), /자동 검색어 수정은 최대 2회/);
    assert.match(client.getInstructions(), /명시한 카테고리·정렬·제목 검색/);
  });
});

test('SDK input rejection gives actionable repairs, leaks no input, and never calls the backend', async () => {
  let calls = 0;
  await session(async input => { calls++; return result(input); }, async client => {
    const secret = 'synthetic-private-input+/=';
    const invalid = [
      [{ pageSize: 100 }, /pageSize: 20/],
      [{ pageSize: '20' }, /1~20의 정수/],
      [{ max_results: 10 }, /max_results는 제거하고 pageSize/],
      [{ categories: ['평가자료'] }, /평가자료="evl_data"/],
      [{ categories: 'evl_data' }, /코드의 배열/],
      [{ page: 51 }, /page: 1/],
      [{ page: 1.5 }, /1~50의 정수/],
      [{ sort: secret }, /"relevance".*"latest"/],
      [{ searchType: secret }, /"title_summary".*"title"/],
      [{ query: '' }, /1~300자/],
      [{ query: secret.repeat(30) }, /1~300자/],
      [{ [secret]: true }, /학년·과목은 query/],
      [{ categories: [secret] }, /카테고리 코드/],
    ];
    for (const [override, hint] of invalid) {
      const output = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성', ...override } });
      assert.equal(output.isError, true);
      assert.match(output.content[0].text, /INVALID_INPUT/);
      assert.match(output.content[0].text, hint);
      assert(!JSON.stringify(output).includes(secret));
      assert.doesNotMatch(JSON.stringify(output), /node_modules|\.js:\d+:\d+|"stack"/);
    }
    assert.equal(calls, 0);
    const fixed = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성', categories: ['evl_data'], page: 1, pageSize: 20 } });
    assert.equal(fixed.isError, undefined);
    assert.equal(fixed.structuredContent.conditions.pageSize, 20);
    assert.equal(calls, 1);
  });
});

test('result guidance distinguishes zero, terminal page, unknown total, and an empty later page', async () => {
  const scenarios = [
    { total: 0, returned: 0, query: '중2 과학 광합성', expect: /핵심 주제와 명시한 필터를 유지.*자동 수정 최대 2회/ },
    { total: 1, returned: 1, expect: /다음 페이지 없음.*이후 페이지를 호출하지 마세요/ },
    { total: null, returned: 1, expect: /존재 여부 미확인.*자동 페이지 이동을 멈추세요/ },
    { total: 5, returned: 0, page: 2, expect: /현재 페이지에 반환된 자료가 없습니다/ },
    { total: 600, returned: 1, page: 50, expect: /한도\(50\).*이후 페이지를 호출하지 마세요/ },
  ];
  for (const s of scenarios) {
    await session(async input => result(input, s.total, s.returned), async client => {
      const output = await client.callTool({ name: 'search_edunet', arguments: { query: s.query ?? '광합성', page: s.page ?? 1 } });
      assert.match(output.content[0].text, s.expect);
      assert.equal(output.structuredContent.pagination.totalCount, s.total);
      if (s.total === 0) assert.match(output.content[0].text, /제안만 요청.*추가 검색을 금지.*재검색 없이.*우선/);
      if (s.total !== 0) assert.doesNotMatch(output.content[0].text, /부가 검색어를 줄여/);
      assert.equal(output.structuredContent.originalRead, false);
      assert.equal(output.structuredContent.attachmentsRead, false);
    });
  }
});

test('MCP annotates only returned items without source URLs and leaves their titles and URLs intact', async () => {
  for (const urls of [[], [null], ['https://www.edunet.net/detail/1'], [null, 'https://www.edunet.net/detail/2']]) {
    await session(async input => ({
      ...result(input, urls.length, urls.length),
      items: urls.map((url, index) => ({ id: String(index), title: `자료 ${index}`, content: '발췌', contentTruncated: false, url, category: null })),
    }), async client => {
      const output = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
      assert.deepEqual(output.structuredContent.items.map(item => item.url), urls);
      assert.deepEqual(output.structuredContent.items.map(item => item.title), urls.map((_, index) => `자료 ${index}`));
      if (urls.includes(null)) {
        assert.match(output.content[0].text, /일반 텍스트.*출처 URL 미제공.*대신 연결하지/);
      } else {
        assert.doesNotMatch(output.content[0].text, /출처 URL 미제공/);
      }
    });
  }
});

test('MCP terminal failures preserve typed error metadata and instruct stopping identical and changed automatic calls', async () => {
  for (const code of ['CONFIGURATION', 'AUTHENTICATION', 'NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_HTTP', 'ABORTED', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'UNVERIFIED_API', 'INTERNAL']) {
    await session(async () => { throw new EdunetError(code); }, async client => {
      const output = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
      assert.equal(output.isError, true);
      assert.equal(output._meta['edunet/errorCode'], code);
      assert.match(output.content[0].text, new RegExp(code));
      assert.match(output.content[0].text, /동일·변경 입력.*이번 요청의 자동 재호출을 중단/);
      if (['CONFIGURATION', 'AUTHENTICATION'].includes(code)) assert.match(output.content[0].text, /키를 대화에 붙여넣으라고 요구하지 마세요/);
    });
  }
});

test('handler error metadata preserves trusted fixture fields without overriding the public error code', async () => {
  await session(async () => { throw new Error('synthetic-private-error'); }, async client => {
    const output = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
    assert.equal(output.isError, true);
    assert.deepEqual(output._meta, { 'edunet/errorCode': 'INTERNAL', 'edunet/fixtureMismatch': true });
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private-error|wrong-code/);
  }, { errorFormatter: () => ({ code: 'INTERNAL', message: '합성 오류', meta: { 'edunet/fixtureMismatch': true, 'edunet/errorCode': 'wrong-code' } }) });
});

test('terminal guidance does not lock the MCP session against a later user request', async () => {
  let calls = 0;
  await session(async input => {
    if (++calls === 1) throw new Error('synthetic-private-error');
    return result(input);
  }, async client => {
    const failed = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
    assert.equal(failed._meta['edunet/errorCode'], 'INTERNAL');
    assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-error|Error:|node_modules|\.js:\d+:\d+|"stack"/);
    const later = await client.callTool({ name: 'search_edunet', arguments: { query: '광합성' } });
    assert.equal(later.isError, undefined);
    assert.equal(later.structuredContent.items.length, 1);
    assert.equal(calls, 2);
  });
});
