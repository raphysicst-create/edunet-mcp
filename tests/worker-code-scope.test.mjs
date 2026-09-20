import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeCodeResult} from '../dist/worker/achievement/scope.js';

const level=(code,description='source level')=>({id:code,achievementStandardCode:{raw:code},achievementLevel:{rawLabel:'A'},description:{raw:description},evidence:[{quote:description,location:{page:1}}]});
const response=()=>({records:[level('[9과01-01]'),level('[9과01-02]','unrelated'.repeat(500000))],rawBlocks:[{text:'source raw text',location:{page:1}}],warnings:[],documentExtractionComplete:true});
const job={mode:'achievement',structuredCodeOnly:true,achievementStandardCode:'[9과01-01]'};

test('code-only worker scope fits IPC without discarding the selected level or evidence',()=>{
 const r=response(),selected=structuredClone(r.records[0]);assert.ok(JSON.stringify(r).length>3500000);
 scopeCodeResult(r,job);assert.deepEqual(r.records,[selected]);assert.deepEqual(r.rawBlocks,[]);assert.ok(JSON.stringify(r).length<20000);
});

test('raw fallback is retained for no complete levels, oversized selected records and unscoped jobs',()=>{
 const absent=response();scopeCodeResult(absent,{...job,achievementStandardCode:'[9과99-99]'});assert.deepEqual(absent.records,[]);assert.equal(absent.rawBlocks.length,1);
 const oversized=response();oversized.records=[level('[9과01-01]','x'.repeat(21000))];scopeCodeResult(oversized,job);assert.equal(oversized.rawBlocks.length,1);
 for(const other of [{mode:'resource',...{structuredCodeOnly:true,achievementStandardCode:'[9과01-01]'}},{mode:'achievement'}]){
   const r=response(),before=JSON.stringify(r);scopeCodeResult(r,other);assert.equal(JSON.stringify(r),before);
 }
});

test('code spelling is normalized without changing subject, course, or numeric components',()=>{
 for(const code of ['[9과01-01]','9과01-01',' [ 9과01 - 01 ] ']) {
   const r=response();scopeCodeResult(r,{...job,achievementStandardCode:code});
   assert.deepEqual(r.records.map(r=>r.achievementStandardCode.raw),['[9과01-01]']);
 }
 for(const code of ['9국01-01','6과01-01','9과01-02]','[9과01-01','9과1-1']) {
   const r=response();r.status='verified_extraction';scopeCodeResult(r,{...job,achievementStandardCode:code});
   assert.equal(r.records.length,0);assert.equal(r.rawBlocks.length,1);assert.equal(r.status,'metadata_only');
 }
 const r=response();r.records[0].achievementStandardCode.normalized='[6국01-01]';
 scopeCodeResult(r,{...job,achievementStandardCode:'6국01-01'});assert.equal(r.records.length,0);
});
