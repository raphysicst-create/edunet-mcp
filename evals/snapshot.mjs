// Archive only reproducible code/configuration; never .env, credentials or user settings.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { args, writeJson } from './lib.mjs';
import { provenance } from './provenance.mjs';

const { out } = args();
if (!out) throw new Error('Required: --out new-directory');
mkdirSync(dirname(resolve(out)), { recursive: true });
mkdirSync(out); // Exclusive directory creation; never merge into an old snapshot.
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const files = [...walk('src'), ...walk('dist'), ...walk('tests'),
  ...readdirSync('evals').filter(f => f.endsWith('.mjs')).map(f => `evals/${f}`),
  ...walk('evals/adapters'), ...walk('evals/tests'), ...walk('evals/fixtures'),
  'package.json', 'package-lock.json', 'tsconfig.json', 'evals/README.md'];
for (const file of files) {
  const target = resolve(out, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target, 1);
}
writeJson(resolve(out, 'snapshot.json'), { capturedAt: new Date().toISOString(), baseline: 'current_product_new_baseline',
  previousProductSnapshot: 'not_found_in_project_or_scratch; no_git_history', files, provenance: provenance() });
console.log(JSON.stringify({ output: out, files: files.length, includesCredentials: false }));
