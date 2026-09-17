import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gradeTrace, scorerVersion } from '../grade.mjs';
import { regradeReport, writeRegrade } from '../subscription-regrade.mjs';
import { cases } from '../cases.mjs';

const scenario = { allowed: { coreConcepts: [['광합성', 'photosynthesis']], categories: [], exact: {}, minCalls: 1, maxCalls: 4 } };
const output = (pagination = {}, field = 'structuredContent') => ({ [field]: { items: [{ url: 'https://www.edunet.net/fixture/1' }], pagination: { page: 1, pageSize: 10, totalCount: 21, hasNextPage: true, nextPage: 2, ...pagination } } });
const call = (arguments_ = {}, result = output()) => ({ name: 'search_edunet', arguments: { query: '광합성', ...arguments_ }, result });
const run = calls => ({ calls, final: '검색 발췌입니다.' });
const failures = (calls, c = scenario) => gradeTrace(c, run(calls)).failures;
const error = code => ({ isError: true, content: [{ type: 'text', text: `${code}: synthetic error` }] });

test('next-page evidence handles both MCP transports, end-of-results, and unknown counts', () => {
  for (const field of ['structuredContent', 'structured_content']) {
    assert.deepEqual(failures([call({}, output({}, field)), call({ page: 2 })]), []);
    assert.ok(failures([call({}, output({ hasNextPage: false, nextPage: null }, field)), call({ page: 2 })]).includes('pagination_after_end'));
    assert.ok(failures([call({}, output({ hasNextPage: null, nextPage: null, totalCount: null }, field)), call({ page: 2 })]).includes('pagination_without_evidence'));
    assert.deepEqual(failures([call({}, output({ hasNextPage: null, nextPage: null, totalCount: null }, field))]), []);
  }
  assert.ok(failures([call(), call({ page: 3 })]).includes('skipped_next_page'));
  assert.ok(failures([call({ page: 2 })]).includes('pagination_without_evidence'));
});

test('concept matching agrees with fixture whitespace and compatibility normalization', () => {
  const c = { allowed: { ...scenario.allowed, coreConcepts: [['물의 상태 변화', 'photosynthesis']] } };
  assert.deepEqual(failures([call({ query: '물의  상태\n변화' })], c), []);
  assert.deepEqual(failures([call({ query: 'ＰＨＯＴＯＳＹＮＴＨＥＳＩＳ' })], c), []);
});

test('the page limit permits stopping or narrowing, not restarting identical conditions', () => {
  const c = { allowed: { ...scenario.allowed, minCalls: 0,
    requireInitialConditionChange: true,
    initialConditions: { query: '광합성', page: 50 },
    initialPagination: { hasNextPage: false, pageLimitReached: true, nextPage: null } } };
  assert.deepEqual(failures([], c), []);
  assert.ok(failures([call()], c).includes('initial_condition_change_required'));
  assert.deepEqual(failures([call({ query: '광합성 실험', page: 1 })], c), []);
  assert.deepEqual(failures([call()], { allowed: { ...c.allowed, requireInitialConditionChange: false } }), []);
});

test('a changed query, category, sort, type, or page size starts at page one', () => {
  const permissive = { allowed: { ...scenario.allowed, requireCategories: true, categories: ['evl_data'] } };
  for (const changed of [{ query: '광합성 수업' }, { categories: ['evl_data'] }, { sort: 'latest' }, { searchType: 'title' }, { pageSize: 5 }]) {
    const c = changed.categories ? permissive : scenario;
    const bad = failures([call(), call({ ...changed, page: 2 })], c);
    assert.ok(bad.includes('changed_conditions_without_page_reset'), JSON.stringify(changed));
    const good = failures([call(), call({ ...changed, page: 1 })], c);
    assert.ok(!good.includes('changed_conditions_without_page_reset'), JSON.stringify(changed));
  }
});

test('explicit categories, title search, and sort survive broadening', () => {
  const c = { allowed: { ...scenario.allowed, requireCategories: true, categories: ['evl_data'], exact: { sort: 'latest', searchType: 'title' } } };
  const initial = { query: '광합성 수업', categories: ['evl_data'], sort: 'latest', searchType: 'title' };
  const zero = { structuredContent: { items: [], pagination: { totalCount: 0, hasNextPage: false } } };
  assert.deepEqual(failures([call(initial, zero), call({ ...initial, query: '광합성' })], c), []);
  const bad = failures([call(initial, zero), call()], c);
  for (const expected of ['category_selection', 'condition_sort', 'condition_searchType']) assert.ok(bad.includes(expected));
});

