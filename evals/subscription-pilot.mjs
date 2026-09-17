// Explicitly opt-in observational subscription experiment. Never a release gate.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, caseVersion, fixtureVersion } from './cases.mjs';
import { args, hash, containsSecret, writeJson, readJson, progressWriter, assertNewPaths, reviewTemplate, mockSession } from './lib.mjs';
import { gradeTrace, scorerVersion } from './grade.mjs';
import { provenance } from './provenance.mjs';
import { cleanEnvironment } from './subscription-isolation.mjs';
import { searchGuidanceVersion } from '../dist/search-guidance.js';

export function parsePilotEvents(stdout) {
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = new Map(), otherTools = new Map(), assistantMessages = [];
  let sessionId = null, usage = null, turnCompleted = false;
  for (const event of events) {
    if (event.type === 'thread.started') sessionId = event.thread_id;
    if (event.type === 'turn.completed') { turnCompleted = true; usage = event.usage ?? null; }
    const item = event.item;
    if (!item) continue;
    if (item.type === 'agent_message' && typeof item.text === 'string' && event.type === 'item.completed') assistantMessages.push(item.text);
    if (item.type === 'mcp_tool_call') {
      const old = calls.get(item.id) ?? { id: item.id };
      Object.assign(old, { server: item.server, name: item.tool, arguments: item.arguments });
      if (item.result) old.result = item.result;
      if (item.error) old.error = 'mcp_tool_error';
      calls.set(item.id, old);
    } else if (item.type?.includes('tool') || item.type === 'command_execution') otherTools.set(item.id, { id: item.id, type: item.type, name: item.tool ?? item.command ?? 'unknown' });
  }
  return { events, calls: [...calls.values()], toolAttempts: [...otherTools.values()], assistantMessages, sessionId, usage, turnCompleted };
}

export function subscriptionBlocker(parsed, exitCode, stderr = '') {
  // Never inspect assistant/tool content for provider errors: authentication,
  // quota and network failures can be intentional EDUNET fixture responses.
  if (exitCode === 0 && parsed.turnCompleted) return null;
  const failures = parsed.events.filter(e => e.type === 'error' || e.type === 'turn.failed');
  const text = JSON.stringify(failures) + (exitCode !== 0 ? stderr : '');
  if (/usage limit|rate.?limit|quota|credits|too many requests/i.test(text)) return 'subscription_limit_or_quota';
  if (/unauthorized|not logged in|authentication.*fail|refresh.*token.*fail/i.test(text)) return 'subscription_authentication_failure';
  return null;
}

export function summarizePilot(report) {
  const runs = report.runs;
  const count = predicate => runs.filter(predicate).length;
  const behavioral = r => r.automatic.failures.length || r.automatic.critical.length || r.toolAttempts.length;
  const environment = r => r.error || r.automatic.harnessErrors.length;
  const tally = values => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
  return { planned: 90, recorded: runs.length, completedResponses: count(r => r.turnCompleted && !r.error), uniqueSessions: new Set(runs.map(r => r.sessionId).filter(Boolean)).size,
    automaticClean: count(r => !behavioral(r) && !environment(r)), observedBehavioralViolationRuns: count(behavioral),
    executionOrFixtureErrorRuns: count(environment), unverifiedEnvironmentRuns: runs.length, pendingHumanReview: runs.length, pendingVersionVerification: runs.length,
    automaticCriticalRuns: count(r => r.automatic.critical.length), releasePass: false, controlledSuccessCount: 0,
    denominator: runs.length, classificationNote: 'Counts overlap; automatic clean is not human-reviewed success. All runs have unverified environment/version. No eligible controlled product failure denominator.',
    failures: tally(runs.flatMap(r => r.automatic.failures)), critical: tally(runs.flatMap(r => r.automatic.critical)),
    harnessErrors: tally(runs.flatMap(r => r.automatic.harnessErrors.map(e => typeof e === 'string' ? e : e.code ?? 'fixture_error'))),
    totalCalls: runs.reduce((n, r) => n + r.calls.length, 0),
    tokenUsage: runs.reduce((s, r) => ({ input: s.input + (r.usage?.input_tokens ?? 0), cached: s.cached + (r.usage?.cached_input_tokens ?? 0), output: s.output + (r.usage?.output_tokens ?? 0) }), { input: 0, cached: 0, output: 0 }),
    perCase: cases.map(c => { const subset = runs.filter(r => r.id === c.id); return { id: c.id, group: c.group, runs: subset.length,
      clean: subset.filter(r => !behavioral(r) && !environment(r)).length, failures: [...new Set(subset.flatMap(r => r.automatic.failures))],
      critical: [...new Set(subset.flatMap(r => r.automatic.critical))], environmentErrors: subset.filter(environment).length }; }) };
}

