// Retrospective scoring writes a separate artifact. It cannot recreate a model
// run against today's fixtures, instructions, or controlled environment.
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, hash, readJson, writeJson } from './lib.mjs';
import { cases, caseVersion } from './cases.mjs';
import { gradeTrace, scorerVersion } from './grade.mjs';
import { provenance } from './provenance.mjs';

export function regradeReport(source) {
  const report = structuredClone(source);
  report.regrading = { sourceReportHash: hash(source), scorerVersion, caseVersion, caseHash: hash(cases),
    retrospective: true, comparableToCurrentModelRun: false, gradingProvenance: provenance() };
  for (const run of report.runs.filter(Boolean)) {
    const scenario = cases.find(c => c.id === run.id);
    if (scenario) {
      run.previousAutomatic = run.automatic;
      run.automatic = gradeTrace(scenario, run);
      run.automaticScoresStale = false;
    }
  }
  if (report.reaggregation) report.reaggregation.automaticScoresStale = report.runs.filter(Boolean).some(run => run.automaticScoresStale);
  return report;
}

export function writeRegrade(sourcePath, outputPath) {
  const extension = extname(sourcePath);
  const destination = outputPath ?? `${extension ? sourcePath.slice(0, -extension.length) : sourcePath}.regraded-v${scorerVersion}.json`;
  if (resolve(sourcePath).toLowerCase() === resolve(destination).toLowerCase() || existsSync(destination)) throw new Error('Regrading requires a new output path; existing reports are preserved.');
  const report = regradeReport(readJson(sourcePath));
  writeJson(destination, report);
  return { output: destination, recomputed: report.runs.filter(Boolean).length, scorerVersion, retrospective: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = args();
  console.log(JSON.stringify(writeRegrade(options.report ?? 'evals/results/2026-09-16-terra-subscription-run.json', options.out)));
}
