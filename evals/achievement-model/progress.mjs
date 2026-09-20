import fs from 'node:fs';
import path from 'node:path';
import {args,read} from './common.mjs';
const o=args(),root=path.resolve(o.out),stage=o.stage??'full';
const rows=[];
for(const model of ['luna','haiku']){
  const p=path.join(root,stage,model);if(!fs.existsSync(p)){rows.push({model,recorded:0,active:[]});continue;}
  const f=path.join(p,'runs.jsonl'),rs=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const active=fs.readdirSync(p,{withFileTypes:true}).filter(e=>e.isDirectory()&&!fs.existsSync(path.join(p,e.name,'result.json'))).map(e=>{
    const a=path.join(p,e.name,'audit'),invocation=path.join(p,e.name,'invocation.json');
    const requests=fs.existsSync(a)?fs.readdirSync(a).filter(f=>/^\d+-request.json$/.test(f)).map(f=>read(path.join(a,f))):[];
    return {id:e.name,seconds:fs.existsSync(invocation)?Math.round((Date.now()-fs.statSync(invocation).mtimeMs)/1000):null,toolCalls:requests.filter(r=>r.message.method==='tools/call').length};
  });
  rows.push({model,recorded:rs.length,finalAnswers:rs.filter(r=>r.finalAnswerCollected).length,environmentErrors:rs.filter(r=>r.environmentErrors.length).map(r=>({id:r.id,errors:r.environmentErrors})),last:rs.slice(-2).map(r=>({id:r.id,seconds:Math.round(r.durationMs/1000),calls:r.toolCalls})),active});
}
console.log(JSON.stringify({time:new Date().toISOString(),stage,models:rows}));