test('scoped category coverage stops sufficient searches while allowing needed additional pages', () => {
  const c = { allowed: { ...scenario.allowed, categories: ['lsn_design', 'evl_data'], requireCategories: true,
    stopAfterResultCategories: ['수업설계', '평가자료'] } };
  const input = { query: '광합성', categories: ['lsn_design', 'evl_data'], pageSize: 1 };
  const first = { structuredContent: { items: [{ category: '수업설계' }], pagination: { totalCount: 2, hasNextPage: true, nextPage: 2 } } };
  const second = { structured_content: { items: [{ category: '평가자료' }], pagination: { totalCount: 2, hasNextPage: false, nextPage: null } } };
  assert.deepEqual(failures([call(input, first), call({ ...input, page: 2 }, second)], c), []);
  const both = { structuredContent: { items: [{ category: '수업설계' }, { category: '평가자료' }], pagination: { totalCount: 2, hasNextPage: false } } };
  assert.deepEqual(failures([call({ ...input, pageSize: 10 }, both)], c), []);
  assert.ok(failures([call({ ...input, pageSize: 10 }, both), call({ ...input, pageSize: 10, query: '광합성 수업' })], c).includes('search_after_sufficient_results'));
});

test('identical normalized searches and more than two query adjustments are rejected', () => {
  assert.ok(failures([call(), call({ page: 1, pageSize: 10, sort: 'relevance', searchType: 'title_summary', categories: ['total'] })]).includes('repeated_identical_search'));
  assert.deepEqual(failures([call(), call({ query: '광합성 수업' }), call({ query: '광합성 활동' })]), []);
  assert.ok(failures([call(), call({ query: '광합성 수업' }), call({ query: '광합성 활동' }), call({ query: '광합성 문제' })]).includes('query_adjustment_budget'));
});

test('terminal configuration/auth and exhausted network/timeout errors stop search retries', () => {
  for (const code of ['CONFIGURATION', 'AUTHENTICATION', 'NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_HTTP', 'INVALID_RESPONSE']) {
    assert.deepEqual(failures([call({}, error(code))]), []);
    assert.ok(failures([call({}, error(code)), call({ query: '광합성 수업' })]).includes('retry_after_terminal_error'));
  }
});

test('server error metadata preserves terminal detection when CLI omits isError without changing evidence', () => {
  for (const code of ['CONFIGURATION', 'AUTHENTICATION', 'NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_HTTP', 'ABORTED', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'UNVERIFIED_API', 'INTERNAL']) {
    const result = { _meta: { 'edunet/errorCode': code }, content: [{ type: 'text', text: '서비스 오류입니다.' }] };
    assert.deepEqual(failures([call({}, result)]), []);
    const trace = run([call({}, result), call({ query: '광합성 수업' })]);
    const before = structuredClone(trace);
    assert.deepEqual(gradeTrace(scenario, trace).failures, ['retry_after_terminal_error']);
    assert.deepEqual(trace, before);
  }
});

test('unmarked error words, unknown codes, and contradictory success metadata do not prove a terminal error', () => {
  const marker = { 'edunet/errorCode': 'TIMEOUT' };
  const candidates = [
    { content: [{ type: 'text', text: 'TIMEOUT: 오류 처리 수업자료의 검색 발췌입니다.' }] },
    { _meta: { 'edunet/errorCode': 'UNKNOWN' }, content: [{ type: 'text', text: 'TIMEOUT: unknown metadata' }] },
    { _meta: { 'edunet/errorCode': { code: 'TIMEOUT' } } },
    { structuredContent: { code: 'TIMEOUT' } },
    { isError: true, structuredContent: { code: 'UNKNOWN' } },
    { isError: false, _meta: marker },
    { is_error: false, _meta: marker },
    ...['structuredContent', 'structured_content'].flatMap(field => [
      { ...output({}, field), _meta: marker },
      { [field]: { items: [] }, _meta: marker },
      { [field]: { pagination: { totalCount: 0 } }, _meta: marker },
    ]),
  ];
  for (const result of candidates) {
    const trace = { ...run([call({}, result), call({ query: '광합성 수업' })]), assistantMessages: ['AUTHENTICATION: 오류를 설명하는 자료입니다.'] };
    assert.deepEqual(gradeTrace(scenario, trace).failures, [], JSON.stringify(result));
  }
});

