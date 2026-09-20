// New review view, with byte-identical case evidence copied from immutable primary segments.
import fs from 'node:fs';
import path from 'node:path';
import {args,read,write,append,sha} from './common.mjs';
const o=args(),root=path.resolve(o.out),dest=path.join(root,'primary');
const stages=['full',...(fs.existsSync(path.join(root,'continuation'))?['continuation']:[])];
for(const stage of stages)read(path.join(root,stage,'summary.json'));
const expected=read(path.join(root,'prompts.json')).map(s=>s.id);
const combined={};
for(const model of ['luna','haiku']){
  const rows=[];
  for(const stage of stages){const f=path.join(root,stage,model,'runs.jsonl');if(fs.existsSync(f))for(const r of fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))rows.push({r,stage});}
  if(rows.length!==90||new Set(rows.map(x=>x.r.id)).size!==90||!expected.every(id=>rows.some(x=>x.r.id===id)))throw Error('PRIMARY_COVERAGE_INCOMPLETE_OR_DUPLICATED');
  combined[model]=rows.sort((a,b)=>a.r.sequence-b.r.sequence);
}
fs.mkdirSync(dest);const mapping=[],summaries=[];
for(const [model,rows]of Object.entries(combined)){
  fs.mkdirSync(path.join(dest,model));
  for(const {r,stage}of rows){
    const source=path.join(root,stage,model,r.id),target=path.join(dest,model,r.id);
    fs.cpSync(source,target,{recursive:true,errorOnExist:true,force:false});
    const sourceHash=sha(fs.readFileSync(path.join(source,'result.json'))),targetHash=sha(fs.readFileSync(path.join(target,'result.json')));if(sourceHash!==targetHash)throw Error('COPY_HASH_MISMATCH');
    append(path.join(dest,model,'runs.jsonl'),r);mapping.push({model,id:r.id,sourceStage:stage,sourceResultSha256:sourceHash,copyResultSha256:targetHash});
  }
  const summary={model,planned:90,recorded:90,finalAnswers:rows.filter(x=>x.r.finalAnswerCollected).length,collectionComplete:true,complete:rows.every(x=>x.r.finalAnswerCollected),environmentErrorRuns:rows.filter(x=>x.r.environmentErrors.length).length,stopped:null,releaseEligible:false};
  summaries.push(summary);write(path.join(dest,model,'summary.json'),summary);
}
write(path.join(dest,'composition.json'),{createdAt:new Date().toISOString(),sourceStages:stages,note:'Disjoint primary segments only. No supplementary attempts substitute for original outcomes. Case evidence copies are byte-identical.',mapping});
write(path.join(dest,'summary.json'),summaries);console.log(JSON.stringify(summaries));
