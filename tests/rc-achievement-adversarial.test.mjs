import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ReferenceCodec } from '../dist/achievement/references.js';
import { createAchievementReader } from '../dist/achievement/read-service.js';
import { createWorkerGateway, WorkerUnavailableError } from '../dist/achievement/gateway.js';
import { resolveResource, resourceDetailUrl } from '../dist/resource/resolver.js';
import { safeDownload, validateDownloadUrl, isPublicAddress } from '../dist/worker/safe-download.js';

const secret = 'rc-boundaries-reference-secret-at-least-32-bytes';
const resource = { id: '123', title: '성취수준', sourceUrl: 'https://www.edunet.net/clssStdDt/view/150/123' };
const file = { id: '789', fileName: '성취수준.pdf', format: 'pdf', url: 'https://api.edunet.net/main/fileRsc/downloadFile/789' };
const config = { searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: true, hwpxReadEnabled: false, autoAttachmentSelectionEnabled: false, resourceReadEnabled: true, referenceSecret: secret };
const registry = [{ sourceType: 'achievement', officialHost: 'api.edunet.net', pathPattern: '/main/clssStdDt/getClssStdDtInfo/{id}', discoveryMethod: 'known_detail', checkedAt: new Date().toISOString(), enabled: true }];
const documentUrl = 'https://educon.edunet.net/KEDNCM/2022NEWEDU/example.pdf';
const code = (expected) => (error) => error?.code === expected;
function setup({ mutate, resolve, run } = {}) {
  const references = new ReferenceCodec(secret);
  const args = { achievementRef: references.issue('achievement', { resource }), attachmentRef: references.issue('attachment', { resourceId: `${resource.id}|${resource.sourceUrl}`, attachmentId: file.id }) };
  let workerCalls = 0;
  let metadataCalls = 0;
  const read = createAchievementReader({ references, config, resolveResource: async (...values) => { metadataCalls++; return resolve ? resolve(...values) : { resource, attachments: [file], warnings: [] }; }, gateway: { run: async (...values) => {
    workerCalls++;
    if (run) return run(...values);
    const result = { status: 'metadata_only', records: [], rawBlocks: [{ text: '원문', kind: 'paragraph', location: { page: 1 } }], contentHash: 'sha256:test', attachment: { attachmentRef: args.attachmentRef, fileName: file.fileName, format: 'pdf', downloadStatus: 'downloaded', parserName: 'fixture', parserVersion: '1' }, warnings: [], visualContentInterpreted: false };
    mutate?.(result);
    return result;
  } } });
  return { read, references, args, counts: () => ({ workerCalls, metadataCalls }) };
}

function network({ address = '8.8.8.8', peer = address, replies = [{}] } = {}) {
  let calls = 0;
  return { calls: () => calls, dependencies: {
    lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    request(_target, options, callback) {
      const reply = replies[Math.min(calls++, replies.length - 1)];
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const response = Readable.from([reply.body ?? Buffer.from('%PDF-1.7\n')]);
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        response.socket = { remoteAddress: peer };
        callback(response);
      });
      req.destroy = (error) => error && queueMicrotask(() => req.emit('error', error));
      return req;
    },
  } };
}

test('RC: a pre-cancelled read never invokes metadata or a worker', async () => {
  const s = setup();
  await assert.rejects(s.read(s.args, AbortSignal.abort('private cancellation reason')), code('ABORTED'));
  assert.deepEqual(s.counts(), { workerCalls: 0, metadataCalls: 0 });
});

test('RC: cancellation during metadata and worker reads is not returned as upstream failure', async () => {
  for (const stage of ['metadata', 'worker']) {
    const controller = new AbortController();
    const fail = async () => { controller.abort('private cancellation reason'); throw new WorkerUnavailableError('ABORTED'); };
    const s = setup(stage === 'metadata' ? { resolve: fail } : { run: fail });
    await assert.rejects(s.read(s.args, controller.signal), code('ABORTED'));
    if (stage === 'metadata') assert.equal(s.counts().workerCalls, 0);
  }
});

