import { createHash } from 'node:crypto';

export const FIELDS = ['grade', 'subject', 'domain', 'achievementStandardCode', 'achievementStandardText', 'achievementLevel', 'description'];
export const SCORER_VERSION = '1.1.0';
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fail = (path, message) => { const error = new Error(`${path}: ${message}`); error.code = path.startsWith('run') || path === 'options' ? 'INVALID_RUN' : 'INVALID_CORPUS'; throw error; };
const check = (condition, path, message) => { if (!condition) fail(path, message); };
const positiveLocations = ['page', 'paragraph', 'block', 'table', 'row', 'column'];
const locationKeys = [...positiveLocations, 'charStart', 'charEnd', 'anchor'];
const ratio = (correct, total) => ({ correct, total, value: total ? correct / total : null });
const counts = () => ({ tp: 0, fp: 0, fn: 0 });
const metric = ({ tp, fp, fn }) => ({ tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null,
  recall: tp + fn ? tp / (tp + fn) : null, f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null });

export const hashCorpus = corpus => 'sha256:' + createHash('sha256').update(JSON.stringify(corpus)).digest('hex');

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    if (/(^|\.)edunet\.net$/i.test(url.hostname)) url.searchParams.delete('contents_openapi');
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function validLocation(location) {
  if (!object(location) || !Object.keys(location).length || Object.keys(location).some(key => !locationKeys.includes(key))) return false;
  if (!['page', 'paragraph', 'block', 'table'].some(key => own(location, key)) && !nonempty(location.anchor)) return false;
  if (positiveLocations.some(key => own(location, key) && (!Number.isSafeInteger(location[key]) || location[key] < 1))) return false;
  if (['charStart', 'charEnd'].some(key => own(location, key) && (!Number.isSafeInteger(location[key]) || location[key] < 0))) return false;
  if (own(location, 'anchor') && !nonempty(location.anchor)) return false;
  if (own(location, 'charStart') !== own(location, 'charEnd')) return false;
  return !(own(location, 'charStart') && own(location, 'charEnd') && location.charEnd <= location.charStart);
}

function review(value, path, document = false) {
  check(object(value) && ['pending', 'approved'].includes(value.status), path, 'review.status must be pending or approved.');
  if (value.status === 'pending') return;
  check(nonempty(value.reviewer) && nonempty(value.reviewedAt) && Number.isFinite(Date.parse(value.reviewedAt)), path, 'Approved review needs reviewer and valid reviewedAt.');
  if (document) check(value.scope === 'full_document', path, 'Approve only independently reviewed full_document gold.');
}

