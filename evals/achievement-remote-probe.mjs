// Read-only Remote MCP probe. This is a diagnostic collector, never a release gate.
// Ground truth must be authored from official originals BEFORE running this file.
import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
if (!args['--corpus'] || !args['--endpoint'] || !args['--out']) {
  throw new Error('Usage: node evals/achievement-remote-probe.mjs --corpus FILE --endpoint HTTPS_URL --out NEW_FILE');
}
const endpoint = new URL(args['--endpoint']);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('HTTPS endpoint without credentials/query required');
const bytes = await readFile(args['--corpus']);
const corpus = JSON.parse(bytes);
if (corpus.kind !== 'independent_original_ground_truth' || !corpus.frozenAt || !Array.isArray(corpus.scenarios) || !corpus.scenarios.length) throw new Error('Independent frozen ground truth required');
if (new Set(corpus.scenarios.map(s => s.id)).size !== corpus.scenarios.length) throw new Error('Duplicate scenario');
for (const scenario of corpus.scenarios) {
  if (!scenario.id || !scenario.question || !scenario.searchArguments || !scenario.expected?.sourceUrl || !scenario.expected?.fileName) throw new Error('Incomplete scenario');
  const source = new URL(scenario.expected.sourceUrl);
  if (source.protocol !== 'https:' || !['www.edunet.net', 'edunet.net'].includes(source.hostname)) throw new Error('Official EDUNET source required');
}
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  try { const url = new URL(value); url.searchParams.delete('contents_openapi'); url.hash = ''; url.searchParams.sort(); return url.href; }
  catch { return null; }
};
const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(key) && value?.length >= 8).map(([, value]) => value);
function mask(key, value) {
  if (typeof value !== 'string') return value;
  if (/^(?:achievementRef|resourceRef|attachmentRef|cursor)$/.test(key)) return `[reference-sha256:${sha(value)}]`;
  let clean = value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/g, '[REDACTED_REFERENCE]');
  for (const secret of secrets) clean = clean.split(secret).join('[REDACTED_SECRET]');
  return clean;
}
const out = resolve(args['--out']);
await mkdir(dirname(out), { recursive: true });
const handle = await open(out, 'wx'); // Refuse to replace historical evidence, before network I/O.
const report = {
  kind: 'remote_achievement_probe', startedAt: new Date().toISOString(), endpoint: endpoint.href,
  localCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  deploymentCommit: null, deploymentIdentityVerified: false,
  corpusSha256: sha(bytes), groundTruthFrozenAt: corpus.frozenAt,
  execution: 'deterministic tool orchestration; no client LLM or final-answer evaluation',
  releaseEligible: false, metrics: { structuredExtractionPrecision: null, evidenceAccuracy: null },
  scenarios: [], diagnostics: [], limitations: ['Small diagnostic sample; not the 30-document/90-scenario acceptance corpus', 'No independent semantic grading or human adjudication is performed by this collector'],
};
async function save() {
  const data = Buffer.from(JSON.stringify(report, mask, 2) + '\n');
  await handle.write(data, 0, data.length, 0); await handle.truncate(data.length); await handle.sync();
}
const client = new Client({ name: 'edunet-achievement-e2e-probe', version: '1' });
const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(55_000)]) }),
});
async function call(log, name, arguments_) {
  const entry = { name, arguments: arguments_, startedAt: new Date().toISOString() };
  log.push(entry);
  const start = performance.now();
  try {
    entry.response = await client.callTool({ name, arguments: arguments_ }, { timeout: 55_000 });
    return entry.response;
  } catch { entry.error = 'REMOTE_CALL_FAILED'; return null; }
  finally { entry.latencyMs = Math.round(performance.now() - start); }
}
try {
  await save();
  await client.connect(transport, { timeout: 20_000 });
  report.server = client.getServerVersion();
  report.tools = (await client.listTools({}, { timeout: 20_000 })).tools;
  for (const scenario of corpus.scenarios) {
    const observation = { id: scenario.id, question: scenario.question, expected: scenario.expected, calls: [], stages: {}, grade: 'NOT_GRADED' };
    report.scenarios.push(observation);
    const response = await call(observation.calls, 'search_edunet_achievement', scenario.searchArguments);
    const search = response?.isError ? null : response?.structuredContent;
    const results = Array.isArray(search?.results) ? search.results : [];
    const index = results.findIndex(candidate => canonical(candidate.sourceUrl) === canonical(scenario.expected.sourceUrl));
    observation.stages.discovery = { status: search ? (index < 0 ? 'EXPECTED_SOURCE_NOT_RETURNED' : 'FOUND') : 'CALL_FAILED', rank: index < 0 ? null : index + 1, officialIndexAvailability: 'UNDETERMINED', candidateCount: results.length };
    if (index >= 0) {
      const candidate = results[index];
      const base = { achievementRef: candidate.achievementRef, maxItems: 100, maxChars: 20000 };
      let listing = (await call(observation.calls, 'read_edunet_achievement', base))?.structuredContent;
      let attachment;
      const seen = new Set();
      for (let page = 0; listing && page < 10; page++) {
        attachment = listing.attachments?.find(a => a.fileName === scenario.expected.fileName && a.format === scenario.expected.format);
        if (attachment || !listing.pagination?.hasMore || !listing.pagination.cursor || seen.has(listing.pagination.cursor)) break;
        seen.add(listing.pagination.cursor);
        listing = (await call(observation.calls, 'read_edunet_achievement', { ...base, cursor: listing.pagination.cursor }))?.structuredContent;
      }
      observation.stages.attachment = { status: attachment ? 'MATCHED_FILENAME_AND_FORMAT' : 'EXPECTED_ATTACHMENT_NOT_RETURNED' };
      if (attachment) {
        const readArgs = { ...base, attachmentRef: attachment.attachmentRef, ...(scenario.readFilters ?? {}) };
        let read = (await call(observation.calls, 'read_edunet_achievement', readArgs))?.structuredContent;
        const pages = []; const cursors = new Set();
        while (read) {
          pages.push(read);
          if (!read.pagination?.hasMore || !read.pagination.cursor || pages.length >= 20 || cursors.has(read.pagination.cursor)) break;
          cursors.add(read.pagination.cursor);
          read = (await call(observation.calls, 'read_edunet_achievement', { ...readArgs, cursor: read.pagination.cursor }))?.structuredContent;
        }
        observation.stages.read = { statuses: pages.map(p => p.status), pages: pages.length, records: pages.reduce((n, p) => n + (p.records?.length ?? 0), 0), cursorComplete: pages.length > 0 && pages.at(-1).pagination?.hasMore === false, semanticVerification: 'PENDING_INDEPENDENT_EVAL' };
      }
    }
    await save();
    console.log(JSON.stringify({ scenario: scenario.id, stages: observation.stages }));
  }
  for (const diagnostic of corpus.diagnostics ?? []) {
    const observation = { id: diagnostic.id, purpose: diagnostic.purpose, calls: [] };
    report.diagnostics.push(observation);
    await call(observation.calls, diagnostic.name, diagnostic.arguments);
    await save();
  }
  report.collectionComplete = true;
} catch { report.collectionComplete = false; report.error = 'REMOTE_PROBE_INCOMPLETE'; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  try { await client.close(); } catch { /* Keep the collected observations. */ }
  await save(); await handle.close();
}
console.log(JSON.stringify({ out, collectionComplete: report.collectionComplete, releaseEligible: false }));
