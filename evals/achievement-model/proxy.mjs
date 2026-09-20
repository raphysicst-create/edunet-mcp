import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {args,read,write,append,credential,remote,TOOLS} from './common.mjs';
const o=args();const audit=path.resolve(o.audit);fs.mkdirSync(audit,{recursive:true});
let seq=0,calls=0;const lock=read(o.lock);
try{
  const connection=await remote(lock,await credential());write(path.join(audit,'manifest-before.json'),await connection.manifest());
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
    let m;try{m=JSON.parse(line);}catch{throw Error('STDIO_INVALID_JSON');}
    const index=++seq,start=Date.now();
    if(m.method==='notifications/cancelled')continue;
    if(!['initialize','notifications/initialized','ping','tools/list','tools/call'].includes(m.method)){
      append(path.join(audit,'blocked.jsonl'),{message:m,reason:'method_not_allowed'});
      if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not available'}})+'\n');continue;
    }
    if(m.method==='tools/call'&&(!TOOLS.includes(m.params?.name)||++calls>60)){
      append(path.join(audit,'blocked.jsonl'),{message:m,reason:'tool_not_allowed_or_limit'});
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Tool not allowed or evaluation call limit reached'}})+'\n');continue;
    }
    write(path.join(audit,`${index}-request.json`),{startedAt:new Date().toISOString(),message:m});
    try{
      const response=await connection.rpc(m);
      write(path.join(audit,`${index}-response.json`),{durationMs:Date.now()-start,response,identityVerified:true});
      if(response)process.stdout.write(JSON.stringify(response)+'\n');
    }catch(e){
      write(path.join(audit,'fatal.json'),{code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'REMOTE_TRANSPORT_FAILURE',index});
      if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Evaluation transport failed'}})+'\n');
      process.exitCode=1;break;
    }
  }
  write(path.join(audit,'manifest-after.json'),await connection.manifest());
}catch(e){try{write(path.join(audit,'startup-error.json'),{code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'PROXY_FAILURE'});}catch{}process.stderr.write('Evaluation proxy failed; details recorded without credentials.\n');process.exitCode=1;}
