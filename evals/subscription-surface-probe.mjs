// Offline CLI transport diagnostic. A local rejecting provider observes the
// emitted request; it never forwards requests and never loads authentication.
// This is NOT evidence of an actual ChatGPT subscription request.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, hash, writeJson, assertNewPaths, connect } from './lib.mjs';
import { cleanEnvironment } from './subscription-isolation.mjs';
import { searchInstructions } from '../dist/search-guidance.js';

export function inspectSurface(body) {
  const tools = [...(body.tools ?? []), ...(body.input ?? []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools ?? [])];
  const flatten = entries => entries.flatMap(t => t.type === 'namespace' ? flatten(t.tools ?? []) : [t]);
  const flat = flatten(tools);
  const names = flat.map(t => t.name ?? t.type);
  const nestedToolNames = flat.flatMap(t => [...(t.description ?? '').matchAll(/### `([^`]+)`/g)].map(m => m[1]));
  const isSearch = name => name === 'search_edunet' || /^mcp__edunet__search_edunet$/.test(name);
  const extras = names.filter(name => !isSearch(name));
  const additionalInstructions = (body.input ?? []).filter(m => ['system', 'developer'].includes(m.role) && m.type !== 'additional_tools')
    .flatMap(m => m.content ?? []).filter(c => c.type === 'input_text' && c.text !== searchInstructions).map(c => c.text);
  return { tools, toolNames: names, nestedToolNames, unexpectedTools: extras, additionalInstructions,
    searchOnly: flat.length === 1 && isSearch(names[0]),
    instructions: body.instructions ?? null, instructionHash: hash(body.instructions ?? null),
    input: body.input ?? [], model: body.model, requestHash: hash(body),
    hasHiddenConversation: body.previous_response_id !== undefined || body.conversation !== undefined };
}

export async function probeSubscriptionSurface(options) {
  const executable = resolve(options['codex-exe']);
  const base = mkdtempSync(join(options['temp-root'] ?? tmpdir(), 'edunet-surface-'));
  const home = join(base, 'home'), workspace = join(base, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const report = { kind: 'offline_cli_surface_diagnostic', profile: 'codex_usage_unverified', pass: false,
    requestedModel: 'gpt-5.6-terra', modelRunsStarted: 0, credentialsLoaded: false, forwardedRequests: 0,
    createdAt: new Date().toISOString(), strictConfig: true, transport: 'local_rejecting_http_provider',
    implementationHashes: Object.fromEntries(['evals/subscription-surface-probe.mjs', 'evals/subscription-isolation.mjs', 'evals/lib.mjs', 'evals/mock-stdio-server.mjs', 'dist/server.js', 'dist/schema.js', 'dist/search-guidance.js'].map(p => [p, hash(readFileSync(p, 'utf8'))])),
    environmentRoot: base, environmentAccessRequested: [], observedSurface: null, blockers: [],
    limitation: 'A local rejecting provider is not the subscription backend. Its request cannot certify the live subscription surface or resolved model version.' };
  let receive;
  const captured = new Promise(resolveCapture => { receive = resolveCapture; });
  const listener = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let bytes = ''; for await (const chunk of req) { bytes += chunk; if (bytes.length > 2_000_000) { req.destroy(); return; } }
    try { receive(inspectSurface(JSON.parse(bytes))); } catch { receive(null); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Offline inspection complete. No model invoked.', code: 'offline_probe' } }));
  });
  await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes); });
  const port = listener.address().port;
  const posix = p => p.replaceAll('\\', '/');
  const config = `model = "gpt-5.6-terra"
model_provider = "surface_probe"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
project_root_markers = [".eval-root"]
web_search = "disabled"
check_for_update_on_startup = false
sandbox_mode = "read-only"
approval_policy = "never"
cli_auth_credentials_store = "ephemeral"
[agents]
enabled = false
[features]
shell_tool = false
unified_exec = false
multi_agent = false
hooks = false
memories = false
remote_plugin = false
apps = false
browser_use = false
computer_use = false
image_generation = false
view_image = false
sleep_tool = false
goals = false
skill_search = false
skip_host_skill_discovery = true
code_mode_host = false
[skills]
config = []
[model_providers.surface_probe]
name = "Offline surface diagnostic"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.edunet]
command = ${JSON.stringify(posix(process.execPath))}
args = ${JSON.stringify([posix(resolve('evals/mock-stdio-server.mjs')), '--preflight'])}
enabled_tools = ["search_edunet"]
`;
  // TOML inline tables, with paths already normalized.
  const skillLine = 'config = [' + ['imagegen', 'openai-docs', 'plugin-creator', 'skill-creator', 'skill-installer'].map(name => `{ path = ${JSON.stringify(posix(join(home, 'skills/.system', name)))}, enabled = false }`).join(', ') + ']';
  const safeConfig = config.replace(/^config = .*$/m, skillLine);
  writeFileSync(join(home, 'config.toml'), safeConfig, { flag: 'wx' });
  writeFileSync(join(workspace, '.eval-root'), '', { flag: 'wx' });
  report.configHash = hash(safeConfig);
  const mcp = await connect(async () => { throw new Error('Diagnostic only'); });
  let searchTool;
  try { searchTool = (await mcp.client.listTools()).tools[0]; } finally { await mcp.close(); }
  report.searchToolSource = 'actual_in_memory_mcp_tools_list_registered_as_dynamic_tool_for_environmentless_probe';
  report.executableHash = hash(readFileSync(executable).toString('base64'));
  const child = spawn(executable, ['--strict-config', '-C', workspace, 'app-server', '--stdio'], { cwd: workspace, env: cleanEnvironment(home), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0, buffer = '', stderr = '';
  child.stderr.on('data', b => { stderr += b.toString(); });
  child.stdout.on('data', b => {
    buffer += b;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) { const { yes, no } = pending.get(message.id); pending.delete(message.id); message.error ? no(new Error('rpc_rejected')) : yes(message.result); }
    }
  });
  const rpc = (method, params) => new Promise((yes, no) => { const id = ++seq; pending.set(id, { yes, no }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  child.on('error', () => { for (const p of pending.values()) p.no(new Error('cli_spawn_failed')); pending.clear(); });
  child.on('exit', code => { report.cliExitCode = code; for (const p of pending.values()) p.no(new Error('cli_exited')); pending.clear(); });
  let timer;
  try {
    await Promise.race([(async () => {
      report.initialization = await rpc('initialize', { clientInfo: { name: 'edunet_offline_surface', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const started = await rpc('thread/start', { model: 'gpt-5.6-terra', modelProvider: 'surface_probe', cwd: workspace, ephemeral: true,
        environments: [], baseInstructions: searchInstructions, developerInstructions: '', approvalPolicy: 'never',
        dynamicTools: [{ type: 'function', name: searchTool.name, description: searchTool.description, inputSchema: searchTool.inputSchema, deferLoading: false }] });
      report.thread = { model: started.model, modelProvider: started.modelProvider };
      await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: '평가 환경 검사입니다. 광합성 자료를 찾아주세요.' }], environments: [] });
      report.observedSurface = await captured;
    })(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('probe_timeout')), 30_000); })]);
  } catch (e) { report.blockers.push(['rpc_rejected', 'cli_spawn_failed', 'cli_exited', 'probe_timeout'].includes(e.message) ? e.message : 'probe_failed'); }
  finally { clearTimeout(timer); child.kill(); listener.closeAllConnections(); await new Promise(yes => listener.close(yes)); }
  report.diagnosticStderr = stderr.slice(0, 12_000); // No credentials are present in this process.
  if (!report.observedSurface) report.blockers.push('request_surface_not_observed');
  else {
    if (!report.observedSurface.searchOnly) report.blockers.push('search_only_surface_not_achieved');
    if (report.observedSurface.additionalInstructions.length) report.blockers.push('additional_instructions_observed');
  }
  report.blockers.push('live_subscription_surface_unverified', 'fixture_read_boundary_unverified', 'resolved_subscription_model_version_unverified');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = args();
  assertNewPaths([options.out]);
  const report = await probeSubscriptionSurface(options);
  writeJson(options.out, report);
  console.log(JSON.stringify({ kind: report.kind, modelRunsStarted: 0, tools: report.observedSurface?.toolNames, blockers: report.blockers }));
  process.exitCode = report.pass ? 0 : 1;
}
