import { readFile, mkdir, open } from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseDocument } from '../dist/worker/parsers/index.js';
import { extractAchievements } from '../dist/worker/achievement/extract.js';
import { achievementRecordSchema } from '../dist/achievement/contracts.js';

const outputArgs=process.argv.slice(2);
if(outputArgs.length && (outputArgs.length!==2||outputArgs[0]!=='--out'))throw Error('Usage: node evals/achievement.mjs [--out NEW_FILE]');
const output=outputArgs.length?resolve(outputArgs[1]):fileURLToPath(new URL('./results/achievement-latest.json',import.meta.url));
await mkdir(dirname(output),{recursive:true});
const outputHandle=await open(output,'wx');

const golden=(await readFile(new URL('./achievement-golden.jsonl',import.meta.url),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const fieldNames=['grade','subject','domain','achievementStandardCode','achievementStandardText','achievementLevel','description'];
const fields=Object.fromEntries(fieldNames.map(name=>[name,{tp:0,fp:0,fn:0}]));
const formatCounts={}; const results=[]; const latencies=[];
let filled=0,evidenced=0,inferred=0,labels=0,exactLabels=0,codes=0,exactCodes=0;
const equal=(name,a,b)=> name==='description'||name==='achievementStandardText' ? a?.replace(/\s/gu,'')===b?.replace(/\s/gu,'') : a===b;
for(const item of golden){
  const start=performance.now();
  try{
    const bytes=item.fixture?await readFile(new URL(`../tests/fixtures/achievement/${item.fixture}`,import.meta.url)):Buffer.from(JSON.stringify(item.blocks));
    const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
    const document=item.blocks?{blocks:item.blocks,parserName:'fixture-ir',parserVersion:'1',documentExtractionComplete:true,warnings:[]}:await parseDocument(bytes,item.format,{enableHwpx:true});
    const actual=extractAchievements(document,hash).records;
    const expected=item.records.map(record=>({...item.common,...record}));
    let pass=actual.length===expected.length;
    for(let index=0;index<Math.max(actual.length,expected.length);index++){
      const record=actual[index];const wanted=expected[index]??{};
      if(record)achievementRecordSchema.parse(record);
      for(const name of fieldNames){
        const value=record?.[name];const raw=value?.raw??value?.rawLabel;const target=wanted[name];
        if(target!==undefined&&raw!==undefined&&equal(name,raw,target))fields[name].tp++;
        else{if(raw!==undefined)fields[name].fp++;if(target!==undefined)fields[name].fn++;if(raw!==undefined||target!==undefined)pass=false;}
        if(name==='achievementLevel'&&target!==undefined){labels++;if(raw===target)exactLabels++;}
        if(name==='achievementStandardCode'&&target!==undefined){codes++;if(raw===target)exactCodes++;}
        if(raw===undefined)continue;
        filled++;
        const spans=value.evidence??[];
        const anchored=spans.length>0&&spans.some(span=>span.quote===raw)&&spans.every(span=>{
          const block=document.blocks.find(block=>block.location.block===span.location.block);
          return span.sourceHash===hash&&block?.text.slice(span.location.charStart,span.location.charEnd)===span.quote;
        });
        if(anchored)evidenced++;
        if(!anchored||target===undefined){inferred++;pass=false;}
        if(value.ordinal!==undefined){inferred++;pass=false;}
      }
    }
    if(item.format){const stats=formatCounts[item.format]??={success:0,total:0};stats.total++;stats.success++;}
    const latencyMs=performance.now()-start;latencies.push(latencyMs);
    results.push({id:item.id,synthetic:item.synthetic,pass,latencyMs,expected,actual,parser:document.parserName,parserVersion:document.parserVersion});
  }catch(error){
    if(item.format){const stats=formatCounts[item.format]??={success:0,total:0};stats.total++;}
    results.push({id:item.id,pass:false,error:error.message});
  }
}
const fieldMetrics=Object.fromEntries(Object.entries(fields).map(([name,{tp,fp,fn}])=>{
  const precision=tp+fp?tp/(tp+fp):null;const recall=tp+fn?tp/(tp+fn):null;
  return[name,{tp,fp,fn,precision,recall,f1:precision!==null&&recall!==null?(precision+recall?2*precision*recall/(precision+recall):0):null}];
}));
latencies.sort((a,b)=>a-b);
const report={
  scope:'Offline synthetic achievement semantics and public non-curriculum layout smoke fixtures. Not a release certification.',
  humanReviewed:false,hwpxDefaultEnabled:false,
  cases:results.length,passed:results.filter(item=>item.pass).length,
  metrics:{fields:fieldMetrics,codeExactAccuracy:codes?exactCodes/codes:null,levelRawLabelFidelity:labels?exactLabels/labels:null,evidenceAttachmentRate:filled?evidenced/filled:null,unsupportedInferenceRate:filled?inferred/filled:null,formatParseSuccess:formatCounts,p95ParseAndExtractLatencyMs:latencies[Math.max(0,Math.ceil(latencies.length*.95)-1)]??null,candidateRecallAtK:null,verifiedDocumentRate:null},
  unmeasured:['Live EDUNET candidate recall and verified-document rate','Human educational-domain review','Production p95 and worker-fault search availability (covered separately by tests)'],results,
};
await outputHandle.writeFile(JSON.stringify(report,null,2)+'\n');
await outputHandle.close();
console.log(JSON.stringify({...report,results:results.map(({id,pass})=>({id,pass}))},null,2));
if(report.passed!==report.cases||report.metrics.levelRawLabelFidelity!==1||report.metrics.evidenceAttachmentRate!==1||report.metrics.unsupportedInferenceRate!==0)process.exitCode=1;
