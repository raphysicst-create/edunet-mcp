import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildVercel } from '../scripts/build-vercel.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function allFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await allFiles(join(directory, entry.name), `${path}/`));
    else files.push(path);
  }
  return files;
}

test('Vercel artifact runs outside the checkout with parser assets and a forked worker', { timeout: 120_000 }, async t => {
  const outputName = `test-output-${randomUUID()}`;
  const output = join(root, '.vercel', outputName);
  const isolated = await mkdtemp(join(tmpdir(), 'edunet-vercel-artifact-'));
  t.after(async () => {
    await rm(output, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  });
  const bundle = await buildVercel({ outputName });
  assert.ok(bundle.bytes < 200 * 1024 * 1024);
  const files = await allFiles(output);
  assert.ok(!files.some(path => /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.codex|evals)(?:\/|$)/.test(path)));
  assert.ok(!files.some(path => /node_modules\/(?:onnxruntime-|@huggingface\/|sharp\/|@img\/)/.test(path)));
  const config = JSON.parse(await readFile(join(bundle.functionDirectory, '.vc-config.json'), 'utf8'));
  const identity=JSON.parse(await readFile(join(bundle.functionDirectory,'dist/build-manifest.json'),'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(output,'static/build-manifest.json'),'utf8')),identity);
  assert.match(identity.sourceDigest,/^[a-f0-9]{64}$/);
  assert.ok(identity.files['src/achievement/official-listing.ts']);
  assert.ok(identity.files['config/achievement-source-registry.json']);
  assert.equal(config.runtime, 'nodejs24.x');
  assert.equal(config.handler, 'api/mcp.mjs');
  assert.equal(config.maxDuration, 60);
  const handlerRoot = join(isolated, 'function');
  // Outside the checkout, Node cannot accidentally resolve omitted packages from its node_modules.
  await cp(bundle.functionDirectory, handlerRoot, { recursive: true });
  await cp(join(root, 'tests/fixtures/achievement'), join(isolated, 'fixtures'), { recursive: true });
  await writeFile(join(handlerRoot, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { fork } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import handler from './api/mcp.mjs';
    import { runtimeBuildIdentity } from './dist/build-identity.js';
    import { parseDocument } from './dist/worker/parsers/index.js';
    import { extractAchievements } from './dist/worker/achievement/extract.js';
    import { PDFiumLibrary } from '@hyzyla/pdfium';
    assert.equal(typeof handler, 'function');
    assert.equal(runtimeBuildIdentity().sourceDigest,${JSON.stringify(identity.sourceDigest)});
    for (const [name, format] of [['synthetic-rows.pdf', 'pdf'], ['synthetic-merged.hwp', 'hwp'], ['synthetic-rows.hwpx', 'hwpx']]) {
      const data = await readFile(new URL('../fixtures/' + name, import.meta.url));
      const parsed = await parseDocument(data, format, { enableHwpx: true });
      assert.equal(extractAchievements(parsed, 'fixture').records.length, 3, name);
    }
    const pdfium = await PDFiumLibrary.init();
    pdfium.destroy();
    await new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./dist/worker/entry.js', import.meta.url)), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, EDUNET_REFERENCE_SECRET: 'artifact-test-secret-'.repeat(3) },
        execArgv: ['--max-old-space-size=256'],
      });
      let errorOutput = '';
      child.stderr.on('data', chunk => { errorOutput += chunk; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Worker failed to initialize: ' + errorOutput)); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('message', value => {
        clearTimeout(timeout);
        try { assert.equal(value.status, 'parse_failed'); assert.ok(value.warnings.length); resolve(); }
        catch (error) { reject(error); }
      });
      child.once('exit', code => { if (code !== 0) { clearTimeout(timeout); reject(new Error('Worker exit ' + code + ': ' + errorOutput)); } });
      child.send({ handle: 'invalid-reference-for-startup-check' });
    });
    console.log('isolated artifact verified');
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(name)));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['verify.mjs'], { cwd: handlerRoot, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /isolated artifact verified/);
});
