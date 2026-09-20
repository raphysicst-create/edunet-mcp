// Offline checks using captured evaluation records; no provider or remote calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scopeCodeResult} from '../../src/worker/achievement/scope.ts';
const root=path.resolve(process.argv[2]);
const fixture='primary/haiku/D17-code/audit/9-response.json';
const response=JSON.parse(fs.readFileSync(path.join(root,fixture))).response.result.structuredContent;
const observed=[];
for(const code of ['[9정01-01]','9정01-01']) {
 const result={records:structuredClone(response.records),rawBlocks:[],warnings:[]};
 scopeCodeResult(result,{mode:'achievement',structuredCodeOnly:true,achievementStandardCode:code});
 observed.push({input:code,matched:result.records.length,labels:result.records.map(r=>r.achievementLevel.rawLabel)});
}
assert.equal(observed[0].matched,2);assert.equal(observed[1].matched,0);
const mainReader=fs.readFileSync('src/achievement/read-service.ts','utf8');
assert.ok(mainReader.includes('record[name]?.raw!==input[name] && record[name]?.normalized!==input[name]'));
const extractor=fs.readFileSync('src/worker/achievement/extract.ts','utf8');
assert.ok(extractor.includes('/^[A-E]$/.test(normalized) ? "abc"'));
const labelFixture='primary/luna/D11-natural';
const labels=[];
for(const f of fs.readdirSync(path.join(root,labelFixture,'audit')).filter(x=>x.endsWith('-response.json'))){
 const s=JSON.parse(fs.readFileSync(path.join(root,labelFixture,'audit',f))).response?.result?.structuredContent;
 for(const r of s?.records??[])if(['D','E'].includes(r.achievementLevel?.rawLabel))labels.push({file:`${labelFixture}/audit/${f}`,rawLabel:r.achievementLevel.rawLabel,labelSystem:r.achievementLevel.labelSystem});
}
assert.ok(labels.some(x=>x.labelSystem==='abc'));
const sourceFiles=['src/worker/achievement/scope.ts','src/achievement/read-service.ts','src/worker/achievement/extract.ts'];
const out={createdAt:new Date().toISOString(),type:'offline_reproduction',networkCalls:0,modelCalls:0,
 codeFilter:{confirmed:true,fixture,observed,interpretation:'Exact comparison in worker and reader rejects equivalent code without brackets. Does not establish this as the sole cause of any session timeout.'},
 labelSystem:{confirmed:true,observed:labels,interpretation:'abc denotes alphabetic labels A-E in implementation; it does not establish that a document has only three levels. Naming can mislead a model; causal effect has not been isolated.'},
 sourceFiles:sourceFiles.map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
fs.writeFileSync(path.join(root,'ai-review','offline-findings.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({codeFilter:out.codeFilter.observed,labelExamples:labels.length,assertions:'passed',networkCalls:0}));
