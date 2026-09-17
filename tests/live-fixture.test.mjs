import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEdunetResponse } from "../dist/response.js";

test("redacted real EDUNET response reads totalCount beside totalResults", () => {
  const body = readFileSync(new URL("./fixtures/edunet-search-live.xml", import.meta.url));
  const metadata = JSON.parse(readFileSync(new URL("./fixtures/edunet-search-live.json", import.meta.url), "utf8"));
  assert.equal(metadata.kind, "redacted_live_api_response");
  const result = parseEdunetResponse(body, new Headers({ "content-type": "application/xml;charset=UTF-8" }));
  assert.equal(result.items.length, metadata.returnedCount);
  assert.equal(result.items.length, 3);
  assert.equal(result.totalCount, 111);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.items[0].title, "광합성");
  assert.ok(result.items.every(item => item.id && item.category && item.url?.startsWith("https://www.edunet.net/")));
  assert.ok(result.items.every(item => Array.from(item.content).length <= 500));
});
