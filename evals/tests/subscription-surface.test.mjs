import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSurface } from '../subscription-surface-probe.mjs';
import { searchInstructions } from '../../dist/search-guidance.js';

test('subscription surface inspection includes tools embedded in additional_tools input items', () => {
  const body = { model: 'gpt-5.6-terra', input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'exec', description: '### `search_edunet`\nSearch\n### `skills__read`\nRead skill' },
    { type: 'function', name: 'request_user_input' },
  ] }] }] };
  const surface = inspectSurface(body);
  assert.equal(surface.searchOnly, false);
  assert.deepEqual(surface.toolNames, ['exec', 'request_user_input']);
  assert.deepEqual(surface.nestedToolNames, ['search_edunet', 'skills__read']);
  assert.equal(surface.model, 'gpt-5.6-terra');
  assert.ok(surface.requestHash);
});

test('search surface and instruction checks are independent and do not certify subscription isolation', () => {
  const body = { tools: [{ type: 'function', name: 'search_edunet' }], input: [
    { role: 'developer', content: [{ type: 'input_text', text: searchInstructions }, { type: 'input_text', text: 'Unexpected skill guidance' }] },
  ] };
  const surface = inspectSurface(body);
  assert.equal(surface.searchOnly, true);
  assert.deepEqual(surface.additionalInstructions, ['Unexpected skill guidance']);
  assert.equal(surface.pass, undefined);
  assert.equal(inspectSurface({}).searchOnly, false);
  assert.equal(inspectSurface({ ...body, previous_response_id: 'old' }).hasHiddenConversation, true);
});

test('subscription entrypoint rejects old output paths before creating an inspection environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'subscription-preserve-'));
  const output = join(root, 'old.json');
  writeFileSync(output, '{"humanEvidence":true}');
  const before = readFileSync(output);
  const run = spawnSync(process.execPath, ['evals/subscription.mjs', '--mode', 'surface', '--out', output], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.deepEqual(readFileSync(output), before);
});