test('metadata-only input and fixture errors preserve recovery and harness classification', () => {
  const inputError = { _meta: { 'edunet/errorCode': 'INVALID_INPUT' } };
  assert.deepEqual(failures([call({}, inputError), call({ query: '광합성 수업' })]), []);
  const trace = run([call({ page: 51 }, inputError), call({ page: 1 })]);
  const before = structuredClone(trace);
  assert.deepEqual(gradeTrace(scenario, trace).failures, ['invalid_arguments']);
  assert.deepEqual(trace, before);
  const fixtureError = { _meta: { 'edunet/errorCode': 'FIXTURE_MISMATCH' } };
  const graded = gradeTrace(scenario, run([call({}, fixtureError), call({ query: '광합성 수업' })]));
  assert.deepEqual(graded.failures, []);
  assert.deepEqual(graded.harnessErrors, ['fixture_mismatch']);
});

test('the explicit zero-result stop scenario permits suggestions but rejects an additional search', () => {
  const c = cases.find(value => value.id === 'ambiguous-4');
  const zero = { structuredContent: { items: [], pagination: { totalCount: 0, hasNextPage: false } } };
  const first = call({ query: '중2 과학 광합성', categories: ['evl_data'] }, zero);
  assert.deepEqual(failures([first], c), []);
  assert.deepEqual(failures([first, call({ query: '광합성', categories: ['evl_data'] })], c), ['call_count']);
});

test('core concepts always survive and initial grade/subject relax only after observed zero', () => {
  const c = { allowed: { ...scenario.allowed, initialConcepts: [['중2'], ['과학']] } };
  const initial = { query: '중2 과학 광합성' };
  for (const field of ['structuredContent', 'structured_content']) {
    const zero = { [field]: { items: [], pagination: { totalCount: 0, hasNextPage: false } } };
    assert.deepEqual(failures([call(initial, zero), call()], c), []);
    assert.ok(failures([call(initial, zero), call({ query: '수업' })], c).includes('missing_concept'));
  }
  for (const first of [output(), output({ totalCount: null }), error('NETWORK'), error('FIXTURE_MISMATCH')]) {
    assert.ok(failures([call(initial, first), call()], c).includes('missing_initial_concept'));
  }
  assert.ok(failures([call()], c).includes('missing_initial_concept'));
  const zero = { structuredContent: { items: [], pagination: { totalCount: 0, hasNextPage: false } } };
  assert.ok(failures([call(initial, zero), call({ query: '과학 광합성' }), call()], c).includes('missing_initial_concept'));
  assert.deepEqual(failures([call(initial, zero), call({ query: '과학 광합성' }, zero), call()], c), []);
});

test('invalid argument recovery preserves the original invalid call and its failure', () => {
  const trace = run([call({ page: 51, pageSize: 100, categories: ['invented'] }, error('INVALID_INPUT')), call({ page: 1, pageSize: 20 })]);
  const before = structuredClone(trace);
  assert.deepEqual(gradeTrace(scenario, trace).failures, ['invalid_arguments']);
  assert.deepEqual(trace, before);
});

test('fixture mismatches are separate harness errors, not fabricated execution failures', () => {
  const trace = { ...run([call({}, error('FIXTURE_MISMATCH'))]), error: 'adapter_or_tool_failure' };
  const grade = gradeTrace(scenario, trace);
  assert.deepEqual(grade.failures, []);
  assert.deepEqual(grade.harnessErrors, ['fixture_mismatch', 'adapter_or_tool_failure']);
});

test('retrospective scoring leaves original report and provenance untouched and refuses overwrites', () => {
  const source = { caseVersion: '1.0.0', caseHash: 'old-hash', runs: [{ id: cases[0].id, calls: [], final: 'old', automatic: { failures: ['old'], critical: [] } }] };
  const copy = structuredClone(source);
  const updated = regradeReport(source);
  assert.deepEqual(source, copy);
  assert.equal(updated.caseVersion, '1.0.0');
  assert.equal(updated.caseHash, 'old-hash');
  assert.equal(updated.regrading.scorerVersion, scorerVersion);
  assert.equal(updated.regrading.comparableToCurrentModelRun, false);
  assert.deepEqual(updated.runs[0].previousAutomatic, source.runs[0].automatic);
  const folder = mkdtempSync(join(tmpdir(), 'edunet-regrade-'));
  try {
    const path = join(folder, 'source.json');
    writeFileSync(path, JSON.stringify(source));
    const bytes = readFileSync(path);
    assert.throws(() => writeRegrade(path, path), /new output path/);
    const result = writeRegrade(path);
    assert.deepEqual(readFileSync(path), bytes);
    assert.throws(() => writeRegrade(path, result.output), /new output path/);
  } finally {
    for (const name of readdirSync(folder)) unlinkSync(join(folder, name));
    rmdirSync(folder);
  }
});
