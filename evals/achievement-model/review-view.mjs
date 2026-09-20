import path from 'node:path';
import {args,read} from './common.mjs';
const o=args(),root=path.resolve(o.out);
for(const id of o.docs.split(',')){
 const d=read(path.join(root,'ai-review',`${id}-evidence.json`));
 console.log(`\n# ${id} ${d.title}\nSOURCE ${d.sourceUrl}\nTRUTH ${JSON.stringify(d.truth)}`);
 for(const c of d.cases){
  console.log(`\n## ${c.stage}/${c.model}/${c.id}\nQ ${c.question}\nFINAL\n${c.final||'(NO FINAL)'}\nEVIDENCE ${JSON.stringify({errors:c.errors,sourceIds:[...new Set(c.sources.map(s=>s.url))],records:c.records.map(r=>({code:r.code,label:r.label,description:d.truth.levels.find(t=>t.label===r.label&&t.description.replace(/\s+/g,'')===r.description?.replace(/\s+/g,''))?'MATCHES_TRUTH':r.description,grade:r.grade?.normalized,location:r.location,source:r.source})),rawTargetEvidence:c.rawTargetEvidence,otherRecordCodes:c.otherRecordCodes,statuses:c.calls.reduce((a,x)=>(a[x.status]=(a[x.status]??0)+1,a),{}),errorsSeen:[...new Set(c.calls.filter(x=>x.error).map(x=>x.error))],readCallsLast8:c.calls.filter(x=>x.tool==='read_edunet_achievement'&&x.status!=='error').slice(-8).map(x=>({file:x.file,status:x.status,code:x.code,source:x.source,more:x.more,truncated:x.truncated,records:x.records,raw:x.rawBlocks,warnings:x.warnings?.filter(w=>!['SKIPPED_IMAGE','TABLE_PROFILE_UNMATCHED','VISUAL_CONTENT_NOT_INTERPRETED','GRADE_NOT_PRESENT','SUBJECT_NOT_PRESENT','MERGED_CELL_INHERITED','PDF_TABLE_STRUCTURE_UNVERIFIED','STANDARD_ONLY_RECORDS_OMITTED'].includes(w))}))})}`);
 }
}
