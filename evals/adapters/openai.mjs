// Responses API, stateless tool loop. Reference:
// https://developers.openai.com/api/docs/guides/function-calling
import { auditRequest } from '../environment.mjs';
export const kind = 'model';
export const evaluationProfile = 'controlled_search';
export function requestBody({ messages, tools, settings }) {
  const input = messages.flatMap(m => {
    if (m.role === 'assistant') return m.providerOutput ?? [];
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.toolCallId, output: JSON.stringify(m.result) }];
    return [{ role: m.role, content: m.content }];
  });
  const options = Object.fromEntries(['temperature', 'top_p', 'max_output_tokens', 'reasoning'].filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
  return { ...options, model: settings.model, input, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false,
    tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })) };
}
export async function next(context) {
  const body = requestBody(context);
  const audit = auditRequest(body, context.preflight);
  await context.recordRequestAudit?.(audit);
  if (!audit.pass) throw new Error('Model input isolation check failed');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error('Missing model credential'), { safeEvidence: { reason: 'missing_model_credential' } });
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', redirect: 'error', signal: context.signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(error => {
    const code = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code) ? error.cause.code : 'unclassified_transport_failure';
    throw Object.assign(new Error('Model network request failed'), { safeEvidence: { reason: 'network_failure', code } });
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const allowed = ['credit_balance_exhausted', 'insufficient_quota', 'invalid_api_key', 'model_not_found', 'rate_limit_exceeded'];
    throw Object.assign(new Error('Model request failed'), { safeEvidence: {
      httpStatus: response.status, reason: allowed.includes(data.error?.code) ? data.error.code : allowed.includes(data.error?.type) ? data.error.type : 'provider_request_rejected',
    } });
  }
  const data = await response.json();
  if (data.status !== 'completed' || !Array.isArray(data.output) || typeof data.model !== 'string') throw new Error('Incomplete model response');
  return {
    text: data.output.filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n'),
    toolCalls: data.output.filter(o => o.type === 'function_call').map(o => ({ id: o.call_id, name: o.name, arguments: JSON.parse(o.arguments) })),
    modelVersion: data.model,
    // Reasoning/tool items must be replayed with their tool outputs. They stay
    // in memory, not in the report or a remote stored conversation.
    providerOutput: data.output,
    usage: data.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : undefined,
  };
}
