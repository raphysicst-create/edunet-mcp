import assert from 'node:assert/strict';
import test from 'node:test';
import { FIELDS, hashCorpus, scoreProduct, validateCorpus } from '../achievement-product/score.mjs';

// These are scorer unit fixtures, never the real-document corpus or product evidence.
const HASH = 'sha256:' + 'a'.repeat(64);
const REVIEW = { status: 'approved', reviewer: 'unit-test-reviewer', reviewedAt: '2026-09-18T00:00:00Z', scope: 'full_document' };
const span = (quote, row = 1) => ({ quote, location: { page: 1, table: 1, row, column: 2 } });
function gold(id = 'record-1', label = '상', description = '광합성을 설명한다.', row = 1) {
  const record = { id, grade: '중학교', subject: '과학', domain: null, achievementStandardCode: '[9과01-01]',
    achievementStandardText: null, achievementLevel: label, description, evidence: {} };
  for (const field of FIELDS) if (record[field] !== null) record.evidence[field] = [span(record[field], row)];
  return record;
}
function actual(record, contentHash = HASH) {
  const result = { id: record.id, evidence: [{ ...span(record.description ?? '표'), sourceHash: contentHash }], extraction: { method: 'table', confidence: 'high' } };
  for (const field of FIELDS) if (record[field] !== null) result[field] = {
    [field === 'achievementLevel' ? 'rawLabel' : 'raw']: record[field],
    evidence: record.evidence[field].map(item => ({ ...structuredClone(item), sourceHash: contentHash })),
  };
  return result;
}
function fixture(records = [gold()]) {
  const corpus = { schemaVersion: 1, documents: [{ id: 'document-1', resource: { id: 'resource-1', title: '단위 검증 자료', sourceUrl: 'https://www.edunet.net/resource?id=1' },
    attachment: { id: 'attachment-1', fileName: 'levels.pdf', format: 'pdf' }, contentHash: HASH, review: { ...REVIEW }, records,
    selection: { expectedAction: 'select', acceptableAttachmentIds: ['attachment-1'] } }],
  queries: [{ id: 'query-1', input: { query: '중학교 과학 성취수준' }, group: 'science', prompt: '중학교 과학 성취수준 찾아줘.', relevantDocumentIds: ['document-1'], review: { ...REVIEW } }] };
  const run = { schemaVersion: 1, kind: 'achievement_product_run', corpusHash: hashCorpus(corpus), completed: true,
    queries: [{ id: 'query-1', status: 'ok', candidates: [{ resourceId: 'resource-1', sourceUrl: 'https://www.edunet.net/resource?id=1' }] }],
    documents: [{ id: 'document-1', status: 'verified_extraction', contentHash: HASH, records: records.map(record => actual(record)), complete: true,
      autoSelection: { action: 'select', attachmentId: 'attachment-1' } }] };
  return { corpus, run };
}
function score({ corpus, run }, options = {}) { run.corpusHash = hashCorpus(corpus); return scoreProduct(corpus, run, { minDocuments: 1, ...options }); }

test('zero reviewed real gold is inconclusive rather than a vacuous pass', () => {
  const corpus = { schemaVersion: 1, documents: [], queries: [] };
  const report = scoreProduct(corpus, { schemaVersion: 1, kind: 'achievement_product_run', corpusHash: hashCorpus(corpus), completed: true, documents: [], queries: [] });
  assert.equal(report.status, 'inconclusive'); assert.equal(report.pass, false); assert.equal(report.complete, false);
  assert.equal(report.metrics.records.precision, null); assert.equal(report.metrics.discoveryRecallAtK.value, null);
});

test('complete reviewed fixture passes explicitly lowered unit-test corpus minimum', () => {
  const report = score(fixture());
  assert.equal(report.status, 'pass'); assert.equal(report.metrics.records.tp, 1);
  assert.equal(report.metrics.levelRecords.recall, 1); assert.equal(report.metrics.evidenceCorrectness.value, 1);
  assert.equal(score(fixture(), { minDocuments: 20 }).status, 'inconclusive');
});

