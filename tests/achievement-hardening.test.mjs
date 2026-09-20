import test from "node:test";
import assert from "node:assert/strict";
import { ReferenceCodec } from "../dist/achievement/references.js";
import { createAchievementReader } from "../dist/achievement/read-service.js";

const secret = "hardening-only-reference-secret-at-least-32-bytes";
const config = {
  searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: true, hwpxReadEnabled: false,
  autoAttachmentSelectionEnabled: false, resourceReadEnabled: true, referenceSecret: secret,
};
const resource = { id: "123", title: "중학교 과학 성취수준", sourceUrl: "https://www.edunet.net/clssStdDt/view/150/123", snippet: "검색 발췌" };
const file = { id: "789", fileName: "교사용.pdf", format: "pdf", url: "https://api.edunet.net/main/fileRsc/downloadFile/789" };
const hash = "sha256:document-content";
const evidence = (quote) => [{ quote, location: { page: 1, table: 1, row: 2, column: 3 }, sourceHash: hash }];
const record = () => ({
  id: "record-1", achievementLevel: { rawLabel: "상", labelSystem: "상중하", evidence: evidence("상") },
  description: { raw: "실험 결과를 설명한다.", evidence: evidence("실험 결과를 설명한다.") },
  evidence: evidence("실험 결과를 설명한다."), extraction: { method: "table", confidence: "high" },
});

function setup({ details, mutateResult } = {}) {
  const references = new ReferenceCodec(secret);
  let workerCalls = 0;
  const achievementRef = references.issue("achievement", { resource });
  const attachmentRef = references.issue("attachment", { resourceId: `${resource.id}|${resource.sourceUrl}`, attachmentId: file.id });
  const read = createAchievementReader({
    references, config,
    resolveResource: async () => details ?? { resource, attachments: [file], warnings: [] },
    gateway: { run: async (handle) => {
      workerCalls++;
      const job = references.verify(handle, "worker");
      const result = {
        status: "verified_extraction", records: [record()], contentHash: hash,
        rawBlocks: [{ text: "실험 결과를 설명한다.", kind: "paragraph", location: { page: 1, block: 1 } }],
        attachment: { attachmentRef: job.attachmentRef, fileName: file.fileName, format: file.format, downloadStatus: "downloaded", parserName: "fixture", parserVersion: "1" },
        documentExtractionComplete: true, visualContentInterpreted: false, warnings: [],
      };
      mutateResult?.(result);
      return result;
    } },
  });
  return { read, references, args: { achievementRef, attachmentRef }, workerCalls: () => workerCalls };
}

test("metadata failure remains source_unavailable with and without a selected attachment", async () => {
  for (const code of ["attachment_metadata_unavailable", "attachment_metadata_timeout", "detail_path_unverified"]) {
    const s = setup({ details: { resource, attachments: [], warnings: [{ code, message: "상세 정보를 확인하지 못했습니다." }] } });
    for (const args of [s.args, { achievementRef: s.args.achievementRef }]) {
      const response = await s.read(args);
      assert.equal(response.status, "source_unavailable", code);
      assert.equal(response.source.sourceUrl, resource.sourceUrl);
      assert.equal(response.source.searchEvidence[0].quote, resource.snippet);
      assert.equal(response.warnings.some((warning) => warning.code === "CANDIDATE_FOUND_NO_ATTACHMENT"), false);
      assert.equal(s.workerCalls(), 0);
    }
  }
});

test("verified empty attachment metadata is distinct from unavailable metadata", async () => {
  const s = setup({ details: { resource, attachments: [], warnings: [{ code: "candidate_found_no_attachment", message: "확인한 첨부가 없습니다." }] } });
  const response = await s.read({ achievementRef: s.args.achievementRef });
  assert.equal(response.status, "metadata_only");
  assert.equal(response.attachments.length, 0);
  assert.equal(s.workerCalls(), 0);
});

test("no-text results retain download provenance and OCR limits without claiming successful extraction", async () => {
  const s = setup({ mutateResult: (result) => {
    result.status = "no_text";
    result.records = [];
    result.rawBlocks = [];
    result.documentExtractionComplete = false;
    result.warnings = [{ code: "OCR_REQUIRED", message: "스캔 문서는 지원하지 않습니다." }];
  } });
  const response = await s.read(s.args);
  assert.equal(response.status, "no_text");
  assert.equal(response.attachment.downloadStatus, "downloaded");
  assert.equal(response.source.contentHash, hash);
  assert.equal(response.documentExtractionComplete, false);
  assert.equal(response.visualContentInterpreted, false);
  assert.deepEqual(response.records, []);
  assert.equal(response.warnings.some((warning) => warning.code === "OCR_REQUIRED"), true);
  assert.equal(response.pagination.hasMore, false);
});

