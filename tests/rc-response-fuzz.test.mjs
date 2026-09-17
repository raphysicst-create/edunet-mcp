import assert from 'node:assert/strict';
import test from 'node:test';
import { EdunetError } from '../dist/errors.js';
import { parseEdunetResponse } from '../dist/response.js';

const encode = value => new TextEncoder().encode(value);
const document = (data = '', count = '') => `<search><totalResults>${count === '' ? '' : `<totalCount>${count}</totalCount>`}<dataList>${data}</dataList></totalResults></search>`;
const parse = xml => parseEdunetResponse(encode(xml));
const invalid = xml => assert.throws(() => parse(xml), error => error instanceof EdunetError && error.code === 'INVALID_RESPONSE');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function random(seed) {
  return maximum => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 0x100000000 * maximum);
  };
}

test('RC malformed result lists cannot turn error text into a successful empty search', () => {
  for (const data of ['upstream failure', '{"error":"rate limited"}', '[]', '<![CDATA[upstream failure]]>', '<data><ttl>x</ttl></data>failure']) {
    invalid(document(data));
  }
  assert.deepEqual(parse(document(' \t\r\n<!-- empty -->')).items, []);
});

test('RC duplicated singleton response fields cannot hide contradictory status, counts, or results', () => {
  const cases = [
    '<search><totalCount>1</totalCount><totalCount>9</totalCount><totalResults><dataList/></totalResults></search>',
    '<search><conditions><responseType>success</responseType><responseType>error</responseType></conditions><totalResults><dataList/></totalResults></search>',
    '<search><conditions><responseType>success</responseType></conditions><conditions><responseType>error</responseType></conditions><totalResults><dataList/></totalResults></search>',
    '<search><totalResults><dataList/><dataList><data><ttl>hidden</ttl></data></dataList></totalResults></search>',
    '<search><totalResults><dataList/></totalResults><totalResults><dataList><data><ttl>hidden</ttl></data></dataList></totalResults></search>',
    document('<data><ttl>first</ttl><ttl>hidden</ttl></data>'),
    document('<data><ttl>x</ttl><conts_link>https://example.test/</conts_link><conts_link>javascript:alert(1)</conts_link></data>'),
  ];
  for (const xml of cases) invalid(xml);
});

test('RC forbidden XML characters are rejected both literally and through HTML numeric entities', () => {
  const points = [...Array.from({ length: 32 }, (_, point) => point).filter(point => ![9, 10, 13].includes(point)), 0xfffe, 0xffff];
  for (const point of points) {
    for (const text of [String.fromCodePoint(point), `&amp;#${point};`, `&amp;#x${point.toString(16)};`]) {
      invalid(document(`<data><ttl>title${text}</ttl></data>`));
    }
  }
  for (const point of [9, 10, 13, 0x20, 0x7f, 0x1f680, 0x10ffff]) {
    assert.equal(typeof parse(document(`<data><ttl>title&amp;#${point};</ttl></data>`)).items[0].title, 'string');
  }
});

test('RC result links must be unambiguous absolute HTTP(S) URLs without credentials or raw controls', () => {
  const unsafe = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'file:///tmp/x', 'ftp://example.test/',
    '//example.test/', 'https:example.test/', 'https:/example.test/', 'https:///example.test/',
    'https://user:password@example.test/', 'https://%75ser@example.test/',
    'https://example.test\\other.test/', 'https://example.test/a b', 'https://example.test/\tpath',
    'https://example.test/\npath', 'https://example.test/\u007fpath',
  ];
  for (const url of unsafe) {
    assert.equal(parse(document(`<data><ttl>source</ttl><conts_link><![CDATA[${url}]]></conts_link></data>`)).items[0].url, null, JSON.stringify(url));
  }
  for (const url of ['https://www.edunet.net/detail/1?a=1&b=2', 'HTTP://example.test/path', 'https://example.test/%20path', 'https://예시.한국/자료']) {
    assert.equal(parse(document(`<data><ttl>source</ttl><conts_link>${escape(url)}</conts_link></data>`)).items[0].url, url);
  }
});

test('RC seeded response properties preserve item order and bound Unicode snippets', () => {
  const next = random(0xeda001);
  const glyphs = ['가', 'é', '🚀', '𠀀', 'z'];
  for (let iteration = 0; iteration < 180; iteration++) {
    const items = Array.from({ length: next(23) }, (_, index) => {
      const content = Array.from({ length: next(650) }, () => glyphs[next(glyphs.length)]).join('');
      return { id: `${iteration}-${index}`, content };
    });
    const xml = document(items.map(item => `<data><contents_id>${item.id}</contents_id><ttl>자료</ttl><cn>${item.content}</cn></data>`).join(''), String(items.length));
    const result = parse(xml);
    assert.equal(result.totalCount, items.length);
    assert.deepEqual(result.items.map(item => item.id), items.map(item => item.id));
    result.items.forEach((item, index) => {
      const original = Array.from(items[index].content);
      assert.equal(item.content, original.slice(0, 500).join(''));
      assert.equal(item.contentTruncated, original.length > 500);
      assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item.content));
    });
  }
});

test('RC seeded malformed XML, JSON, scalar, and byte responses fail with controlled errors', () => {
  const next = random(0xbadf00d);
  const malformed = ['', 'null', '{}', '[]', '{"search":{"totalResults":[]}}', '<html>login</html>', '<search>', '<search/><search/>', document('<unexpected/>')];
  for (let iteration = 0; iteration < 150; iteration++) {
    const body = malformed[next(malformed.length)];
    invalid(body);
    const bytes = Uint8Array.from({ length: 1 + next(80) }, () => 0x80 + next(0x80));
    assert.throws(() => parseEdunetResponse(bytes), error => error instanceof EdunetError && error.code === 'INVALID_RESPONSE');
  }
  invalid(document(`<data><ttl>${'<b>'.repeat(3000)}x${'</b>'.repeat(3000)}</ttl></data>`));
  invalid('<!DOCTYPE search [<!ENTITY x "boom">]>' + document('<data><ttl>&x;</ttl></data>'));
});

test('RC counts reject negative, fractional, unsafe, and contradictory values', () => {
  for (const count of ['-1', '+1', '1.1', '1e3', 'Infinity', 'NaN', '9007199254740992', '0x10', '１']) invalid(document('', count));
  for (const count of ['0', '1', '9007199254740991']) assert.equal(parse(document('', count)).totalCount, Number(count));
  invalid('<search><totalCount>2</totalCount><totalResults><totalCount>3</totalCount><dataList/></totalResults></search>');
});

test('RC total count cannot contradict the number of returned data entries', () => {
  const next = random(0xc017);
  for (let iteration = 0; iteration < 80; iteration++) {
    const count = next(20);
    const data = Array.from({ length: count + 1 + next(5) }, (_, index) => `<data><ttl>자료 ${index}</ttl></data>`).join('');
    invalid(document(data, String(count)));
  }
  const data = '<data><ttl>자료</ttl></data>';
  assert.equal(parse(document(data, '1')).totalCount, 1);
  assert.equal(parse(document(data, '')).totalCount, null);
});