test('pending review or interrupted run cannot fully pass', () => {
  const data = fixture(); data.corpus.documents.push({ id: 'pending-document', review: { status: 'pending' } });
  assert.equal(score(data).status, 'inconclusive');
  const interrupted = fixture(); interrupted.run.completed = false;
  assert.equal(score(interrupted).complete, false); assert.equal(score(interrupted).pass, false);
});

test('missing expected observations remain in recall and selection denominators', () => {
  const data = fixture(); data.run.queries = []; data.run.documents = [];
  const report = score(data);
  assert.equal(report.metrics.discoveryRecallAtK.value, 0); assert.equal(report.metrics.records.fn, 1);
  assert.equal(report.metrics.levelRawLabelFidelity.value, 0); assert.equal(report.metrics.evidenceCorrectness.value, 0);
  assert.equal(report.metrics.attachmentSelection.value, 0); assert.equal(report.complete, false);
});

test('duplicate observations and mismatched corpus hash are rejected safely', () => {
  for (const key of ['queries', 'documents']) {
    const data = fixture(); data.run[key].push(structuredClone(data.run[key][0]));
    assert.throws(() => score(data), error => error.code === 'INVALID_RUN' && /Duplicate/.test(error.message));
  }
  const { corpus, run } = fixture(); run.corpusHash = 'sha256:' + 'b'.repeat(64);
  assert.throws(() => scoreProduct(corpus, run), { code: 'INVALID_RUN' });
});

test('changed file hash invalidates every extraction credit but selection is independent', () => {
  const data = fixture(); data.run.documents[0].contentHash = 'sha256:' + 'b'.repeat(64);
  const report = score(data);
  assert.equal(report.metrics.records.tp, 0); assert.equal(report.metrics.records.fn, 1); assert.equal(report.metrics.records.fp, 1);
  assert.equal(report.metrics.fields.description.tp, 0); assert.equal(report.metrics.evidenceCorrectness.value, 0);
  assert.equal(report.metrics.attachmentSelection.value, 1); assert.equal(report.pass, false);
});

test('record order does not affect one-to-one extraction or evidence scoring', () => {
  const data = fixture([gold(), gold('record-2', '중', '광합성에 필요한 물질을 제시한다.', 2)]);
  data.run.documents[0].records.reverse();
  assert.equal(score(data).metrics.records.tp, 2); assert.equal(score(data).pass, true);
});

test('duplicate predictions incur FP rather than stealing the same gold repeatedly', () => {
  const data = fixture(); data.run.documents[0].records.push(structuredClone(data.run.documents[0].records[0]));
  const report = score(data);
  assert.equal(report.metrics.records.tp, 1); assert.equal(report.metrics.records.fp, 1); assert.equal(report.metrics.records.precision, 0.5);
  assert.equal(report.metrics.levelRawLabelFidelity.value, 0.5); assert.equal(report.pass, false);
});

test('exact matching takes priority when a near match could greedily steal a record', () => {
  const first = gold(), second = gold('record-2', '중', '광합성을 설명한다.', 2);
  const data = fixture([first, second]);
  const near = actual(first); near.description.raw = '다른 설명';
  data.run.documents[0].records = [near, actual(first)];
  const report = score(data);
  assert.equal(report.metrics.records.tp, 1); assert.equal(report.metrics.records.fp, 1); assert.equal(report.metrics.records.fn, 1);
});

test('swapped row evidence fails even when raw values and hashes are correct', () => {
  const data = fixture([gold(), gold('record-2', '중', '성취 설명', 2)]);
  data.run.documents[0].records[0].description.evidence[0].location.row = 2;
  const report = score(data);
  assert.equal(report.metrics.records.recall, 1); assert.ok(report.metrics.evidenceCorrectness.value < 1);
  assert.equal(report.pass, false); assert.ok(report.cases.documents[0].reasons.includes('field_evidence_mismatch'));
});

