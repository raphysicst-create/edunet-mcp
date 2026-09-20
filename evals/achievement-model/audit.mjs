import fs from 'node:fs';
import path from 'node:path';
import {args,read,write,sha,TOOLS} from './common.mjs';
const o=args();const root=path.resolve(o.out),stage=o.stage??'full';
if(o.name&&path.basename(o.name)!==o.name)throw Error('AUDIT_NAME_MUST_BE_BASENAME');
if(o.model&&!['luna','haiku'].includes(o.model))throw Error('UNKNOWN_MODEL');
const models=o.model?[o.model]:['luna','haiku'];
const lock=read(path.join(root,'evaluation-lock.json'));
const problems=[],runs=[],incompleteEvidence=[];
for(const model of models){
  const dir=path.join(root,stage,model);if(!fs.existsSync(dir))continue;
  const cases=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory());
  for(const c of cases){
    const p=path.join(dir,c.name),audit=path.join(p,'audit');if(!fs.existsSync(path.join(p,'result.json'))){problems.push({model,id:c.name,problem:'missing_result'});continue;}
    const r=read(path.join(p,'result.json')),events=read(path.join(p,'events.json'));
    const requests=fs.readdirSync(audit).filter(f=>/^\d+-request.json$/.test(f));
    const calls=requests.map(f=>({file:f,...read(path.join(audit,f))})).filter(x=>x.message.method==='tools/call');
    const blockedFile=path.join(audit,'blocked.jsonl');
    const blockedCalls=fs.existsSync(blockedFile)?fs.readFileSync(blockedFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.message?.method==='tools/call'):[];
    const local=[],timedOut=r.environmentErrors.includes('session_timeout');
    const lastRequest=Math.max(...requests.map(f=>Number(f.split('-')[0])));
    if(calls.length!==r.toolCalls)local.push('result_call_count_mismatch');
    for(const request of requests){const responseFile=path.join(audit,request.replace('-request','-response'));if(!fs.existsSync(responseFile)){if(timedOut&&Number(request.split('-')[0])===lastRequest)incompleteEvidence.push({model,id:c.name,kind:'timeout_missing_last_response',request});else local.push('request_missing_response');continue;}const q=read(path.join(audit,request)),a=read(responseFile);if(!a.identityVerified)local.push('rpc_identity_unverified');if(q.message.id!==undefined&&q.message.id!==a.response?.id)local.push('rpc_id_mismatch');}
    for(const f of ['manifest-before.json','manifest-after.json'])if(fs.existsSync(path.join(audit,f))){const m=read(path.join(audit,f));if(m.sourceDigest!==lock.sourceDigest||m.manifestDigest!==lock.manifestDigest)local.push('manifest_mismatch');}
    const lunaCalls=events.filter(e=>['item.started','item.completed'].includes(e.type)&&e.item?.type==='mcp_tool_call');
    const attempts=model==='haiku'?events.filter(e=>e.type==='assistant').flatMap(e=>(e.message?.content??[]).filter(c=>c.type==='tool_use')):[...new Map(lunaCalls.map(e=>[e.item.id,e.item])).values()];
    if(model==='luna')for(const a of attempts)if(!lunaCalls.some(e=>e.type==='item.completed'&&e.item.id===a.id)){if(timedOut)incompleteEvidence.push({model,id:c.name,kind:'timeout_incomplete_model_tool_event',itemId:a.id});else local.push('incomplete_model_tool_event');}
    if(!fs.existsSync(path.join(audit,'manifest-after.json')))incompleteEvidence.push({model,id:c.name,kind:timedOut?'timeout_missing_session_post_manifest':'missing_session_post_manifest',note:'Pre-session manifest and individual RPC identity are checked separately; final per-session manifest was not captured.'});
    if(attempts.length!==calls.length+blockedCalls.length)local.push('model_attempt_count_mismatch');
    if(calls.some(c=>!TOOLS.includes(c.message.params?.name)))local.push('unexpected_tool');
    if(r.finalAnswerCollected&&(!r.final?.trim()||!r.turnCompleted||r.cliExitCode!==0))local.push('false_completion');
    if(r.model==='haiku'&&read(path.join(p,'invocation.json')).argv.includes('--effort'))local.push('haiku_effort_override');
    if(r.model==='luna'&&!read(path.join(p,'invocation.json')).argv.includes('model_reasoning_effort="high"'))local.push('luna_effort_missing');
    for(const problem of [...new Set(local)])problems.push({model,id:c.name,problem});
    runs.push({model,id:r.id,sessionId:r.sessionId,callCount:calls.length,blockedCallCount:blockedCalls.length,modelAttemptCount:attempts.length,environmentErrors:r.environmentErrors,finalAnswerCollected:r.finalAnswerCollected,resultHash:sha(fs.readFileSync(path.join(p,'result.json')))});
  }
}
for(const model of models){const rs=runs.filter(r=>r.model===model);if(new Set(rs.map(r=>r.id)).size!==rs.length)problems.push({model,problem:'duplicate_scenario'});if(new Set(rs.map(r=>r.sessionId).filter(Boolean)).size!==rs.filter(r=>r.sessionId).length)problems.push({model,problem:'session_reused'});}
write(path.join(root,stage,o.name??(o.model?`integrity-audit-${o.model}.json`:'integrity-audit.json')),{createdAt:new Date().toISOString(),stage,models,pass:problems.length===0,evidenceComplete:incompleteEvidence.length===0,problems,incompleteEvidence,runs,scope:'Pass means no unexplained request/response trace discrepancy. Missing post-session manifests and timeout gaps remain unverified and evidenceComplete=false; not a semantic grade or full environment isolation certificate.'});
console.log(JSON.stringify({stage,runs:runs.length,pass:problems.length===0,evidenceComplete:incompleteEvidence.length===0,incompleteEvidenceCount:incompleteEvidence.length,problems}));if(problems.length)process.exitCode=1;
