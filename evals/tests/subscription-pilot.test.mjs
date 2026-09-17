import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePilotEvents, summarizePilot, subscriptionBlocker } from '../subscription-pilot.mjs';
import { gradeTrace } from '../grade.mjs';
import { cases } from '../cases.mjs';

test('pilot aggregates one MCP call once and preserves completed results and subscription usage', () => {
  const item = { id: 'call-1', type: 'mcp_tool_call', server: 'edunet', tool: 'search_edunet', arguments: { query: '광합성' } };
  const events = [
    { type: 'thread.started', thread_id: 'fresh-1' }, { type: 'item.started', item },
    { type: 'item.completed', item: { ...item, result: { structured_content: { items: [] } } } },
    { type: 'item.completed', item: { type: 'agent_message', text: '메타데이터만 확인했습니다.' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } },
  ];
  const parsed = parsePilotEvents(events.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(parsed.calls.length, 1);
  assert.deepEqual(parsed.calls[0].result.structured_content.items, []);
  assert.equal(parsed.sessionId, 'fresh-1');
  assert.equal(parsed.turnCompleted, true);
  assert.equal(parsed.assistantMessages.length, 1);
  assert.equal(parsed.usage.input_tokens, 100);
});

test('pilot automatic clean never becomes release success and simultaneous environment/behavior findings survive', () => {
  const clean = { id: 'search-1', sessionId: 'one', turnCompleted: true, calls: [], toolAttempts: [], automatic: { failures: [], critical: [], harnessErrors: [] } };
  const bad = { ...clean, sessionId: 'two', automatic: { failures: ['missing_concept'], critical: [], harnessErrors: ['fixture_mismatch'] } };
  const summary = summarizePilot({ runs: [clean, bad] });
  assert.equal(summary.automaticClean, 1);
  assert.equal(summary.observedBehavioralViolationRuns, 1);
  assert.equal(summary.executionOrFixtureErrorRuns, 1);
  assert.equal(summary.unverifiedEnvironmentRuns, 2);
  assert.equal(summary.pendingHumanReview, 2);
  assert.equal(summary.releasePass, false);
  assert.equal(summary.controlledSuccessCount, 0);
});

test('pilot preserves metadata-only CLI errors for terminal grading without inventing isError', () => {
  const result = { _meta: { 'edunet/errorCode': 'TIMEOUT' }, content: [{ type: 'text', text: '요청 시간이 초과됐습니다.' }] };
  const item = { id: 'call-1', type: 'mcp_tool_call', server: 'edunet', tool: 'search_edunet', arguments: { query: '광합성' }, result };
  const events = [
    { type: 'item.completed', item },
    { type: 'item.completed', item: { ...item, id: 'call-2' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '시간 초과로 결과를 받지 못했습니다.' } },
    { type: 'turn.completed' },
  ];
  const parsed = parsePilotEvents(events.map(event => JSON.stringify(event)).join('\n'));
  const before = structuredClone(parsed);
  const scenario = cases.find(value => value.id === 'failure-4');
  const graded = gradeTrace(scenario, { ...parsed, final: parsed.assistantMessages.at(-1) });
  assert.ok(graded.failures.includes('retry_after_terminal_error'));
  assert.equal(parsed.calls[0].result.isError, undefined);
  assert.deepEqual(parsed.calls[0].result, result);
  assert.deepEqual(parsed, before);
  assert.equal(subscriptionBlocker(parsed, 0), null);
});

test('intentional fixture errors and assistant explanations never masquerade as subscription provider errors', () => {
  const success = { turnCompleted: true, events: [{ type: 'item.completed', item: { text: 'AUTHENTICATION: authentication failed. quota. too many requests.' } }] };
  assert.equal(subscriptionBlocker(success, 0), null);
  assert.equal(subscriptionBlocker({ ...success, turnCompleted: false }, 1), null);
  assert.equal(subscriptionBlocker({ turnCompleted: false, events: [{ type: 'error', message: 'usage limit reached' }] }, 1), 'subscription_limit_or_quota');
  assert.equal(subscriptionBlocker({ turnCompleted: false, events: [{ type: 'turn.failed', error: { message: 'unauthorized' } }] }, 1), 'subscription_authentication_failure');
});
