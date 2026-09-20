import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {args,credential,read,write} from './common.mjs';
const o=args(),root=path.resolve(o.out),name=o.name??'credential-audit.json';
if(path.basename(name)!==name)throw Error('AUDIT_NAME_MUST_BE_BASENAME');
const automation=await credential(),auth=read(path.join(os.homedir(),'AppData/Roaming/com.vercel.cli/Data/auth.json'));
const known=[['vercel_cli',auth.token],['automation',automation]].filter(([,v])=>typeof v==='string'&&v.length>8).map(([kind,value])=>({kind,variants:[value,encodeURIComponent(value),JSON.stringify(value).slice(1,-1)]}));
const exposures=[],unmaskedExportReferences=[];let files=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){walk(p);continue;}const s=fs.readFileSync(p,'utf8'),rel=path.relative(root,p).replaceAll('\\','/');files++;for(const item of known)if(item.variants.some(v=>s.includes(v)))exposures.push({file:rel,credential:item.kind});if((rel.startsWith('primary/')||rel.startsWith('continuation/')||rel.startsWith('full/')||rel.startsWith('recovery/')||rel.startsWith('sanitized-pilot/'))&&/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(s))unmaskedExportReferences.push(rel);}}
walk(root);
const result={createdAt:new Date().toISOString(),pass:exposures.length===0&&unmaskedExportReferences.length===0,files,knownCredentialTypes:known.map(x=>x.kind),exposures,unmaskedExportReferences,scope:'Known current Vercel CLI and automation credential values; primary, continuation, full, recovery and sanitized pilot signed-reference strings. Not a scan of provider credential stores.'};
write(path.join(root,name),result);console.log(JSON.stringify({pass:result.pass,files,credentialExposures:exposures.length,unmaskedExportReferences:unmaskedExportReferences.length}));if(!result.pass)process.exitCode=1;