test('RC: metadata resolver distinguishes caller cancellation from its own timeout', async () => {
  let calls = 0;
  const deps = { registry, timeoutMs: 10, fetchJson: () => { calls++; return new Promise(() => {}); } };
  await assert.rejects(resolveResource(resource, AbortSignal.abort(), deps), code('ABORTED'));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = resolveResource(resource, controller.signal, deps);
  controller.abort();
  await assert.rejects(pending, code('ABORTED'));
  assert.equal((await resolveResource(resource, undefined, deps)).warnings[0].code, 'attachment_metadata_timeout');
});

test('RC: successful dependency completion cannot revive a cancelled read', async () => {
  for (const stage of ['metadata', 'worker']) {
    const controller = new AbortController();
    const s = setup(stage === 'metadata' ? { resolve: async () => { controller.abort(); return { resource, attachments: [file], warnings: [] }; } } : { mutate: () => controller.abort() });
    await assert.rejects(s.read(s.args, controller.signal), code('ABORTED'));
  }
});

test('RC: cancellation promptly interrupts dependencies that ignore the signal', async () => {
  for (const stage of ['metadata', 'worker']) {
    const controller = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const stall = () => { started(); return new Promise(() => {}); };
    const s = setup(stage === 'metadata' ? { resolve: stall } : { run: stall });
    const pending = s.read(s.args, controller.signal);
    await ready;
    controller.abort();
    let timer;
    try {
      await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation did not settle')), 250); })]), code('ABORTED'));
    } finally { clearTimeout(timer); }
    if (stage === 'metadata') assert.equal(s.counts().workerCalls, 0);
  }
});

test('RC: a raw block whose location exceeds the hard budget cannot trap pagination forever', async () => {
  const s = setup({ mutate: (result) => { result.rawBlocks = [{ text: 'unrepresentable', kind: 'paragraph', location: { anchor: 'x'.repeat(21000) } }, { text: 'next block', kind: 'paragraph', location: { page: 2 } }]; } });
  const response = await s.read({ ...s.args, maxChars: 20000 });
  assert.equal(response.pagination.hasMore, false);
  assert.deepEqual(response.rawBlocks.map((block) => block.text), ['next block']);
  assert.ok(response.warnings.some((warning) => warning.code === 'RAW_BLOCK_EXCEEDS_HARD_LIMIT'));
});

test('RC: raw block overhead larger than the caller budget explains how to continue', async () => {
  const s = setup({ mutate: (result) => { result.rawBlocks[0].location.anchor = 'x'.repeat(600); } });
  const first = await s.read({ ...s.args, maxChars: 500 });
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.warnings.some((warning) => warning.code === 'RAW_BLOCK_EXCEEDS_RESPONSE_LIMIT'));
  const next = await s.read({ ...s.args, cursor: first.pagination.cursor, maxChars: 2000 });
  assert.equal(next.rawBlocks[0].text, '원문');
  assert.equal(next.pagination.hasMore, false);
});

test('RC: verified extraction cannot claim success when download was blocked or failed', async () => {
  for (const downloadStatus of ['blocked', 'failed']) {
    const s = setup({ mutate: (result) => {
      result.status = 'verified_extraction';
      result.attachment.downloadStatus = downloadStatus;
      result.records = [{ id: 'r', evidence: [{ quote: 'data', location: {} }], extraction: { method: 'table', confidence: 'high' } }];
    } });
    const response = await s.read(s.args);
    assert.equal(response.status, 'worker_unavailable');
    assert.ok(response.warnings.some((warning) => warning.code === 'WORKER_INVALID_RESPONSE'));
  }
});

