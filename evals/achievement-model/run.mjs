import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ROOT,LOCK,CORPUS,MODELS,TOOLS,INSTRUCTIONS,args,read,write,append,sha,clean,cliEnv,corpus,publicScenarios,credential,remote} from './common.mjs';
import {schedule} from './scheduler.mjs';

export const REPRESENTATIVE=['D06-code','D21-code','D15-natural','D26-code','D18-code','D01-discovery'];
export function jobs(stage,scenarios){
  if(stage==='connection')return [scenarios.find(s=>s.id==='D06-discovery')];
  if(stage==='representative')return REPRESENTATIVE.map(id=>scenarios.find(s=>s.id===id));
  if(stage!=='full')throw Error('UNKNOWN_STAGE');
  // Round-robin document assignment spreads school/format groups over three batches.
  return [0,1,2].flatMap(batch=>scenarios.filter(s=>(Number(s.documentId.slice(1))-1)%3===batch));
}
export function parseEvents(stdout,model){
  const events=stdout.split(/\r?\n/).filter(Boolean).flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}});
  if(model==='haiku'){
    const init=events.find(e=>e.type==='system'&&e.subtype==='init'),result=events.findLast(e=>e.type==='result');
    const messages=events.filter(e=>e.type==='assistant').map(e=>e.message);
    const attempts=messages.flatMap(m=>(m?.content??[]).filter(c=>c.type==='tool_use'));
    return {events,sessionId:result?.session_id??init?.session_id??null,final:result?.result??'',completed:result?.subtype==='success'&&!result?.is_error,
      observedModelVersions:[...new Set(messages.map(m=>m?.model).filter(Boolean))],observedTools:init?.tools??null,attempts,
      usage:result?.usage??null,estimatedCostUsd:result?.total_cost_usd??null,resultSubtype:result?.subtype??null};
  }
  const items=events.filter(e=>e.type==='item.completed').map(e=>e.item).filter(Boolean);
  const completed=events.findLast(e=>e.type==='turn.completed');
  return {events,sessionId:events.find(e=>e.type==='thread.started')?.thread_id??null,final:items.filter(i=>i.type==='agent_message').at(-1)?.text??'',completed:!!completed,
    observedModelVersions:[...new Set(events.flatMap(e=>[e.model,e.model_version,e.response?.model]).filter(Boolean))],observedTools:null,
    attempts:items.filter(i=>i.type==='mcp_tool_call'||i.type==='command_execution'||i.type?.includes('tool')),usage:completed?.usage??null,estimatedCostUsd:null,resultSubtype:completed?'success':null};
}
const fileHashes=()=>Object.fromEntries(['common.mjs','proxy.mjs','run.mjs','runner.test.mjs','scheduler.mjs','scheduler.test.mjs'].map(f=>[f,sha(fs.readFileSync(path.join(import.meta.dirname,f)))]));
const posix=s=>s.replaceAll('\\','/');
export function invocation(model,workspace,config,instructions,audit,lock){
  const m=MODELS[model],proxy=posix(path.join(import.meta.dirname,'proxy.mjs'));
  const proxyArgs=[proxy,'--lock',posix(lock),'--audit',posix(audit)];
  if(model==='haiku'){
    return ['-p','--model',m.model,'--output-format','stream-json','--verbose','--no-session-persistence','--restricted','--tools','','--allowedTools',...TOOLS.map(t=>'mcp__edunet__'+t),'--strict-mcp-config','--mcp-config',config,'--setting-sources','','--settings',path.join(workspace,'../settings.json'),'--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--system-prompt',instructions];
  }
  const mcp=`mcp_servers={edunet={command=${JSON.stringify(posix(process.execPath))},args=${JSON.stringify(proxyArgs)},cwd=${JSON.stringify(posix(ROOT))},enabled=true,enabled_tools=${JSON.stringify(TOOLS)},startup_timeout_sec=45,tool_timeout_sec=100}}`;
  const argv=['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--strict-config','--model',m.model,'--sandbox','read-only','--skip-git-repo-check','--cd',workspace,'-c',mcp,'-c','approval_policy="never"','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','project_doc_fallback_filenames=[]','-c','agents.enabled=false','-c','model_reasoning_effort="high"','-c',`model_instructions_file=${JSON.stringify(posix(path.join(workspace,'../instructions.md')))}`];
  for(const feature of ['shell_tool','unified_exec','hooks','apps','plugins','remote_plugin','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use','in_app_browser','image_generation','view_image','memories','skill_search','tool_suggest','workspace_dependencies'])argv.push('-c',`features.${feature}=false`);
  return argv;
}
async function prepare(out){
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(out);const lock=read(LOCK),conn=await remote(lock,await credential());
  const manifest=await conn.manifest();
  const initialize=await conn.rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'achievement-model-preflight',version:'1.0'}}});
  await conn.rpc({jsonrpc:'2.0',method:'notifications/initialized'});
  const listed=await conn.rpc({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  if(!TOOLS.every(n=>listed.result?.tools.some(t=>t.name===n))||listed.result.tools.length!==TOOLS.length)throw Error('UNEXPECTED_TOOL_SURFACE');
  const versions={};for(const [model,m]of Object.entries(MODELS)){
    const v=spawnSync(m.exe,['--version'],{env:cliEnv(),encoding:'utf8',timeout:20000,windowsHide:true});
    if(v.status!==0)throw Error('CLI_UNAVAILABLE');
    versions[model]={version:v.stdout.trim(),exeHash:sha(fs.readFileSync(m.exe)),requestedModel:m.model,requestedEffort:m.effort};
  }
  const a=spawnSync(MODELS.haiku.exe,['auth','status'],{env:cliEnv(),encoding:'utf8',windowsHide:true,timeout:20000});const ah=JSON.parse(a.stdout);
  const b=spawnSync(MODELS.luna.exe,['login','status'],{env:cliEnv(),encoding:'utf8',windowsHide:true,timeout:20000});
  if(a.status!==0||!ah.loggedIn||ah.authMethod!=='claude.ai'||b.status!==0||!/ChatGPT/.test(b.stdout+b.stderr))throw Error('SUBSCRIPTION_AUTH_REQUIRED');
  const c=corpus(),scenarios=publicScenarios();
  write(path.join(out,'rc-lock.json'),lock);write(path.join(out,'surface.json'),{initialize:initialize.result,tools:listed.result.tools});
  const instruction=INSTRUCTIONS+'\n\n'+(initialize.result.instructions??'');
  fs.writeFileSync(path.join(out,'instructions.md'),instruction,{flag:'wx'});write(path.join(out,'prompts.json'),scenarios);
  const rubric={version:'achievement-final-answer-1',frozenAt:new Date().toISOString(),humanReviewed:false,
    discovery:'Find suitable official material and explain relevance. Do not require unrequested code extraction; accept valid alternative official sources after source review.',
    code:'Give the requested code, original level labels, accurate descriptions, official source and available location; preserve grade bands.',
    natural:'Connect the requested topic to an evidenced achievement standard and its levels; state unresolved matching or read limitations.',
    all:['No fabricated content/source/original-read claim','Preserve source labels and combined grade-band wording; do not infer a single grade','Appropriate limitation handling counts as a useful response when requested content cannot be read','Do not require every cursor when a bounded user request is fully answered; state partial scope','Human usefulness/groundedness remain pending until actual review'],
    critical:['fabricatedSource','fabricatedContent','falseOriginalRead','unsupportedGradeInference','keyLeak','externalInstructionExecuted'],
    recordPrecisionGate:null,finalAnswerReleaseThreshold:null,releaseEligible:false};
  write(path.join(out,'rubric.json'),rubric);
  write(path.join(out,'review-reference.json'),{documents:c.documents,scenarios:c.scenarios,note:'Outside model workspace; original corpus unchanged. Combined grade labels judged against official originals, not old narrow accepted values.'});
  write(path.join(out,'evaluation-lock.json'),{createdAt:new Date().toISOString(),kind:'subscription_observational_final_answer',releaseEligible:false,corpusSha256:sha(fs.readFileSync(CORPUS)),sourceDigest:manifest.sourceDigest,manifestDigest:manifest.manifestDigest,
    promptsHash:sha(JSON.stringify(scenarios)),instructionsHash:sha(instruction),rubricHash:sha(JSON.stringify(rubric)),runnerHashes:fileHashes(),models:versions,
    plannedPerModel:90,connectionPerModel:1,representativePerModel:6,timeoutMs:600000,toolCallLimit:60,modelConcurrency:1,totalConcurrency:2,
    limitations:['Full native system instructions and OS file-read isolation unverified; not a controlled release certification','Provider-resolved Luna version may not be exposed by CLI; requested config and observed version recorded separately','Human source/table and final-answer review remain pending','Subscription CLI/provider default output budgets may differ; no equivalence assumed'],authentication:{haiku:ah.authMethod,luna:'ChatGPT'}});
  fs.mkdirSync(path.join(out,'runner-snapshot'));
  for(const f of Object.keys(fileHashes()))fs.copyFileSync(path.join(import.meta.dirname,f),path.join(out,'runner-snapshot',f),fs.constants.COPYFILE_EXCL);
  console.log(JSON.stringify({prepared:out,scenarios:scenarios.length,sourceDigest:manifest.sourceDigest,tools:TOOLS,models:versions}));
}
function auditCalls(dir){return fs.readdirSync(dir).filter(f=>/^\d+-request.json$/.test(f)).sort((a,b)=>parseInt(a)-parseInt(b)).map(f=>{
  const req=read(path.join(dir,f)),responseFile=path.join(dir,f.replace('-request','-response'));
  return {request:req.message,response:fs.existsSync(responseFile)?read(responseFile):null};
}).filter(x=>x.request.method==='tools/call');}
async function runOne(out,stage,model,s,index){
  const dir=path.join(out,stage,model,s.id);fs.mkdirSync(dir,{recursive:true});
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'edunet-final-')),workspace=path.join(base,'workspace');fs.mkdirSync(workspace);
  const audit=path.join(dir,'audit');fs.mkdirSync(audit);const instruction=fs.readFileSync(path.join(out,'instructions.md'),'utf8');
  fs.writeFileSync(path.join(base,'instructions.md'),instruction,{flag:'wx'});
  const config=path.join(base,'mcp.json');write(config,{mcpServers:{edunet:{command:process.execPath,args:[path.join(import.meta.dirname,'proxy.mjs'),'--lock',path.join(out,'rc-lock.json'),'--audit',audit],cwd:ROOT}}});
  write(path.join(base,'settings.json'),{disableAllHooks:true,autoMemoryEnabled:false,permissions:{allow:TOOLS.map(t=>'mcp__edunet__'+t),deny:['Bash','PowerShell','Read','Write','Edit','Glob','Grep','WebFetch','WebSearch','Agent','Task']}});
  const argv=invocation(model,workspace,config,instruction,audit,path.join(out,'rc-lock.json'));
  if(model==='haiku')argv.push('--',s.question);else argv.push(s.question);
  write(path.join(dir,'invocation.json'),{model,requestedModel:MODELS[model].model,requestedEffort:MODELS[model].effort,argv,workspace,environmentKeys:Object.keys(cliEnv()),question:s.question});
  const startedAt=new Date().toISOString(),start=Date.now();let stdout='',stderr='',timeout=false;
  const child=spawn(MODELS[model].exe,argv,{cwd:workspace,env:cliEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>{timeout=true;spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});},600000);
  const exit=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve);});clearTimeout(timer);
  // Let the stdio proxy finish its final manifest check after the CLI closes its pipe.
  for(let i=0;i<30&&!fs.existsSync(path.join(audit,'manifest-after.json'))&&!fs.existsSync(path.join(audit,'startup-error.json'));i++)await new Promise(r=>setTimeout(r,100));
  const parsed=parseEvents(stdout,model),calls=auditCalls(audit);const errors=[];
  if(timeout)errors.push('session_timeout');else if(exit!==0||!parsed.completed)errors.push('provider_or_cli_failure');
  if(!parsed.final.trim())errors.push('missing_final_answer');
  if(parsed.events.some(e=>e.type==='item.completed'&&e.item?.type==='error'))errors.push('cli_tool_runtime_error');
  for(const f of ['fatal.json','startup-error.json'])if(fs.existsSync(path.join(audit,f)))errors.push('proxy_'+read(path.join(audit,f)).code);
  if(!fs.existsSync(path.join(audit,'manifest-before.json')))errors.push('proxy_startup_unverified');
  if(calls.some(c=>!c.response))errors.push('incomplete_mcp_audit');
  if(stage==='connection'&&!calls.length)errors.push('connection_no_tool_call');
  if(model==='haiku'){
    if(!parsed.observedTools||parsed.observedTools.length!==TOOLS.length||!TOOLS.every(t=>parsed.observedTools.includes('mcp__edunet__'+t)))errors.push('unexpected_tool_surface');
    if(parsed.attempts.length!==calls.length)errors.push('mcp_audit_count_mismatch');
    if(!parsed.observedModelVersions.length||parsed.observedModelVersions.some(v=>v!==MODELS.haiku.model))errors.push('model_version_mismatch');
  }
  const outOfScope=parsed.attempts.filter(t=>model==='haiku'?!TOOLS.some(n=>t.name==='mcp__edunet__'+n):(t.type!=='mcp_tool_call'||t.server!=='edunet'||!TOOLS.includes(t.tool)));
  if(outOfScope.length)errors.push('out_of_scope_tool');
  const flags=[];if(!calls.length)flags.push('no_mcp_tool_calls');if(fs.existsSync(path.join(audit,'blocked.jsonl')))flags.push('blocked_tool_or_method');
  const responses=calls.map(c=>c.response?.response?.result?.structuredContent).filter(Boolean);
  const recordCount=responses.reduce((n,r)=>n+(r.records?.length??0),0);
  const result={id:s.id,documentId:s.documentId,kind:s.kind,model,stage,sequence:index+1,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-start,cliExitCode:exit,requestedModel:MODELS[model].model,requestedEffort:MODELS[model].effort,
    observedModelVersions:parsed.observedModelVersions,observedEffort:null,sessionId:parsed.sessionId,final:parsed.final,turnCompleted:parsed.completed,finalAnswerCollected:!!parsed.final.trim()&&parsed.completed&&exit===0,
    usage:parsed.usage,estimatedCostUsd:parsed.estimatedCostUsd,observedTools:parsed.observedTools,toolCalls:calls.length,returnedRecords:recordCount,toolStatuses:responses.map(r=>r.status).filter(Boolean),
    environmentErrors:errors,automaticReviewFlags:flags,humanReview:'pending',qualityPass:null,releaseEligible:false,proxyFinalManifestVerified:fs.existsSync(path.join(audit,'manifest-after.json'))};
  write(path.join(dir,'events.json'),parsed.events);write(path.join(dir,'result.json'),result);
  fs.writeFileSync(path.join(dir,'final.md'),clean(parsed.final),{flag:'wx'});
  write(path.join(dir,'execution.json'),{exit,timeout,stderr:clean(stderr),resultSubtype:parsed.resultSubtype});
  append(path.join(out,stage,model,'runs.jsonl'),result);
  console.log(JSON.stringify({stage,model,completed:index+1,id:s.id,answer:result.finalAnswerCollected,calls:calls.length,records:recordCount,seconds:Math.round(result.durationMs/1000),errors,flags}));
  return result;
}
async function collect(out,stage){
  const lock=read(path.join(out,'evaluation-lock.json'));
  let fullLock=null;
  if(stage==='full'){
    fullLock=read(path.join(out,'full-stage-lock.json'));
    if(fullLock.originalLockHash!==sha(fs.readFileSync(path.join(out,'evaluation-lock.json')))||fullLock.modelConcurrency!==3||fullLock.timeoutMs!==600000||fullLock.toolCallLimit!==60)throw Error('FULL_STAGE_LOCK_INVALID');
    if(fullLock.reviewReferenceHash!==sha(fs.readFileSync(path.join(out,'review-reference.json'))))throw Error('REVIEW_REFERENCE_DRIFT');
  }
  if(JSON.stringify(fileHashes())!==JSON.stringify(fullLock?.runnerHashes??lock.runnerHashes))throw Error('RUNNER_CHANGED_NEW_COHORT_REQUIRED');
  const scenarios=read(path.join(out,'prompts.json'));
  if(sha(JSON.stringify(scenarios))!==lock.promptsHash||sha(fs.readFileSync(path.join(out,'instructions.md')))!==lock.instructionsHash)throw Error('INPUT_DRIFT');
  if(sha(JSON.stringify(read(path.join(out,'rubric.json'))))!==lock.rubricHash)throw Error('RUBRIC_DRIFT');
  const folder=path.join(out,stage);fs.mkdirSync(folder);
  const selected=jobs(stage,scenarios);const conn=await remote(read(path.join(out,'rc-lock.json')),await credential());await conn.manifest();
  for(const [model,m]of Object.entries(MODELS))if(sha(fs.readFileSync(m.exe))!==lock.models[model].exeHash)throw Error('CLI_DRIFT');
  if(stage!=='connection'){
    const previous=read(path.join(out,stage==='representative'?'connection':'representative','summary.json'));
    if(!previous.every(s=>s.complete&&!s.stopped))throw Error('PREVIOUS_STAGE_INCOMPLETE');
  }
  const summaries=await Promise.all(Object.keys(MODELS).map(async model=>{
    fs.mkdirSync(path.join(folder,model));
    const fatal=r=>r.environmentErrors.filter(e=>stage!=='full'||!['session_timeout','missing_final_answer'].includes(e));
    const scheduled=await schedule(selected,(s,i)=>runOne(out,stage,model,s,i),{concurrency:fullLock?.modelConcurrency??1,isFatal:r=>fatal(r).length>0});
    const results=scheduled.results,stopped=scheduled.stopped?{id:scheduled.stopped.result.id,reasons:fatal(scheduled.stopped.result)}:null;
    const summary={model,stage,planned:selected.length,recorded:results.length,finalAnswers:results.filter(r=>r.finalAnswerCollected).length,collectionComplete:results.length===selected.length,complete:results.length===selected.length&&results.every(r=>r.finalAnswerCollected),stopped,humanReviewed:0,releaseEligible:false};
    write(path.join(folder,model,'review.json'),{reviewer:null,reviewedAt:null,runs:results.map(r=>({id:r.id,resultHash:sha(JSON.stringify(r)),useful:null,grounded:null,critical:null,notes:''}))});
    write(path.join(folder,model,'summary.json'),summary);return summary;
  }));
  write(path.join(folder,'manifest-after.json'),await conn.manifest());write(path.join(folder,'summary.json'),summaries);console.log(JSON.stringify(summaries));
}
async function main(){const o=args();if(!o.out||!o.stage)throw Error('OUT_AND_STAGE_REQUIRED');const out=path.resolve(o.out);if(o.stage==='prepare')await prepare(out);else await collect(out,o.stage);}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error('EVALUATION_STOPPED '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'UNEXPECTED_RUNNER_ERROR'));process.exitCode=1;});