export function validateCorpus(corpus) {
  check(object(corpus) && corpus.schemaVersion === 1, 'corpus', 'Expected schemaVersion 1.');
  check(corpus.synthetic !== true, 'corpus', 'Synthetic fixtures cannot establish real-document product quality.');
  check(Array.isArray(corpus.documents) && Array.isArray(corpus.queries), 'corpus', 'documents and queries must be arrays.');
  const documents = new Map(), resourceUrls = new Map(), attachmentIdentities = new Set();
  corpus.documents.forEach((document, i) => {
    const path = `documents[${i}]`;
    check(object(document) && nonempty(document.id), path, 'A stable document id is required.');
    check(!documents.has(document.id), path, 'Duplicate document id.'); documents.set(document.id, document);
    check(document.synthetic !== true, path, 'Synthetic documents cannot be approved as real corpus.');
    review(document.review, `${path}.review`, true);
    if (document.review.status !== 'approved') return;
    check(object(document.resource) && nonempty(document.resource.id) && nonempty(document.resource.title) && canonicalUrl(document.resource.sourceUrl), path, 'Approved document needs resource id, title, and public HTTP(S) sourceUrl.');
    const url = canonicalUrl(document.resource.sourceUrl);
    check(!resourceUrls.has(document.resource.id) || resourceUrls.get(document.resource.id) === url, path, 'One resource id must have one canonical source URL.');
    resourceUrls.set(document.resource.id, url);
    check(object(document.attachment) && nonempty(document.attachment.id) && nonempty(document.attachment.fileName) && ['pdf', 'hwp', 'hwpx'].includes(document.attachment.format), path, 'Approved document needs attachment id, fileName, and pdf/hwp/hwpx format.');
    const attachmentIdentity = JSON.stringify([document.resource.id, document.attachment.id]);
    check(!attachmentIdentities.has(attachmentIdentity), path, 'Duplicate approved resource/attachment identity.'); attachmentIdentities.add(attachmentIdentity);
    check(hash(document.contentHash), path, 'Approved document needs lowercase sha256: file hash.');
    check(Array.isArray(document.records), path, 'Approved document needs records, including [] for a verified negative.');
    const ids = new Set();
    document.records.forEach((record, j) => {
      const rp = `${path}.records[${j}]`;
      check(object(record) && nonempty(record.id) && !ids.has(record.id), rp, 'A unique gold record id is required.'); ids.add(record.id);
      check(record.synthetic !== true, rp, 'Synthetic gold is not accepted.');
      check(FIELDS.some(field => nonempty(record[field])), rp, 'Gold records need at least one verified field.');
      check(!nonempty(record.achievementLevel) || nonempty(record.description), rp, 'An achievement level needs its original description.');
      for (const field of FIELDS) {
        check(own(record, field) && (record[field] === null || nonempty(record[field])), `${rp}.${field}`, 'All seven fields must be explicit nonempty strings or verified-absent null.');
        if (record[field] === null) continue;
        const spans = record.evidence?.[field];
        check(Array.isArray(spans) && spans.length > 0, `${rp}.evidence.${field}`, 'Non-null fields need original quotations and source locations.');
        spans.forEach(span => check(object(span) && nonempty(span.quote) && validLocation(span.location) && (!own(span, 'sourceHash') || span.sourceHash === document.contentHash), `${rp}.evidence.${field}`, 'Every span needs a nonempty quote and valid anchored location; any sourceHash must match the file.'));
        const normalize = value => ['description', 'achievementStandardText'].includes(field) ? value.replace(/\s+/gu, '') : value;
        check(normalize(spans.map(span => span.quote).join('')).includes(normalize(record[field])), `${rp}.evidence.${field}`, 'Gold quotations must contain the original field value.');
      }
    });
    const selection = document.selection;
    check(object(selection) && ['select', 'abstain'].includes(selection.expectedAction) && Array.isArray(selection.acceptableAttachmentIds) && selection.acceptableAttachmentIds.every(nonempty), path, 'Approved document needs an explicit automatic-selection judgment.');
    check(new Set(selection.acceptableAttachmentIds).size === selection.acceptableAttachmentIds.length, path, 'Duplicate acceptable attachment ids.');
    check(selection.expectedAction === 'select' ? selection.acceptableAttachmentIds.length > 0 : selection.acceptableAttachmentIds.length === 0, path, 'Select needs acceptable attachment ids; abstain needs an empty list.');
  });
  const queryIds = new Set();
  corpus.queries.forEach((query, i) => {
    const path = `queries[${i}]`;
    check(object(query) && nonempty(query.id) && !queryIds.has(query.id), path, 'A unique query id is required.'); queryIds.add(query.id);
    check(object(query.input) && ['query', 'grade', 'subject', 'achievementStandardCode'].some(key => nonempty(query.input[key])), path, 'A search input is required.');
    review(query.review, `${path}.review`);
    if (query.review.status !== 'approved') return;
    check(Array.isArray(query.relevantDocumentIds) && new Set(query.relevantDocumentIds).size === query.relevantDocumentIds.length, path, 'Approved query needs unique relevantDocumentIds; [] explicitly means negative.');
    check(query.relevantDocumentIds.every(id => documents.get(id)?.review.status === 'approved'), path, 'Approved query relevance must reference approved documents.');
  });
  return corpus;
}

