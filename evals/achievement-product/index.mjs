import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../dist/config.js';
import { ReferenceCodec } from '../../dist/achievement/references.js';
import { searchAchievementInputSchema } from '../../dist/achievement/contracts.js';
import { args, assertNewPaths, connect, progressWriter, readJson, writeJson } from '../lib.mjs';
import { collectDocument, collectQuery, withoutReferences } from './collect.mjs';
import { hashCorpus, scoreProduct, validateCorpus } from './score.mjs';

const defaultCorpus = new URL('./corpus.json', import.meta.url);
const hashFile = url => 'sha256:' + createHash('sha256').update(readFileSync(url)).digest('hex');
const integer = (value, fallback, max) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Expected a positive integer within the documented limit.');
  return n;
};

export function auditCorpus(corpus) {
  validateCorpus(corpus);
  const approvedDocuments = corpus.documents.filter(d => d.review.status === 'approved');
  return { kind: 'achievement_corpus_audit', schemaVersion: 1, corpusHash: hashCorpus(corpus),
    status: approvedDocuments.length ? 'review_in_progress' : 'unmeasured',
    documents: corpus.documents.length, approvedDocuments: approvedDocuments.length,
    queries: corpus.queries.length, approvedQueries: corpus.queries.filter(q => q.review.status === 'approved').length,
    queryGroups: Object.fromEntries([...new Set(corpus.queries.map(q => q.group))].map(group => [group, corpus.queries.filter(q => q.group === group).length])),
    targetDocuments: { minimum: 20, recommended: 30, maximum: 50 },
    note: 'Corpus readiness only. No discovery, extraction, client-model, or release success is implied.' };
}

export function makeReviewPacket(corpus, run) {
  if (run.kind !== 'achievement_product_run' || run.corpusHash !== hashCorpus(corpus)) throw new Error('Run and corpus do not match.');
  return { kind: 'achievement_product_review_packet', schemaVersion: 1, corpusHash: hashCorpus(corpus),
    runHash: 'sha256:' + createHash('sha256').update(JSON.stringify(run)).digest('hex'),
    reviewer: '', reviewedAt: '',
    instructions: ['Open and inspect the original independently; parser output is not gold.',
      'Identify missed documents using an independent source list; returned candidates alone cannot establish recall.',
      'Approve only full-document gold with file SHA-256, exact raw labels, and field-specific source locations.',
      'Null means verified absent; do not mark an unreviewed field null. Keep incomplete review pending.'],
    queries: corpus.queries.map(q => ({ id: q.id, prompt: q.prompt, input: q.input,
      observed: withoutReferences(run.queries?.find(item => item.id === q.id) ?? null),
      relevantDocumentIds: [], review: { status: 'pending', reviewer: '', reviewedAt: '' }, notes: '' })),
    documents: corpus.documents.map(d => ({ id: d.id, resource: d.resource, attachment: d.attachment,
      observed: { contentHash: run.documents?.find(item => item.id === d.id)?.contentHash,
        status: run.documents?.find(item => item.id === d.id)?.status },
      review: { status: 'pending', reviewer: '', reviewedAt: '', scope: 'full_document' },
      records: [], selection: { expectedAction: null, acceptableAttachmentIds: [] }, notes: '' })),
    clientEvaluation: { status: 'not_run', caseFile: 'evals/achievement-product/client-cases.json' } };
}

