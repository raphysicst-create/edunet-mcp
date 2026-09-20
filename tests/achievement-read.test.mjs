import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { ReferenceCodec } from '../dist/achievement/references.js';
import { createAchievementReader } from '../dist/achievement/read-service.js';
import { WorkerUnavailableError } from '../dist/achievement/gateway.js';
import { scopeCodeResult } from '../dist/worker/achievement/scope.js';

const secret='test-only-32-byte-reference-secret-123456';
const config={searchEnabled:true,pdfReadEnabled:true,hwpReadEnabled:true,hwpxReadEnabled:false,autoAttachmentSelectionEnabled:false,resourceReadEnabled:true,referenceSecret:secret};
const resource={id:'123',title:'중학교 과학 성취수준',sourceUrl:'https://www.edunet.net/clssStdDt/view/150/123',snippet:'검색 발췌'};
const attachments=[{id:'a',fileName:'교사용.pdf',format:'pdf',url:'https://api.edunet.net/main/fileRsc/downloadFile/1'},{id:'b',fileName:'학생용.hwp',format:'hwp',url:'https://api.edunet.net/main/fileRsc/downloadFile/2'}];
const evidence=(quote)=>[{quote,location:{page:1,table:1,row:2,column:2}}];
const record=(id,label='상')=>({id,achievementStandardCode:{raw:'[9과01-01]',evidence:evidence('[9과01-01]')},achievementLevel:{rawLabel:label,labelSystem:'상중하',evidence:evidence(label)},description:{raw:'실험 결과를 설명한다.',evidence:evidence('실험 결과를 설명한다.')},evidence:evidence('실험 결과를 설명한다.'),extraction:{method:'table',confidence:'high'}});
const workerResult=()=>({status:'verified_extraction',contentHash:'sha256:abc',records:[record('r1'),record('r2','중')],rawBlocks:[{kind:'paragraph',text:'원문입니다.',location:{page:1,block:1}}],documentExtractionComplete:true,visualContentInterpreted:false,warnings:[]});
function setup(extra={}) {
  const references=new ReferenceCodec(secret);
  let calls=0;
  const result=workerResult();
  const deps={references,config,registry:[],resolveResource:async()=>({resource,attachments,warnings:[]}),gateway:{run:async(handle)=>{calls++;const job=references.verify(handle,'worker');return {...result,attachment:{attachmentRef:job.attachmentRef,fileName:'교사용.pdf',format:'pdf',downloadStatus:'downloaded',parserName:'test',parserVersion:'1'}};}},...extra};
  return {references,read:createAchievementReader(deps),deps,result,calls:()=>calls,achievementRef:references.issue('achievement',{resource})};
}

test('metadata-first read lists all attachments and never downloads ambiguous documents',async()=>{
  const s=setup();const response=await s.read({achievementRef:s.achievementRef});
  assert.equal(response.status,'attachment_selection_required');assert.equal(response.attachments.length,2);assert.equal(s.calls(),0);
  assert.equal(response.source.searchEvidence[0].quote,'검색 발췌');
  const r=await s.read({achievementRef:s.achievementRef,attachmentRef:response.attachments[0].attachmentRef});
  assert.equal(r.status,'verified_extraction');assert.equal(r.records[0].achievementLevel.rawLabel,'상');assert.equal(s.calls(),1);
});

test('bare standards cannot masquerade as verified achievement levels and retain raw fallback',async()=>{
 const s=setup();const bare={...record('bare')};delete bare.achievementLevel;delete bare.description;
 s.result.records=[bare,...s.result.records];
 const listing=await s.read({achievementRef:s.achievementRef});
 const args={achievementRef:s.achievementRef,attachmentRef:listing.attachments[0].attachmentRef};
 const mixed=await s.read(args);assert.deepEqual(mixed.records.map(r=>r.id),['r1','r2']);
 assert.ok(mixed.warnings.some(w=>w.code==='STANDARD_ONLY_RECORDS_OMITTED'));
 s.result.records=[bare];const only=await s.read(args);
 assert.equal(only.status,'metadata_only');assert.deepEqual(only.records,[]);assert.equal(only.rawBlocks[0].text,'원문입니다.');
});

test('attachment belongs to resource, remains present in current metadata, and disabled formats never download',async()=>{
  const s=setup();const wrong=s.references.issue('attachment',{resourceId:'other',attachmentId:'a'});
  await assert.rejects(s.read({achievementRef:s.achievementRef,attachmentRef:wrong}),/참조/);
  const gone=s.references.issue('attachment',{resourceId:`${resource.id}|${resource.sourceUrl}`,attachmentId:'gone'});
  await assert.rejects(s.read({achievementRef:s.achievementRef,attachmentRef:gone}),/참조/);
  const disabled=setup({config:{...config,pdfReadEnabled:false}});const list=await disabled.read({achievementRef:disabled.achievementRef});
  assert.equal((await disabled.read({achievementRef:disabled.achievementRef,attachmentRef:list.attachments[0].attachmentRef})).status,'unsupported_format');assert.equal(disabled.calls(),0);
});

