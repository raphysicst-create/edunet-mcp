import assert from "node:assert/strict";
import test from "node:test";
import { EdunetError } from "../dist/errors.js";
import { parseEdunetResponse } from "../dist/response.js";

const utf8 = (value) => new TextEncoder().encode(value);
const wrap = (inner, count = "1") => utf8(`<?xml version="1.0" encoding="UTF-8"?>
  <search><totalResults><totalCount>${count}</totalCount><dataList>${inner}</dataList></totalResults>
  <conditions><responseType>success</responseType></conditions></search>`);

test("normalizes the official sample aliases and mixed highlight elements", () => {
  const parsed = parseEdunetResponse(wrap(`<data>
    <conts_id>20416</conts_id><ttl>우리 <b>무역</b> 특징</ttl><cn>본문 &lt;b&gt;강조&lt;/b&gt;</cn>
    <ctgry_nm><b>수업설계</b></ctgry_nm>
    <conts_link>https://www.edunet.net/clssStdDt/view/149/20416</conts_link>
  </data>`));
  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.encoding, "utf-8");
  assert.deepEqual(parsed.items[0], {
    id: "20416", title: "우리 무역 특징", content: "본문 강조", contentTruncated: false,
    url: "https://www.edunet.net/clssStdDt/view/149/20416", category: "수업설계",
  });
});

test("accepts documented field names, missing totalCount, and empty result lists", () => {
  const one = parseEdunetResponse(wrap("<data><contents_id>x</contents_id><category_nm>평가자료</category_nm></data>", ""));
  assert.equal(one.totalCount, null);
  assert.equal(one.items[0]?.id, "x");
  const empty = parseEdunetResponse(wrap("", "0"));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.totalCount, 0);
  const many = parseEdunetResponse(wrap("<data><ttl>a</ttl></data><data><ttl>b</ttl></data>", "2"));
  assert.deepEqual(many.items.map((item) => item.title), ["a", "b"]);
});

test("accepts the live root-level total and rejects conflicting documented total", () => {
  const xml = count => utf8(`<search><totalCount>111</totalCount><totalResults>${count}<dataList/></totalResults></search>`);
  assert.equal(parseEdunetResponse(xml("")).totalCount, 111);
  assert.equal(parseEdunetResponse(xml("<totalCount>111</totalCount>")).totalCount, 111);
  assert.throws(() => parseEdunetResponse(xml("<totalCount>3</totalCount>")), { code: "INVALID_RESPONSE" });
});

test("redacts secrets before Unicode-safe 500-character truncation", () => {
  const secret = "secret-crossing-boundary";
  const content = `${"가".repeat(495)}${secret}${"나".repeat(20)}`;
  const parsed = parseEdunetResponse(wrap(`<data><ttl>title</ttl><cn>${content}</cn></data>`), undefined, [secret]);
  assert.equal(parsed.items[0]?.content.includes("secret"), false);
  assert.equal(Array.from(parsed.items[0]?.content ?? "").length, 500);
  assert.equal(parsed.items[0]?.contentTruncated, true);
});

test("decodes EUC-KR selected by declaration and header", () => {
  const before = Buffer.from('<?xml version="1.0" encoding="EUC-KR"?><search><totalResults><dataList><data><ttl>', "ascii");
  const korean = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // 한글 in EUC-KR/CP949
  const after = Buffer.from("</ttl></data></dataList></totalResults></search>", "ascii");
  const parsed = parseEdunetResponse(Buffer.concat([before, korean, after]), new Headers({ "content-type": "application/xml; charset=euc-kr" }));
  assert.equal(parsed.encoding, "euc-kr");
  assert.equal(parsed.items[0]?.title, "한글");
});

test("rejects unsafe or unrecognized XML instead of returning empty success", () => {
  const invalid = [
    utf8("<other/>"),
    utf8("<search><totalResults/></search>"),
    utf8("<!DOCTYPE search [<!ENTITY x 'y'>]><search/>"),
    utf8("<search>"),
    wrap("<unexpected/>", "0"),
    wrap("<data><ttl>&amp;#999999999;</ttl></data>"),
    utf8("<search><totalResults><dataList/></totalResults><conditions><responseType>error</responseType></conditions></search>"),
  ];
  for (const body of invalid) {
    assert.throws(() => parseEdunetResponse(body), (error) => error instanceof EdunetError && error.code === "INVALID_RESPONSE");
  }
});

test("rejects conflicting encodings and drops unsafe API-provided links", () => {
  assert.throws(
    () => parseEdunetResponse(wrap("<data><ttl>x</ttl></data>"), new Headers({ "content-type": "application/xml; charset=euc-kr" })),
    (error) => error instanceof EdunetError && error.code === "INVALID_RESPONSE",
  );
  const parsed = parseEdunetResponse(wrap("<data><ttl>x</ttl><conts_link>javascript:alert(1)</conts_link></data>"));
  assert.equal(parsed.items[0]?.url, null);
});
