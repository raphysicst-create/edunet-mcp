// Retain original private pilot evidence; create separately hashed, fully redacted copies.
import fs from 'node:fs';
import path from 'node:path';
import {args,clean,read,write,sha} from './common.mjs';
const o=args(),root=path.resolve(o.out),dest=path.join(root,'sanitized-pilot');
for(const stage of ['connection','representative'])if(!fs.existsSync(path.join(root,stage,'summary.json')))throw Error('PILOT_STILL_RUNNING');
fs.mkdirSync(dest);const mapping=[];
function visit(source,target){
  fs.mkdirSync(target,{recursive:true});
  for(const e of fs.readdirSync(source,{withFileTypes:true})){
    const a=path.join(source,e.name),b=path.join(target,e.name);
    if(e.isDirectory()){visit(a,b);continue;}
    if(e.name==='artifact-hashes.json')continue;
    const original=fs.readFileSync(a);let text=original.toString('utf8');
    if(e.name.endsWith('.json'))text=JSON.stringify(clean(JSON.parse(text)),null,2)+'\n';
    else if(e.name.endsWith('.jsonl'))text=text.trim().split('\n').filter(Boolean).map(s=>JSON.stringify(clean(JSON.parse(s)))).join('\n')+'\n';
    else text=clean(text);
    if(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text))throw Error('REFERENCE_REDACTION_INCOMPLETE');
    fs.writeFileSync(b,text,{flag:'wx'});mapping.push({original:path.relative(root,a).replaceAll('\\','/'),originalHash:sha(original),export:path.relative(dest,b).replaceAll('\\','/'),exportHash:sha(text)});
  }
}
for(const stage of ['connection','representative'])visit(path.join(root,stage),path.join(dest,stage));
write(path.join(dest,'export-manifest.json'),{createdAt:new Date().toISOString(),reason:'Original pilot redaction masked reference object fields but missed two-part references embedded in JSON text. Export fixes persisted evidence only; model inputs and original outcomes unchanged. Originals remain private ignored artifacts.',files:mapping});
console.log(JSON.stringify({export:dest,files:mapping.length,unmaskedReferences:0}));