test('cursor continues exact attachment/filter/content/parser scope and respects item limits',async()=>{
  const s=setup();const metadata=await s.read({achievementRef:s.achievementRef});const args={achievementRef:s.achievementRef,attachmentRef:metadata.attachments[0].attachmentRef,maxItems:1};
  const first=await s.read(args);assert.equal(first.records.length,1);assert.equal(first.pagination.hasMore,true);assert.equal(first.documentExtractionComplete,true);assert.equal(first.responseTruncated,true);
  const next=await s.read({...args,cursor:first.pagination.cursor});assert.equal(next.records[0].id,'r2');assert.equal(next.pagination.hasMore,false);
  await assert.rejects(s.read({...args,cursor:first.pagination.cursor,levelLabel:'중'}),/참조/);
  s.result.contentHash='sha256:changed';await assert.rejects(s.read({...args,cursor:first.pagination.cursor}),/참조/);
});

test('character limit preserves complete evidence and reports records larger than budget',async()=>{
  const s=setup();s.result.records[0].description.raw='x'.repeat(1500);s.result.records[0].description.evidence=evidence('x'.repeat(1500));
  const list=await s.read({achievementRef:s.achievementRef});const result=await s.read({achievementRef:s.achievementRef,attachmentRef:list.attachments[0].attachmentRef,maxChars:500});
  assert.equal(result.records.length,0);assert.equal(result.responseTruncated,true);assert.ok(result.warnings.some(w=>w.code==='RECORD_EXCEEDS_RESPONSE_LIMIT'));
});

test('source and worker failure responses preserve original source and failure scope',async()=>{
  const unavailable=setup({resolveResource:async()=>{throw new Error('secret');}});const a=await unavailable.read({achievementRef:unavailable.achievementRef});assert.equal(a.status,'source_unavailable');assert.equal(a.source.title,resource.title);assert.doesNotMatch(JSON.stringify(a),/secret/);
  for(const code of ['WORKER_TIMEOUT','WORKER_CIRCUIT_OPEN','WORKER_INVALID_RESPONSE']) {
    const s=setup({gateway:{run:async()=>{throw new WorkerUnavailableError(code);}}});const list=await s.read({achievementRef:s.achievementRef});const r=await s.read({achievementRef:s.achievementRef,attachmentRef:list.attachments[0].attachmentRef});assert.equal(r.status,code==='WORKER_TIMEOUT'?'parse_failed':'worker_unavailable');assert.equal(r.source.sourceUrl,resource.sourceUrl);
  }
});

