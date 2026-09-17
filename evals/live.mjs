import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { buildSearchUrl, searchEdunet } from '../dist/client.js';
import { requestBytes } from '../dist/http.js';
import { parseEdunetResponse } from '../dist/response.js';
import { searchInputSchema } from '../dist/schema.js';
import { redact } from '../dist/logger.js';
import { liveTasks, liveTaskVersion } from './live-tasks.mjs';
import { args, connect, hash, readJson, writeJson, assertNewPaths } from './lib.mjs';

export function gradeLive(report, review) {
  const invalid = [];
  if (report.taskVersion !== liveTaskVersion || report.taskHash !== hash(liveTasks) || report.tasks?.length !== 10) invalid.push('invalid_task_set');
  if (review?.reportHash !== hash(report) || !review?.reviewer?.trim() || !Number.isFinite(Date.parse(review?.reviewedAt))) invalid.push('missing_or_stale_review');
  const results = liveTasks.map(task => {
    const collected = report.tasks?.filter(t => t.id === task.id) ?? [];
    const reviews = review?.tasks?.filter(t => t.id === task.id) ?? [];
    const data = collected[0]; const r = reviews[0];
    const items = data?.mcp?.structuredContent?.items ?? [];
    const valid = collected.length === 1 && reviews.length === 1 && !data.error && !data.mcp?.isError &&
      Array.isArray(r.scores) && r.scores.length === items.length && items.length <= 5 && r.scores.every(s => [0, 1, 2].includes(s));
    const success = valid && r.scores.some(s => s === 2);
    const causeRequired = !success || data?.wrapperMatches !== true || data?.liveDrift;
    const analysisComplete = !causeRequired || (['query', 'api_quality', 'corpus_shortage', 'wrapper', 'network', 'uncertain'].includes(r?.cause) &&
      ['evidence', 'userImpact', 'queryGuidanceChange', 'recheckResult'].every(k => typeof r[k] === 'string' && r[k].trim()));
    return { id: task.id, success, reviewed: Boolean(valid && analysisComplete), wrapperMatches: data?.wrapperMatches === true, liveDrift: data?.liveDrift ?? null,
      scores: r?.scores ?? null, cause: r?.cause ?? '', evidence: r?.evidence ?? '', userImpact: r?.userImpact ?? '',
      queryGuidanceChange: r?.queryGuidanceChange ?? '', recheckResult: r?.recheckResult ?? '' };
  });
  const successes = results.filter(r => r.success).length;
  const complete = !invalid.length && results.every(r => r.reviewed);
  return { goalMet: complete && successes >= 8, successes, total: 10, complete,
    wrapperFailureCount: results.filter(r => !r.wrapperMatches).length, invalid, results,
    releaseNote: '실검색은 CI 통과 조건이 아닙니다. 목표 미달·래퍼 불일치·실검색 변동은 원인, 사용자 영향, 검색어 안내 개선과 재확인 결과를 릴리스 보고서에 남깁니다.' };
}

async function collect() {
  const config = loadConfig();
  const session = await connect(searchEdunet);
  const report = { kind: 'live_relevance', taskVersion: liveTaskVersion, taskHash: hash(liveTasks), capturedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform }, tasks: [] };
  try {
    for (const task of liveTasks) {
      const start = performance.now();
      const input = searchInputSchema.parse(task.input);
      const entry = { id: task.id, task: task.task, input };
      try {
        const direct = await requestBytes(buildSearchUrl(input, config));
        const parsed = parseEdunetResponse(direct.body, direct.headers, [config.apiKey]);
        const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
        entry.direct = { status: direct.status, contentType: direct.headers.get('content-type'), parsed,
          // Keep sanitized original fields for human parser/fidelity inspection.
          xml: redact(new TextDecoder(parsed.encoding).decode(direct.body), [config.apiKey, config.domain, xmlEscape(config.apiKey), xmlEscape(config.domain)]) };
        const replay = await connect((args, signal) => searchEdunet(args, signal, { config, http: {
          maxRetries: 0, fetch: async () => new Response(direct.body, { status: direct.status, headers: direct.headers }),
        } }));
        try {
          entry.replay = await replay.client.callTool({ name: 'search_edunet', arguments: input });
          entry.wrapperMatches = !entry.replay.isError && hash(parsed.items.slice(0, 5)) === hash(entry.replay.structuredContent?.items) && parsed.totalCount === entry.replay.structuredContent?.pagination.totalCount;
        } finally { await replay.close(); }
        // Independent live call, identical conditions. Drift is reported, not
        // misclassified as deterministic wrapper loss.
        entry.mcp = await session.client.callTool({ name: 'search_edunet', arguments: input }, undefined, { timeout: 50_000 });
        entry.liveDrift = hash(entry.replay.structuredContent) !== hash(entry.mcp.structuredContent);
      } catch { entry.error = 'live_collection_failed'; }
      entry.durationMs = Math.round(performance.now() - start);
      report.tasks.push(entry);
      console.log(`${task.id}: ${entry.error ?? 'collected; relevance requires human scores'}`);
    }
  } finally { await session.close(); }
  return report;
}

async function main() {
  const options = args();
  if (options.mode === 'grade') {
    const result = gradeLive(readJson(options.report), readJson(options.review));
    writeJson(options.out ?? 'evals/results/live-grade.json', result);
    console.log(JSON.stringify(result));
    // Below-target relevance itself is intentionally not a CI failure.
    process.exitCode = result.complete ? 0 : 1;
    return;
  }
  if (options.mode !== 'collect') throw new Error('Specify --mode collect or grade');
  const output = options.out ?? 'evals/results/live-run.json';
  assertNewPaths([output, options.review ?? 'evals/results/live-review.json']);
  writeJson(output, await collect());
  const report = readJson(output);
  writeJson(options.review ?? 'evals/results/live-review.json', { reportHash: hash(report), reviewer: '', reviewedAt: '',
    tasks: report.tasks.map(t => ({ id: t.id, scores: (t.mcp?.structuredContent?.items ?? []).map(() => null),
      cause: '', evidence: '', userImpact: '', queryGuidanceChange: '', recheckResult: '' })) });
  if (report.tasks.some(t => t.error || t.mcp?.isError)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('Live eval failed. Check configuration and report/review paths. Raw errors omitted.'); process.exitCode = 1;
});
