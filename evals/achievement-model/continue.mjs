// Continue only unstarted primary slots; do not replace any attempted outcome.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {args,read,write,sha,MODELS,credential,remote} from './common.mjs';
import {schedule} from './scheduler.mjs';
import {jobs} from './run.mjs';
const o=args(),root=path.resolve(o.out),original=read(path.join(root,'evaluation-lock.json')),fullLock=read(path.join(root,'full-stage-lock.json'));
read(path.join(root,'full','summary.json')); // Original collector must have exited and finalized its prefix.
for(const [f,h]of Object.entries(fullLock.runnerHashes))if(sha(fs.readFileSync(path.join(import.meta.dirname,f)))!==h)throw Error('RUNNER_DRIFT');
for(const [m,s]of Object.entries(MODELS))if(sha(fs.readFileSync(s.exe))!==original.models[m].exeHash)throw Error('CLI_DRIFT');
const scenarios=read(path.join(root,'prompts.json'));
if(sha(JSON.stringify(scenarios))!==original.promptsHash||sha(fs.readFileSync(path.join(root,'instructions.md')))!==original.instructionsHash)throw Error('INPUT_DRIFT');
const planned=jobs('full',scenarios);
const sourceRuns=Object.fromEntries(Object.keys(MODELS).map(m=>[m,fs.readFileSync(path.join(root,'full',m,'runs.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)]));
for(const [m,rs]of Object.entries(sourceRuns)){
  const dirs=fs.readdirSync(path.join(root,'full',m),{withFileTypes:true}).filter(e=>e.isDirectory());
  if(dirs.some(d=>!rs.some(r=>r.id===d.name)))throw Error('UNACCOUNTED_STARTED_SESSION');
  if(rs.some(r=>r.environmentErrors.some(e=>!['session_timeout','missing_final_answer','incomplete_mcp_audit'].includes(e))))throw Error('UNRESOLVED_PROVIDER_OR_ENVIRONMENT_FAILURE');
}
const selected=Object.fromEntries(Object.entries(sourceRuns).map(([m,rs])=>[m,planned.map((s,index)=>({scenario:s,index})).filter(j=>!rs.some(r=>r.id===j.scenario.id))]));
const stage='continuation',dest=path.join(root,stage);fs.mkdirSync(dest);
write(path.join(dest,'continuation-lock.json'),{createdAt:new Date().toISOString(),reason:'A timeout during an RPC produced incomplete_mcp_audit and stopped primary queue claims. Treat that missing tail as expected timeout evidence; retain it and continue only unstarted scenarios.',unchanged:['Model IDs/effort','Prompts and instructions','RC4','600 seconds and 60 calls per session','3 concurrent sessions per model','Per-session runOne implementation'],primaryFullLockHash:sha(fs.readFileSync(path.join(root,'full-stage-lock.json'))),selectedByModel:Object.fromEntries(Object.entries(selected).map(([m,js])=>[m,js.map(j=>j.scenario.id)])),existingRunLogHashes:Object.fromEntries(Object.keys(MODELS).map(m=>[m,sha(fs.readFileSync(path.join(root,'full',m,'runs.jsonl')))])),releaseEligible:false});
const moduleDir=path.join(root,'continuation-runner');fs.mkdirSync(moduleDir);
const source=fs.readFileSync(path.join(root,'full-runner-snapshot','run.mjs'),'utf8');if(sha(source)!==fullLock.runnerHashes['run.mjs'])throw Error('SNAPSHOT_DRIFT');
const generated=source.replace("'./common.mjs'",JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'common.mjs')).href)).replace("'./scheduler.mjs'",JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'scheduler.mjs')).href)).replaceAll('import.meta.dirname',JSON.stringify(import.meta.dirname))+'\nexport {runOne};\n';
const modulePath=path.join(moduleDir,'session.mjs');fs.writeFileSync(modulePath,generated,{flag:'wx'});
write(path.join(moduleDir,'derivation.json'),{sourceSha256:sha(source),generatedSha256:sha(generated),transformation:'Bind imports/dirname and export unchanged runOne. Only outer queue stop classification changes.'});
const {runOne}=await import(pathToFileURL(modulePath).href);
const conn=await remote(read(path.join(root,'rc-lock.json')),await credential());write(path.join(dest,'manifest-before.json'),await conn.manifest());
const summaries=await Promise.all(Object.keys(MODELS).map(async model=>{
  fs.mkdirSync(path.join(dest,model));
  const isFatal=r=>r.environmentErrors.some(e=>!(['session_timeout','missing_final_answer'].includes(e)||(e==='incomplete_mcp_audit'&&r.environmentErrors.includes('session_timeout'))));
  const collected=await schedule(selected[model],j=>runOne(root,stage,model,j.scenario,j.index),{concurrency:3,isFatal});
  const summary={model,stage,planned:selected[model].length,recorded:collected.results.length,finalAnswers:collected.results.filter(r=>r.finalAnswerCollected).length,collectionComplete:collected.results.length===selected[model].length,stopped:collected.stopped?{id:collected.stopped.result.id,errors:collected.stopped.result.environmentErrors}:null,releaseEligible:false};
  write(path.join(dest,model,'summary.json'),summary);return summary;
}));
write(path.join(dest,'manifest-after.json'),await conn.manifest());write(path.join(dest,'summary.json'),summaries);console.log(JSON.stringify(summaries));
