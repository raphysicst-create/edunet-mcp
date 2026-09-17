import { searchEdunet } from '../dist/client.js';
import { EdunetError, publicError } from '../dist/errors.js';

const xmlEscape = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function responseXml(items, totalCount = items.length) {
  const total = totalCount === null ? '' : `<totalCount>${totalCount}</totalCount>`;
  const data = items.map(item => `<data><conts_id>${xmlEscape(item.id)}</conts_id><ttl>${xmlEscape(item.title)}</ttl><cn>${xmlEscape(item.content)}</cn>${item.url ? `<conts_link>${xmlEscape(item.url)}</conts_link>` : ''}<ctgry_nm>${xmlEscape(item.category)}</ctgry_nm></data>`).join('');
  return `<search>${total}<totalResults><dataList>${data}</dataList></totalResults></search>`;
}

const normalized = value => String(value).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
const hasAlternative = (query, alternatives) => alternatives.some(value => query.includes(normalized(value)));
const canonicalCategories = categories => [...new Set(categories.includes('total') ? [] : categories)].sort();
const sameCategories = (left = [], right = []) => JSON.stringify(canonicalCategories(left)) === JSON.stringify(canonicalCategories(right));

function validateRoutes(scenario) {
  if (!Array.isArray(scenario?.mockApiResponses)) throw new TypeError('Synthetic scenario must contain mockApiResponses');
  for (const route of scenario.mockApiResponses) {
    if (!route || route.kind !== 'synthetic' || !Object.hasOwn(route, 'match') || !route.match || typeof route.match !== 'object' || Array.isArray(route.match)) {
      throw new TypeError('Synthetic fixture route requires an explicit match object');
    }
    const shapes = Number(Object.hasOwn(route, 'response')) + Number(Object.hasOwn(route, 'error'));
    if (shapes !== 1 || (route.response && (typeof route.response !== 'object' || !Array.isArray(route.response.items) || !Object.hasOwn(route.response, 'totalCount')))) {
      throw new TypeError('Synthetic fixture route requires exactly one response or error');
    }
  }
  return scenario.mockApiResponses;
}

export function routeMatches(match = {}, input) {
  const query = normalized(input.query);
  if (match.concepts?.some(group => !hasAlternative(query, group))) return false;
  if (match.missingAnyConcepts && !match.missingAnyConcepts.some(group => !hasAlternative(query, group))) return false;
  if (match.categories && !sameCategories(match.categories, input.categories)) return false;
  for (const key of ['page', 'pageSize', 'sort', 'searchType']) {
    if (match[key] !== undefined && match[key] !== input[key]) return false;
  }
  return true;
}

export class FixtureMismatchError extends Error {
  constructor(detail) {
    super('No synthetic fixture matched this request.');
    this.name = 'FixtureMismatchError';
    this.detail = detail;
  }
}

export function mockErrorFormatter(error) {
  if (error instanceof FixtureMismatchError) {
    return { code: 'FIXTURE_MISMATCH', message: error.message, meta: { fixtureError: 'FIXTURE_MISMATCH' } };
  }
  return publicError(error);
}

function fixtureMismatch(input, scenario, onFixtureError) {
  const detail = {
    code: 'FIXTURE_MISMATCH', scenarioId: scenario.id ?? null,
    request: { query: input.query, categories: input.categories, sort: input.sort, searchType: input.searchType, page: input.page, pageSize: input.pageSize },
  };
  onFixtureError?.(detail);
  throw new FixtureMismatchError(detail);
}

export function createMockSearch(scenario, { apiKey, onFixtureError } = {}) {
  if (!apiKey) throw new Error('mock apiKey required');
  const routes = validateRoutes(scenario);
  return async (input, signal) => {
    const route = routes.find(candidate => routeMatches(candidate.match, input));
    if (!route) return fixtureMismatch(input, scenario, onFixtureError);
    if (route.error) throw new EdunetError(route.error);
    const response = route.response ?? {};
    const catalog = response.items ?? [];
    const start = (input.page - 1) * input.pageSize;
    const items = catalog.slice(start, start + input.pageSize);
    return searchEdunet(input, signal, {
      config: { apiKey, domain: 'eval.invalid' },
      http: {
        maxRetries: 0,
        fetch: async () => new Response(responseXml(items, response.totalCount), {
          status: response.status ?? 200,
          headers: { 'content-type': 'application/xml; charset=UTF-8' },
        }),
      },
    });
  };
}
