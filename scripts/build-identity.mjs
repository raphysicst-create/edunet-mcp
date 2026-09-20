import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonicalJson=value=>Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalJson(value[key])])):value;
async function files(root,dir){const result=[];for(const entry of await readdir(join(root,dir),{withFileTypes:true})){
 const path=`${dir}/${entry.name}`;
 if(entry.isSymbolicLink())throw Error('Source symlinks are not accepted');
 if(entry.isDirectory())result.push(...await files(root,path));else if(entry.isFile())result.push(path);
}return result;}

/** Content identity is authoritative even for CLI deployments without Git metadata. */
export async function buildIdentity(root){
 const paths=[...await files(root,'src'),...await files(root,'config'),...await files(root,'api'),
   'package.json','package-lock.json','tsconfig.json','vercel.json','scripts/build-vercel.mjs','scripts/build-identity.mjs'];
 const hashes={};for(const path of paths.sort()){
   const bytes=await readFile(join(root,path));
   // Vercel rewrites this file during remote builds. Compare every setting,
   // including injected defaults pinned in the source, independent of formatting.
   hashes[path]=hash(path==='vercel.json'?JSON.stringify(canonicalJson(JSON.parse(bytes.toString('utf8')))):bytes);
 }
 let sourceCommit=null,gitClean=null;
 try{sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
   gitClean=execFileSync('git',['status','--porcelain','--',...paths],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()==='';
 }catch{const commit=process.env.VERCEL_GIT_COMMIT_SHA;if(/^[a-f0-9]{40}$/.test(commit??''))sourceCommit=commit;}
 const core={schemaVersion:1,fileHashEncodings:{'vercel.json':'sorted-json-v1',default:'raw-bytes'},packageVersion:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,
   sourceCommit,gitClean,sourceDigest:hash(JSON.stringify(hashes)),files:hashes};
 return {...core,manifestDigest:hash(JSON.stringify(core))};
}
