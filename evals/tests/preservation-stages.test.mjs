import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeJson, progressWriter, hash } from '../lib.mjs';
import { selectStage, representativeCases } from '../stages.mjs';
import { provenance, compareReports } from '../provenance.mjs';
import { controlledPreflight, auditRequest } from '../environment.mjs';
import { requestBody } from '../adapters/openai.mjs';

test('exclusive outputs protect reviews, grades, concurrent writers and same-run progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-preservation-'));
  const out = join(root, 'run.json'), review = join(root, 'review.json');
  writeJson(review, { reviewer: 'human evidence' });
  const before = readFileSync(review);
  assert.throws(() => writeJson(review, {}), /EEXIST/);
  assert.throws(() => progressWriter(review), /EEXIST/);
  const writer = progressWriter(out);
  try {
    writer.write({ long: 'first long progress contents' });
    writer.write({ n: 2 });
    assert.deepEqual(JSON.parse(readFileSync(out)), { n: 2 });
    assert.throws(() => progressWriter(out), /EEXIST/);
  } finally { writer.close(); }
  const run = join(root, 'new-run.json');
  const result = spawnSync(process.execPath, ['evals/ai.mjs', '--adapter', 'evals/adapters/smoke.mjs', '--model', 'smoke', '--model-version', 'smoke', '--stage', 'connection', '--repetitions', '1', '--out', run, '--review', review]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(run), false, 'refuse before starting collection');
  assert.deepEqual(readFileSync(review), before);
});

test('representative stage freezes eight existing IDs and cannot be mistaken for full coverage', () => {
  assert.equal(selectStage('connection').length, 1);
  assert.equal(selectStage('representative').length * 3, 24);
  assert.deepEqual(selectStage('representative').map(c => c.id), Object.keys(representativeCases));
  assert.equal(selectStage('full').length * 3, 90);
  assert.throws(() => selectStage('unknown'));
});

test('provider failure stops a planned 24-run collection after one attempt and preserves empty human review', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-stop-'));
  const adapter = join(root, 'adapter.mjs'), out = join(root, 'run.json'), review = join(root, 'review.json');
  writeFileSync(adapter, `export async function next() { throw Object.assign(new Error('redacted'), { safeEvidence: { httpStatus: 429, reason: 'credit_balance_exhausted' } }); }`);
  const result = spawnSync(process.execPath, ['evals/ai.mjs', '--adapter', adapter, '--model', 'test', '--model-version', 'test', '--stage', 'representative', '--repetitions', '3', '--out', out, '--review', review]);
  assert.equal(result.status, 1);
  const report = JSON.parse(readFileSync(out));
  assert.equal(report.plannedRuns, 24);
  assert.equal(report.runs.length, 1);
  assert.equal(report.stopped.reason.reason, 'credit_balance_exhausted');
  assert.deepEqual(report.runs[0].automatic.failures, []);
  const human = JSON.parse(readFileSync(review));
  assert.equal(human.reviewer, '');
  assert.equal(human.runs[0].useful, null);
  assert.equal(human.reportHash, hash(report));
});

test('comparison rejects changed settings, runtime, fixture, scorer, version and historical subscription', () => {
  const preflight = controlledPreflight([{ name: 'search_edunet', inputSchema: {} }], 'instructions');
  const audit = auditRequest(requestBody({ tools: preflight.tools, messages: [{ role: 'system', content: preflight.instructions }], settings: {} }), preflight);
  const report = { kind: 'model_run', model: 'test', modelVersion: 'test-version', settings: {}, environment: { node: process.version }, evaluationProfile: 'controlled_search',
    caseHash: 'test', stage: 'connection', selectedCaseIds: ['search-1'], repetitions: 1, plannedRuns: 1, preflight, provenance: provenance(),
    runs: [{ observedModelVersions: ['test-version'], requestAudits: [audit] }] };
  assert.equal(compareReports(report, report).comparable, true);
  for (const mutate of [r => r.settings.temperature = 1, r => r.environment.node = 'different', r => r.provenance.groups.fixture.hash = 'old', r => r.provenance.groups.scorer.hash = 'old', r => r.runs[0].observedModelVersions = [], r => r.evaluationProfile = 'codex_usage_unverified', r => r.runs[0].requestAudits = []]) {
    const other = structuredClone(report); mutate(other);
    assert.equal(compareReports(report, other).comparable, false);
  }
  const groups = provenance().groups;
  assert.ok(groups.product.files['dist/response.js']);
  assert.ok(groups.product.files['dist/http.js']);
  assert.ok(groups.runner.files['evals/environment.mjs']);
  for (const group of Object.values(groups)) assert.equal(group.hash, hash(group.files));
});
