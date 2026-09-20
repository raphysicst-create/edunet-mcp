// Aggregate manual AI judgments. This does not classify answers automatically.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]), dest=path.join(root,'ai-review');
const read=p=>JSON.parse(fs.readFileSync(p));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const write=(name,value)=>fs.writeFileSync(path.join(dest,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const key=c=>`${c.stage}/${c.model}/${c.id}`;
const inventory=read(path.join(dest,'inventory.json'));
const outcomes=['satisfied','partial','incorrect','limited','unanswered','uncertain'];
const names={satisfied:'요청 충족',partial:'부분 답변',incorrect:'내용 오류',limited:'미충족·제한 안내',unanswered:'무응답',uncertain:'판단 보류'};
const expected=new Map(inventory.records.map(c=>[key(c),c]));
assert.equal(expected.size,191);assert.equal(inventory.primary,180);assert.equal(inventory.supplemental,11);
let cases=[];const seen=new Set();
for(let n=1;n<=30;n++){
 const id=`D${String(n).padStart(2,'0')}`,file=path.join(dest,`${id}-review.json`),review=read(file),evidence=read(path.join(dest,`${id}-evidence.json`));
 assert.equal(review.documentId,id);assert.equal(review.reviewer,'Codex AI semantic review');
 for(const c of review.cases){
  const k=key(c);assert.ok(expected.has(k),`Unexpected ${k}`);assert.ok(!seen.has(k),`Duplicate ${k}`);seen.add(k);
  assert.ok(outcomes.includes(c.outcome));assert.ok(['supported','mixed','unsupported','not_applicable'].includes(c.grounding));assert.ok(c.rationale?.length>15);assert.ok(Array.isArray(c.issues));
  const resultFile=`${k}/result.json`,result=read(path.join(root,resultFile)),e=evidence.cases.find(x=>key(x)===k);
  assert.ok(e);assert.equal(hash(path.join(root,resultFile)),expected.get(k).resultHash);assert.equal(e.resultHash,expected.get(k).resultHash);
  assert.equal(e.final,result.final);assert.equal(c.outcome==='unanswered',!result.finalAnswerCollected,`Answer presence ${k}`);
  cases.push({...c,question:e.question,documentId:id,referenceSource:evidence.sourceUrl,resultFile,resultHash:e.resultHash,reviewFile:`ai-review/${id}-review.json`,evidenceFile:`ai-review/${id}-evidence.json`,manualJudgment:true});
 }
}
assert.equal(seen.size,expected.size);
const frozen=[];
for(const manifest of ['primary/artifact-hashes.json','recovery/artifact-hashes.json','final-report-hashes.json']){
 const data=read(path.join(root,manifest));let count=0;
 for(const [p,digest] of Object.entries(data.files)){assert.equal(hash(path.join(root,p)),digest,`Frozen artifact changed ${p}`);count++;}
 frozen.push({manifest,sha256:hash(path.join(root,manifest)),checkedFiles:count,unchanged:true});
}
const counts=a=>Object.fromEntries(outcomes.map(o=>[o,a.filter(c=>c.outcome===o).length]));
const primary=cases.filter(c=>c.stage==='primary'),recovery=cases.filter(c=>c.stage==='recovery');
const groups={};
for(const stage of ['primary','recovery'])for(const model of ['luna','haiku']){
 const a=cases.filter(c=>c.stage===stage&&c.model===model);if(!a.length)continue;
 groups[`${stage}/${model}`]={total:a.length,counts:counts(a),byScenario:Object.fromEntries(['discovery','code','natural'].map(s=>[s,counts(a.filter(c=>c.id.endsWith(`-${s}`)))]))};
}
for(const c of recovery)assert.equal(primary.find(p=>p.model===c.model&&p.id===c.id)?.outcome,'unanswered');
const supplemented=primary.filter(c=>c.model==='luna').map(c=>recovery.find(r=>r.id===c.id)??c);
const alias={wrong_label_system:'wrong_level_system',unsupportedGradeInference:'unsupported_grade_inference',falseOriginalRead:'false_original_read'};
const issueCounts={};for(const c of primary)for(const i of new Set(c.issues.map(i=>alias[i]??i))){issueCounts[i]??={luna:0,haiku:0};issueCounts[i][c.model]++;}
const summary={createdAt:new Date().toISOString(),reviewType:'manual_AI_semantic_review',reviewer:'Codex AI semantic review',humanReviewed:false,
 scope:{primary:180,supplemental:11,documents:30,allCasesReviewed:true},groups,supplementedLuna:{total:90,counts:counts(supplemented),note:'Supplemental sensitivity view only; primary 90-trial results are unchanged.'},issueCounts,
 criteria:names,interpretation:{satisfied:'요청 종류에 맞는 실질 답변과 공식 근거가 있고 중대한 오류가 없음. 자료 찾기 요청은 적절한 공식 자료 발견으로 충족 가능.',partial:'대상 내용 일부는 정확하나 필수 수준 또는 핵심 내용을 누락.',incorrect:'내용·코드·학년군·라벨 체계 또는 도구 상태에 관한 명백하고 중대한 잘못된 주장.',limited:'실질 요청은 미충족. 검색 또는 읽기 제한을 주로 안내. mixed는 제한 설명 등의 일부 부수 주장에 근거 문제가 있음을 뜻함.',unanswered:'세션 종료까지 최종 답변 없음.',uncertain:'근거만으로 판정할 수 없어 별도 판단이 필요한 사례.'},
 limitations:['AI 전수 의미 검토이며 사람 검토로 표시하지 않는다.','동결한 원문 기준·확보된 MCP 응답·최종 답변을 대조했다. 모든 원문 페이지를 이번에 새로 시각 검증한 것은 아니다.','Luna의 종료 후 manifest와 일부 시간 초과 응답 꼬리가 누락된 기존 감사 한계는 그대로다.','각 문서·질문·설정당 최초 1회인 관찰 평가이며 모델·effort·도구 제약의 인과 효과와 통계적 우열은 분리 실험하지 않았다.','동결된 수치 합격 기준이 없어 RC4 출시 합격 판정으로 사용하지 않는다.'],frozenArtifactChecks:frozen,
 references:{rubricSha256:hash(path.join(root,'rubric.json')),referenceSha256:hash(path.join(root,'review-reference.json')),inventorySha256:hash(path.join(dest,'inventory.json')),offlineFindingsSha256:hash(path.join(dest,'offline-findings.json'))}};
write('review-results.json',{...summary,cases});
write('summary.json',summary);
const row=(name,g)=>`| ${name} | ${g.total} | ${outcomes.map(o=>g.counts[o]).join(' | ')} |`;
const table=`| 구분 | 건수 | ${outcomes.map(o=>names[o]).join(' | ')} |\n|---|---:|${outcomes.map(()=>'---:').join('|')}|\n${row('Luna High 최초',groups['primary/luna'])}\n${row('Haiku 기본 effort 최초',groups['primary/haiku'])}\n${row('Luna 보충',groups['recovery/luna'])}`;
let report=`# 최종 답변 AI 전수 검토\n\n본 평가 180건과 보충 11건을 모두 직접 읽고 동결 원문 기준 및 실제 도구 응답과 대조했다. 사용자가 180건을 다시 검토할 필요는 없다. 중요한 예외는 [핵심 확인 사항](attention.md)에 모았다.\n\n${table}\n\n최종 답변 수집과 요청 충족은 다르다. 최초 수집은 Luna 79/90, Haiku 90/90이지만 요청 충족은 각각 ${groups['primary/luna'].counts.satisfied}/90, ${groups['primary/haiku'].counts.satisfied}/90이다. 제한 안내는 내용을 지어내지 않은 경우에도 내용 제공 성공으로 합산하지 않았다.\n\n## 질문 종류별 최초 결과\n\n| 모델·질문 | ${outcomes.map(o=>names[o]).join(' | ')} |\n|---|${outcomes.map(()=>'---:').join('|')}|\n`;
for(const model of ['luna','haiku'])for(const kind of ['discovery','code','natural'])report+=`| ${model} · ${kind} | ${outcomes.map(o=>groups[`primary/${model}`].byScenario[kind][o]).join(' | ')} |\n`;
report+='\n발견 질문은 관련 공식 자료를 찾으면 충족으로 판정했다. 코드·주제 질문은 요청한 수준 내용까지 필요하다. 전체 문서의 다음 커서가 남아 있어도 요청 기준 전체를 이미 답했다면 누락으로 보지 않았다. 원문 병합 라벨 A/B·C/D, 학년군, HWP의 표·블록 위치를 보존했는지 확인했다. 자동 레코드 0건도 원문 블록의 표를 정확히 읽었으면 인정했다.\n';
report+=`\n## 보충 및 예외 처리\n\n보충 11건은 충족 2, 부분 1, 제한 6, 무응답 2건이다. 보충을 포함한 참고 집계는 Luna 요청 충족 ${summary.supplementedLuna.counts.satisfied}/90이며 최초 43/90을 대체하지 않는다. D05-natural과 D07-code는 보충에서도 무응답이었다.\n\n- D01 Luna code: 교육과정 버전이 질문에 없으므로 다른 공식 버전의 동일 코드 답변은 출처를 명시한 타당한 대안으로 인정했다. 다음 평가에서 버전 지정으로 해결할 사항이다.\n- D26 자연어: 환경과 인간의 상호 작용이라는 넓은 질문은 12생환02-01 등 근거 있는 관련 기준도 허용했다. 잠근 기준 코드와 다르다는 이유만으로 오답 처리하지 않았다.\n- D06 Haiku 최초 code 및 Luna 보충 code: rawBlocks의 A~E 표를 직접 대조해 충족으로 인정했다.\n- D12 Luna 보충 code 및 D15 Haiku code: 일반 수준 표는 원문과 일치하지만 목표 코드 표를 못 읽었으므로 제한 안내로 분류했다.\n\n## 근거 및 검증\n\n191개 고유 stage/model/질문 조합에 판정이 하나씩 있으며 누락·중복 0건이다. 각 판정은 result.json의 SHA-256과 연결했다. 원본·보충·최종 수집 보고서의 동결 해시 ${frozen.reduce((n,x)=>n+x.checkedFiles,0)}개 항목을 다시 확인했고 변경은 없었다. 기존 human-review.json의 미검토 값은 그대로 보존했다.\n\n[전체 개별 판정](review-results.json) · [읽기용 판정 원장](case-ledger.md) · [오프라인 도구 문제 재현](offline-findings.json)\n\n${summary.limitations.map(x=>`- ${x}`).join('\n')}\n`;
write('report.md',report);
let ledger='# AI 개별 판정 원장\n\n전수 판정 기록이며 사용자에게 재검토를 요청하는 목록이 아니다.\n\n| 사례 | 판정 | 근거 상태 | 이유 |\n|---|---|---|---|\n';
for(const c of cases)ledger+=`| [${key(c)}](${c.documentId}-packet.md) | ${names[c.outcome]} | ${c.grounding} | ${c.rationale.replaceAll('|','/').replaceAll('\n',' ')} |\n`;
write('case-ledger.md',ledger);
console.log(JSON.stringify({scope:summary.scope,groups,supplementedLuna:summary.supplementedLuna,frozenArtifacts:frozen},null,2));
