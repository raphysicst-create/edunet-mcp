import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, assertNewPaths, hash, readJson, writeJson, progressWriter, reviewTemplate, mockSession, containsSecret } from './lib.mjs';
import { cases, caseVersion, fixtureVersion } from './cases.mjs';
import { gradeTrace, scorerVersion } from './grade.mjs';
import { provenance } from './provenance.mjs';
import { cleanEnvironment } from './subscription-isolation.mjs';
import { summarizePilot } from './subscription-pilot.mjs';

export function parseClaudeEvents(stdout) {
  const events=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const init=events.find(e=>e.type==='system'&&e.subtype==='init');
  const result=events.findLast(e=>e.type==='result');
  const attempts=events.filter(e=>e.type==='assistant').flatMap(e=>(e.message?.content??[]).filter(c=>c.type==='tool_use'));
  const models=[...new Set(events.filter(e=>e.type==='assistant').map(e=>e.message?.model).filter(Boolean))];
  return {events,init,result,attempts,models,final:result?.result??'',sessionId:result?.session_id??init?.session_id??null};
}
export function claudeSurfaceValid(init) {
  return Array.isArray(init?.tools) && init.tools.length===1 && init.tools[0]==='mcp__edunet__search_edunet';
}
export function claudeEnv() {
  const env=cleanEnvironment(homedir()); delete env.CODEX_HOME;
  // Use the native credential store; do not copy tokens or inherit API keys.
  for(const k of ['APPDATA','LOCALAPPDATA']) if(process.env[k]) env[k]=process.env[k];
  return {...env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
}
async function main() {
  const o=args(); if(o['allow-unverified']!=='true') throw Error('Explicit unverified pilot opt-in required');
  if(!['preflight','connection','full','case'].includes(o.mode)) throw Error('mode: preflight, connection, full, case');
  if(o.mode==='case'&&!cases.some(c=>c.id===o['case-id']))throw Error('Known case-id required');
  if(!o.model || !/sonnet/i.test(o.model)) throw Error('Explicit Sonnet model required');
  assertNewPaths([o.out,o.review,o.artifacts]); mkdirSync(o.artifacts,{recursive:true});
  const executable=resolve(o['claude-exe']), env=claudeEnv();
  const version=spawnSync(executable,['--version'],{env,encoding:'utf8',timeout:15000});
  const auth=spawnSync(executable,['auth','status'],{env,encoding:'utf8',timeout:15000});
  let status={};try{status=JSON.parse(auth.stdout);}catch{}
  const authenticated=auth.status===0&&status.loggedIn===true&&status.authMethod==='claude.ai';
  const session=await mockSession(cases[0]);let surface;try{surface={tools:(await session.client.listTools()).tools,instructions:session.instructions};}finally{await session.close();}
  const report={kind:'subscription_model_run',evaluationProfile:'claude_usage_unverified',releaseEligible:false,requestedModel:o.model,model:o.model,modelVersion:null,
    stage:o.mode,selectedCaseId:o['case-id']??null,plannedRuns:o.mode==='full'?90:o.mode==='case'?3:o.mode==='connection'?1:0,repetitions:['full','case'].includes(o.mode)?3:1,caseVersion,caseHash:hash(cases),fixtureVersion,scorerVersion,
    provenance:provenance('evals/claude-pilot.mjs'),extraHashes:Object.fromEntries(['evals/claude-mcp-proxy.mjs','evals/subscription-isolation.mjs','evals/subscription-pilot.mjs'].map(p=>[p,hash(readFileSync(p,'utf8'))])),
    executableHash:hash(readFileSync(executable).toString('base64')),cliVersion:version.stdout?.trim(),authentication:{loggedIn:status.loggedIn===true,authMethod:status.authMethod??'unknown'},
    settings:{model:o.model,effort:'medium',concurrency:1,builtinTools:[],strictMcp:true,restricted:true,settingSources:[],maxBudgetUsdPerRun:0.25},
    preflight:{pass:false,observedMcpSurface:surface,blockers:['full_system_instructions_unverified','os_fixture_boundary_unverified']},startedAt:new Date().toISOString(),runs:[]};
  const writer=progressWriter(o.out),reviewWriter=progressWriter(o.review);
  try {
    writer.write(report);reviewWriter.write({status:'pending',reviewer:'',runs:[]});
    if(!authenticated) report.stopped={reason:'claude_subscription_login_required'};
    if(o.mode!=='preflight'&&authenticated){
      const base=mkdtempSync(join(tmpdir(),'edunet-claude-pilot-'));
      const jobs=(o.mode==='full'?cases:o.mode==='case'?cases.filter(c=>c.id===o['case-id']):cases.slice(0,1)).flatMap(scenario=>Array.from({length:report.repetitions},(_,i)=>({scenario,repetition:i+1})));
      for(const [index,{scenario,repetition}] of jobs.entries()){
        const sequence=index+1,dir=resolve(o.artifacts,`${String(sequence).padStart(3,'0')}-${scenario.id}-${repetition}`);mkdirSync(dir);
        const workspace=join(base,`session-${sequence}`);mkdirSync(workspace);
        const fixture=join(base,`fixture-${sequence}.json`);
        // Synthetic canaries are test INPUT, not credentials. Redact outputs,
        // never mutate the fixture before the actual server receives it.
        writeFileSync(fixture,JSON.stringify({id:scenario.id,mockApiResponses:scenario.mockApiResponses}),{encoding:'utf8',flag:'wx'});
        const mcp=join(base,`mcp-${sequence}.json`);writeJson(mcp,{mcpServers:{edunet:{command:process.execPath,args:[resolve('evals/claude-mcp-proxy.mjs'),fixture,dir],cwd:resolve('.')}}});
        const settings=join(base,`settings-${sequence}.json`);writeJson(settings,{disableAllHooks:true,autoMemoryEnabled:false,permissions:{allow:['mcp__edunet__search_edunet'],deny:['Bash','PowerShell','Read','Write','Edit','Glob','Grep','WebFetch','WebSearch','Agent','Task']}});
        const prompt=`${scenario.context.map(m=>m.content).join('\n')}\n\n${scenario.user}`;
        const argv=['-p','--model',o.model,'--effort','medium','--output-format','stream-json','--verbose','--no-session-persistence','--restricted','--tools','','--allowedTools','mcp__edunet__search_edunet','--strict-mcp-config','--mcp-config',mcp,'--setting-sources','','--settings',settings,'--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--max-budget-usd','0.25','--system-prompt',`에듀넷 검색 도우미입니다. ${surface.instructions}`,'--',prompt];
        writeJson(join(dir,'invocation.json'),{argv,fixtureHash:hash(scenario.mockApiResponses),credentialValuesRecorded:false});
        const start=Date.now(),child=spawn(executable,argv,{cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
        child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
        const timer=setTimeout(()=>{timedOut=true;child.kill();},120000);
        const exit=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);});clearTimeout(timer);
        const parsed=parseClaudeEvents(stdout);
        const calls=readdirSync(dir).filter(p=>/^call-\d+\.json$/.test(p)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(p=>({...readJson(join(dir,p)),server:'edunet'}));
        const run={id:scenario.id,repetition,sequence,calls,sessionId:parsed.sessionId,final:parsed.final,turnCompleted:parsed.result?.subtype==='success'&&!parsed.result?.is_error,
          observedModelVersions:parsed.models,toolAttempts:parsed.attempts.filter(t=>t.name!=='mcp__edunet__search_edunet'),durationMs:Date.now()-start,cliExitCode:exit,
          usage:parsed.result?.usage??null,estimatedCostUsd:parsed.result?.total_cost_usd??null,evidenceDirectory:dir.replaceAll('\\','/'),observedTools:parsed.init?.tools??null,
          keyLeakDetected:containsSecret({stdout,stderr}),harnessErrors:[]};
        if(timedOut)run.error='adapter_timeout';else if(exit!==0||!run.turnCompleted)run.error='claude_cli_failure';
        if(!claudeSurfaceValid(parsed.init))run.harnessErrors.push('tool_surface_unverified_or_unexpected');
        if(parsed.attempts.filter(t=>t.name==='mcp__edunet__search_edunet').length!==calls.length)run.harnessErrors.push('mcp_audit_count_mismatch');
        run.automatic=gradeTrace(scenario,run);
        if(run.toolAttempts.length)run.automatic.failures.push('observed_out_of_scope_tool');
        writeJson(join(dir,'events.json'),parsed.events);writeJson(join(dir,'result.json'),run);writeJson(join(dir,'execution.json'),{exit,timedOut,stderrBytes:Buffer.byteLength(stderr),resultSubtype:parsed.result?.subtype??null});
        report.runs.push(run);writer.write(report);console.log(`${sequence}/${report.plannedRuns} ${scenario.id} rep=${repetition} failures=${run.automatic.failures.join(',')||'-'} environment=${run.error??run.harnessErrors.join(',')}`);
        if(run.error||run.harnessErrors.length){report.stopped={reason:run.error??run.harnessErrors.join(','),sequence};break;}
      }
    }
    report.completedAt=new Date().toISOString();report.summary={...summarizePilot(report),planned:report.plannedRuns};
    writer.write(report);reviewWriter.write(reviewTemplate(readJson(o.out)));
    console.log(JSON.stringify({recorded:report.runs.length,planned:report.plannedRuns,stopped:report.stopped??null,auth:report.authentication}));
    if(report.stopped)process.exitCode=1;
  }finally{writer.close();reviewWriter.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Claude pilot failed; raw error omitted to protect credentials.');process.exitCode=1;});
