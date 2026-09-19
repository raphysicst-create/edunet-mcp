import assert from 'node:assert/strict';
import test from 'node:test';
import { EdunetError } from '../dist/errors.js';
import { parseEdunetResponse } from '../dist/response.js';

const encode = value => new TextEncoder().encode(value);
const wrap = data => `<search><totalResults><dataList><data><ttl>자료</ttl>${data}</data></dataList></totalResults></search>`;
const parse = xml => parseEdunetResponse(encode(xml));
const invalid = xml => assert.throws(() => parse(xml), error => error instanceof EdunetError && error.code === 'INVALID_RESPONSE');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function random(seed) {
  return maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * maximum); };
}

test('RC2 direct forbidden numeric entities cannot be silently erased by the XML parser', () => {
  const next = random(0xe1717);
  const points = [...Array.from({ length: 32 }, (_, point) => point).filter(point => ![9, 10, 13].includes(point)), 0xfffe, 0xffff, 0x110000];
  for (let index = 0; index < 120; index++) points.push(0xd800 + next(0x800));
  for (const point of points) {
    for (const entity of [`&#${point};`, `&#x${point.toString(16)};`]) {
      for (const field of ['cn', 'ignored']) invalid(wrap(`<${field}>prefix${entity}suffix</${field}>`));
    }
  }
  for (const point of [9, 10, 13, 32, 0xd7ff, 0xe000, 0x1f680, 0x10ffff]) {
    assert.equal(typeof parse(wrap(`<cn>prefix&#${point};suffix</cn>`)).items[0].content, 'string');
  }
  for (const entity of ['&#;', '&#x;', '&#xZZ;', '&#-1;', '&#12', '&#x12']) invalid(wrap(`<cn>prefix${entity}suffix</cn>`));
  assert.equal(parse(wrap('<!-- &#0; &#; -->')).items[0].title, '자료');
  assert.equal(parse(wrap('<cn><![CDATA[literal &#; and &#x;]]></cn>')).items[0].content, 'literal &#; and &#x;');
  assert.equal(parse(wrap('<ignored><![CDATA[&#0;]]></ignored>')).items[0].title, '자료');
});

test('RC2 documented aliases cannot conceal conflicting or duplicated fallback fields', () => {
  const next = random(0xa11a5);
  for (const [primary, alias, output] of [['contents_id', 'conts_id', 'id'], ['category_nm', 'ctgry_nm', 'category']]) {
    for (let index = 0; index < 90; index++) {
      const value = `자료${next(10000)}`;
      const primaryField = `<${primary}>${value}</${primary}>`;
      const aliasField = `<${alias}>${value}</${alias}>`;
      for (const pair of [primaryField + aliasField, aliasField + primaryField]) assert.equal(parse(wrap(pair)).items[0][output], value);
      invalid(wrap(primaryField + `<${alias}>conflict-${value}</${alias}>`));
      invalid(wrap(aliasField + `<${primary}>conflict-${value}</${primary}>`));
      invalid(wrap(primaryField + aliasField + aliasField));
    }
  }
});

test('RC2 unsafe source URLs cannot become valid through text trimming or markup removal', () => {
  const url = 'https://example.test/material';
  const whitespace = [' ', '\t', '\r', '\n', '\u00a0', '\u2028', '\ufeff'];
  for (const value of whitespace.flatMap(space => [space + url, url + space, space + url + space])) {
    assert.equal(parse(wrap(`<conts_link><![CDATA[${value}]]></conts_link>`)).items[0].url, null, JSON.stringify(value));
  }
  for (const value of ['https://<b>example</b>.test/', '<b>https://example.test/</b>', 'https://example.test/<b>path</b>']) {
    for (const body of [value, escape(value), `<![CDATA[${value}]]>`]) {
      assert.equal(parse(wrap(`<conts_link>${body}</conts_link>`)).items[0].url, null, body);
    }
  }
  for (const value of ['https://example.test/material?a=1&b=2', 'HTTPS://예시.한국/자료', 'https://example.test/%20material']) {
    assert.equal(parse(wrap(`<conts_link>${escape(value)}</conts_link>`)).items[0].url, value);
  }
});
