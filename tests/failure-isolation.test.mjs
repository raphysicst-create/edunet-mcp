import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createWorkerGateway } from '../dist/achievement/gateway.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { ReferenceCodec } from '../dist/achievement/references.js';

function child(behavior) {const c=new EventEmitter();c.kill=()=>{c.killed=true;};c.send=()=>queueMicrotask(()=>behavior(c));return c;}
test('worker crash, malformed message, timeout and breaker recover without retrying parsers',async()=>{
  let now=0,calls=0,mode='exit';const children=[];
  const gateway=createWorkerGateway({secret:'x'.repeat(32),timeoutMs:20,failureThreshold:3,cooldownMs:100,now:()=>now,spawn:()=>{calls++;const c=child(c=>{if(mode==='exit')c.emit('exit',1);if(mode==='invalid')c.emit('message',{records:'bad'});if(mode==='ok')c.emit('message',{status:'metadata_only',records:[],warnings:[],visualContentInterpreted:false});});children.push(c);return c;}});
  await assert.rejects(gateway.run('h'),/WORKER_EXITED/);mode='invalid';await assert.rejects(gateway.run('h'),/WORKER_INVALID_RESPONSE/);mode='timeout';await assert.rejects(gateway.run('h'),/WORKER_TIMEOUT/);
  await assert.rejects(gateway.run('h'),/WORKER_CIRCUIT_OPEN/);assert.equal(calls,3);assert.ok(children.every(c=>c.killed));
  now=101;mode='ok';assert.equal((await gateway.run('h')).status,'metadata_only');
});
test('worker admission and caller cancellation are bounded',async()=>{
  const c=child(()=>{});const gateway=createWorkerGateway({secret:'x'.repeat(32),maxConcurrent:1,timeoutMs:100,spawn:()=>c});const abort=new AbortController();const pending=gateway.run('h',abort.signal);
  await assert.rejects(gateway.run('h'),/WORKER_BUSY/);abort.abort();await assert.rejects(pending,/ABORTED/);assert.equal(c.killed,true);
});

test('a document output limit does not open the infrastructure circuit for unrelated reads',async()=>{
 let calls=0;
 const gateway=createWorkerGateway({secret:'x'.repeat(32),failureThreshold:3,spawn:()=>child(c=>{
   calls++;c.emit('message',calls<=3?{status:'parse_failed',records:[],warnings:[{code:'WORKER_OUTPUT_TOO_LARGE',message:'document limit'}],visualContentInterpreted:false}
     :{status:'metadata_only',records:[],warnings:[],visualContentInterpreted:false});
 })});
 for(let i=0;i<3;i++)assert.equal((await gateway.run('h')).status,'parse_failed');
 assert.equal((await gateway.run('h')).status,'metadata_only');assert.equal(calls,4);
});
test('search runtime import graph never loads parser libraries or worker entry',()=>{
  const seen=new Set();function walk(file){if(seen.has(file))return;seen.add(file);const text=readFileSync(file,'utf8');assert.doesNotMatch(text,/from ["'](?:kordoc|pdfjs-dist|hwp\.js|cfb|fflate|sharp|onnxruntime)/);for(const match of text.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+\.js)["']/g)){const target=resolve(dirname(file),match[1]);assert.doesNotMatch(target,/[\\/]worker[\\/](?:entry|parsers|achievement)[\\/.]/);walk(target);}}walk(resolve('dist/server.js'));
});

test('real child crashes, stalls and malformed IPC never disrupt MCP search while reading',async()=>{
  const secret='worker-isolation-reference-secret-123456';
  const references=new ReferenceCodec(secret);
  const resource={id:'1',title:'성취수준',sourceUrl:'https://www.edunet.net/clssStdDt/view/150/1'};
  for(const mode of ['exit','timeout','malformed']) {
    const gateway=createWorkerGateway({secret,timeoutMs:mode==='timeout'?100:2000,spawn:()=>fork(fileURLToPath(new URL('./fixtures/achievement/fault-worker.cjs',import.meta.url)),[],{execArgv:[],env:{FAULT_MODE:mode},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true})});
    const config={searchEnabled:true,pdfReadEnabled:true,hwpReadEnabled:false,hwpxReadEnabled:false,autoAttachmentSelectionEnabled:false,resourceReadEnabled:false,referenceSecret:secret};
    const search=async conditions=>({conditions,items:[],pagination:{page:1,pageSize:10,returnedCount:0,totalCount:0,hasNextPage:false,nextPage:null,pageLimitReached:false},source:'EDUNET_SEARCH_API',originalRead:false,attachmentsRead:false,integrationStatus:'live_verified',warnings:[]});
    const server=createServer(search,{achievement:{config,references,gateway,resolveResource:async()=>({resource,attachments:[{id:'a',fileName:'x.pdf',format:'pdf',url:'https://api.edunet.net/main/fileRsc/downloadFile/1'}],warnings:[]})}});
    const client=new Client({name:'fault-isolation',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);await client.connect(ct);
      const achievementRef=references.issue('achievement',{resource});const attachmentRef=references.issue('attachment',{resourceId:`1|${resource.sourceUrl}`,attachmentId:'a'});
      const reading=client.callTool({name:'read_edunet_achievement',arguments:{achievementRef,attachmentRef}});
      const searchDuring=await client.callTool({name:'search_edunet',arguments:{query:'과학'}});
      assert.equal(searchDuring.isError,undefined);assert.equal(searchDuring.structuredContent.originalRead,false);
      const failed=await reading;assert.equal(failed.structuredContent.status,mode==='timeout'?'parse_failed':'worker_unavailable');
      assert.equal((await client.callTool({name:'search_edunet',arguments:{query:'과학'}})).isError,undefined);
    }finally{await client.close();await server.close();}
  }
});
