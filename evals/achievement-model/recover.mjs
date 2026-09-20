// One supplementary attempt for no-answer timeouts, never a replacement for the primary run.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {args,read,write,sha,MODELS,credential,remote} from './common.mjs';
import {schedule} from './scheduler.mjs';
const o=args(),root=path.resolve(o.out),original=read(path.join(root,'evaluation-lock.json')),fullLock=read(path.join(root,'full-stage-lock.json'));
const fullSummary=read(path.join(root,'primary','summary.json'));
if(fullSummary.length!==2||fullSummary.some(s=>s.recorded!==90||s.stopped))throw Error('PRIMARY_COLLECTION_NOT_FINISHED');
for(const [f,h]of Object.entries(fullLock.runnerHashes))if(sha(fs.readFileSync(path.join(import.meta.dirname,f)))!==h)throw Error('RUNNER_DRIFT');
for(const [m,s]of Object.entries(MODELS))if(sha(fs.readFileSync(s.exe))!==original.models[m].exeHash)throw Error('CLI_DRIFT');
if(sha(fs.readFileSync(path.join(root,'instructions.md')))!==original.instructionsHash)throw Error('INSTRUCTION_DRIFT');
const scenarios=read(path.join(root,'prompts.json'));
if(sha(JSON.stringify(scenarios))!==original.promptsHash)throw Error('PROMPT_DRIFT');
const primary=Object.fromEntries(Object.keys(MODELS).map(m=>[m,fs.readFileSync(path.join(root,'primary',m,'runs.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)]));
const selected=Object.fromEntries(Object.entries(primary).map(([m,rs])=>[m,rs.filter(r=>!r.finalAnswerCollected&&r.environmentErrors.length&&r.environmentErrors.every(e=>['session_timeout','missing_final_answer','incomplete_mcp_audit'].includes(e))).sort((a,b)=>a.sequence-b.sequence)]));
const dest=path.join(root,'recovery');fs.mkdirSync(dest);
write(path.join(dest,'recovery-lock.json'),{createdAt:new Date().toISOString(),purpose:'Single supplementary attempt for primary no-answer sessions. Primary denominator and failures remain unchanged.',policy:'Only no-final-answer timeouts; never retry a completed incorrect/limited answer; at most one fresh supplementary session per scenario.',primaryFullLockHash:sha(fs.readFileSync(path.join(root,'full-stage-lock.json'))),selectedByModel:Object.fromEntries(Object.entries(selected).map(([m,rs])=>[m,rs.map(r=>({id:r.id,primaryResultSha256:sha(fs.readFileSync(path.join(root,'primary',m,r.id,'result.json')))}))])),modelConcurrency:3,timeoutMs:600000,toolCallLimit:60,releaseEligible:false});
const moduleDir=path.join(root,'recovery-runner');fs.mkdirSync(moduleDir);
const source=fs.readFileSync(path.join(root,'full-runner-snapshot','run.mjs'),'utf8');
if(sha(source)!==fullLock.runnerHashes['run.mjs'])throw Error('FULL_SNAPSHOT_DRIFT');
// Only module import locations / dirname are bound and the existing session function exported.
const generated=source.replace("'./common.mjs'",JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'common.mjs')).href))
  .replace("'./scheduler.mjs'",JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'scheduler.mjs')).href))
  .replaceAll('import.meta.dirname',JSON.stringify(import.meta.dirname))+'\nexport {runOne};\n';
const modulePath=path.join(moduleDir,'session.mjs');fs.writeFileSync(modulePath,generated,{flag:'wx'});
write(path.join(moduleDir,'derivation.json'),{sourceSha256:sha(source),generatedSha256:sha(generated),transformation:'Bind the two relative imports and dirname to verified original modules, append export of unchanged runOne; no session behavior or model arguments changed.'});
const {runOne}=await import(pathToFileURL(modulePath).href);
const conn=await remote(read(path.join(root,'rc-lock.json')),await credential());write(path.join(dest,'manifest-before.json'),await conn.manifest());
const summaries=await Promise.all(Object.keys(MODELS).map(async model=>{
  fs.mkdirSync(path.join(dest,model));
  const queued=selected[model];
  const collected=await schedule(queued,(r)=>runOne(root,'recovery',model,scenarios.find(s=>s.id===r.id),r.sequence-1),{concurrency:3,isFatal:r=>r.environmentErrors.some(e=>!(['session_timeout','missing_final_answer'].includes(e)||(e==='incomplete_mcp_audit'&&r.environmentErrors.includes('session_timeout'))))});
  const recovered=collected.results.filter(r=>r.finalAnswerCollected).length;
  const summary={model,planned:queued.length,recorded:collected.results.length,finalAnswers:recovered,primaryFinalAnswers:primary[model].filter(r=>r.finalAnswerCollected).length,uniqueScenariosWithFinalAnswer:primary[model].filter(r=>r.finalAnswerCollected).length+recovered,stopped:collected.stopped?{id:collected.stopped.result.id,errors:collected.stopped.result.environmentErrors}:null,releaseEligible:false};
  write(path.join(dest,model,'summary.json'),summary);return summary;
}));
write(path.join(dest,'manifest-after.json'),await conn.manifest());write(path.join(dest,'summary.json'),summaries);console.log(JSON.stringify(summaries));
