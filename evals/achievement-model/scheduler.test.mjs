import test from 'node:test';
import assert from 'node:assert/strict';
import {schedule} from './scheduler.mjs';
test('bounded parallel claims cover 90 scenarios exactly once, results retain planned order',async()=>{
  let running=0,peak=0;const seen=[];
  const {results,stopped}=await schedule(Array.from({length:90},(_,i)=>i),async(n)=>{running++;peak=Math.max(peak,running);seen.push(n);await new Promise(r=>setTimeout(r,n%3));running--;return n;},{concurrency:3});
  assert.equal(peak,3);assert.equal(seen.length,90);assert.equal(new Set(seen).size,90);assert.deepEqual(results,Array.from({length:90},(_,i)=>i));assert.equal(stopped,null);
});
test('fatal provider result stops new jobs but retains already running outcomes',async()=>{
  const seen=[];const r=await schedule([0,1,2,3,4],async n=>{seen.push(n);await new Promise(r=>setTimeout(r,n===0?0:10));return {n,fatal:n===0};},{concurrency:3,isFatal:r=>r.fatal});
  assert.deepEqual(seen,[0,1,2]);assert.equal(r.results.length,3);assert.equal(r.stopped.index,0);
});
test('invalid concurrency rejected before any job starts',async()=>{await assert.rejects(schedule([1],()=>{throw Error('should not run');},{concurrency:4}),/INVALID_CONCURRENCY/);});
