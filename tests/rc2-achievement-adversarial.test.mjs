import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { preflightHwpx } from '../dist/worker/parsers/preflight.js';
import { ReferenceCodec } from '../dist/achievement/references.js';
import { createAchievementReader } from '../dist/achievement/read-service.js';
import { createWorkerGateway } from '../dist/achievement/gateway.js';

const require = createRequire(import.meta.url);
const crc32 = require('jszip/lib/crc32.js');
const secret = 'rc2-achievement-boundary-secret-at-least-32-bytes';
const resource = { id: '123', title: '성취수준', sourceUrl: 'https://www.edunet.net/clssStdDt/view/150/123' };
const file = { id: '789', fileName: '성취수준.pdf', format: 'pdf', url: 'https://api.edunet.net/main/fileRsc/downloadFile/789' };
const config = { searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: false, hwpxReadEnabled: false, autoAttachmentSelectionEnabled: false, resourceReadEnabled: true, referenceSecret: secret };
const code = expected => error => error?.code === expected;

function reader(attachments) {
  const references = new ReferenceCodec(secret);
  let workerCalls = 0, metadataCalls = 0;
  const read = createAchievementReader({ references, config, resolveResource: async () => { metadataCalls++; return { resource, attachments, warnings: [] }; }, gateway: { run: async () => { workerCalls++; throw new Error('unexpected worker'); } } });
  return { read, references, args: { achievementRef: references.issue('achievement', { resource }) }, workerCalls: () => workerCalls, metadataCalls: () => metadataCalls };
}

function zipLayout(bytes) {
  const locals = new Map(), central = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = bytes.readUInt16LE(offset + 26);
    locals.set(bytes.toString('utf8', offset + 30, offset + 30 + nameLength), offset);
    offset += 30 + nameLength + bytes.readUInt16LE(offset + 28) + bytes.readUInt32LE(offset + 18);
  }
  const centralStart = offset;
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    central.set(bytes.toString('utf8', offset + 46, offset + 46 + nameLength), offset);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return { locals, central, centralStart, end: offset };
}

async function zipFixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip');
  zip.file('Contents/section0.xml', '<section>valid</section>', { createFolders: false });
  zip.file('payload.bin', '<!DOCTYPE section [<!ENTITY hidden "unchecked">]><section>&hidden;</section>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function unicodeAlias(bytes, filename, effectiveName) {
  const layout = zipLayout(bytes);
  const central = layout.central.get(filename);
  const extraStart = central + 46 + bytes.readUInt16LE(central + 28);
  const name = Buffer.from(effectiveName);
  const extra = Buffer.alloc(9 + name.length);
  extra.writeUInt16LE(0x7075, 0);
  extra.writeUInt16LE(5 + name.length, 2);
  extra[4] = 1;
  extra.writeInt32LE(crc32(Buffer.from(filename)), 5);
  name.copy(extra, 9);
  const altered = Buffer.concat([bytes.subarray(0, extraStart), extra, bytes.subarray(extraStart)]);
  altered.writeUInt16LE(bytes.readUInt16LE(central + 30) + extra.length, central + 30);
  altered.writeUInt32LE(bytes.readUInt32LE(layout.end + 12) + extra.length, layout.end + extra.length + 12);
  return altered;
}

test('RC2: HWPX Unicode path extras cannot hide XML from the preflight policy', async () => {
  const bytes = unicodeAlias(await zipFixture(), 'payload.bin', 'Contents/section1.xml');
  const parsed = await JSZip.loadAsync(bytes);
  assert.match(await parsed.file('Contents/section1.xml').async('string'), /<!DOCTYPE/);
  assert.throws(() => preflightHwpx(bytes), code('CORRUPTED_ARCHIVE'));
});

test('RC2: HWPX Unicode path extras cannot replace an already validated section', async () => {
  const bytes = unicodeAlias(await zipFixture(), 'payload.bin', 'Contents/section0.xml');
  const parsed = await JSZip.loadAsync(bytes);
  assert.match(await parsed.file('Contents/section0.xml').async('string'), /<!DOCTYPE/);
  assert.throws(() => preflightHwpx(bytes), code('CORRUPTED_ARCHIVE'));
});

test('RC2: benign HWPX Unicode extras and ordinary non-ASCII filenames remain supported', async () => {
  const original = await zipFixture();
  assert.doesNotThrow(() => preflightHwpx(unicodeAlias(original, 'payload.bin', 'payload.bin')));
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip');
  zip.file('Contents/section0.xml', '<section/>', { createFolders: false });
  zip.file('BinData/설명.txt', '첨부 이름', { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.doesNotThrow(() => preflightHwpx(bytes));
});

test('RC2: attachment pagination rejects reordered, removed, or renamed upstream files', async () => {
  for (const mutation of [files => files.reverse(), files => files.shift(), files => { files[1].fileName = 'changed.pdf'; }]) {
    const files = Array.from({ length: 4 }, (_, index) => ({ ...file, id: String(789 + index), fileName: `file-${index}.pdf` }));
    const s = reader(files);
    const first = await s.read({ ...s.args, maxItems: 1 });
    assert.equal(first.pagination.hasMore, true);
    mutation(files);
    await assert.rejects(s.read({ ...s.args, cursor: first.pagination.cursor, maxItems: 1 }), code('INVALID_REFERENCE'));
    assert.equal(s.workerCalls(), 0);
  }
});

test('RC2 property: repeated invalid or out-of-scope attachment/cursor references never call metadata', async () => {
  const s = reader([file]);
  const invalid = [
    { attachmentRef: s.references.issue('attachment', { resourceId: 'another-resource', attachmentId: file.id }) },
    { cursor: s.references.issue('cursor', { mode: 'attachments', resourceId: 'another-resource', offset: 1 }) },
    { attachmentRef: s.references.issue('resource', { resource }) },
    { cursor: s.references.issue('achievement', { resource }) },
  ];
  for (let i = 0; i < 64; i++) invalid.push({ [i % 2 ? 'cursor' : 'attachmentRef']: `malformed-${i}.signature` });
  for (const input of invalid) await assert.rejects(s.read({ ...s.args, ...input }), code('INVALID_REFERENCE'));
  assert.equal(s.metadataCalls(), 0);
  assert.equal(s.workerCalls(), 0);
});

test('RC2: pre-cancelled worker jobs stay ABORTED when admission is busy or the circuit is open', async () => {
  const children = [];
  const gateway = createWorkerGateway({ secret, maxConcurrent: 1, failureThreshold: 1, timeoutMs: 1000, spawn: () => {
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => {};
    children.push(child);
    return child;
  } });
  const first = gateway.run('handle');
  try {
    await assert.rejects(gateway.run('handle', AbortSignal.abort()), code('ABORTED'));
  } finally {
    children[0].emit('error', new Error('private-error'));
    await assert.rejects(first, code('WORKER_CONNECTION_FAILED'));
  }
  await assert.rejects(gateway.run('handle', AbortSignal.abort()), code('ABORTED'));
  assert.equal(children.length, 1);
});
