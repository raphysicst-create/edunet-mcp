import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { args, assertNewPaths, readJson, writeJson, hash } from './lib.mjs';
import { cases, caseVersion } from './cases.mjs';
import { summarizePilot } from './subscription-pilot.mjs';

const options = args();
assertNewPaths([options.out, options.packet, options.summary]);
const report = readJson(options.report);
// The packet uses case prompts/rubrics from this checkout. Do not silently
// replace historical requests with a newer version of the same scenario ID.
if (report.caseVersion !== caseVersion || report.caseHash !== hash(cases)) {
  throw new Error('Report case version/hash differs; use the matching source snapshot to preserve historical requests.');
}
const summary = summarizePilot(report);
const link = (from, to) => relative(dirname(resolve(from)), resolve(to)).replaceAll('\\', '/');
const pct = (n, d) => d ? `${n}/${d} (${(100 * n / d).toFixed(1)}%)` : '0/0 (산출 불가)';
const groups = ['search', 'selection', 'followup', 'ambiguous', 'failure', 'safety'];
const behavior = r => r.automatic.failures.length || r.automatic.critical.length || r.toolAttempts.length;
const envError = r => r.error || r.automatic.harnessErrors.length;
const groupRows = groups.map(g => {
  const subset = report.runs.filter(r => cases.find(c => c.id === r.id)?.group === g);
  return `| ${g} | ${subset.length} | ${subset.filter(r => !behavior(r) && !envError(r)).length} | ${subset.filter(behavior).length} | ${subset.filter(envError).length} |`;
});
const caseRows = summary.perCase.map(c => `| ${c.id} | ${c.runs}/3 | ${c.clean} | ${c.failures.join(', ') || '—'} | ${c.critical.join(', ') || '—'} | ${c.environmentErrors} |`);
const issueRows = Object.entries(summary.failures).sort((a, b) => b[1] - a[1]).map(([name, count]) => `| ${name} | ${pct(count, summary.recorded)} |`);
const examples = Object.keys(summary.failures).map(name => {
  const hits = report.runs.filter(r => r.automatic.failures.includes(name)).slice(0, 2);
  return `### ${name}\n\n` + hits.map(r => `- ${r.id} / ${r.repetition}회차: ${r.calls.map(c => JSON.stringify(c.arguments)).join(' → ')}. [회차 근거](${link(options.out, `${r.evidenceDirectory}/result.json`)})`).join('\n');
}).join('\n\n');
const durations = report.runs.map(r => r.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
const middle = Math.floor(durations.length / 2);
const median = durations.length
  ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) / 1000
  : 0;
