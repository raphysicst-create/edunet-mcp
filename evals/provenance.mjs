import { readdirSync, readFileSync } from 'node:fs';
import { hash } from './lib.mjs';
import { validControlledEvidence } from './environment.mjs';

const files = (dir, suffix) => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`, suffix) : e.name.endsWith(suffix) ? [`${dir}/${e.name}`] : []);
export function provenance(adapterPath = 'evals/adapters/openai.mjs') {
  const groups = {
    runner: ['evals/ai.mjs', 'evals/lib.mjs', 'evals/environment.mjs', 'evals/provenance.mjs', 'evals/stages.mjs'],
    adapter: [adapterPath],
    fixture: ['evals/cases.mjs', 'evals/mock-backend.mjs', 'evals/mock-stdio-server.mjs'],
    scorer: ['evals/grade.mjs'],
    product: [...files('src', '.ts'), ...files('dist', '.js')],
    guidance: ['src/search-guidance.ts', 'dist/search-guidance.js', 'src/server.ts', 'dist/server.js'],
    dependencies: ['package.json', 'package-lock.json', 'tsconfig.json'],
  };
  return { version: '1.0.0', groups: Object.fromEntries(Object.entries(groups).map(([name, paths]) => {
    const hashes = Object.fromEntries(paths.sort().map(p => [name === 'adapter' ? 'selectedAdapter' : p, hash(readFileSync(p, 'utf8'))]));
    return [name, { files: hashes, hash: hash(hashes) }];
  })) };
}
export function compareReports(left, right) {
  const reasons = [];
  for (const key of ['model', 'modelVersion', 'settings', 'environment', 'evaluationProfile', 'caseHash', 'stage', 'selectedCaseIds', 'repetitions']) {
    if (left[key] === undefined || right[key] === undefined || hash(left[key]) !== hash(right[key])) reasons.push(`${key}_missing_or_changed`);
  }
  for (const key of ['runner', 'adapter', 'fixture', 'scorer', 'dependencies']) {
    const a = left.provenance?.groups?.[key]?.hash, b = right.provenance?.groups?.[key]?.hash;
    if (!a || !b || a !== b) reasons.push(`${key}_missing_or_changed`);
  }
  for (const report of [left, right]) {
    if (report.kind !== 'model_run' || report.evaluationProfile !== 'controlled_search' || !report.preflight?.pass || !report.runs?.length || report.runs.length !== report.plannedRuns || report.runs.some(r => !validControlledEvidence(report, r) || r.error || r.automatic?.harnessErrors?.length || r.observedModelVersions?.length !== 1 || r.observedModelVersions[0] !== report.modelVersion)) reasons.push('invalid_execution_or_version_evidence');
  }
  return { comparable: reasons.length === 0, reasons: [...new Set(reasons)], productDifferenceAllowed: true, leftReportHash: hash(left), rightReportHash: hash(right) };
}