test('RC: safeDownload applies the same raw URL policy as its validator', async () => {
  for (const unsafe of [` ${documentUrl}`, `${documentUrl}\n`, documentUrl.replace('https://', 'https:\\\\'), documentUrl.replace('/KEDNCM/', '/KEDNCM\\')]) {
    assert.throws(() => validateDownloadUrl(unsafe), code('DOWNLOAD_BLOCKED'));
    const mock = network();
    await assert.rejects(safeDownload(unsafe, { dependencies: mock.dependencies }), code('DOWNLOAD_BLOCKED'));
    assert.equal(mock.calls(), 0);
  }
});

test('RC: IPv6 dotted tails compare their complete address when pinning the socket', async () => {
  const mismatch = network({ address: '2606:4700::8.8.8.8', peer: '2606:4700::8.9.9.9' });
  await assert.rejects(safeDownload(documentUrl, { dependencies: mismatch.dependencies }), code('DOWNLOAD_BLOCKED'));
  const equivalent = network({ address: '2606:4700::8.8.8.8', peer: '2606:4700::808:808' });
  assert.ok((await safeDownload(documentUrl, { dependencies: equivalent.dependencies })).bytes.length > 0);
});

test('RC: raw redirect locations cannot bypass the backslash and whitespace policy', async () => {
  for (const location of [' next.pdf', 'next.pdf\n', '\\KEDNCM\\2022NEWEDU\\example.pdf']) {
    const mock = network({ replies: [{ status: 302, headers: { location } }] });
    await assert.rejects(safeDownload(documentUrl, { dependencies: mock.dependencies }), code('DOWNLOAD_BLOCKED'));
    assert.equal(mock.calls(), 1);
  }
});

test('RC: 429 and repeated transient download failures have bounded request counts', async () => {
  for (const [status, expected] of [[429, 1], [503, 2]]) {
    const mock = network({ replies: [{ status, headers: { 'retry-after': '999999999' } }] });
    await assert.rejects(safeDownload(documentUrl, { dependencies: mock.dependencies }), code('DOWNLOAD_FAILED'));
    assert.equal(mock.calls(), expected);
  }
});

test('RC property: seeded Unicode raw pagination is bounded, advances and reconstructs exact text', async () => {
  let seed = 0x5eed;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const atoms = ['가', '😀', '"', '\\', '\n', '\u0000', 'e\u0301'];
  for (let run = 0; run < 40; run++) {
    const text = Array.from({ length: 150 + Math.floor(random() * 600) }, () => atoms[Math.floor(random() * atoms.length)]).join('');
    const maxChars = 500 + Math.floor(random() * 700);
    const s = setup({ mutate: (result) => { result.rawBlocks = [{ text, kind: 'paragraph', location: { page: 1, charStart: 17 } }]; } });
    let cursor;
    let joined = '';
    let pages = 0;
    do {
      const response = await s.read({ ...s.args, maxChars, ...(cursor ? { cursor } : {}) });
      assert.ok(++pages < 30);
      assert.ok(response.rawBlocks.length > 0);
      assert.ok(response.rawBlocks.reduce((sum, block) => sum + JSON.stringify(block).length, 0) <= maxChars);
      for (const block of response.rawBlocks) {
        assert.ok(block.text.isWellFormed(), 'never split a surrogate pair');
        assert.equal(block.location.charStart, 17 + joined.length);
        joined += block.text;
        assert.equal(block.location.charEnd, 17 + joined.length);
      }
      cursor = response.pagination.cursor;
    } while (cursor);
    assert.equal(joined, text);
  }
});

