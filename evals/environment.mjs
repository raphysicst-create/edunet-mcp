import { hash } from './lib.mjs';

export const environmentVersion = '2.0.0';
export function controlledPreflight(tools, instructions) {
  const blockers = [];
  if (!Array.isArray(tools) || tools.length !== 1 || tools[0]?.name !== 'search_edunet' || !tools[0]?.inputSchema) blockers.push('unexpected_tool_surface');
  if (typeof instructions !== 'string' || !instructions.trim()) blockers.push('missing_common_instructions');
  const surface = { tools: structuredClone(tools), instructions };
  return { version: environmentVersion, profile: 'controlled_search', pass: blockers.length === 0,
    evidence: 'actual_mcp_tools_list_and_explicit_api_request', ...surface, surfaceHash: hash(surface),
    inheritedPersonalConfig: false, inheritedProjectInstructions: false, builtInTools: [],
    excluded: ['browser', 'shell', 'kordoc', 'other_mcp', 'AGENTS.md', 'CLAUDE.md', 'skills', 'plugins'],
    dataBoundary: 'Only messages and declared tool schema cross the model API boundary. No filesystem or fixture access tool is exposed.', blockers };
}

export function auditRequest(body, preflight) {
  const blockers = [];
  if (!preflight?.pass || preflight.profile !== 'controlled_search') blockers.push('preflight_not_passed');
  const expectedTools = preflight?.tools?.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
  if (hash(body.tools) !== hash(expectedTools)) blockers.push('request_tools_changed');
  const instructions = body.input?.filter(m => ['system', 'developer'].includes(m.role)) ?? [];
  if (instructions.length !== 1 || instructions[0].role !== 'system' || instructions[0].content !== preflight?.instructions) blockers.push('request_instructions_changed');
  if (body.instructions !== undefined || body.previous_response_id !== undefined || body.conversation !== undefined) blockers.push('uninspected_context');
  return { pass: !blockers.length, blockers, surfaceHash: preflight?.surfaceHash,
    tools: structuredClone(body.tools), instructions: structuredClone(instructions), requestHash: hash(body) };
}

export function validControlledEvidence(report, run) {
  const p = report.preflight;
  if (report.evaluationProfile !== 'controlled_search' || !p?.pass || p.version !== environmentVersion) return false;
  const checked = controlledPreflight(p.tools, p.instructions);
  if (!checked.pass || p.surfaceHash !== checked.surfaceHash || p.inheritedPersonalConfig !== false || p.inheritedProjectInstructions !== false || p.builtInTools?.length !== 0) return false;
  if (!Array.isArray(run.requestAudits) || !run.requestAudits.length) return false;
  const expectedTools = p.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
  return run.requestAudits.every(a => a.pass === true && a.blockers?.length === 0 && a.surfaceHash === p.surfaceHash &&
    hash(a.tools) === hash(expectedTools) && hash(a.instructions) === hash([{ role: 'system', content: p.instructions }]) && typeof a.requestHash === 'string');
}
