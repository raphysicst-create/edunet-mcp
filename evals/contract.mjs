import { run } from 'node:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { args, writeJson } from './lib.mjs';

const options = args();
const files = ['tests', 'evals/tests'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.test.mjs')).map(f => resolve(dir, f)));
const results = [];
const start = performance.now();
// Run the existing tests once, not a second implementation of their assertions.
const stream = run({ files, concurrency: true });
for await (const event of stream) {
  if (['test:pass', 'test:fail'].includes(event.type)) {
    const d = event.data;
    results.push({ name: d.name, file: d.file, pass: event.type === 'test:pass', skipped: Boolean(d.skip), todo: Boolean(d.todo), durationMs: d.details?.duration_ms ?? null });
    console.log(`${event.type === 'test:pass' ? 'PASS' : 'FAIL'} ${d.name}`);
  }
}
const pass = results.length > 0 && results.every(r => r.pass && !r.skipped && !r.todo) && files.every(f => results.some(r => r.file === f));
writeJson(options.out ?? 'evals/results/contract.json', { suite: 'deterministic_contract', requiredSuccessRate: 1, pass,
  capturedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
  durationMs: Math.round(performance.now() - start), files, results });
console.log(`Contract: ${results.filter(r => r.pass).length}/${results.length}; ${pass ? 'PASS' : 'FAIL'}`);
process.exitCode = pass ? 0 : 1;
