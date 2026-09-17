import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchUrl, searchEdunet } from "../dist/client.js";
import { searchInputSchema } from "../dist/schema.js";

// Synthetic responses based on the official v4.5 manual, NOT live API fixtures.
const config = { apiKey: "test-only-secret", domain: "example.test" };
function response(data, total = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><search><totalResults>${total === "" ? "" : `<totalCount>${total}</totalCount>`}<dataList>${data}</dataList></totalResults></search>`;
}
function deps(xml) { return { config, http: { fetch: async () => new Response(xml, { headers: { "content-type": "application/xml; charset=UTF-8" } }) } }; }

test("official request mapping preserves Korean, punctuation and multiple categories", () => {
  const input = searchInputSchema.parse({ query: "중2 광합성 & 빛+물", categories: ["evl_data", "lsn_design"], sort: "latest", searchType: "title", page: 2 });
  const url = buildSearchUrl(input, config);
  assert.equal(url.origin + url.pathname, "https://api.edunet.net/search/searchApi/search");
  assert.equal(url.searchParams.get("kwd"), input.query);
  assert.equal(url.searchParams.get("collection"), "evl_data,lsn_design");
  assert.equal(url.searchParams.get("sno"), config.apiKey);
  assert.equal(url.searchParams.get("svc_domain"), config.domain);
  assert.equal(url.searchParams.get("svc_version"), "4.5");
  assert.equal(url.searchParams.get("sort"), "d");
  assert.equal(url.searchParams.get("searchType"), "title");
  assert.equal(url.searchParams.get("pageNum"), "2");
});

test("unknown count never invents next page, content is bounded and secret echoes removed", async () => {
  const xml = response(`<data><conts_id>0001</conts_id><ttl><![CDATA[<b>광합성</b>]]></ttl><cn><![CDATA[${"가".repeat(510)}]]></cn><conts_link>https://www.edunet.net/detail?sno=${config.apiKey}</conts_link><ctgry_nm>평가자료</ctgry_nm></data>`);
  const result = await searchEdunet(searchInputSchema.parse({ query: "광합성" }), undefined, deps(xml));
  assert.equal(result.items[0].id, "0001");
  assert.equal(result.items[0].title, "광합성");
  assert.equal(Array.from(result.items[0].content).length, 500);
  assert.equal(result.items[0].contentTruncated, true);
  assert.equal(result.items[0].url, null);
  assert(result.warnings.some(warning => warning.includes('출처 URL 미제공')));
  assert.equal(result.pagination.totalCount, null);
  assert.equal(result.pagination.hasNextPage, null);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret/);
});

test("known pagination respects tool page limit and empty results", async () => {
  const input = searchInputSchema.parse({ query: "q", page: 50, pageSize: 10 });
  const result = await searchEdunet(input, undefined, deps(response("", 1000)));
  assert.equal(result.pagination.hasNextPage, true);
  assert.equal(result.pagination.nextPage, null);
  assert.equal(result.pagination.pageLimitReached, true);
  const empty = await searchEdunet(searchInputSchema.parse({ query: "q" }), undefined, deps(response("", 0)));
  assert.equal(empty.items.length, 0);
  assert.equal(empty.pagination.hasNextPage, false);
  assert(!empty.warnings.some(warning => warning.includes('출처 URL 미제공')));
});

test("missing-source warnings follow only displayed items without creating replacement URLs", async () => {
  const linked = '<data><ttl>링크 있는 자료</ttl><conts_link>https://www.edunet.net/detail/1</conts_link></data>';
  const missing = '<data><ttl>링크 없는 자료</ttl></data>';
  const scenarios = [
    { data: linked, pageSize: 10, urls: ['https://www.edunet.net/detail/1'], missing: false },
    { data: missing, pageSize: 10, urls: [null], missing: true },
    { data: linked + missing, pageSize: 10, urls: ['https://www.edunet.net/detail/1', null], missing: true },
    { data: linked + missing, pageSize: 1, urls: ['https://www.edunet.net/detail/1'], missing: false },
  ];
  for (const scenario of scenarios) {
    const result = await searchEdunet(searchInputSchema.parse({ query: '광합성', pageSize: scenario.pageSize }), undefined, deps(response(scenario.data, 2)));
    assert.deepEqual(result.items.map(item => item.url), scenario.urls);
    assert.equal(result.warnings.some(warning => warning.includes('출처 URL 미제공')), scenario.missing);
  }
});

test("redaction happens before snippet clipping and includes echoed conditions", async () => {
  const xml = response(`<data><ttl>${config.apiKey}</ttl><cn>${"나".repeat(494)}${config.apiKey}후속</cn></data>`, 1);
  const result = await searchEdunet(searchInputSchema.parse({ query: config.apiKey }), undefined, deps(xml));
  assert.equal(result.conditions.query, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret|test-o/);
  assert.equal(result.items[0].contentTruncated, true);
});

test("total overrides category combinations, malformed XML fails closed", async () => {
  let requested;
  await searchEdunet(searchInputSchema.parse({ query: "q", categories: ["evl_data", "total"] }), undefined, {
    config, http: { fetch: async url => { requested = url; return new Response(response("", 0)); } },
  });
  assert.equal(requested.searchParams.get("collection"), "total");
  await assert.rejects(searchEdunet(searchInputSchema.parse({ query: "q" }), undefined, deps("<html>login</html>")), { code: "INVALID_RESPONSE" });
});