function observations(items, expected, path) {
  check(Array.isArray(items), path, 'Expected an observation array.');
  const known = new Set(expected.map(item => item.id)), result = new Map();
  items.forEach((item, i) => {
    check(object(item) && known.has(item.id), `${path}[${i}]`, 'Observation must reference a corpus id.');
    check(!result.has(item.id), `${path}[${i}]`, 'Duplicate observations are invalid; collect each case once.');
    result.set(item.id, item);
  });
  return result;
}

const raw = (record, field) => {
  if (!own(record, field)) return null;
  const value = record[field]?.[field === 'achievementLevel' ? 'rawLabel' : 'raw'];
  return typeof value === 'string' ? value : undefined;
};
const equal = (field, actual, expected) => {
  if (typeof actual !== 'string' || typeof expected !== 'string') return actual === expected;
  return ['description', 'achievementStandardText'].includes(field)
    ? actual.replace(/\s+/gu, '') === expected.replace(/\s+/gu, '') : actual === expected;
};
const exactRecord = (record, gold) => object(record) && FIELDS.every(field => equal(field, raw(record, field), gold[field]));

function evidenceStatus(record, gold, field, contentHash) {
  const spans = record?.[field]?.evidence, expected = gold.evidence[field];
  if (!Array.isArray(spans) || !spans.length) return 'mismatch';
  const matchesReviewedScope = (actual, target) => object(actual) && actual.sourceHash === contentHash && actual.quote === target.quote && validLocation(actual.location)
    && Object.entries(target.location).every(([key, value]) => actual.location[key] === value);
  const allMatch = matches => expected.every(target => spans.some(actual => matches(actual, target)))
    && spans.every(actual => expected.some(target => matches(actual, target)));
  // Human gold verifies only its own coordinate keys. Extra parser coordinates
  // need review even when they agree with every reviewed coordinate.
  if (allMatch((actual, target) => matchesReviewedScope(actual, target)
    && Object.keys(actual.location).length === Object.keys(target.location).length)) return 'verified';
  return allMatch(matchesReviewedScope) ? 'additional_location_review_needed' : 'mismatch';
}

// Hungarian assignment: exact-record count takes priority over field agreement,
// then field agreement over evidence. Dummy rows/columns permit unmatched records.
// This avoids record-order dependence and greedy stealing when labels repeat.
function matchRecords(actual, expected, contentHash) {
  if (!actual.length || !expected.length) return [];
  const n = Math.max(actual.length, expected.length);
  if (!n) return [];
  const evidenceScale = 7 * n + 1, exactScale = (7 * n + 1) * evidenceScale;
  const weights = actual.map(record => expected.map(gold => {
    const common = FIELDS.filter(field => gold[field] !== null && equal(field, raw(record, field), gold[field]));
    if (!common.length) return 0;
    return Number(exactRecord(record, gold)) * exactScale + common.length * evidenceScale
      + common.filter(field => evidenceStatus(record, gold, field, contentHash) === 'verified').length;
  }));
  if (weights.every(row => row.every(weight => weight === 0))) return [];
  const u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let column = 0;
    const minimum = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false);
    do {
      used[column] = true;
      const row = p[column]; let delta = Infinity, next = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cost = -(weights[row - 1]?.[j - 1] ?? 0) - u[row] - v[j];
        if (cost < minimum[j]) { minimum[j] = cost; way[j] = column; }
        if (minimum[j] < delta) { delta = minimum[j]; next = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minimum[j] -= delta;
      column = next;
    } while (p[column] !== 0);
    do { const previous = way[column]; p[column] = p[previous]; column = previous; } while (column !== 0);
  }
  return p.slice(1).flatMap((row, index) => row <= actual.length && index < expected.length && weights[row - 1]?.[index] > 0 ? [[row - 1, index]] : []);
}

