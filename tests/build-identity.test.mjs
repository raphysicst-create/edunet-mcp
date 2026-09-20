import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildIdentity} from '../scripts/build-identity.mjs';

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
