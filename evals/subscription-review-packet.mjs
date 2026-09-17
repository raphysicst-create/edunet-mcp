// Produce a human-only review index from already collected, redacted evidence.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args } from './lib.mjs';
const harnessErrors = run => [...(run.automatic?.harnessErrors ?? []), ...(run.fixtureErrors ?? []), ...(run.harnessErrors ?? [])];
export function reviewPacket(report) {
const scoresStale = run => run.automaticScoresStale || report.reaggregation?.automaticScoresStale;
const rows = report.runs.map((run, index) => {
  const findings = [...(run.automatic?.failures ?? []), ...(run.automatic?.critical ?? [])];
  if (scoresStale(run)) findings.unshift('STALE: regrade required');
  const evidence = `subscription-terra/${String(index + 1).padStart(3, '0')}-${run.id}-${run.repetition}/events.jsonl`;
  const otherTools = [...run.calls.filter(c => c.server && c.server !== 'edunet').map(c => `${c.server}/${c.name}`), ...(run.toolAttempts ?? []).map(t => t.name)];
  const harness = harnessErrors(run).map(error => typeof error === 'string' ? error : error.code ?? 'fixture_error');
  return `| ${run.id} | ${run.repetition} | ${run.calls.length} | ${findings.join(', ') || 'none'} | ${harness.join(', ') || 'none'} | ${otherTools.join(', ') || 'none'} | [event](${evidence}) |`;
});
const clean = report.runs.filter(run => run.automatic && !scoresStale(run) && !run.error && !run.automatic.failures.length && !run.automatic.critical.length && !harnessErrors(run).length).length;
return `# Subscription review packet\n\nThis packet is for a human reviewer. Do not infer any reviewer field from automated findings. Each event file contains the redacted Codex CLI JSON stream and actual mock-MCP results where a call completed.\n\n- Requested model: \`${report.requestedModel}\`; resolved snapshot: **unavailable from CLI JSON**.\n- Runs: ${report.runs.length}; CLI execution errors: ${report.runs.filter(r => r.error).length}.\n- Reaggregation: item ID deduplication repaired ${report.reaggregation?.repairedRuns ?? 0} runs.\n- Automated clean: ${clean}/${report.runs.length}. Harness errors and stale scores are excluded. This is not a release decision.\n- Human review must be bound to this report's hash; previously bound review files are not reusable after changes.\n\n| Case | Rep | MCP calls | Automated findings | Harness errors | Non-MCP tool attempts | Evidence |\n| --- | ---: | ---: | --- | --- | --- | --- |\n${rows.join('\n')}\n\nHuman reviewers must inspect the user request, actual MCP arguments/results, and final response before filling \`useful\`, \`grounded\`, critical fields, and non-empty notes in the JSON review file.\n`;
}

export function writeReviewPacket(reportPath, output) {
  const extension = extname(reportPath);
  const stem = extension ? reportPath.slice(0, -extension.length) : reportPath;
  const out = output ?? `${stem}.review-packet.md`;
  if (resolve(reportPath).toLowerCase() === resolve(out).toLowerCase() || existsSync(out)) throw new Error('Review packet requires a new output path; existing artifacts are preserved.');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, reviewPacket(report), { encoding: 'utf8', flag: 'wx' });
  return { packet: out, runs: report.runs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = args();
  console.log(JSON.stringify(writeReviewPacket(options.report ?? 'evals/results/2026-09-16-terra-subscription-run.json', options.out)));
}
