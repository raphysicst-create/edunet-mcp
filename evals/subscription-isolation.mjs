import { writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { args, hash, writeJson, assertNewPaths } from './lib.mjs';
import { environmentVersion } from './environment.mjs';

const projectRoot = realpathSync(new URL('..', import.meta.url));
export function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function cleanEnvironment(home, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC)$/i.test(key)));
  // Child process only; never mutate user configuration or authentication.
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: home };
}
export function ancestorSources(workspace) {
  const found = [];
  for (let current = workspace;; current = dirname(current)) {
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.codex/config.toml', '.codex/AGENTS.md', '.agents/skills']) {
      const path = join(current, name);
      if (existsSync(path)) found.push({ path, action: 'detected_not_loaded_by_this_inspector' });
    }
    if (current === dirname(current)) break;
  }
  return found;
}
export async function inspectSubscription(options = {}) {
  const tempRoot = realpathSync(options['temp-root'] ?? tmpdir());
  if (inside(projectRoot, tempRoot)) throw new Error('Environment must be outside project');
  const base = mkdtempSync(join(tempRoot, 'edunet-eval-isolated-'));
  const home = join(base, 'home'); const workspace = join(base, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const env = cleanEnvironment(home);
  const server = resolve(projectRoot, 'evals/mock-stdio-server.mjs');
  const client = new Client({ name: 'evaluation-surface-inspector', version: environmentVersion });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--preflight'], env, stderr: 'pipe' });
  let tools; let instructions;
  try {
    await client.connect(transport);
    tools = (await client.listTools()).tools;
    instructions = client.getInstructions();
  } finally { await client.close(); }
  writeFileSync(join(home, 'instructions.md'), instructions, 'utf8');
  const posix = path => path.replaceAll('\\', '/');
  const effectiveSettings = {
    model: 'gpt-5.6-terra', model_instructions_file: posix(join(home, 'instructions.md')),
    project_doc_max_bytes: 0, project_doc_fallback_filenames: [], project_root_markers: ['.eval-root'],
    web_search: 'disabled', sandbox_mode: 'read-only', approval_policy: 'never',
    features: { shell_tool: false, unified_exec: false },
    mcp_servers: { edunet: { command: posix(process.execPath), args: [posix(server), '--preflight'], enabled: true, enabled_tools: ['search_edunet'] } },
  };
  const scalar = Object.entries(effectiveSettings).filter(([k]) => !['features', 'mcp_servers'].includes(k)).map(([k,v]) => `${k} = ${JSON.stringify(v)}`).join('\n');
  const config = `${scalar}\n[features]\nshell_tool = false\nunified_exec = false\n[mcp_servers.edunet]\ncommand = ${JSON.stringify(posix(process.execPath))}\nargs = ${JSON.stringify([posix(server), '--preflight'])}\nenabled = true\nenabled_tools = ["search_edunet"]\n`;
  writeFileSync(join(home, 'config.toml'), config, 'utf8');
  writeFileSync(join(workspace, '.eval-root'), '', 'utf8');
  const report = { version: environmentVersion, profile: 'codex_usage_unverified', pass: false,
    createdAt: new Date().toISOString(), environmentRoot: base, home, workspace,
    requestedSettings: effectiveSettings, configHash: hash(config), inheritedEnvironmentKeys: Object.keys(env),
    personalConfigCopied: false, authenticationCopied: false, privateFixturesPresent: false,
    registeredMcp: ['edunet'], excludedMcp: ['kordoc', 'all_other_personal_and_plugin_servers'],
    observedMcpSurface: { source: 'direct_stdio_initialize_and_tools_list', tools, instructions },
    observedCodexToolSurface: null, observedCodexPrompt: null, completeInstructionsVerified: false,
    ancestorSources: ancestorSources(workspace), blockers: [],
    limitations: ['MCP tools/list verifies EDUNET only, not Codex built-in tools.',
      'debug prompt-input does not expose the complete tool inventory or complete system instructions.',
      'read-only does not deny reading fixture files outside the workspace. No benchmark fixture is created by this preflight.'],
  };
  if (options['codex-exe']) {
    const executable = realpathSync(options['codex-exe']);
    report.executable = executable;
    const call = argv => spawnSync(executable, argv, { cwd: workspace, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const version = call(['--version']);
    report.cliVersion = version.status === 0 ? version.stdout.trim() : null;
    const probe = call(['-C', workspace, 'debug', 'prompt-input', '평가 환경 사전 검사']);
    report.promptInspectionExitCode = probe.status;
    if (probe.status === 0) {
      try { report.observedCodexPrompt = JSON.parse(probe.stdout); }
      catch { report.blockers.push('prompt_inspection_unparseable'); }
    } else report.blockers.push('prompt_inspection_failed');
    report.observedInstructionKinds = [...new Set((report.observedCodexPrompt ?? []).flatMap(m => m.internal_chat_message_metadata_passthrough?.content_item_kinds ?? []))];
  } else report.blockers.push('codex_executable_not_specified');
  report.blockers.push('complete_codex_tool_inventory_unavailable', 'complete_codex_instructions_unverified', 'fixture_read_boundary_unverified');
  if (report.ancestorSources.length) report.blockers.push('ancestor_instruction_sources_detected');
  return report;
}
export async function main() {
  const options = args();
  const output = options.out ?? 'evals/results/subscription-preflight.json';
  assertNewPaths([output]);
  if (options.mode && !['preflight', 'surface'].includes(options.mode)) throw new Error('Unsupported subscription mode; model collection requires verified isolation.');
  const report = options.mode === 'surface'
    ? await (await import('./subscription-surface-probe.mjs')).probeSubscriptionSurface(options)
    : await inspectSubscription(options);
  writeJson(output, report);
  console.log(JSON.stringify({ profile: report.profile, pass: report.pass, modelRunsStarted: 0,
    registeredMcp: report.registeredMcp, observedInstructionKinds: report.observedInstructionKinds, blockers: report.blockers }));
  // Never fall back to inherited settings or a prompt-only tool prohibition.
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('Subscription inspection failed; no model evaluation started.'); process.exitCode = 1;
});