test('missing evidence, wrong quote, extra unsupported span, and wrong source hash fail', () => {
  for (const mutate of [
    value => { delete value.evidence; },
    value => { value.evidence[0].quote = '다른 문장'; },
    value => { value.evidence[0].sourceHash = 'sha256:' + 'b'.repeat(64); },
    value => { value.evidence.push({ quote: '다른 문장', location: { page: 2 }, sourceHash: HASH }); },
  ]) {
    const data = fixture(); mutate(data.run.documents[0].records[0].description);
    assert.ok(score(data).metrics.evidenceCorrectness.value < 1); assert.equal(score(data).pass, false);
  }
});

test('raw label normalization, deletion, or code fabrication loses credit', () => {
  for (const mutate of [
    record => { record.achievementLevel.rawLabel = 'A'; },
    record => { delete record.achievementLevel; },
  ]) {
    const data = fixture(); mutate(data.run.documents[0].records[0]);
    assert.equal(score(data).metrics.levelRawLabelFidelity.value, 0);
    assert.equal(score(data).metrics.levelRecords.recall, 0);
  }
  const data = fixture(); data.corpus.documents[0].records[0].achievementStandardCode = null;
  delete data.corpus.documents[0].records[0].evidence.achievementStandardCode;
  assert.equal(score(data).metrics.fields.achievementStandardCode.fp, 1);
});

test('whitespace normalization is allowed only for description and standard text', () => {
  const data = fixture(); data.run.documents[0].records[0].description.raw = '광합성을\n 설명한다.';
  assert.equal(score(data).metrics.records.recall, 1);
  data.run.documents[0].records[0].subject.raw = '과 학';
  assert.equal(score(data).metrics.records.recall, 0);
});

test('incomplete parsing cannot pass despite perfect visible records', () => {
  const data = fixture(); data.run.documents[0].complete = false;
  const report = score(data);
  assert.equal(report.metrics.records.recall, 1); assert.equal(report.complete, false); assert.equal(report.pass, false);
});

test('negative documents and queries penalize false positives', () => {
  const data = fixture();
  const negative = structuredClone(data.corpus.documents[0]); negative.id = 'negative'; negative.attachment.id = 'attachment-negative'; negative.records = [];
  data.corpus.documents.push(negative);
  data.run.documents.push({ ...structuredClone(data.run.documents[0]), id: 'negative' });
  data.corpus.queries.push({ id: 'negative-query', input: { query: '존재하지 않는 성취수준' }, relevantDocumentIds: [], review: { ...REVIEW } });
  data.run.queries.push({ id: 'negative-query', status: 'ok', candidates: [] });
  let report = score(data);
  assert.equal(report.metrics.records.fp, 1); assert.equal(report.metrics.negativeQueryAccuracy.value, 1);
  data.run.queries[1].candidates = [{ resourceId: 'resource-1' }];
  report = score(data); assert.equal(report.metrics.negativeQueryAccuracy.value, 0); assert.equal(report.pass, false);
});

test('abstention is correct only for an independently judged ambiguous selection', () => {
  const data = fixture(); data.corpus.documents[0].selection = { expectedAction: 'abstain', acceptableAttachmentIds: [] };
  data.run.documents[0].autoSelection = { action: 'abstain' };
  assert.equal(score(data).metrics.abstentionCoverage.value, 1); assert.equal(score(data).pass, true);
  data.corpus.documents[0].selection = { expectedAction: 'select', acceptableAttachmentIds: ['attachment-1'] };
  assert.equal(score(data).metrics.attachmentSelection.value, 0); assert.equal(score(data).metrics.attachmentSelection.selectionCoverage.value, 0);
});

