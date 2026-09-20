import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildIdentity} from '../scripts/build-identity.mjs';

test('build identity tolerates Vercel JSON serialization but detects setting and source changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'edunet-identity-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['src','config','api','scripts'])await mkdir(join(root,dir));
 for(const path of ['package-lock.json','tsconfig.json','scripts/build-vercel.mjs','scripts/build-identity.mjs'])await writeFile(join(root,path),'{}');
 await writeFile(join(root,'package.json'),JSON.stringify({version:'test'}));
 await writeFile(join(root,'src/example.ts'),'original');
 const config={name:'edunet-mcp',version:2,framework:null,buildCommand:'npm run build:vercel'};
 await writeFile(join(root,'vercel.json'),JSON.stringify(config,null,2)+'\r\n');
 const original=await buildIdentity(root);
 await writeFile(join(root,'vercel.json'),JSON.stringify(Object.fromEntries(Object.entries(config).reverse()))+'\n');
 assert.equal((await buildIdentity(root)).sourceDigest,original.sourceDigest);
 await writeFile(join(root,'vercel.json'),JSON.stringify({...config,buildCommand:'different build'}));
 assert.notEqual((await buildIdentity(root)).sourceDigest,original.sourceDigest);
 await writeFile(join(root,'vercel.json'),JSON.stringify(config));
 await writeFile(join(root,'src/example.ts'),'changed');
 assert.notEqual((await buildIdentity(root)).sourceDigest,original.sourceDigest);
 assert.deepEqual(original.fileHashEncodings,{'vercel.json':'sorted-json-v1',default:'raw-bytes'});
});

test('build identity detects same-version source/config/dependency changes and excludes secrets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'edunet-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['src','config','api','scripts'])await mkdir(join(root,dir));
 for(const file of ['src/example.ts','config/profile.json','api/mcp.mjs','package-lock.json','tsconfig.json','vercel.json','scripts/build-vercel.mjs','scripts/build-identity.mjs'])await writeFile(join(root,file),'{}');
 await writeFile(join(root,'package.json'),'{"version":"test"}');await writeFile(join(root,'.env'),'SECRET=never-include');
 const initial=await buildIdentity(root);assert.deepEqual(await buildIdentity(root),initial);assert.ok(!JSON.stringify(initial).includes('SECRET'));
 const {manifestDigest,...core}=initial;assert.equal(manifestDigest,createHash('sha256').update(JSON.stringify(core)).digest('hex'));
 for(const file of ['src/example.ts','config/profile.json','package-lock.json']){
   await writeFile(join(root,file),'changed');const changed=await buildIdentity(root);assert.notEqual(changed.sourceDigest,initial.sourceDigest);assert.equal(changed.packageVersion,initial.packageVersion);await writeFile(join(root,file),'{}');
 }
});