test('enabled MCP tools expose discovery/read/resource without changing search or invoking worker on search',async()=>{
  const s=setup();let searches=0;
  const search=async conditions=>{searches++;return {conditions,items:[{id:'123',title:resource.title,content:'성취수준 평가기준',contentTruncated:false,url:resource.sourceUrl,category:'evl_data'}],pagination:{page:1,pageSize:10,returnedCount:1,totalCount:1,hasNextPage:false,nextPage:null,pageLimitReached:false},source:'EDUNET_SEARCH_API',originalRead:false,attachmentsRead:false,integrationStatus:'live_verified',warnings:[]};};
  const server=createServer(search,{achievement:s.deps});const client=new Client({name:'achievement-test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);await client.connect(ct);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['search_edunet','search_edunet_achievement','read_edunet_achievement','read_edunet_resource']);
    const old=await client.callTool({name:'search_edunet',arguments:{query:'성취수준'}});assert.equal(old.structuredContent.originalRead,false);assert.equal(s.calls(),0);
    const found=await client.callTool({name:'search_edunet_achievement',arguments:{subject:'과학'}});assert.equal(found.isError,undefined);assert.ok(searches>1);assert.equal(s.calls(),0);
    const candidate=found.structuredContent.results[0];const list=await client.callTool({name:'read_edunet_achievement',arguments:{achievementRef:candidate.achievementRef}});assert.equal(list.structuredContent.status,'attachment_selection_required');
    const read=await client.callTool({name:'read_edunet_resource',arguments:{resourceRef:candidate.resourceRef,attachmentRef:list.structuredContent.attachments[0].attachmentRef}});assert.equal(read.isError,undefined);assert.equal(read.structuredContent.rawBlocks[0].text,'원문입니다.');assert.equal(read.structuredContent.records,undefined);
  } finally {await client.close();await server.close();}
});

test('missing achievement secret is isolated from ordinary search',async()=>{
  const server=createServer(async()=>{throw new Error('test');},{achievement:{config:{...config,referenceSecret:undefined}}});const client=new Client({name:'missing-key',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  try {await server.connect(st);await client.connect(ct);const bad=await client.callTool({name:'search_edunet_achievement',arguments:{subject:'과학'}});assert.match(bad.content[0].text,/CONFIGURATION/);assert.equal((await client.listTools()).tools[0].name,'search_edunet');}finally{await client.close();await server.close();}
});

test('worker and reader normalize code notation and bind equivalent cursors without substituting codes',async()=>{
 const s=setup();const run=s.deps.gateway.run;
 s.deps.gateway.run=async handle=>{const result=await run(handle);scopeCodeResult(result,s.references.verify(handle,'worker'));return result;};
 const metadata=await s.read({achievementRef:s.achievementRef});
 const args={achievementRef:s.achievementRef,attachmentRef:metadata.attachments[0].attachmentRef,achievementStandardCode:'9과01-01',maxItems:1};
 const first=await s.read(args);assert.equal(first.records[0].id,'r1');
 const next=await s.read({...args,achievementStandardCode:' [ 9과01-01 ] ',cursor:first.pagination.cursor});
 assert.equal(next.records[0].id,'r2');assert.equal(next.pagination.hasMore,false);
 await assert.rejects(s.read({...args,achievementStandardCode:'9국01-01',cursor:first.pagination.cursor}),/참조/);
 const absent=await s.read({...args,achievementStandardCode:'6국01-01'});
 assert.equal(absent.status,'metadata_only');assert.equal(absent.records.length,0);
 assert.ok(absent.warnings.some(w=>w.code==='NO_MATCHING_RECORDS'));assert.equal(absent.rawBlocks.length,1);
 // The reader must also enforce this boundary when the Worker returns unscoped records.
 s.deps.gateway.run=run;
 s.result.records[0].achievementStandardCode.normalized='[6국01-01]';
 assert.equal((await s.read({...args,achievementStandardCode:'6국01-01'})).records.length,0);
 for(const code of ['[10공수1-01-01]','[12미감01-01]']) {
   s.result.records=[record('course')];s.result.records[0].achievementStandardCode.raw=code;
   const response=await s.read({...args,achievementStandardCode:code.slice(1,-1)});
   assert.equal(response.records[0].achievementStandardCode.raw,code);
 }
});

test('A-E coverage remains explicit across response limits and legacy Workers',async()=>{
 const s=setup();
 s.result.records=['A','B','C','D','E'].map(label=>({...record(label,label),achievementLevel:{rawLabel:label,labelSystem:'abc',evidence:evidence(label)}}));
 const metadata=await s.read({achievementRef:s.achievementRef});
 const args={achievementRef:s.achievementRef,attachmentRef:metadata.attachments[0].attachmentRef,achievementStandardCode:'9과01-01',maxItems:2};
 let cursor;const seen=[];
 for(const remaining of [3,1,0]) {
   const response=await s.read({...args,...(cursor?{cursor}:{})});
   const coverage=response.levelCoverage;
   assert.deepEqual(coverage.extractedLabels,['A','B','C','D','E']);
   assert.equal(coverage.matchingRecordCount,5);assert.equal(coverage.remainingRecordCount,remaining);
   assert.equal(coverage.allMatchingRecordsDelivered,remaining===0);assert.equal(coverage.sourceCompleteness,'unverified');
   assert.equal(response.warnings.some(w=>w.code==='LEVEL_RECORDS_REMAIN'),remaining>0);
   assert.ok(response.records.every(r=>r.achievementLevel.labelSystem==='alphabetic'));
   assert.ok(response.records.reduce((sum,record)=>sum+JSON.stringify(record).length,0)<=8000);
   seen.push(...response.records.map(r=>r.achievementLevel.rawLabel));cursor=response.pagination.cursor;
 }
 assert.deepEqual(seen,['A','B','C','D','E']);
 const filtered=await s.read({...args,levelLabel:'B'});
 assert.deepEqual(filtered.levelCoverage.extractedLabels,['B']);assert.equal(filtered.levelCoverage.levelLabelFilterApplied,true);
 assert.ok(filtered.warnings.some(w=>w.code==='LEVEL_LABEL_FILTER_APPLIED'));
 const blocked=await s.read({...args,maxChars:500});
 assert.equal(blocked.records.length,0);assert.equal(blocked.levelCoverage.remainingRecordCount,5);
 assert.equal(blocked.levelCoverage.allMatchingRecordsDelivered,false);
 s.result.documentExtractionComplete=false;
 const partial=await s.read({...args,maxItems:100});
 assert.equal(partial.levelCoverage.sourceCompleteness,'unverified');
 assert.ok(partial.warnings.some(w=>w.code==='DOCUMENT_EXTRACTION_INCOMPLETE'));
});
