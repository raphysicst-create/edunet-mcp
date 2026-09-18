import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const normalize = value => value.replaceAll('\\', '/');
const disabledDependencies = /(?:^|\/)node_modules\/(?:onnxruntime-[^/]+|@huggingface|sharp|@img|puppeteer(?:-core)?)(?:\/|$)/;
const privateFiles = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.codex)(?:\/|$)/;
const dataFiles = ['config/achievement-source-registry.json', 'config/document-profiles/korean-achievement-v1.json'];
const sizeLimit = 200 * 1024 * 1024;

function assertInside(root, candidate) {
  const path = relative(root, candidate);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Build path is outside its expected directory');
}

async function filesWithin(root, directory) {
  const output = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = normalize(join(directory, entry.name));
    if (privateFiles.test(path)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Unsupported package symlink: ${path}`);
    if (entry.isDirectory()) output.push(...await filesWithin(root, path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function allowedFile(path) {
  if (privateFiles.test(path) || disabledDependencies.test(path)) return false;
  if (path.endsWith('.map') || /\.d\.(?:ts|mts|cts)$/.test(path)) return false;
  return path === 'api/mcp.mjs' || path === 'package.json' || dataFiles.includes(path) ||
    /^dist\/.*\.js$/.test(path) || path.startsWith('node_modules/');
}

/** Preserve Node's directory structure: the document worker forks a separate JS entry. */
export async function buildVercel({ root = projectRoot, outputName = 'output' } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(outputName)) throw new Error('Invalid build output directory name');
  root = await realpath(root);
  const vercelRoot = join(root, '.vercel');
  await mkdir(vercelRoot, { recursive: true });
  if ((await lstat(vercelRoot)).isSymbolicLink()) throw new Error('The .vercel directory must not be a symlink');
  const output = resolve(vercelRoot, outputName);
  assertInside(vercelRoot, output);
  const functionDirectory = join(output, 'functions', 'api', 'mcp.func');

  const entries = ['api/mcp.mjs', 'dist/worker/entry.js'];
  for (const path of [...entries, ...dataFiles, 'package.json', 'public/index.html']) await stat(join(root, path));
  const trace = await nodeFileTrace(entries.map(path => join(root, path)), {
    base: root,
    processCwd: root,
    conditions: ['node', 'import', 'default'],
    ignore: path => disabledDependencies.test(normalize(path)) || privateFiles.test(normalize(path)),
  });
  // NFT first attempts CommonJS parsing on these valid ESM assets, then retries as modules.
  // puppeteer is only used for Kordoc's unrelated print/HTML features.
  const unexpectedWarnings = [...trace.warnings].filter(warning => {
    const message = normalize(warning.message);
    return !message.includes('Failed to resolve dependency "puppeteer-core"') &&
      !(/Failed to parse .*node_modules\/(?:pdfjs-dist|@hyzyla\/pdfium)\/.* as script:/.test(message) && message.includes("Cannot use 'import.meta' outside a module"));
  });
  if (unexpectedWarnings.length) throw new AggregateError(unexpectedWarnings, 'Unexpected runtime dependency tracing warnings');

  const files = new Set([...trace.fileList].map(normalize));
  for (const path of ['package.json', ...dataFiles, ...await filesWithin(root, 'dist')]) files.add(path);
  // Dynamic PDF workers, CMaps, fonts and WASM are assets rather than static JS imports.
  for (const directory of ['node_modules/pdfjs-dist', 'node_modules/@hyzyla/pdfium', 'node_modules/@napi-rs/canvas']) {
    for (const path of await filesWithin(root, directory)) files.add(path);
  }
  const canvasPackage = JSON.parse(await readFile(join(root, 'node_modules/@napi-rs/canvas/package.json'), 'utf8'));
  for (const dependency of Object.keys(canvasPackage.optionalDependencies ?? {})) {
    const directory = `node_modules/${dependency}`;
    try {
      for (const path of await filesWithin(root, directory)) files.add(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const path of ['node_modules/kordoc/LICENSE', 'node_modules/kordoc/NOTICE']) files.add(path);
  for (const path of await filesWithin(root, 'node_modules/kordoc/THIRD_PARTY')) files.add(path);
  const selected = [...files].filter(allowedFile).sort();
  let bytes = 0;
  for (const path of selected) {
    const source = await realpath(join(root, path));
    assertInside(root, source);
    bytes += (await stat(source)).size;
  }
  if (bytes > sizeLimit) throw new Error(`Function bundle exceeds the 200 MiB project safety limit: ${bytes} bytes`);

  // Only this verified child of the project's .vercel directory is replaced.
  await rm(output, { recursive: true, force: true });
  await mkdir(functionDirectory, { recursive: true });
  for (const path of selected) {
    const target = join(functionDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target);
  }
  await writeFile(join(functionDirectory, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs24.x',
    handler: 'api/mcp.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    maxDuration: 60,
  }, null, 2) + '\n');
  await mkdir(join(output, 'static'), { recursive: true });
  await copyFile(join(root, 'public/index.html'), join(output, 'static/index.html'));
  await writeFile(join(output, 'config.json'), JSON.stringify({
    version: 3,
    routes: [{ src: '/api/mcp/?', dest: '/api/mcp' }, { handle: 'filesystem' }, { src: '/', dest: '/index.html' }],
  }, null, 2) + '\n');
  const result = { output, functionDirectory, files: selected.length, bytes, sizeMiB: Number((bytes / 1024 / 1024).toFixed(2)) };
  await writeFile(join(output, 'bundle-summary.json'), JSON.stringify({
    version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
    files: result.files,
    bytes,
    sizeMiB: result.sizeMiB,
    buildPlatform: process.platform,
    buildArchitecture: process.arch,
    excludedFeatures: ['OCR', 'formula OCR', 'browser printing'],
  }, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildVercel();
  console.log(`Vercel function ready: ${result.files} files, ${result.sizeMiB} MiB (${process.platform}/${process.arch})`);
  if (process.platform !== 'linux') console.log('Deploy from a Vercel/Linux build so PDF native support matches the production runtime.');
}
