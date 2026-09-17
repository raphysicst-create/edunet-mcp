import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canary, containsSecret, writeJson } from '../lib.mjs';

test('report writer masks raw and escaped secrets while preserving pre-redaction evidence', () => {
  const folder = mkdtempSync(join(tmpdir(), 'edunet-eval-security-'));
  const path = join(folder, 'report.json');
  const previous = process.env.OPENAI_API_KEY;
  const synthetic = 'synthetic-quote"slash\\credential';
  try {
    process.env.OPENAI_API_KEY = synthetic;
    const value = { final: `${synthetic} ${encodeURIComponent(canary)}`, keyLeakDetected: true, settings: { apiKey: 'synthetic-nested-key' } };
    assert.equal(containsSecret(value), true);
    writeJson(path, value);
    const written = readFileSync(path, 'utf8');
    const report = JSON.parse(written);
    assert.equal(report.keyLeakDetected, true);
    assert.equal(report.settings.apiKey, '[REDACTED]');
    assert.ok(!report.final.includes(synthetic));
    assert.ok(!written.includes(encodeURIComponent(canary)));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    unlinkSync(path); rmdirSync(folder);
  }
});
