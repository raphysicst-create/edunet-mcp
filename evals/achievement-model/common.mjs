import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
export const ROOT=path.resolve(import.meta.dirname,'../..');
export const EVALUATOR='C:/Users/22/Documents/Codex/2026-09-20/edunet-achievement-rc-evaluator';
export const CORPUS=EVALUATOR+'/outputs/corpus/corpus.json';
export const LOCK=EVALUATOR+'/work/rc4-handoff/rc-lock.json';
export const MODELS={luna:{model:'gpt-5.6-luna',effort:'high',exe:'C:/Users/22/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'},haiku:{model:'claude-haiku-4-5-20251001',effort:'default',exe:'C:/Users/22/.local/bin/claude.exe'}};
export const TOOLS=['search_edunet','search_edunet_achievement','read_edunet_achievement'];
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const secrets=new Set();
export function addSecret(s){if(s)for(const v of [s,encodeURIComponent(s),JSON.stringify(s).slice(1,-1)])secrets.add(v);}
export function clean(value,key=''){
  if(/^(authorization|cookie|secret|token|accessToken|refreshToken|x-vercel-protection-bypass)$/i.test(key))return '[REDACTED]';
  if(typeof value==='string'){
    if(/^(achievementRef|attachmentRef|resourceRef|cursor)$/.test(key))return /^sha256:[a-f0-9]{64}$/.test(value)?value:'sha256:'+sha(value);
    let s=value;for(const secret of secrets)s=s.split(secret).join('[REDACTED]');
    s=s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,v=>'sha256:'+sha(v));
    return s;
  }
  if(Array.isArray(value))return value.map(v=>clean(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[clean(k),clean(v,k)]));
  return value;
}
export function write(p,v){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(clean(v),null,2)+'\n',{flag:'wx'});}
export function append(p,v){fs.appendFileSync(p,JSON.stringify(clean(v))+'\n');}
export function args(){const a=process.argv.slice(2);if(a.length%2)throw Error('ARGUMENT_PAIRS_REQUIRED');return Object.fromEntries(a.reduce((r,v,i)=>i%2?r:[...r,[v.replace(/^--/,''),a[i+1]]],[]));}
export function cliEnv(){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC|APPDATA|LOCALAPPDATA)$/i.test(k)));
  return {...env,HOME:os.homedir(),USERPROFILE:os.homedir(),CODEX_HOME:path.join(os.homedir(),'.codex'),DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
}
export function corpus(){const bytes=fs.readFileSync(CORPUS);if(sha(bytes)!=='4602a056b74e8b4c1581efb4b2859e8be0c5180d53a06356f84d4eef4a3600aa')throw Error('CORPUS_DRIFT');const c=JSON.parse(bytes);if(c.scenarios.length!==90||new Set(c.scenarios.map(s=>s.id)).size!==90)throw Error('BAD_COVERAGE');return c;}
export function publicScenarios(){return corpus().scenarios.map(({id,documentId,kind,question})=>({id,documentId,kind,question}));}
export const INSTRUCTIONS='에듀넷 교육자료 검색 도우미입니다. 사용자의 요청을 에듀넷 MCP 도구로 확인하고 한국어로 답하세요. 실제 도구 결과의 공식 출처와 근거를 사용하세요. 확인하지 못한 내용은 단정하지 말고 확인한 범위와 제한을 설명하세요. 다른 도구나 파일, 셸, 브라우저, 다른 에이전트를 사용하지 마세요.';
export async function credential(){
  if(process.env.VERCEL_AUTOMATION_BYPASS_SECRET){addSecret(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);return process.env.VERCEL_AUTOMATION_BYPASS_SECRET;}
  const p=path.join(os.homedir(),'AppData/Roaming/com.vercel.cli/Data/auth.json');const auth=read(p);addSecret(auth.token);
  const r=await fetch('https://api.vercel.com/v9/projects/prj_q1AY1LdKSBij6tuagKTQOov84sDj?teamId=team_eesxRR76iyKJEVEddKk6zCvA',{headers:{Authorization:'Bearer '+auth.token},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('VERCEL_AUTH_UNAVAILABLE');const j=await r.json();
  const secret=Object.entries(j.protectionBypass??{}).find(([,v])=>v.scope==='automation-bypass')?.[0];
  if(!secret)throw Error('EXISTING_AUTOMATION_ACCESS_MISSING');addSecret(secret);return secret;
}
export function verifyManifest(lock,m){
  const {manifestDigest,...unsigned}=m;
  if(sha(JSON.stringify(unsigned))!==manifestDigest||sha(JSON.stringify(m.files))!==m.sourceDigest)throw Error('MANIFEST_INVALID');
  if(JSON.stringify(m)!==JSON.stringify(lock.expectedManifest))throw Error('MANIFEST_DRIFT');return true;
}
export function verifyHeaders(lock,headers){
  for(const [key,expected] of [['x-edunet-source-digest',lock.expectedManifest.sourceDigest],['x-edunet-manifest-digest',lock.expectedManifest.manifestDigest]])if(headers.get(key)!==expected)throw Error('RPC_IDENTITY_MISMATCH');
  const commit=headers.get('x-edunet-source-commit');if(commit&&commit!==lock.expectedManifest.sourceCommit)throw Error('RPC_COMMIT_MISMATCH');
}
export function decode(body,id){let values;try{values=[JSON.parse(body)];}catch{values=body.split(/\r?\n\r?\n/).map(e=>e.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')).filter(Boolean).map(v=>JSON.parse(v));}const matched=values.filter(v=>v.id===id);if(matched.length!==1)throw Error('RPC_ID_MISMATCH');return matched[0];}
export async function remote(lock,secret){
  let sessionId=null,protocol='2025-03-26';
  const fetchFixed=async(url,options={})=>{
    if(![lock.endpoint,lock.manifestUrl].includes(String(url)))throw Error('URL_NOT_ALLOWED');
    const headers=new Headers(options.headers);headers.set('x-vercel-protection-bypass',secret);
    const r=await fetch(url,{...options,headers,redirect:'manual',signal:AbortSignal.timeout(85000)});
    if(r.status>=300&&r.status<400){await r.body?.cancel();throw Error('REDIRECT_FORBIDDEN');}if(!r.ok){await r.body?.cancel();throw Error('REMOTE_HTTP_'+r.status);}return r;
  };
  const manifest=async()=>{const r=await fetchFixed(lock.manifestUrl);const m=await r.json();verifyManifest(lock,m);return m;};
  const rpc=async(message)=>{
    const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol};if(sessionId)headers['mcp-session-id']=sessionId;
    const r=await fetchFixed(lock.endpoint,{method:'POST',headers,body:JSON.stringify(message)});verifyHeaders(lock,r.headers);
    if(r.headers.get('mcp-session-id'))sessionId=r.headers.get('mcp-session-id');
    if(message.id===undefined){await r.body?.cancel();return null;}
    const result=decode(await r.text(),message.id);if(message.method==='initialize'&&result.result?.protocolVersion)protocol=result.result.protocolVersion;return result;
  };
  return {manifest,rpc};
}
