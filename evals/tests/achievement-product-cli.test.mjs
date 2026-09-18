import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashCorpus } from '../achievement-product/score.mjs';
import { auditCorpus, makeReviewPacket } from '../achievement-product/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const corpus = JSON.parse(readFileSync(new URL('../achievement-product/corpus.json', import.meta.url), 'utf8'));
const run = { schemaVersion: 1, kind: 'achievement_product_run', corpusHash: hashCorpus(corpus),
  completed: true, queries: [], documents: [] };
const cli = (...args) => spawnSync(process.execPath, ['evals/achievement-product/index.mjs', ...args],
  { cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, EDUNET_API_KEY: '', EDUNET_DOMAIN: '' } });

test('seed corpus is 30 pending teacher queries, never 30 verified documents', () => {
  const audit = auditCorpus(corpus);
  assert.equal(audit.queries, 30);
  assert.equal(audit.documents, 0);
  assert.equal(audit.approvedDocuments, 0);
  assert.equal(audit.approvedQueries, 0);
  assert.equal(audit.status, 'unmeasured');
  assert.deepEqual(Object.values(audit.queryGroups).sort((a, b) => a - b), [5, 5, 5, 5, 10]);
});

test('review packet is blank human work, hash-bound to observed run', () => {
  const packet = makeReviewPacket(corpus, run);
  assert.match(packet.runHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(packet.clientEvaluation.status, 'not_run');
  assert.ok(packet.queries.every(q => q.review.status === 'pending' && !q.review.reviewer && !q.relevantDocumentIds.length));
  assert.throws(() => makeReviewPacket(corpus, { ...run, corpusHash: 'wrong' }));
});

test('CLI audit works without credentials; grade reports unmeasured and preserves prior output', () => {
  const audit = cli('--mode', 'audit');
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).status, 'unmeasured');
  mkdirSync(resolve(root, '.scratch'), { recursive: true });
  const dir = mkdtempSync(resolve(root, '.scratch/achievement-product-cli-'));
  const runPath = join(dir, 'run.json'), reportPath = join(dir, 'report.json');
  writeFileSync(runPath, JSON.stringify(run));
  const grade = cli('--mode', 'grade', '--run', runPath, '--out', reportPath);
  assert.equal(grade.status, 2, grade.stderr);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status, 'inconclusive');
  const original = readFileSync(reportPath, 'utf8');
  const repeated = cli('--mode', 'grade', '--run', runPath, '--out', reportPath);
  assert.equal(repeated.status, 1);
  assert.equal(readFileSync(reportPath, 'utf8'), original);
  writeFileSync(runPath, JSON.stringify({ ...run, corpusHash: 'wrong' }));
  const invalidPath = join(dir, 'invalid.json');
  assert.equal(cli('--mode', 'grade', '--run', runPath, '--out', invalidPath).status, 1);
  assert.equal(existsSync(invalidPath), false);
});
