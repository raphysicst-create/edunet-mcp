import assert from 'node:assert/strict';
import test from 'node:test';
import { controlledPreflight, auditRequest } from '../environment.mjs';
import { cleanEnvironment, inside, inspectSubscription } from '../subscription-isolation.mjs';
import { requestBody, next } from '../adapters/openai.mjs';
const tools = [{ name: 'search_edunet', description: 'search', inputSchema: { type: 'object' } }];

test('only exact EDUNET schema and common instructions can cross the API boundary', async () => {
  const preflight = controlledPreflight(tools, 'common instructions');
  assert.equal(preflight.pass, true);
  for (const name of ['kordoc', 'browser', 'shell']) assert.equal(controlledPreflight([...tools, { name }], 'instructions').pass, false);
  const make = () => requestBody({ tools, messages: [{ role: 'system', content: preflight.instructions }], settings: {} });
  assert.equal(auditRequest(make(), preflight).pass, true);
  for (const mutate of [b => b.tools.push({ type: 'web_search' }), b => b.input.push({ role: 'developer', content: 'personal instructions' }), b => { b.conversation = 'old-session'; }]) {
    const body = make(); mutate(body); assert.equal(auditRequest(body, preflight).pass, false);
  }
  let fetched = false; const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { fetched = true; throw new Error('must never fetch'); };
    await assert.rejects(next({ tools: [...tools, { name: 'kordoc' }], messages: [{ role: 'system', content: preflight.instructions }], settings: {}, preflight }), /isolation/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = oldFetch; }
});

test('subscription process does not inherit personal settings, keys, hooks or Node injection', () => {
  const env = cleanEnvironment('/isolated/home', { PATH: 'runtime', SystemRoot: 'windows', CODEX_HOME: '/personal', OPENAI_API_KEY: 'secret', EDUNET_API_KEY: 'secret', NODE_OPTIONS: '--require evil', CODEX_INSTRUCTIONS: 'personal' });
  assert.equal(env.CODEX_HOME, '/isolated/home');
  for (const k of ['OPENAI_API_KEY', 'EDUNET_API_KEY', 'NODE_OPTIONS', 'CODEX_INSTRUCTIONS']) assert.equal(env[k], undefined);
  assert.equal(inside('/project', '/project/evals'), true);
  assert.equal(inside('/project', '/project-other'), false);
});

test('fresh subscription preflight verifies actual stdio tool but never assumes full CLI isolation', async () => {
  const report = await inspectSubscription();
  assert.equal(report.pass, false);
  assert.equal(report.profile, 'codex_usage_unverified');
  assert.equal(report.authenticationCopied, false);
  assert.equal(report.personalConfigCopied, false);
  assert.equal(report.privateFixturesPresent, false);
  assert.deepEqual(report.observedMcpSurface.tools.map(t => t.name), ['search_edunet']);
  assert.equal(report.observedCodexToolSurface, null);
  assert.ok(report.blockers.includes('complete_codex_tool_inventory_unavailable'));
});
