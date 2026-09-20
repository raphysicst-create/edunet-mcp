import fs from 'node:fs';
import path from 'node:path';
import {args,read,sha} from './common.mjs';
const o=args(),root=path.resolve(o.out),dest=path.join(root,'ai-review');fs.mkdirSync(dest,{recursive:true});
const reference=read(path.join(root,'review-reference.json')),scenarios=read(path.join(root,'prompts.json'));
const norm=s=>(s??'').normalize('NFC').replace(/\s+/g,'');
const unique=a=>[...new Map(a.map(x=>[JSON.stringify(x),x])).values()];
const all=[];
for(const doc of reference.documents){
  const cases=[];
  for(const stage of ['primary','recovery'])for(const model of ['luna','haiku'])for(const kind of ['discovery','code','natural']){
    const id=`${doc.documentId}-${kind}`,p=path.join(root,stage,model,id);if(!fs.existsSync(path.join(p,'result.json')))continue;
    const r=read(path.join(p,'result.json')),calls=[],sources=[],records=[],raws=[];
    for(const f of fs.readdirSync(path.join(p,'audit')).filter(f=>/^\d+-request.json$/.test(f)).sort((a,b)=>parseInt(a)-parseInt(b))){
      const q=read(path.join(p,'audit',f)).message;if(q.method!=='tools/call')continue;
      const rf=f.replace('-request','-response'),rp=path.join(p,'audit',rf),a=fs.existsSync(rp)?read(rp).response:null;
      let s=a?.result?.structuredContent;if(!s)for(const c of a?.result?.content??[])if(c.text){try{s=JSON.parse(c.text);break;}catch{}}
      const error=a?.error??(a?.result?.isError?a.result.content:null);
      const call={file:rf,tool:q.params.name,query:q.params.arguments?.query,code:q.params.arguments?.achievementStandardCode,cursor:!!q.params.arguments?.cursor,status:s?.status??(error?'error':a?'other':'missing'),source:s?.source?.sourceUrl,more:s?.pagination?.hasMore,truncated:s?.responseTruncated,records:s?.records?.length??0,rawBlocks:s?.rawBlocks?.length??0};
      if(error)call.error=JSON.stringify(error).slice(0,450);
      if(s?.warnings)call.warnings=[...new Set(s.warnings.map(w=>w.code))];
      calls.push(call);
      for(const x of s?.results??[])sources.push({title:x.title,url:x.sourceUrl,snippet:x.snippet});
      if(s?.source)sources.push({title:s.source.title,url:s.source.sourceUrl});
      for(const x of s?.records??[])records.push({code:x.achievementStandardCode?.normalized??x.achievementStandardCode?.raw,standard:x.achievementStandardText?.normalized??x.achievementStandardText?.raw,label:x.achievementLevel?.rawLabel,description:x.description?.normalized??x.description?.raw,grade:x.grade,location:x.description?.evidence?.[0]?.location,source:s.source?.sourceUrl,file:rf});
      for(const x of s?.rawBlocks??[]){const text=x.text??x.content??JSON.stringify(x);if(typeof text==='string')raws.push({text,location:x.location,file:rf});}
    }
    const rec=unique(records.map(({file,...x})=>x));
    const relevant=rec.filter(x=>x.code===doc.truth.code||(x.code&&r.final.includes(x.code)));
    const seenLabels=[...new Set(rec.filter(x=>x.code===doc.truth.code).map(x=>x.label))];
    const relevantRaw=unique(raws.filter(x=>norm(x.text).includes(norm(doc.truth.code))).map(x=>({...x,text:x.text.length>4000?x.text.slice(Math.max(0,x.text.indexOf(doc.truth.code)-100),x.text.indexOf(doc.truth.code)+3900):x.text})));
    const item={stage,model,id,question:scenarios.find(s=>s.id===id).question,final:r.final,collected:r.finalAnswerCollected,errors:r.environmentErrors,resultHash:sha(fs.readFileSync(path.join(p,'result.json'))),seenTargetLabels:seenLabels,sources:unique(sources),records:relevant,otherRecordCodes:[...new Set(rec.map(x=>x.code).filter(x=>x&&x!==doc.truth.code))],rawTargetEvidence:relevantRaw,calls};cases.push(item);all.push(item);
  }
  const evidence={documentId:doc.documentId,title:doc.title,sourceUrl:doc.sourceUrl,truth:{code:doc.truth.code,standard:doc.truth.standardText,levels:doc.truth.levels,rawChunk:doc.truth.rawChunk,pdfPage:doc.truth.pdfPage},cases};
  fs.writeFileSync(path.join(dest,`${doc.documentId}-evidence.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  let md=`# ${doc.documentId} ${doc.title}\nSOURCE ${doc.sourceUrl}\nTRUTH ${JSON.stringify(evidence.truth)}\n`;
  for(const c of cases){md+=`\n## ${c.stage}/${c.model}/${c.id}\nQUESTION ${c.question}\nFINAL\n${c.final||'(NO FINAL)'}\nEVIDENCE\n${JSON.stringify({collected:c.collected,errors:c.errors,seenTargetLabels:c.seenTargetLabels,sources:c.sources,records:c.records,otherRecordCodes:c.otherRecordCodes,rawTargetEvidence:c.rawTargetEvidence,calls:c.calls})}\n`;}
  fs.writeFileSync(path.join(dest,`${doc.documentId}-packet.md`),md,{flag:'wx'});
}
fs.writeFileSync(path.join(dest,'inventory.json'),JSON.stringify({createdAt:new Date().toISOString(),primary:all.filter(x=>x.stage==='primary').length,supplemental:all.filter(x=>x.stage==='recovery').length,records:all.map(({stage,model,id,resultHash})=>({stage,model,id,resultHash})),note:'Evidence packaging only. Semantic judgments must be recorded separately as AI review, never human review.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({primary:all.filter(x=>x.stage==='primary').length,supplemental:all.filter(x=>x.stage==='recovery').length,documents:reference.documents.length}));