test('RC property: malformed metadata is bounded and cannot choose an arbitrary URL', async () => {
  const payloads = [null, [], 0, 'secret', {}, { success: 'true' }, { success: true, data: null }, { success: true, data: { clssStdDtInfo: { contsId: 'other', contsNm: 'x' }, fileList: [] } }];
  for (const payload of payloads) {
    const result = await resolveResource(resource, undefined, { registry, fetchJson: async () => payload });
    assert.equal(result.attachments.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'attachment_metadata_unavailable'));
  }
  const files = Array.from({ length: 200 }, (_, i) => ({ fileRscId: String(i), fileLgcNm: `file-${i}.pdf`, url: 'http://169.254.169.254/private', fileByte: Number.MAX_VALUE }));
  const result = await resolveResource(resource, undefined, { registry, fetchJson: async () => ({ success: true, data: { clssStdDtInfo: { contsId: resource.id, contsNm: 'title' }, fileList: files } }) });
  assert.equal(result.attachments.length, 100);
  for (const attachment of result.attachments) {
    assert.match(attachment.url, /^https:\/\/api\.edunet\.net\/main\/fileRsc\/downloadFile\/\d+$/);
    assert.equal(attachment.byteSize, undefined);
  }
});

test('RC property: unsafe source hosts and special-use IPv4 ranges never become fetch targets', () => {
  for (const host of ['127.0.0.1', '[::1]', 'www.edunet.net.evil.test', 'www.edunet.net@evil.test', 'evil.test', '169.254.169.254']) {
    assert.equal(resourceDetailUrl({ ...resource, sourceUrl: `https://${host}/clssStdDt/view/150/123` }), undefined);
  }
  for (let i = 0; i < 256; i++) {
    for (const address of [`10.${i}.1.1`, `127.0.${i}.1`, `192.168.${i}.1`, `169.254.${i}.1`, `172.${16 + i % 16}.0.1`, `${224 + i % 32}.1.1.1`]) assert.equal(isPublicAddress(address), false, address);
  }
});

test('RC: cancelling workers repeatedly frees admission without opening the circuit', async () => {
  let spawns = 0;
  let kills = 0;
  const gateway = createWorkerGateway({ secret, maxConcurrent: 1, failureThreshold: 1, timeoutMs: 100, spawn: () => {
    spawns++;
    const child = new EventEmitter();
    child.send = () => {};
    child.kill = () => { kills++; };
    return child;
  } });
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController();
    const pending = gateway.run('signed-handle', controller.signal);
    await assert.rejects(gateway.run('signed-handle'), code('WORKER_BUSY'));
    controller.abort();
    await assert.rejects(pending, code('ABORTED'));
  }
  assert.equal(spawns, 20);
  assert.equal(kills, 20);
});

test('RC: synchronous IPC send failure clears all job listeners and frees admission', async () => {
  const children = [];
  const gateway = createWorkerGateway({ secret, maxConcurrent: 1, failureThreshold: 5, timeoutMs: 20, spawn: () => {
    const child = new EventEmitter();
    child.send = () => { throw new Error('private child failure'); };
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(gateway.run('signed-handle'), code('WORKER_CONNECTION_FAILED'));
    assert.equal(children[i].listenerCount('message'), 0);
    assert.equal(children[i].listenerCount('exit'), 0);
    assert.equal(children[i].killed, true);
  }
});

test('RC property: malformed IPC messages terminate each child without parser retries', async () => {
  const malformed = [null, undefined, 'private upstream text', [], 42, { status: 'verified_extraction', records: 'bad' }, { status: 'metadata_only', records: [], warnings: [{ code: 1, message: 'bad' }] }, { status: 'metadata_only', records: [], warnings: [], rawBlocks: [{ text: 'x', kind: 'script', location: {} }] }, { oversized: 'x'.repeat(4_000_001) }, { value: 1n }];
  const cycle = {};
  cycle.self = cycle;
  malformed.push(cycle);
  for (const payload of malformed) {
    let calls = 0;
    let child;
    const gateway = createWorkerGateway({ secret, timeoutMs: 100, spawn: () => {
      calls++;
      child = new EventEmitter();
      child.send = () => queueMicrotask(() => child.emit('message', payload));
      child.kill = () => { child.killed = true; };
      return child;
    } });
    await assert.rejects(gateway.run('signed-handle'), code('WORKER_INVALID_RESPONSE'));
    assert.equal(calls, 1);
    assert.equal(child.killed, true);
    assert.equal(child.listenerCount('message'), 0);
  }
});
