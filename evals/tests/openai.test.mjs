import assert from 'node:assert/strict';
import test from 'node:test';
import { requestBody, next } from '../adapters/openai.mjs';
import { controlledPreflight } from '../environment.mjs';
const tools = [{ name: 'search_edunet', description: 'search', inputSchema: { type: 'object' } }];
const context = () => ({ messages: [{ role: 'system', content: 'instructions' }], tools, settings: { model: 'test' }, preflight: controlledPreflight(tools, 'instructions') });

test('model adapter preserves reasoning and call IDs and sends only supported settings', () => {
  const output = [{ type: 'reasoning', encrypted_content: 'synthetic' }, { type: 'function_call', call_id: 'c1', name: 'search_edunet', arguments: '{"query":"광합성"}' }];
  const body = requestBody({ messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'query' },
    { role: 'assistant', providerOutput: output }, { role: 'tool', toolCallId: 'c1', result: { ok: true } }],
    tools: [{ name: 'search_edunet', description: 'search', inputSchema: { type: 'object' } }],
    settings: { model: 'test', modelVersion: 'test-snapshot', max_output_tokens: 2000, apiKey: 'must-not-send', store: true } });
  assert.equal(body.store, false);
  assert.equal(body.apiKey, undefined);
  assert.deepEqual(body.input.slice(2, 4), output);
  assert.equal(body.input[4].call_id, 'c1');
  assert.equal(body.tools[0].strict, false);
});

test('model adapter records returned version and token usage without real network access', async () => {
  const originalFetch = globalThis.fetch; const originalKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'synthetic-model-credential';
    let auditSaved = false;
    globalThis.fetch = async (url, options) => {
      assert.equal(auditSaved, true, 'inspection must be recorded before network request');
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ status: 'completed', model: 'test-snapshot', usage: { input_tokens: 42, output_tokens: 7 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }));
    };
    const result = await next({ ...context(), recordRequestAudit: async audit => { assert.equal(audit.pass, true); auditSaved = true; } });
    assert.equal(result.modelVersion, 'test-snapshot');
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 7 });
    assert.equal(result.text, 'done');
    globalThis.fetch = async () => new Response('sensitive upstream error', { status: 401 });
    await assert.rejects(next(context()), { message: 'Model request failed' });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'credit_balance_exhausted', message: 'sensitive upstream text' } }), { status: 429 });
    await assert.rejects(next(context()), error => {
      assert.deepEqual(error.safeEvidence, { httpStatus: 429, reason: 'credit_balance_exhausted' });
      assert.ok(!JSON.stringify(error).includes('sensitive'));
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