test('discovery uses stable identity, canonical URL agreement, and unique rank positions', () => {
  const data = fixture();
  data.run.queries[0].candidates = [{ resourceId: 'wrong' }, { resourceId: 'wrong' }, { resourceId: 'resource-1' }];
  assert.equal(score(data, { k: 2 }).metrics.discoveryRecallAtK.value, 1);
  data.run.queries[0].candidates = [{ resourceId: 'fabricated', sourceUrl: data.corpus.documents[0].resource.sourceUrl }];
  assert.equal(score(data).metrics.discoveryRecallAtK.value, 0);
  data.run.queries[0].candidates = [{ resourceId: 'resource-1', sourceUrl: 'https://www.edunet.net/wrong' }];
  assert.equal(score(data).metrics.discoveryRecallAtK.value, 0);
  data.run.queries[0].candidates = [{ sourceUrl: data.corpus.documents[0].resource.sourceUrl + '#section' }];
  assert.equal(score(data).metrics.discoveryRecallAtK.value, 1);
});

test('multiple gold attachments share one discovery denominator and same bytes do not inflate sample size', () => {
  const data = fixture();
  const second = structuredClone(data.corpus.documents[0]); second.id = 'document-2'; second.attachment.id = 'attachment-2';
  data.corpus.documents.push(second); data.corpus.queries[0].relevantDocumentIds.push(second.id);
  data.run.documents.push({ ...structuredClone(data.run.documents[0]), id: second.id });
  const report = score(data, { minDocuments: 2 });
  assert.equal(report.metrics.discoveryRecallAtK.total, 1); assert.equal(report.corpus.uniquePositiveFiles, 1); assert.equal(report.status, 'inconclusive');
});

test('standard-only output cannot inflate achievement-level extraction metrics', () => {
  const data = fixture(); const standard = gold('standard-only'); standard.achievementLevel = null; standard.description = null;
  delete standard.evidence.achievementLevel; delete standard.evidence.description;
  data.corpus.documents[0].records.push(standard); data.run.documents[0].records = [actual(standard)];
  const report = score(data);
  assert.equal(report.metrics.records.recall, 0.5); assert.equal(report.metrics.levelRecords.recall, 0); assert.equal(report.pass, false);
});

test('gold validation rejects incomplete, synthetic, duplicate, unanchored or unreviewed assertions', () => {
  for (const mutate of [
    corpus => { delete corpus.documents[0].records[0].grade; },
    corpus => { corpus.documents[0].synthetic = true; },
    corpus => { corpus.documents[0].records[0].evidence.description[0].location = {}; },
    corpus => { corpus.documents[0].records[0].evidence.description[0].location = { row: 1 }; },
    corpus => { corpus.documents[0].records[0].evidence.description[0].location = { charStart: 0 }; },
    corpus => { corpus.documents[0].records[0].evidence.description[0].location = { page: 1, charStart: 0 }; },
    corpus => { corpus.documents[0].records[0].evidence.achievementLevel[0].quote = '하'; },
    corpus => { corpus.documents[0].review.scope = 'sample'; },
    corpus => { corpus.documents[0].review.reviewer = ''; },
    corpus => { corpus.queries[0].relevantDocumentIds = ['unknown']; },
    corpus => { const duplicate = structuredClone(corpus.documents[0]); duplicate.id = 'different-id'; corpus.documents.push(duplicate); },
  ]) {
    const { corpus } = fixture(); mutate(corpus);
    assert.throws(() => validateCorpus(corpus), error => error.code === 'INVALID_CORPUS' && !error.message.includes('광합성'));
  }
});

test('EDUNET tracker is ignored while resource-identifying query parameters remain significant', () => {
  const data = fixture(); data.run.queries[0].candidates[0].sourceUrl += '&contents_openapi=yes';
  assert.equal(score(data).metrics.discoveryRecallAtK.value, 1);
  data.run.queries[0].candidates[0].sourceUrl = 'https://www.edunet.net/resource?id=2&contents_openapi=yes';
  assert.equal(score(data).metrics.discoveryRecallAtK.value, 0);
});

test('empty parser output handles a full large gold document without quadratic assignment allocation', () => {
  const data = fixture(Array.from({ length: 1000 }, (_, index) => gold(`record-${index}`, '상', '광합성을 설명한다.', index + 1)));
  data.run.documents[0].records = [];
  const report = score(data);
  assert.equal(report.metrics.records.fn, 1000); assert.equal(report.metrics.records.recall, 0);
});