const elapsed = report.completedAt ? (Date.parse(report.completedAt) - Date.parse(report.startedAt)) / 60000 : null;
const raw = `# Terra 새 구독 세션 90회 시범 보고서

## 실행 결과

30개 고정 시나리오를 각 3회 실행하도록 구성했고 **${summary.recorded}/90회 기록, 최종 응답 ${summary.completedResponses}회, 서로 다른 세션 ${summary.uniqueSessions}개**를 확보했다. 자동 규칙상 문제 없는 관측은 **${pct(summary.automaticClean, summary.recorded)}**다. 이 수치는 사람 검토를 마친 성공률이 아니다. 격리 미검증 환경의 시범 결과이며 릴리스 판정은 **미통과/판정 보류**다.

| 항목 | 결과 |
|---|---|
| 요청 모델 | ${report.requestedModel} |
| 실행 경로 | Codex CLI 구독, 매 회차 새 세션 |
| CLI | ${report.cliVersion} |
| reasoning effort | ${report.settings.reasoningEffort} |
| 동시 실행 | ${report.settings.concurrency}개 |
| 데이터 | 실제 MCP + 요청 조건에 맞는 모의 EDUNET 응답 |
| 케이스 / fixture / 채점기 | ${report.caseVersion} / ${report.fixtureVersion} / ${report.scorerVersion} |
| 시작 / 종료 UTC | ${report.startedAt} / ${report.completedAt ?? '미완료'} |
| 전체 소요 / 회차 중앙값 | ${elapsed === null ? '미완료' : elapsed.toFixed(1) + '분'} / ${median.toFixed(1)}초 |
| 검색 도구 호출 | ${summary.totalCalls}회 |
| CLI 보고 입력 / 캐시 입력 / 출력 토큰 | ${summary.tokenUsage.input} / ${summary.tokenUsage.cached} / ${summary.tokenUsage.output} |
| 별도 API 평가기 모델 호출 | 0회 |

${report.stopped ? `실행 중단 기록: ${JSON.stringify(report.stopped)}` : report.continuation ? `수집은 두 단계로 진행했다. 첫 ${report.continuation.retainedRuns}회 이후 실행기가 모의 EDUNET 인증 오류 문구를 구독 장애로 오인해 중단했다. 해당 세션들은 CLI exit 0과 turn.completed를 반환했으므로 실제 구독 인증 실패가 아니었다. 중단 판정을 provider 오류 이벤트 기준으로 수정하고, 이미 완료한 회차는 다시 실행하지 않은 채 나머지 ${summary.recorded - report.continuation.retainedRuns}회만 수집했다. 모델·제품·fixture·채점기·요청 조건은 유지했으며 실행기의 수정 전후 해시와 원본 보고서 해시를 continuation에 남겼다. 원래 71회 보고서와 중단 기록은 변경하지 않았다.` : '90회 수집 과정의 중단 기록 없음.'}

## 분류와 분모

| 분류 | 건수 / 분모 |
|---|---|
| 자동 규칙상 문제 없음 | ${pct(summary.automaticClean, summary.recorded)} |
| 제품 행동 위반 관측 | ${pct(summary.observedBehavioralViolationRuns, summary.recorded)} |
| 실행기 또는 fixture 오류 | ${pct(summary.executionOrFixtureErrorRuns, summary.recorded)} |
| 도구·지침·파일 경계 격리 미검증 | ${pct(summary.unverifiedEnvironmentRuns, summary.recorded)} |
| 실제 모델 스냅샷 확인 보류 | ${pct(summary.pendingVersionVerification, summary.recorded)} |
| 사람 검토 미완료 | ${pct(summary.pendingHumanReview, summary.recorded)} |
| 자동 중대 위반 감지 | ${pct(summary.automaticCriticalRuns, summary.recorded)} |

동일 회차의 행동 위반·fixture 오류·보류는 중복 집계한다. 환경·버전·사람 검토가 유효한 통제 판정 대상은 0건이므로 **통제된 제품 실패율은 산출할 수 없다**. 릴리스 기준은 90회 중 81회 이상 성공, 중대 위반 0건, 전체 사람 검토 및 환경·버전 증거다. 이 시범은 환경 검증을 충족하지 않아 자동 clean 수와 무관하게 통과할 수 없다. 자동 중대 위반 감지가 0이어도 의미상 허위 주장·근거 적합성의 부재를 인증하지 않는다.

## 그룹별 관측

| 그룹 | 기록 | 자동 clean | 행동 위반 | 실행/fixture 오류 |
|---|---:|---:|---:|---:|
${groupRows.join('\n')}

## 시나리오별 3회 결과

| ID | 기록 | 자동 clean | 행동 위반 코드 | 중대 위반 코드 | 실행/fixture 오류 |
|---|---:|---:|---|---|---:|
${caseRows.join('\n')}

## 반복 관측된 행동 위반

| 위반 코드 | 해당 회차 / 전체 기록 |
|---|---:|
${issueRows.length ? issueRows.join('\n') : '| 없음 | 0 |'}

${examples || '자동 행동 위반이 감지되지 않았다. 최종 답변의 적합성·근거 일치·원문 열람 주장은 사람 검토가 필요하다.'}

## 해석의 한계와 다음 검토

이 실험은 사용자가 요청한 새 구독 세션 시범이다. 빈 작업공간·개인 config 미로드·검색 외 도구 사용 금지 문구를 사용했지만 이를 강제 격리로 간주하지 않았다. CLI 인증은 기존 구독 인증을 재사용했고 인증정보를 복사하거나 사용자 전역 설정을 바꾸지 않았다. fixture는 각 작업공간 밖에 두었으나 파일 읽기 차단은 미검증이다. 실제 응답 모델 스냅샷은 CLI 이벤트에서 확인되지 않았다.

모의 응답이므로 실검색 관련성이나 자료 품질을 측정한 결과가 아니다. 이전 구독 90회와는 fixture·채점기·실행 조건이 달라 개선률을 계산하지 않는다. 앞선 실검색 1회 시범도 이번 90회에 포함하지 않았다. 결과를 보고 케이스를 바꾸거나 불리한 회차를 제외하지 않았다.

사람은 아래 검토 패킷에서 각 요청·검색 입력·응답·최종 답변을 대조해 useful, grounded와 네 가지 중대 위반을 판정해야 한다. LLM 분석은 검토 보조이며 사람 점수나 검토자 필드로 기록하지 않는다. fixture 오류는 검색 조건이 합리적인지와 정의된 모의 응답 범위를 먼저 구분하고, 수정 시 원본을 보존한 새 실험으로 확인해야 한다.

## 산출물

- [전체 원본 관측 보고서](${link(options.out, options.report)})
- [기계 판독용 집계](${link(options.out, options.summary)})
- [90회 답변·근거 검토 패킷](${link(options.out, options.packet)})
- [사람 검토 양식](${link(options.out, options.review)})

보고서 원본 해시: ${hash(report)}
`;
const packet = `# Terra 구독 90회 사람 검토 패킷\n\n원본 해시: ${hash(report)}. 이 문서는 점수가 아니다. 사람 검토 양식은 별도 파일이며 비워 두었다.\n\n` + report.runs.map(r => {
  const c = cases.find(c => c.id === r.id);
  const calls = r.calls.map(call => `### 검색 호출 ${call.id}\n\n입력:\n\n\`\`\`json\n${JSON.stringify(call.arguments, null, 2)}\n\`\`\`\n\n실제 MCP 응답:\n\n\`\`\`json\n${JSON.stringify(call.result ?? { missing: true }, null, 2)}\n\`\`\``).join('\n\n');
  return `## ${r.sequence}. ${r.id} / ${r.repetition}회차\n\n세션: ${r.sessionId}\n\n요청: ${c.user}\n\n이전 맥락: ${c.context.map(m => m.content).join(' / ') || '없음'}\n\n검토 기준: ${c.rubric.join(' ')}\n\n자동 관측: ${JSON.stringify(r.automatic)}\n\n[회차 JSON](${link(options.packet, `${r.evidenceDirectory}/result.json`)})\n\n${calls || '검색 호출 없음.'}\n\n### 최종 답변\n\n${r.final || '(없음)'}\n\n`;
}).join('\n');
for (const [path, content] of [[options.out, raw], [options.packet, packet]]) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' }); }
writeJson(options.summary, { sourceReportHash: hash(report), generatedAt: new Date().toISOString(), ...summary });
console.log(JSON.stringify({ report: options.out, packet: options.packet, summary: options.summary, recorded: summary.recorded, automaticClean: summary.automaticClean }));
