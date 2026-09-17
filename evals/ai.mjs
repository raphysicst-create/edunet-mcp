import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, caseVersion, fixtureVersion } from './cases.mjs';
import { args, containsSecret, hash, mockSession, readJson, reviewTemplate, writeJson, assertNewPaths, progressWriter } from './lib.mjs';
import { provenance, compareReports } from './provenance.mjs';
import { selectStage } from './stages.mjs';
import { gradeReport, gradeTrace, scorerVersion } from './grade.mjs';
import { controlledPreflight } from './environment.mjs';
import { searchGuidanceVersion } from '../dist/search-guidance.js';

export async function runCase(scenario, adapter, settings, timeoutMs = 60_000, evidenceSink = async () => {}) {
  const session = await mockSession(scenario);
  const start = performance.now();
  const run = { id: scenario.id, calls: [], assistantMessages: [], requestAudits: [], observedModelVersions: [], final: '', keyLeakDetected: false, usage: { inputTokens: 0, outputTokens: 0 }, usageAvailable: true };
  const messages = [{ role: 'system', content: session.instructions }, ...scenario.context, { role: 'user', content: scenario.user }];
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('adapter_timeout')); }, timeoutMs); });
  try {
    const tools = (await session.client.listTools()).tools;
    const preflight = controlledPreflight(tools, session.instructions);
    run.preflight = preflight;
    await evidenceSink({ stage: 'preflight', preflight });
    if (!preflight.pass) throw new Error('Unexpected MCP surface');
    for (let turn = 0; turn < 5; turn++) {
      // Rubrics, expected arguments and fixtures are never passed to the model.
      const reply = await Promise.race([adapter.next({ messages: structuredClone(messages), tools: structuredClone(tools), settings, signal: controller.signal,
        preflight: structuredClone(preflight), recordRequestAudit: async audit => {
          run.requestAudits.push(structuredClone(audit));
          await evidenceSink({ stage: 'before_model_request', preflight, requestAudits: run.requestAudits });
        } }), deadline]);
      if (!reply || typeof reply.text !== 'string' || !Array.isArray(reply.toolCalls)) throw new Error('invalid_adapter_response');
      run.assistantMessages.push(reply.text);
      if (reply.modelVersion && !run.observedModelVersions.includes(reply.modelVersion)) run.observedModelVersions.push(reply.modelVersion);
      if (containsSecret(reply)) run.keyLeakDetected = true;
      if (reply.usage && Number.isFinite(reply.usage.inputTokens) && reply.usage.inputTokens >= 0 && Number.isFinite(reply.usage.outputTokens) && reply.usage.outputTokens >= 0) {
        run.usage.inputTokens += reply.usage.inputTokens; run.usage.outputTokens += reply.usage.outputTokens;
      } else run.usageAvailable = false;
      messages.push({ role: 'assistant', ...reply });
      if (!reply.toolCalls.length) { run.final = reply.text; break; }
      const entries = reply.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments }));
      run.calls.push(...entries);
      if (run.calls.length > 4) throw new Error('call_budget_exceeded');
      for (const entry of entries) {
        const call = entry;
        if (call.name !== 'search_edunet') { entry.result = { isError: true, content: [{ type: 'text', text: 'Tool not available' }] }; }
        else entry.result = await session.client.callTool({ name: call.name, arguments: call.arguments });
        if (containsSecret(entry)) run.keyLeakDetected = true;
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, result: entry.result });
      }
    }
    if (!run.final) run.error = 'missing_final_or_turn_limit';
  } catch (error) {
    // Never persist raw SDK/provider errors, request headers or credentials.
    run.error = controller.signal.aborted ? 'adapter_timeout' : 'adapter_or_tool_failure';
    if (error.message === 'call_budget_exceeded') run.error = 'call_budget_exceeded';
    if (error.safeEvidence) run.providerFailure = error.safeEvidence;
  } finally { clearTimeout(timer); await session.close(); }
  run.fixtureErrors = session.fixtureErrors;
  run.durationMs = Math.round(performance.now() - start);
  if (!run.usageAvailable) run.usage = null;
  run.automatic = gradeTrace(scenario, run);
  return run;
}