async function main() {
  const options = args();
  if (options['allow-unverified'] !== 'true') throw new Error('This pilot requires explicit acceptance of unverified subscription observations.');
  const output = options.out, review = options.review, artifactRoot = options.artifacts;
  assertNewPaths([output, review, artifactRoot]);
  const executable = resolve(options['codex-exe']);
  const authHome = resolve(options['auth-home']);
  const concurrency = Number(options.concurrency ?? 3);
  if (![1, 2, 3].includes(concurrency)) throw new Error('Concurrency must be 1..3');
  const base = mkdtempSync(join(tmpdir(), 'edunet-subscription-pilot-'));
  mkdirSync(artifactRoot, { recursive: true });
  // Native CLI reads its normal subscription authentication. No credential
  // copying, no API key, no global config writes. Personal instruction/capability
  // inheritance remains unverified even with --ignore-user-config.
  const env = { ...cleanEnvironment(resolve(authHome, '..')), CODEX_HOME: authHome };
  const version = spawnSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  const auth = spawnSync(executable, ['login', 'status'], { env, encoding: 'utf8', timeout: 10_000 });
  const authText = `${auth.stdout ?? ''}\n${auth.stderr ?? ''}`;
  const subscriptionAuthenticated = auth.status === 0 && /ChatGPT/i.test(authText) && !/API key/i.test(authText);
  const session = await mockSession(cases[0]);
  let surface;
  try { surface = { tools: (await session.client.listTools()).tools, instructions: session.instructions }; } finally { await session.close(); }
  const report = { kind: 'subscription_model_run', evaluationProfile: 'codex_usage_unverified', releaseEligible: false,
    experiment: '30_cases_x_3_fresh_subscription_sessions', requestedModel: 'gpt-5.6-terra', model: 'gpt-5.6-terra', modelVersion: null,
    repetitions: 3, plannedRuns: 90, caseVersion, caseHash: hash(cases), fixtureVersion, scorerVersion, searchGuidanceVersion,
    provenance: provenance('evals/subscription-pilot.mjs'), runnerHash: hash(readFileSync('evals/subscription-pilot.mjs', 'utf8')),
    executableHash: hash(readFileSync(executable).toString('base64')), cliVersion: version.stdout?.trim() ?? null,
    subscriptionAuthenticated, modelCallsViaApiAdapter: 0, startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    settings: { freshSessionPerCase: true, ephemeral: true, ignoreUserConfig: true, sandbox: 'read-only', reasoningEffort: 'medium', concurrency },
    preflight: { pass: false, profile: 'codex_usage_unverified', observedMcpSurface: surface,
      blockers: ['native_tool_and_instruction_surface_unverified', 'fixture_read_boundary_unverified', 'resolved_model_version_unverified'] },
    limitations: ['Observational pilot explicitly requested by user; does not bypass the controlled release gate.',
      'Native subscription authentication reused without copying credentials; personal capability inheritance unverified.',
      'Fixtures are outside each empty workspace but OS read denial is not established.',
      'Prompt restrictions are instructions, not enforced tool isolation.', 'Human review is pending for every run.'], runs: [] };
  if (options['continue-from']) {
    const source = readJson(options['continue-from']);
    if (source.kind !== report.kind || source.caseHash !== report.caseHash || source.scorerVersion !== report.scorerVersion ||
      source.model !== report.model || hash(source.settings) !== hash(report.settings) ||
      ['product', 'fixture', 'scorer', 'dependencies'].some(k => source.provenance.groups[k].hash !== report.provenance.groups[k].hash)) throw new Error('Continuation conditions differ');
    const seen = new Set();
    for (const run of source.runs) {
      if (!cases.some(c => c.id === run.id) || ![1, 2, 3].includes(run.repetition) || seen.has(`${run.id}:${run.repetition}`)) throw new Error('Invalid continuation source');
      seen.add(`${run.id}:${run.repetition}`);
      const retained = structuredClone(run);
      retained.sourceReportHash = hash(source);
      if (retained.providerBlocker && retained.cliExitCode === 0 && retained.turnCompleted) {
        retained.previousProviderBlocker = retained.providerBlocker;
        retained.providerBlocker = null;
        retained.providerBlockerCorrection = 'Successful CLI turn was misclassified from intentional EDUNET fixture text; source artifact preserved.';
      }
      report.runs.push(retained);
    }
    report.continuation = { sourcePath: options['continue-from'], sourceReportHash: hash(source), sourceRunnerHash: source.runnerHash,
      sourceStopped: source.stopped ?? null, retainedRuns: source.runs.length, resumedAt: report.startedAt,
      reason: 'Fix provider error classification; retain completed sessions and collect only missing scenario repetitions.' };
    report.startedAt = source.startedAt;
  }
  const writer = progressWriter(output), reviewWriter = progressWriter(review);
  let stop = false;
  const runOne = async (scenario, repetition, sequence) => {
    const dir = join(artifactRoot, `${String(sequence).padStart(3, '0')}-${scenario.id}-${repetition}`);
    mkdirSync(dir);
    const workspace = join(base, `session-${sequence}`); mkdirSync(workspace);
    writeFileSync(join(workspace, '.eval-root'), '', { flag: 'wx' });
    const fixture = join(base, `fixture-${sequence}.json`);
    writeFileSync(fixture, JSON.stringify({ id: scenario.id, mockApiResponses: scenario.mockApiResponses }), { flag: 'wx' });
    const posix = s => s.replaceAll('\\', '/');
    const mcp = `mcp_servers={edunet={command=${JSON.stringify(posix(process.execPath))},args=[${JSON.stringify(posix(resolve('evals/mock-stdio-server.mjs')))},${JSON.stringify(posix(fixture))}],cwd=${JSON.stringify(posix(resolve('.')))},enabled=true,enabled_tools=["search_edunet"],startup_timeout_sec=20,tool_timeout_sec=60}}`;
    const prompt = `${scenario.context.map(m => m.content).join('\n')}\n\n${scenario.user}\n\n에듀넷 MCP의 search_edunet으로 답하세요. 셸·파일·브라우저·다른 MCP는 사용하지 마세요. 검색 결과는 메타데이터 발췌이며 원문·첨부파일은 읽지 않습니다.`;
    const argv = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--model', 'gpt-5.6-terra', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', workspace,
      '-c', mcp, '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'project_doc_fallback_filenames=[]', '-c', 'agents.enabled=false', '-c', 'features.hooks=false', '-c', 'model_reasoning_effort="medium"', prompt];
    writeJson(join(dir, 'invocation.json'), { sequence, id: scenario.id, repetition, model: report.model, argv, fixtureHash: hash(scenario.mockApiResponses), credentialValuesRecorded: false });
    const start = Date.now();
    const child = spawn(executable, argv, { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    const exitCode = await new Promise(done => { child.once('error', () => done(-1)); child.once('close', done); });
    clearTimeout(timer);
    const parsed = parsePilotEvents(stdout);
    const { events, ...evidence } = parsed;
    const run = { id: scenario.id, repetition, sequence, ...evidence, durationMs: Date.now() - start,
      cliExitCode: exitCode, observedModelVersions: [], final: parsed.assistantMessages.at(-1) ?? '',
      keyLeakDetected: containsSecret({ stdout, stderr }), evidenceDirectory: dir.replaceAll('\\', '/') };
    if (timedOut) run.error = 'adapter_timeout';
    else if (exitCode !== 0 || !parsed.turnCompleted) run.error = 'codex_cli_failure';
    else if (!run.final) run.error = 'missing_final_or_turn_limit';
    run.providerBlocker = subscriptionBlocker(parsed, exitCode, stderr);
    run.automatic = gradeTrace(scenario, run);
    if (run.toolAttempts.length || run.calls.some(c => c.server !== 'edunet')) run.automatic.failures.push('observed_out_of_scope_tool');
    writeJson(join(dir, 'events.json'), events);
    writeJson(join(dir, 'result.json'), run);
    // Raw stderr is deliberately not persisted; it may include provider details.
    writeJson(join(dir, 'execution.json'), { exitCode, timedOut, stderrBytes: Buffer.byteLength(stderr), providerBlocker: run.providerBlocker });
    report.runs.push(run); report.runs.sort((a, b) => a.sequence - b.sequence);
    writer.write(report);
    console.log(`${report.runs.length}/90 ${scenario.id} rep=${repetition} calls=${run.calls.length} failures=${run.automatic.failures.join(',') || '-'} environment=${run.error ?? (run.automatic.harnessErrors.length ? 'fixture_error' : '-')} seconds=${Math.round(run.durationMs / 1000)}`);
    if (run.providerBlocker || run.error === 'codex_cli_failure') { stop = true; report.stopped = { reason: run.providerBlocker ?? run.error, sequence }; writer.write(report); }
    return run;
  };
  try {
    writer.write(report); reviewWriter.write({ status: 'collection_in_progress', reviewer: '', reviewedAt: '', runs: [] });
    if (!subscriptionAuthenticated) { report.stopped = { reason: 'subscription_auth_not_confirmed' }; stop = true; }
    const queue = cases.flatMap(scenario => [1, 2, 3].map(repetition => ({ scenario, repetition })))
      .map((job, index) => ({ ...job, sequence: index + 1 }))
      .filter(job => !report.runs.some(r => r.id === job.scenario.id && r.repetition === job.repetition));
    // One actual fresh-session check before the remaining 89; its unchanged
    // scenario is part of the 90, not a separate or reused warm-up conversation.
    if (!stop && queue.length) await runOne(queue[0].scenario, queue[0].repetition, queue[0].sequence);
    let next = 1;
    const worker = async () => { while (!stop && next < queue.length) { const index = next++; await runOne(queue[index].scenario, queue[index].repetition, queue[index].sequence); } };
    if (!stop) await Promise.all(Array.from({ length: concurrency }, worker));
    report.completedAt = new Date().toISOString(); report.summary = summarizePilot(report);
    writer.write(report); reviewWriter.write(reviewTemplate(readJson(output)));
    console.log(JSON.stringify(report.summary));
  } finally { writer.close(); reviewWriter.close(); }
  if (report.runs.length !== 90) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Subscription pilot runner failed; raw error omitted. Preserve partial artifacts.'); process.exitCode = 1; });
