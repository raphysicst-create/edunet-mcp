import fs from 'node:fs';
import path from 'node:path';
import {args,read,write,sha,MODELS} from './common.mjs';
const o=args();if(!o.out)throw Error('OUT_REQUIRED');const root=path.resolve(o.out),stage=o.stage??'full';
const reference=read(path.join(root,'review-reference.json')),lock=read(path.join(root,'evaluation-lock.json'));
const scenarios=read(path.join(root,'prompts.json'));
const norm=s=>(s??'').normalize('NFC').replace(/[\s*_`]/gu,'');
const urls=s=>[...new Set((s.match(/https?:\/\/[^\s<>"\]\)]+/g)??[]).map(u=>u.replace(/[.,;]+$/,'')))];
const percentile=(values,p)=>{const a=values.slice().sort((a,b)=>a-b);return a.length?a[Math.ceil(a.length*p)-1]:null;};
const summaries=[];const detailed={};
for(const model of Object.keys(MODELS)){
  const dir=path.join(root,stage,model),file=path.join(dir,'runs.jsonl');
  const runs=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).sort((a,b)=>a.sequence-b.sequence):[];
  const details=runs.map(r=>{
    const doc=reference.documents.find(d=>d.documentId===r.documentId),truth=doc.truth;
    const audit=path.join(dir,r.id,'audit');
    const responseFiles=fs.readdirSync(audit).filter(f=>/^\d+-response.json$/.test(f));
    const responseObjects=responseFiles.map(f=>read(path.join(audit,f)));
    const responseText=responseFiles.map(f=>fs.readFileSync(path.join(audit,f),'utf8')).join('\n');
    const toolErrors=responseObjects.filter(x=>x.response?.error||x.response?.result?.isError).map(x=>JSON.stringify(x.response));
    const requests=fs.readdirSync(audit).filter(f=>/^\d+-request.json$/.test(f)).map(f=>read(path.join(audit,f)).message);
    const responseUrls=urls(responseText.replaceAll('\\"','"'));
    const finalUrls=urls(r.final),unsupportedUrls=finalUrls.filter(u=>!responseUrls.includes(u));
    const exactDescriptions=(truth.levels??[]).filter(l=>norm(r.final).includes(norm(l.description))).map(l=>l.label);
    const flags=[...r.automaticReviewFlags];
    if(!finalUrls.length)flags.push('no_url_in_answer');
    if(unsupportedUrls.length)flags.push('answer_url_not_exactly_in_tool_trace_review_required');
    if(r.kind==='code'&&r.returnedRecords>0&&!norm(r.final).includes(norm(truth.code)))flags.push('requested_code_not_in_answer');
    return {...r,answerUrls:finalUrls,urlsNeedingReview:unsupportedUrls,expectedSourceMentioned:r.final.includes(doc.sourceUrl),referenceCodeMentioned:norm(r.final).includes(norm(truth.code)),exactReferenceDescriptions:exactDescriptions,referenceDescriptionCount:truth.levels?.length??0,
      toolErrorCount:toolErrors.length,invalidReferenceCount:toolErrors.filter(t=>t.includes('INVALID_REFERENCE')).length,inputValidationErrorCount:toolErrors.filter(t=>/Input validation|Invalid arguments/.test(t)).length,
      readsWithCodeFilter:requests.filter(q=>q.method==='tools/call'&&q.params?.name==='read_edunet_achievement'&&q.params?.arguments?.achievementStandardCode).length,
      diagnosticFlags:flags,note:'Exact textual overlap is diagnostic only. Paraphrases, valid alternate sources and correctly explained restrictions require semantic review.'};
  });
  detailed[model]=details;
  const summary={model,requestedModel:MODELS[model].model,requestedEffort:MODELS[model].effort,planned:['full','primary'].includes(stage)?90:stage==='representative'?6:['recovery','continuation'].includes(stage)?read(path.join(root,stage,`${stage}-lock.json`)).selectedByModel[model].length:1,
    recorded:runs.length,uniqueScenarioIds:new Set(runs.map(r=>r.id)).size,uniqueSessions:new Set(runs.map(r=>r.sessionId).filter(Boolean)).size,
    finalAnswers:runs.filter(r=>r.finalAnswerCollected).length,environmentErrorRuns:runs.filter(r=>r.environmentErrors.length).length,humanReviewed:0,qualitySuccesses:null,criticalViolations:null,releaseEligible:false,
    toolCalls:runs.reduce((n,r)=>n+r.toolCalls,0),returnedRecords:runs.reduce((n,r)=>n+r.returnedRecords,0),observedModelVersions:[...new Set(runs.flatMap(r=>r.observedModelVersions))],
    durationMs:{p50:percentile(runs.map(r=>r.durationMs),.5),p95:percentile(runs.map(r=>r.durationMs),.95),sum:runs.reduce((n,r)=>n+r.durationMs,0)},
    estimatedCostUsd:runs.length&&runs.every(r=>typeof r.estimatedCostUsd==='number')?runs.reduce((n,r)=>n+r.estimatedCostUsd,0):null,
    usageTotals:Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','cache_creation_input_tokens','cache_read_input_tokens'].map(k=>[k,runs.length&&runs.every(r=>typeof r.usage?.[k]==='number')?runs.reduce((n,r)=>n+r.usage[k],0):null])),
    perKind:Object.fromEntries(['discovery','code','natural'].map(kind=>[kind,{recorded:runs.filter(r=>r.kind===kind).length,finalAnswers:runs.filter(r=>r.kind===kind&&r.finalAnswerCollected).length,qualitySuccesses:null}])),
    reviewFlagRuns:details.filter(r=>r.diagnosticFlags.length).length,toolErrorCount:details.reduce((n,r)=>n+r.toolErrorCount,0),invalidReferenceCount:details.reduce((n,r)=>n+r.invalidReferenceCount,0),inputValidationErrorCount:details.reduce((n,r)=>n+r.inputValidationErrorCount,0),finishedAt:runs.length?runs.map(r=>r.finishedAt).sort().at(-1):null};
  summaries.push(summary);
  write(path.join(dir,'diagnostics.json'),{summary,runs:details});
  write(path.join(dir,'human-review.json'),{schemaVersion:1,reviewer:null,reviewedAt:null,scope:'Human judgment only; no automatic filling of these fields',runs:details.map(r=>({id:r.id,evidenceFileSha256:sha(fs.readFileSync(path.join(dir,r.id,'result.json'))),useful:null,grounded:null,fabricatedSource:null,fabricatedContent:null,falseOriginalRead:null,unsupportedGradeInference:null,keyLeak:null,externalInstructionExecuted:null,notes:''}))});
  let packet=`# ${model} 최종 답변 검토 패킷\n\n사람 검토 0/${runs.length}. 자동 진단은 정답률이나 중대 위반 확정값이 아니다. 공식 원문 및 실제 호출 기록을 대조해야 한다.\n\n`;
  for(const r of details){const s=scenarios.find(s=>s.id===r.id),doc=reference.documents.find(d=>d.documentId===r.documentId);packet+=`## ${r.id}\n\n질문: ${s.question}\n\n공식 기준 원문: ${doc.sourceUrl}\n\n기준 코드: ${doc.truth.code}. 기준 위치: ${JSON.stringify({pdfPage:doc.truth.pdfPage??null,primaryFormat:doc.primaryFormat})}\n\n### 실제 최종 답변\n\n${r.final||'(최종 답변 없음)'}\n\n### 검토 보조\n\n환경 오류: ${r.environmentErrors.join(', ')||'없음'}\n\n자동 검토 표시: ${r.diagnosticFlags.join(', ')||'없음'}\n\n[호출·응답 디렉터리](./${r.id}/audit/) · [세션 결과](./${r.id}/result.json)\n\n원문 정답 발췌:\n\n${(doc.truth.levels??[]).map(l=>`- ${l.label}: ${l.description}`).join('\n')}\n\n사람 판정: 미검토\n\n`;}
  fs.writeFileSync(path.join(dir,'review-packet.md'),packet,{flag:'wx'});
}
write(path.join(root,stage,'comparison.json'),{generatedAt:new Date().toISOString(),sourceDigest:lock.sourceDigest,summaries,qualityComparison:null,reason:'Human semantic review pending; native CLI environments differ.'});
const rows=summaries.map(s=>`| ${s.model} | ${s.requestedEffort} | ${s.finalAnswers}/${s.planned} | ${s.environmentErrorRuns} | ${s.toolCalls} | ${Math.round((s.durationMs.p50??0)/1000)}초 | ${Math.round((s.durationMs.p95??0)/1000)}초 | 0 |`).join('\n');
fs.writeFileSync(path.join(root,stage,'report.md'),`# 성취수준 모델 최종 답변 수집 결과\n\n${stage} 단계. RC4 sourceDigest: ${lock.sourceDigest}.\n\n| 모델 | 요청 effort | 최종 답변 수집 | 환경 오류 회차 | 도구 호출 | p50 | p95 | 사람 검토 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n최종 답변 수집은 품질 통과와 다르다. 사람 검토 및 중대 위반 의미 검토는 미완료이며, 성공률과 모델 우열을 확정하지 않는다. 구독 CLI의 전체 시스템 지침·OS 파일 격리는 검증되지 않았다. Luna의 provider 관측 모델 ID가 없으면 요청 모델과 구분하여 미확인으로 남긴다. Haiku 기본 동작과 Luna High의 조건 차이를 유지한다. 출시 승인 판정은 하지 않는다.\n\n- [Luna 검토 패킷](./luna/review-packet.md)\n- [Haiku 검토 패킷](./haiku/review-packet.md)\n- [기계 판독 비교](./comparison.json)\n`,{flag:'wx'});
const files={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name!=='artifact-hashes.json')files[path.relative(root,p).replaceAll('\\','/')]=sha(fs.readFileSync(p));}}walk(path.join(root,stage));
write(path.join(root,stage,'artifact-hashes.json'),{generatedAt:new Date().toISOString(),files});console.log(JSON.stringify(summaries));