export function scoreProduct(corpus, run, { k = 10, minDocuments = 20 } = {}) {
  validateCorpus(corpus);
  check(Number.isSafeInteger(k) && k > 0 && Number.isSafeInteger(minDocuments) && minDocuments > 0, 'options', 'k and minDocuments must be positive integers.');
  check(object(run) && run.schemaVersion === 1 && run.kind === 'achievement_product_run', 'run', 'Expected achievement_product_run schemaVersion 1.');
  check(run.corpusHash === hashCorpus(corpus), 'run', 'Corpus hash changed; recollect or explicitly re-review against this corpus.');
  const queryRuns = observations(run.queries, corpus.queries, 'run.queries');
  const documentRuns = observations(run.documents, corpus.documents, 'run.documents');
  const docs = corpus.documents.filter(document => document.review.status === 'approved');
  const queries = corpus.queries.filter(query => query.review.status === 'approved');
  const byId = new Map(docs.map(document => [document.id, document]));
  const failures = [], queryCases = [], documentCases = [];
  let found = 0, relevant = 0, negativeCorrect = 0, negativeTotal = 0;
  for (const query of queries) {
    const observation = queryRuns.get(query.id), reasons = [];
    const usable = observation && !observation.error && ['ok', 'partial', 'not_found_in_official_index'].includes(observation.status) && Array.isArray(observation.candidates);
    if (!observation) reasons.push('missing_observation'); else if (!usable) reasons.push('discovery_failed');
    const dedup = new Map();
    for (const candidate of usable ? observation.candidates : []) {
      const key = nonempty(candidate?.resourceId) ? `id:${candidate.resourceId}` : `url:${canonicalUrl(candidate?.sourceUrl)}`;
      if (!dedup.has(key)) dedup.set(key, candidate);
    }
    const top = [...dedup.values()].slice(0, k);
    const targets = [...new Map(query.relevantDocumentIds.map(id => { const doc = byId.get(id); return [doc.resource.id, doc.resource]; })).values()];
    const hits = targets.filter(resource => top.some(candidate => {
      const url = candidate?.sourceUrl === undefined ? null : canonicalUrl(candidate.sourceUrl);
      if (nonempty(candidate?.resourceId)) return candidate.resourceId === resource.id && (candidate.sourceUrl === undefined || url === canonicalUrl(resource.sourceUrl));
      return url !== null && url === canonicalUrl(resource.sourceUrl);
    })).length;
    found += hits; relevant += targets.length;
    if (hits < targets.length) reasons.push('relevant_resources_missed');
    if (!targets.length) { negativeTotal++; if (usable && top.length === 0) negativeCorrect++; else reasons.push('negative_query_not_empty_or_failed'); }
    const result = { id: query.id, group: query.group ?? null, observed: Boolean(usable), expectedResources: targets.length, foundResources: hits, recallAtK: targets.length ? hits / targets.length : null, returnedResources: top.length, pass: reasons.length === 0, reasons };
    queryCases.push(result);
  }
  const records = counts(), levelRecords = counts(), fields = Object.fromEntries(FIELDS.map(field => [field, counts()]));
  let labelsCorrect = 0, labelsTotal = 0, evidenceCorrect = 0, evidenceTotal = 0, evidenceUnverifiedLocationFields = 0;
  let selectionCorrect = 0, abstainCorrect = 0, abstainTotal = 0, selectableTotal = 0, selected = 0, completeDocuments = 0;
  for (const document of docs) {
    const observation = documentRuns.get(document.id), reasons = [];
    const actual = Array.isArray(observation?.records) ? observation.records : [];
    const usable = observation && hash(observation.contentHash) && observation.contentHash === document.contentHash && ['ok', 'partial', 'verified_extraction', 'metadata_only', 'no_text'].includes(observation.status);
    if (!observation) reasons.push('missing_observation');
    else {
      if (observation.contentHash !== document.contentHash) reasons.push('content_hash_mismatch');
      if (!usable || !Array.isArray(observation.records)) reasons.push('document_read_failed');
      if (observation.error) reasons.push('document_collection_error');
    }
    const complete = Boolean(usable && observation.complete === true && !observation.error && Array.isArray(observation.records));
    if (complete) completeDocuments++; else reasons.push('document_incomplete');
    const pairs = usable ? matchRecords(actual, document.records, document.contentHash) : [];
    const pairedActual = new Set(pairs.map(([index]) => index)), pairedGold = new Set(pairs.map(([, index]) => index));
    const allPairs = [...pairs, ...actual.flatMap((_, index) => pairedActual.has(index) ? [] : [[index, -1]]), ...document.records.flatMap((_, index) => pairedGold.has(index) ? [] : [[-1, index]])];
    const local = counts(); let localLabels = 0, localEvidence = 0, localUnverifiedLocationFields = 0;
    for (const [a, g] of allPairs) {
      const prediction = a >= 0 ? actual[a] : undefined, gold = g >= 0 ? document.records[g] : undefined;
      const exact = prediction !== undefined && gold !== undefined && exactRecord(prediction, gold);
      const actualLevel = a >= 0 && nonempty(raw(prediction, 'achievementLevel')) && nonempty(raw(prediction, 'description'));
      const goldLevel = g >= 0 && nonempty(gold.achievementLevel) && nonempty(gold.description);
      if (exact && actualLevel && goldLevel) levelRecords.tp++;
      else { if (actualLevel) levelRecords.fp++; if (goldLevel) levelRecords.fn++; }
      if (exact) { records.tp++; local.tp++; }
      else { if (a >= 0) { records.fp++; local.fp++; } if (g >= 0) { records.fn++; local.fn++; } }
      for (const field of FIELDS) {
        const wanted = gold?.[field] ?? null, value = a >= 0 ? raw(prediction, field) : null;
        const present = a >= 0 && own(prediction, field), expected = wanted !== null;
        const correct = present && expected && equal(field, value, wanted);
        if (correct) fields[field].tp++; else { if (present) fields[field].fp++; if (expected) fields[field].fn++; }
        if (field === 'achievementLevel' && (present || expected)) {
          labelsTotal++; if (correct) labelsCorrect++; else localLabels++;
        }
        if (present || expected) {
          evidenceTotal++;
          const status = correct ? evidenceStatus(prediction, gold, field, document.contentHash) : 'mismatch';
          if (status === 'verified') evidenceCorrect++;
          else if (status === 'additional_location_review_needed') { evidenceUnverifiedLocationFields++; localUnverifiedLocationFields++; }
          else localEvidence++;
        }
      }
    }
    if (local.fp || local.fn) reasons.push('record_mismatch');
    if (localLabels) reasons.push('raw_label_mismatch');
    if (localEvidence) reasons.push('field_evidence_mismatch');
    if (localUnverifiedLocationFields) reasons.push('field_evidence_additional_location_review_needed');
    const auto = observation?.autoSelection, expectedSelection = document.selection;
    const selectionPass = auto?.action === expectedSelection.expectedAction && (auto.action === 'abstain' || expectedSelection.acceptableAttachmentIds.includes(auto.attachmentId));
    if (selectionPass) selectionCorrect++; else reasons.push('automatic_attachment_selection_mismatch');
    if (expectedSelection.expectedAction === 'abstain') { abstainTotal++; if (selectionPass) abstainCorrect++; }
    else { selectableTotal++; if (auto?.action === 'select') selected++; }
    documentCases.push({ id: document.id, format: document.attachment.format, positive: document.records.some(record => nonempty(record.achievementLevel) && nonempty(record.description)), complete, records: metric(local), labelErrors: localLabels, evidenceErrors: localEvidence, evidenceUnverifiedLocationFields: localUnverifiedLocationFields, selectionPass, pass: reasons.length === 0, reasons });
  }
  const positiveDocs = docs.filter(document => document.records.some(record => nonempty(record.achievementLevel) && nonempty(record.description)));
  const positiveDocuments = positiveDocs.length, uniquePositiveFiles = new Set(positiveDocs.map(document => document.contentHash)).size;
  const metrics = { discoveryRecallAtK: { ...ratio(found, relevant), k, reference: 'Human-judged resource set; not all documents on EDUNET.' },
    negativeQueryAccuracy: ratio(negativeCorrect, negativeTotal), records: metric(records), levelRecords: metric(levelRecords), fields: Object.fromEntries(FIELDS.map(field => [field, metric(fields[field])])),
    levelRawLabelFidelity: ratio(labelsCorrect, labelsTotal), evidenceCorrectness: { ...ratio(evidenceCorrect, evidenceTotal), unverifiedLocationFields: evidenceUnverifiedLocationFields },
    attachmentSelection: { ...ratio(selectionCorrect, docs.length), accuracy: docs.length ? selectionCorrect / docs.length : null, selectionCoverage: ratio(selected, selectableTotal) },
    abstentionCoverage: ratio(abstainCorrect, abstainTotal), documentCompleteness: ratio(completeDocuments, docs.length),
    macroDocumentRecordRecall: { value: positiveDocuments ? documentCases.filter(c => c.positive).reduce((sum, c) => sum + (c.records.recall ?? 0), 0) / positiveDocuments : null, documents: positiveDocuments } };
  const targets = { discoveryRecallAtK: 0.8, recordPrecision: 0.95, recordRecall: 0.9, levelRawLabelFidelity: 1, evidenceCorrectness: 1, attachmentSelectionAccuracy: 0.95, negativeQueryAccuracy: 1 };
  const pendingDocuments = corpus.documents.length - docs.length, pendingQueries = corpus.queries.length - queries.length;
  if (uniquePositiveFiles < minDocuments) failures.push('insufficient_reviewed_positive_documents');
  if (pendingDocuments || pendingQueries) failures.push('corpus_review_pending');
  if (!relevant) failures.push('no_approved_positive_discovery_queries');
  if (run.completed !== true) failures.push('collection_not_completed');
  const meets = (value, target) => value !== null && value >= target;
  const targetChecks = {
    discoveryRecallAtK: meets(metrics.discoveryRecallAtK.value, targets.discoveryRecallAtK),
    recordPrecision: meets(metrics.records.precision, targets.recordPrecision), recordRecall: meets(metrics.records.recall, targets.recordRecall),
    levelRecordPrecision: meets(metrics.levelRecords.precision, targets.recordPrecision), levelRecordRecall: meets(metrics.levelRecords.recall, targets.recordRecall),
    levelRawLabelFidelity: meets(metrics.levelRawLabelFidelity.value, 1), evidenceCorrectness: meets(metrics.evidenceCorrectness.value, 1),
    attachmentSelectionAccuracy: meets(metrics.attachmentSelection.value, targets.attachmentSelectionAccuracy),
    negativeQueryAccuracy: !negativeTotal || metrics.negativeQueryAccuracy.value === 1,
  };
  for (const [name, passed] of Object.entries(targetChecks)) if (!passed) failures.push(`target_not_met:${name}`);
  const ready = uniquePositiveFiles >= minDocuments && !pendingDocuments && !pendingQueries && relevant > 0;
  const complete = ready && run.completed === true && completeDocuments === docs.length && queryCases.every(query => query.observed);
  if (completeDocuments !== docs.length) failures.push('incomplete_documents');
  if (queries.some(query => !queryRuns.has(query.id))) failures.push('missing_query_observations');
  const pass = complete && Object.values(targetChecks).every(Boolean);
  return { schemaVersion: 1, scorerVersion: SCORER_VERSION, kind: 'achievement_product_report', corpusHash: hashCorpus(corpus),
    scope: 'Reviewed real-document discovery, extraction, evidence, and attachment selection. Does not certify client-model behavior, educational-domain approval, operational beta, or release readiness.',
    status: !ready ? 'inconclusive' : pass ? 'pass' : 'fail', complete, pass,
    corpus: { documents: corpus.documents.length, approvedDocuments: docs.length, positiveDocuments, uniquePositiveFiles, negativeDocuments: docs.length - positiveDocuments,
      pendingDocuments, queries: corpus.queries.length, approvedQueries: queries.length, pendingQueries, minimumPositiveDocuments: minDocuments },
    metrics, targets, targetChecks, failures, cases: { queries: queryCases, documents: documentCases } };
}