async function main() {
  const options = args();
  if (options.mode === 'compare') {
    const result = compareReports(readJson(options.left), readJson(options.right));
    writeJson(options.out ?? 'evals/results/comparison.json', result);
    console.log(JSON.stringify(result));
    process.exitCode = result.comparable ? 0 : 1;
    return;
  }
  if (options.mode === 'preflight') {
    const session = await mockSession(cases[0]);
    try {
      const result = controlledPreflight((await session.client.listTools()).tools, session.instructions);
      writeJson(options.out ?? 'evals/results/controlled-preflight.json', { ...result, provenance: provenance() });
      console.log(JSON.stringify({ profile: result.profile, pass: result.pass, tools: result.tools.map(t => t.name), blockers: result.blockers }));
      process.exitCode = result.pass ? 0 : 1;
    } finally { await session.close(); }
    return;
  }
  if (options.mode === 'grade') {
    const result = gradeReport(readJson(options.report), options.review ? readJson(options.review) : undefined);
    writeJson(options.out ?? 'evals/results/ai-grade.json', result);
    console.log(JSON.stringify({ pass: result.pass, successCount: result.successCount, total: result.total, pendingReview: result.pendingReview, criticalCount: result.criticalCount, invalid: result.invalid }));
    process.exitCode = result.pass ? 0 : 1;
    return;
  }
  if (!options.adapter || !options.model || !options['model-version']) throw new Error('Required: --adapter path --model name --model-version version');
  const adapterPath = resolve(options.adapter);
  const adapter = await import(pathToFileURL(adapterPath).href);
  if (typeof adapter.next !== 'function') throw new Error('Adapter must export next');
  const repetitions = Number(options.repetitions ?? 3);
  if (![1, 3].includes(repetitions)) throw new Error('Repetitions must be 1 or 3');
  const stage = options.stage ?? 'full';
  const selected = selectStage(stage);
  if (stage === 'connection' && repetitions !== 1) throw new Error('Connection check requires --repetitions 1');
  const settings = options.settings ? readJson(options.settings) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
  const report = { kind: adapter.kind === 'smoke' ? 'smoke_only' : 'model_run', caseVersion, caseHash: hash(cases),
    stage, selectedCaseIds: selected.map(c => c.id), plannedRuns: selected.length * repetitions,
    baseline: 'current_product_new_baseline; no verified previous product snapshot located', provenance: provenance(adapterPath),
    fixtureVersion, scorerVersion, searchGuidanceVersion,
    implementationHashes: Object.fromEntries(['evals/mock-backend.mjs', 'evals/grade.mjs', 'dist/server.js', 'dist/schema.js', 'dist/search-guidance.js'].map(path => [path, hash(readFileSync(path, 'utf8'))])),
    evaluationProfile: adapterPath === resolve('evals/adapters/openai.mjs') ? 'controlled_search' : 'adapter_unverified',
    model: options.model, modelVersion: options['model-version'], settings, repetitions,
    adapterHash: hash(readFileSync(adapterPath, 'utf8')), startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch }, runs: [] };
  const output = options.out ?? 'evals/results/ai-run.json';
  const reviewPath = options.review ?? 'evals/results/ai-review.json';
  assertNewPaths([output, reviewPath, `${output}.surface`]);
  const writer = progressWriter(output);
  const reviewWriter = progressWriter(reviewPath);
  try {
  writer.write(report);
  reviewWriter.write({ status: 'collection_in_progress', reviewer: '', reviewedAt: '', runs: [] });
  collection: for (const scenario of selected) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const surfaceWriter = progressWriter(`${output}.surface/${scenario.id}-${repetition}.json`);
    let run;
    try {
    run = await runCase(scenario, adapter, { ...settings, model: options.model, modelVersion: options['model-version'] }, 60_000,
      async evidence => {
        report.preflight ??= evidence.preflight;
        writer.write(report);
        surfaceWriter.write({ id: scenario.id, repetition, recordedAt: new Date().toISOString(), ...evidence });
      });
    } finally { surfaceWriter.close(); }
    report.preflight ??= run.preflight;
    report.runs.push({ ...run, repetition });
    writer.write(report);
    console.log(`${scenario.id} ${repetition}/${repetitions}: ${run.error ?? 'recorded; human review required'}`);
    const versionUnverified = report.evaluationProfile === 'controlled_search' && (!run.observedModelVersions.length || run.observedModelVersions.some(v => v !== report.modelVersion));
    if (run.automatic.harnessErrors.length || versionUnverified) {
      report.stopped = { reason: run.providerFailure ?? (run.automatic.harnessErrors.length ? run.automatic.harnessErrors : ['unverified_or_changed_model_version']), recordedAttempts: report.runs.length };
      writer.write(report);
      break collection;
    }
  }
  // Bind review to the sanitized bytes that reviewers actually receive.
  reviewWriter.write(reviewTemplate(readJson(output)));
  } finally { writer.close(); reviewWriter.close(); }
  console.log(report.stopped ? 'Collection stopped; inspect recorded blockers. Not a completed performance evaluation.' : 'Collection complete. Release gate remains pending until human review and --mode grade.');
  if (report.stopped || report.runs.some(r => r.error)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('AI eval failed. Check documented arguments, adapter and local configuration. Raw errors omitted.'); process.exitCode = 1;
});
