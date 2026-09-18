import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceCodec } from '../dist/achievement/references.js';
import { readAchievementInputSchema, searchAchievementInputSchema } from '../dist/achievement/contracts.js';

test('signed references survive restart, reject tampering, wrong purpose, expiry and future issue time',()=>{
  let now=100000;
  const a=new ReferenceCodec('test-reference-secret-32-bytes-minimum',()=>now,1000);
  const token=a.issue('achievement',{resource:{id:'1'}});
  assert.deepEqual(new ReferenceCodec('test-reference-secret-32-bytes-minimum',()=>now,1000).verify(token,'achievement'),{resource:{id:'1'}});
  assert.throws(()=>a.verify(token,'attachment'));
  assert.throws(()=>a.verify(token.slice(0,-3)+'xxx','achievement'));
  assert.throws(()=>new ReferenceCodec('other-test-secret-32-bytes-minimum').verify(token,'achievement'));
  now+=1000;assert.throws(()=>a.verify(token,'achievement'));
  now=-100000;assert.throws(()=>a.verify(token,'achievement'));
  assert.throws(()=>new ReferenceCodec('short'));
  assert.throws(()=>a.issue('resource',{resource:'한'.repeat(10000)}));
});

test('references issued across clock ticks retain their exact lifetime and verify immediately',()=>{
  let now=100000;
  const codec=new ReferenceCodec('test-reference-secret-32-bytes-minimum',()=>now++,1000);
  const token=codec.issue('achievement',{resource:{id:'1'}});
  const payload=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8'));
  assert.equal(payload.exp-payload.iat,1000);
  assert.deepEqual(codec.verify(token,'achievement'),{resource:{id:'1'}});
});

test('achievement inputs reject arbitrary URLs, files, unknown fields and unbounded responses',()=>{
  for(const value of [{},{levelLabel:'상'},{query:'https://evil.test/a'},{query:'C:\\private.hwp'},{query:'q',url:'https://evil.test'},{subject:'과학',page:51}]) assert.equal(searchAchievementInputSchema.safeParse(value).success,false);
  assert.equal(searchAchievementInputSchema.parse({subject:'과학'}).pageSize,10);
  assert.equal(readAchievementInputSchema.safeParse({achievementRef:'x',file_path:'a'}).success,false);
  assert.equal(readAchievementInputSchema.safeParse({achievementRef:'x',maxChars:20001}).success,false);
});
