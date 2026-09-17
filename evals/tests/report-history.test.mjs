import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from '../lib.mjs';
import { cases, caseVersion } from '../cases.mjs';
import { reaggregateReport, writeReaggregation } from '../subscription-reaggregate.mjs';
import { reviewPacket, writeReviewPacket } from '../subscription-review-packet.mjs';
import { regradeReport } from '../subscription-regrade.mjs';

const source = () => ({ caseVersion: '1.0.0', caseHash: 'historic', requestedModel: 'synthetic', runs: [{
  id: 'search-1', repetition: 1, calls: [], final: 'before', automatic: { failures: [], critical: [] }, toolAttempts: [],
}] });
const events = [
  { type: 'item.started', item: { id: 'call-1', type: 'mcp_tool_call', tool: 'search_edunet', arguments: { query: '광합성' } } },
  { type: 'item.completed', item: { id: 'call-1', type: 'mcp_tool_call', status: 'completed', tool: 'search_edunet', result: { structured_content: { items: [] } } } },
  { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'after' } },
].map(event => JSON.stringify(event)).join('\n');

test('reaggregation deduplicates evidence without silently replacing historical rubric scores', () => {
  const original = source();
  const before = structuredClone(original);
  const report = reaggregateReport(original, [events]);
  assert.deepEqual(original, before);
  assert.equal(report.runs[0].calls.length, 1);
  assert.equal(report.runs[0].final, 'after');
  assert.deepEqual(report.runs[0].automatic, original.runs[0].automatic);
  assert.equal(report.runs[0].automaticScoresStale, true);
  assert.equal(report.caseVersion, '1.0.0');
  assert.equal(report.reaggregation.sourceReportHash, hash(original));
  assert.match(reviewPacket(report), /Automated clean: 0\/1/);
  assert.match(reviewPacket(report), /STALE: regrade required/);
  const regraded = regradeReport(report);
  assert.equal(regraded.runs[0].automaticScoresStale, false);
  assert.equal(regraded.reaggregation.automaticScoresStale, false);
  assert.equal(regraded.regrading.retrospective, true);
});

test('review packets distinguish harness errors and do not count them as automated clean', () => {
  const report = source();
  report.runs[0].automatic.harnessErrors = ['fixture_mismatch'];
  assert.match(reviewPacket(report), /Harness errors/);
  assert.match(reviewPacket(report), /fixture_mismatch/);
  assert.match(reviewPacket(report), /Automated clean: 0\/1/);
  report.runs[0].automatic.harnessErrors = [];
  report.runs[0].fixtureErrors = [{ code: 'FIXTURE_MISMATCH' }];
  assert.match(reviewPacket(report), /Automated clean: 0\/1/);
  delete report.runs[0].fixtureErrors;
  assert.match(reviewPacket(report), /Automated clean: 1\/1/);
});

test('reaggregation and packet writers preserve original artifacts and refuse existing outputs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'edunet-history-'));
  const logs = join(folder, 'logs');
  const runLogs = join(logs, '001-search-1-1');
  mkdirSync(runLogs, { recursive: true });
  const eventPath = join(runLogs, 'events.jsonl');
  writeFileSync(eventPath, events);
  try {
    const original = join(folder, 'original.json');
    const oldReview = join(folder, 'old-review.json');
    writeFileSync(original, JSON.stringify(source()));
    writeFileSync(oldReview, '{"historic":true}');
    const originalBytes = readFileSync(original);
    const reviewBytes = readFileSync(oldReview);
    const out = join(folder, 'copy.json');
    assert.throws(() => writeReaggregation({ report: original, logs, out: original }), /new output/);
    assert.throws(() => writeReaggregation({ report: original, logs, out, review: oldReview }), /new output/);
    assert.equal(existsSync(out), false);
    const result = writeReaggregation({ report: original, logs, out });
    assert.deepEqual(readFileSync(original), originalBytes);
    assert.deepEqual(readFileSync(oldReview), reviewBytes);
    assert.equal(JSON.parse(readFileSync(result.review)).reportHash, hash(JSON.parse(readFileSync(out))));
    assert.throws(() => writeReaggregation({ report: original, logs, out }), /new output/);
    assert.throws(() => writeReviewPacket(original, original), /new output/);
    const packet = writeReviewPacket(original);
    assert.throws(() => writeReviewPacket(original, packet.packet), /new output/);
    assert.deepEqual(readFileSync(original), originalBytes);
  } finally {
    unlinkSync(eventPath); rmdirSync(runLogs); rmdirSync(logs);
    for (const name of readdirSync(folder)) unlinkSync(join(folder, name));
    rmdirSync(folder);
  }
});

test('pilot report generation refuses changed historical case prompts before writing outputs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'edunet-pilot-history-'));
  const input = join(folder, 'original.json');
  const out = join(folder, 'report.md'), packet = join(folder, 'packet.md'), summary = join(folder, 'summary.json');
  try {
    for (const identity of [{ caseVersion: 'historic', caseHash: hash(cases) }, { caseVersion, caseHash: 'historic' }]) {
      writeFileSync(input, JSON.stringify({ ...source(), ...identity }));
      const before = readFileSync(input);
      const result = spawnSync(process.execPath, ['evals/subscription-pilot-report.mjs', '--report', input,
        '--out', out, '--packet', packet, '--summary', summary], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /case version\/hash differs/);
      for (const p of [out, packet, summary]) assert.equal(existsSync(p), false);
      assert.deepEqual(readFileSync(input), before);
    }
  } finally {
    unlinkSync(input); rmdirSync(folder);
  }
});