async function main() {
  const options = args();
  const allowed = ['mode', 'corpus', 'out', 'run', 'limit', 'max-pages', 'hwpx', 'k', 'min-documents'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Unknown option.');
  const corpus = readJson(options.corpus ?? defaultCorpus);
  validateCorpus(corpus);
  for (const query of corpus.queries) searchAchievementInputSchema.parse(query.input);
  const mode = options.mode ?? 'audit';
  if (mode === 'audit') {
    const audit = auditCorpus(corpus);
    if (options.out) writeJson(options.out, audit);
    console.log(JSON.stringify(audit, null, 2)); return;
  }
  if (!options.out) throw new Error('--out must be a new output file.');
  assertNewPaths([options.out]);
  if (mode === 'grade' || mode === 'review-packet') {
    if (!options.run) throw new Error('--run is required.');
    const run = readJson(options.run);
    const result = mode === 'grade' ? scoreProduct(corpus, run, { k: integer(options.k, 10, 20),
      minDocuments: integer(options['min-documents'], 20, 50) }) : makeReviewPacket(corpus, run);
    result.evaluatorHash = hashFile(new URL('./score.mjs', import.meta.url));
    writeJson(options.out, result);
    console.log(JSON.stringify(mode === 'grade' ? { status: result.status, complete: result.complete, metrics: result.metrics } : { status: 'review_pending', output: options.out }, null, 2));
    if (mode === 'grade' && !result.pass) process.exitCode = result.status === 'inconclusive' ? 2 : 1;
    return;
  }
  if (!['discover', 'collect'].includes(mode)) throw new Error('Use audit, discover, collect, grade, or review-packet.');
  if (options.hwpx !== undefined && !['true', 'false'].includes(options.hwpx)) throw new Error('--hwpx must be true or false.');
  const limit = integer(options.limit, Math.max(1, corpus.queries.length), Math.max(1, corpus.queries.length));
  const maxPages = integer(options['max-pages'], 20, 100);
  // Read configuration without printing or persisting credentials.
  loadConfig();
  const secret = randomBytes(32).toString('hex');
  const references = new ReferenceCodec(secret);
  const config = { searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: true, hwpxReadEnabled: options.hwpx === 'true',
    autoAttachmentSelectionEnabled: true, resourceReadEnabled: false, referenceSecret: secret };
  const run = { schemaVersion: 1, kind: 'achievement_product_run', mode, corpusHash: hashCorpus(corpus),
    startedAt: new Date().toISOString(), completed: false, environment: { node: process.version, platform: process.platform },
    evaluationProfile: { ...config, referenceSecret: undefined },
    implementation: Object.fromEntries(['./collect.mjs', './index.mjs', './score.mjs', '../../dist/achievement/search-orchestrator.js', '../../dist/achievement/read-service.js',
      '../../dist/worker/achievement/extract.js', '../../dist/worker/parsers/index.js', '../../config/document-profiles/korean-achievement-v1.json', '../../config/achievement-source-registry.json']
      .map(file => [file, hashFile(new URL(file, import.meta.url))])),
    limits: { queryLimit: limit, readPages: maxPages, searchPage: 1, searchPageSize: 20 }, queries: [], documents: [],
    scope: 'Live first-page discovery; full-document extraction uses the annotated attachment independently of automatic selection. No client-model run.' };
  const writer = progressWriter(options.out);
  let session;
  try {
    writer.write(run);
    session = await connect(undefined, { achievement: { config, references } });
    const dependencies = { client: session.client, references, maxPages };
    for (const query of corpus.queries.slice(0, limit)) {
      const observation = await collectQuery(query, dependencies);
      run.queries.push(observation); writer.write(run);
      console.log(`${query.id}: ${observation.status}; ${observation.candidates.length} candidates; relevance unjudged`);
      if (observation.status === 'search_unavailable' || observation.error) {
        run.stopReason = 'discovery_unavailable'; break;
      }
    }
    if (mode === 'collect' && !run.stopReason) for (const document of corpus.documents) {
      const observation = await collectDocument(document, dependencies);
      run.documents.push(observation); writer.write(run);
      console.log(`${document.id}: ${observation.status}; ${observation.records.length} records; complete=${observation.complete}`);
    }
    run.completed = !run.stopReason && run.queries.length === corpus.queries.length &&
      (mode === 'discover' || run.documents.length === corpus.documents.length);
    run.finishedAt = new Date().toISOString(); writer.write(run);
    if (run.stopReason || run.documents.some(d => d.error)) process.exitCode = 1;
  } finally { try { await session?.close(); } finally { writer.close(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(['INVALID_CORPUS', 'INVALID_RUN'].includes(error?.code) ? error.message
    : 'Achievement product eval failed. Check corpus schema, EDUNET configuration, and new output paths. Raw errors omitted.');
  process.exitCode = 1;
});
