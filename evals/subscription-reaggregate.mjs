// Repair only transport-event bookkeeping for a completed subscription run.
// It never reruns a model, changes a scenario, or changes a rubric.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, hash, readJson, reviewTemplate, writeJson } from './lib.mjs';

function parseEvents(text) {
  const calls = new Map(), assistantMessages = [], toolAttempts = [];
  let threadId = null, usage = null;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id ?? null;
    if (event.type === 'turn.completed' && event.usage) usage = { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null, cachedInputTokens: event.usage.cached_input_tokens ?? null, reasoningOutputTokens: event.usage.reasoning_output_tokens ?? null };
    const item = event.item; if (!item) continue;
    if (item.type === 'agent_message' && typeof item.text === 'string') assistantMessages.push(item.text);
    else if (item.type === 'mcp_tool_call') {
      const call = calls.get(item.id) ?? { id: item.id, server: item.server ?? null, name: item.tool, arguments: item.arguments };
      call.server = item.server ?? call.server;
      call.name = item.tool ?? call.name; call.arguments = item.arguments ?? call.arguments;
      if (item.status === 'completed') call.result = item.result;
      if (item.error) call.error = 'mcp_tool_error';
      calls.set(item.id, call);
    } else if (item.type?.includes('tool') || item.type === 'command_execution') toolAttempts.push({ type: item.type, name: item.tool ?? item.command ?? 'unknown' });
  }
  return { calls: [...calls.values()], assistantMessages, toolAttempts, threadId, usage };
}

export function reaggregateReport(source, eventTexts) {
  const report = structuredClone(source);
  if (eventTexts.length !== report.runs.length) throw new Error('run/log count mismatch');
  let repaired = 0, unresolved = 0;
  for (let index = 0; index < report.runs.length; index++) {
    const run = report.runs[index];
    const parsed = parseEvents(eventTexts[index]);
    if (!parsed.assistantMessages.length) unresolved++;
    if (run.calls.length !== parsed.calls.length || run.calls.some(c => !c.result)) repaired++;
    run.calls = parsed.calls; run.toolAttempts = parsed.toolAttempts; run.assistantMessages = parsed.assistantMessages;
    run.final = parsed.assistantMessages.at(-1) ?? ''; run.sessionId = parsed.threadId; run.usage = parsed.usage;
    // Preserve historical findings; changed transport evidence must be explicitly
    // regraded and reviewed before those findings can be treated as current.
    run.automaticScoresStale = true;
  }
  report.reaggregatedAt = new Date().toISOString();
  report.reaggregation = { source: 'codex_cli_json_item_id', sourceReportHash: hash(source),
    repairedRuns: repaired, unresolvedRuns: unresolved, automaticScoresStale: true };
  return report;
}

export function writeReaggregation({ report: sourcePath, logs: logRoot, out, review }) {
  const extension = extname(sourcePath);
  const stem = extension ? sourcePath.slice(0, -extension.length) : sourcePath;
  const destination = out ?? `${stem}.reaggregated.json`;
  const reviewPath = review ?? `${stem}.reaggregated-review.json`;
  const paths = [sourcePath, destination, reviewPath].map(path => resolve(path).toLowerCase());
  if (new Set(paths).size !== paths.length || existsSync(destination) || existsSync(reviewPath)) throw new Error('Reaggregation requires new output and review paths; existing artifacts are preserved.');
  const events = readdirSync(logRoot).sort().map(dir => readFileSync(resolve(logRoot, dir, 'events.jsonl'), 'utf8'));
  const report = reaggregateReport(readJson(sourcePath), events);
  writeJson(destination, report);
  writeJson(reviewPath, reviewTemplate(readJson(destination)));
  return { output: destination, review: reviewPath, runs: report.runs.length,
    repaired: report.reaggregation.repairedRuns, unresolved: report.reaggregation.unresolvedRuns, automaticScoresStale: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = args();
  console.log(JSON.stringify(writeReaggregation({ report: options.report ?? 'evals/results/2026-09-16-terra-subscription-run.json',
    logs: options.logs ?? 'evals/results/subscription-terra', out: options.out, review: options.review })));
}