test("the read boundary rejects worker attachment or source-hash provenance mismatches", async () => {
  for (const mutateResult of [
    (result) => { result.attachment.attachmentRef = "another-attachment-reference"; },
    (result) => { result.attachment.fileName = "다른 문서.pdf"; },
    (result) => { result.attachment.format = "hwp"; },
    (result) => { result.records[0].evidence[0].sourceHash = "sha256:other-document"; },
    (result) => { result.records[0].description.evidence[0].sourceHash = "sha256:other-document"; },
  ]) {
    const s = setup({ mutateResult });
    const response = await s.read(s.args);
    assert.equal(response.status, "worker_unavailable");
    assert.equal(response.warnings.some((warning) => warning.code === "WORKER_INVALID_RESPONSE"), true);
    assert.equal(response.source.sourceUrl, resource.sourceUrl);
    assert.deepEqual(response.records, []);
  }
});

test("records beyond the hard output bound yield an explicit warning and raw evidence fallback", async () => {
  const s = setup({ mutateResult: (result) => {
    const oversized = "성취 설명 ".repeat(2500);
    result.records[0].description = { raw: oversized, evidence: evidence(oversized) };
    result.records[0].evidence = evidence(oversized);
    result.rawBlocks = [{ text: "문서의 원문 근거", kind: "paragraph", location: { page: 1, block: 1 } }];
  } });
  const response = await s.read({ ...s.args, maxChars: 20000 });
  assert.deepEqual(response.records, []);
  assert.equal(response.warnings.some((warning) => warning.code === "RECORD_EXCEEDS_HARD_LIMIT"), true);
  assert.equal(response.rawBlocks[0].text, "문서의 원문 근거");
  assert.equal(response.pagination.hasMore, false, "the cursor must not stall on an item larger than every legal budget");
  assert.equal(response.levelCoverage.omittedRecordCount,1);
  assert.equal(response.levelCoverage.allMatchingRecordsDelivered,false);
});

test("large raw blocks paginate literal text and absolute character spans without losing content", async () => {
  const original = "긴 문단의 시작: " + "가나다라마 ".repeat(3500) + " 끝.";
  const s = setup({ mutateResult: (result) => {
    result.status = "metadata_only";
    result.records = [];
    result.rawBlocks = [{ text: original, kind: "paragraph", location: { page: 2, block: 3, charStart: 100, charEnd: 100 + original.length } }];
  } });
  let cursor;
  let joined = "";
  let pages = 0;
  do {
    const response = await s.read({ ...s.args, maxChars: 1200, ...(cursor ? { cursor } : {}) });
    assert.ok(++pages < 100, "every nonterminal response must advance the text cursor");
    assert.ok(response.rawBlocks.length > 0);
    assert.ok(response.rawBlocks.reduce((sum, block) => sum + JSON.stringify(block).length, 0) <= 1200);
    for (const block of response.rawBlocks) {
      assert.equal(block.location.page, 2);
      assert.equal(block.location.block, 3);
      assert.equal(block.location.charStart, 100 + joined.length);
      joined += block.text;
      assert.equal(block.location.charEnd, 100 + joined.length);
    }
    assert.equal(response.responseTruncated, response.pagination.hasMore);
    cursor = response.pagination.cursor;
  } while (cursor);
  assert.ok(pages > 1);
  assert.equal(joined, original);
});

test("attachment metadata is paginated and parsed responses omit the redundant full list", async () => {
  const attachments = Array.from({ length: 35 }, (_, index) => ({ ...file, id: String(1000 + index), fileName: `교사용-${index}.pdf` }));
  const listed = setup({ details: { resource, attachments, warnings: [] } });
  const response = await listed.read({ achievementRef: listed.args.achievementRef, maxItems: 3 });
  assert.equal(response.attachments.length, 3);
  assert.equal(response.pagination.hasMore, true);
  assert.equal(listed.workerCalls(), 0);
  const seen = response.attachments.map((item) => item.fileName);
  let cursor = response.pagination.cursor;
  while (cursor) {
    const page = await listed.read({ achievementRef: listed.args.achievementRef, maxItems: 3, cursor });
    assert.ok(page.attachments.length > 0 && page.attachments.length <= 3);
    seen.push(...page.attachments.map((item) => item.fileName));
    cursor = page.pagination.cursor;
  }
  assert.deepEqual(seen, attachments.map((item) => item.fileName));
  const s = setup();
  const read = await s.read(s.args);
  assert.equal(read.attachments, undefined);
});

test("an empty record filter can return literal source blocks without inventing a matching record", async () => {
  const s = setup();
  const response = await s.read({ ...s.args, levelLabel: "하" });
  assert.equal(response.status, "metadata_only");
  assert.deepEqual(response.records, []);
  assert.equal(response.rawBlocks[0].text, "실험 결과를 설명한다.");
  assert.equal(response.warnings.some((warning) => warning.code === "NO_MATCHING_RECORDS"), true);
});

test("read references are reusable within their signed lifetime and keep attachment scope on replay", async () => {
  const s = setup();
  const first = await s.read(s.args);
  const second = await s.read(s.args);
  assert.equal(first.status, "verified_extraction");
  assert.deepEqual(second.records, first.records);
  assert.equal(s.workerCalls(), 2);
  const other = s.references.issue("attachment", { resourceId: "different-resource", attachmentId: file.id });
  await assert.rejects(s.read({ ...s.args, attachmentRef: other }), (error) => error.code === "INVALID_REFERENCE");
});
