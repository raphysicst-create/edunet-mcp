import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { parseDocument } from '../dist/worker/parsers/index.js';
import { preflightHwpx } from '../dist/worker/parsers/preflight.js';
import { extractAchievements } from '../dist/worker/achievement/extract.js';
import { achievementRecordSchema } from '../dist/achievement/contracts.js';
import { syntheticPdf, syntheticHwp, descriptions } from './fixtures/achievement/generate.mjs';

const fixture = name => readFile(new URL(`./fixtures/achievement/${name}`,import.meta.url));
const doc = blocks => ({blocks,parserName:'fixture',parserVersion:'1',documentExtractionComplete:true,warnings:[]});
const heading = (text,block) => ({text,kind:'heading',location:{block}});
const paragraph = (text,block) => ({text,kind:'paragraph',location:{block}});
const table = rows => rows.flatMap((row,r)=>row.map((text,c)=>({text,kind:'table_cell',location:{table:1,row:r+1,column:c+1,block:r*row.length+c+1}})));
function assertEvidence(document,records,hash) {
  for (const record of records) {
    achievementRecordSchema.parse(record);
    for (const [name,value] of Object.entries(record)) {
      if (!value || typeof value !== 'object' || !('evidence' in value)) continue;
      assert.ok(value.evidence.length,`${name} lacks evidence`);
      for (const span of value.evidence) {
        const block=document.blocks.find(b=>b.location.block===span.location.block);
        assert.ok(block,`${name} references missing block`);
        assert.equal(block.text.slice(span.location.charStart,span.location.charEnd),span.quote);
        assert.equal(span.sourceHash,hash);
      }
      const raw=value.raw ?? value.rawLabel;
      assert.ok(value.evidence.some(span=>span.quote===raw),`${name} raw value has no exact quote`);
    }
  }
}

for (const [name,format,labels,orientation] of [
  ['synthetic-rows.pdf','pdf',['상','중','하'],'levels_in_rows'],
  ['synthetic-columns.pdf','pdf',['A','B','C'],'levels_in_columns'],
  ['synthetic-merged.hwp','hwp',['상','중','하'],'levels_in_rows'],
  ['synthetic-rows.hwpx','hwpx',['상','중','하'],'levels_in_rows'],
]) test(`${format}: ${name} extracts exact codes/labels with source coordinates`,async()=>{
  const bytes=await fixture(name); const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const document=await parseDocument(bytes,format,{enableHwpx:true});
  const result=extractAchievements(document,hash);
  assert.equal(result.records.length,3);
  assert.deepEqual(result.records.map(r=>r.achievementLevel.rawLabel),labels);
  assert.equal(result.documentProfile.tableOrientation,orientation);
  for (const record of result.records) {
    assert.equal(record.achievementStandardCode.raw,'[9과01-01]');
    assert.equal(record.grade.raw,'중학교 1학년');
    assert.equal(record.subject.raw,'과학');
    assert.equal(record.achievementLevel.ordinal,undefined);
    const loc=record.description.evidence[0].location;
    assert.ok(loc.table && loc.row && loc.column);
    if(format==='pdf') assert.equal(loc.page,1);
    else assert.equal(loc.page,undefined,'section/table-start numbers must not masquerade as exact cell pages');
  }
  assertEvidence(document,result.records,hash);
});

test('HWP merged source evidence stays at anchor row, and simple unmerged HWP works',async()=>{
  const document=await parseDocument(syntheticHwp(),'hwp');
  assert.equal(document.blocks.find(b=>b.text.startsWith('[9과')).rowSpan,3);
  const records=extractAchievements(document,'hash').records;
  assert.deepEqual(records.map(r=>r.achievementStandardCode.evidence[0].location.row),[2,2,2]);
  assert.deepEqual(records.map(r=>r.description.evidence[0].location.row),[2,3,4]);
  assert.equal(records[0].extraction.parserWarnings,undefined);
  assert.ok(records[1].extraction.parserWarnings.includes('MERGED_CELL_INHERITED'));
  assert.equal(records[1].extraction.confidence,'medium');
  assert.equal((await parseDocument(syntheticHwp({merged:false}),'hwp')).blocks.filter(b=>b.text.startsWith('[9과')).length,3);
});
test('PDF multi-page repeated headers are not emitted as records',async()=>{
  const document=await parseDocument(syntheticPdf({pages:2}),'pdf');
  const records=extractAchievements(document,'hash').records;
  assert.equal(records.length,6);
  assert.deepEqual(records.map(r=>r.description.evidence[0].location.page),[1,1,1,2,2,2]);
});
test('code-free descriptive and document-defined labels retain original wording',()=>{
  const document=doc(table([['성취수준','설명'],['매우 우수','서술형 수준의 원문 설명'],['발전 중','문서에서 정의한 단계']]));
  const result=extractAchievements(document,'hash');
  assert.equal(result.records.length,2);
  assert.deepEqual(result.records.map(r=>r.achievementLevel.rawLabel),['매우 우수','발전 중']);
  assert.equal(result.records[1].achievementLevel.labelSystem,'document_defined');
  assert.ok(result.records.every(r=>!r.achievementStandardCode));
  assert.ok(result.warnings.some(w=>w.code==='STANDARD_CODE_NOT_PRESENT'));
  assertEvidence(document,result.records,'hash');
});

test('A-E labels use alphabetic notation without asserting three levels or converting source labels',()=>{
  const document=doc(table([['성취기준','A','B','C','D','E'],['[10공수1-01-01] 원문 기준','A 설명','B 설명','C 설명','D 설명','E 설명']]));
  const records=extractAchievements(document,'hash').records;
  assert.deepEqual(records.map(r=>r.achievementLevel.rawLabel),['A','B','C','D','E']);
  assert.ok(records.every(r=>r.achievementLevel.labelSystem==='alphabetic'));
  assertEvidence(document,records,'hash');
});
test('blank code cells do not silently inherit unreported merged spans',()=>{
  const document=doc(table([['성취기준','성취수준','설명'],['[9과01-01] 기준','상','첫 설명'],['','중','둘째 설명']]));
  const records=extractAchievements(document,'hash').records;
  assert.equal(records[0].achievementStandardCode.raw,'[9과01-01]');
  assert.equal(records[1].achievementStandardCode,undefined);
});
test('ambiguous subject headings and new grade sections do not leak prior context',()=>{
  const document=doc([heading('중학교 1학년 과학',1),paragraph('영역: 물질',2),paragraph('상: 첫째 설명',3),heading('중학교 2학년',4),paragraph('상: 둘째 설명',5),heading('과학/수학',6),paragraph('상: 셋째 설명',7)]);
  const result=extractAchievements(document,'hash');
  assert.equal(result.records[0].subject.raw,'과학');
  assert.equal(result.records[1].subject,undefined);
  assert.equal(result.records[1].domain,undefined);
  assert.equal(result.records[2].subject,undefined);
  assert.ok(result.warnings.some(w=>w.code==='AMBIGUOUS_SUBJECT_CONTEXT'));
});
test('explicit paragraph syntax works, prose and unknown tables stay unverified',()=>{
  const records=extractAchievements(doc([paragraph('[9과01-01] 원문 기준',1),paragraph('상: 원문 수준 설명',2)]),'hash').records;
  assert.equal(records.length,1);assert.equal(records[0].achievementStandardCode.raw,'[9과01-01]');
  assert.equal(extractAchievements(doc([paragraph('상상력을 발휘한다.',1)]),'hash').records.length,0);
  const unknown=extractAchievements(doc(table([['항목','금액'],['상','100']])),'hash');
  assert.equal(unknown.records.length,0);assert.ok(unknown.warnings.some(w=>w.code==='TABLE_PROFILE_UNMATCHED'));
});
test('scanned/no-text PDF returns explicit OCR_REQUIRED and no invented text',async()=>{
  await assert.rejects(parseDocument(syntheticPdf({scanned:true}),'pdf'),e=>e.status==='no_text'&&e.code==='OCR_REQUIRED');
});
test('HWPX default is disabled, malformed HWP and PDF fail safely',async()=>{
  await assert.rejects(parseDocument(await fixture('synthetic-rows.hwpx'),'hwpx'),e=>e.code==='HWPX_DISABLED'&&e.status==='unsupported_format');
  await assert.rejects(parseDocument(Buffer.from('<html>error</html>'),'hwp'),e=>e.code==='INVALID_HWP');
  await assert.rejects(parseDocument(Buffer.from('%PDF-1.7 invalid'),'pdf'),e=>e.status==='parse_failed');
});
test('HWPX forged expanded-size metadata is checked against actual inflation',async()=>{
  const zip=new JSZip();zip.file('mimetype','application/hwp+zip');zip.file('Contents/section0.xml','x'.repeat(33*1024*1024));
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  // Falsify local metadata to make declared size small; actual inflation still has a hard cap.
  let offset=0;while(bytes.readUInt32LE(offset)===0x04034b50){const length=bytes.readUInt32LE(offset+18);const nl=bytes.readUInt16LE(offset+26);const el=bytes.readUInt16LE(offset+28);if(bytes.readUInt32LE(offset+22)>32*1024*1024)bytes.writeUInt32LE(1,offset+22);offset+=30+nl+el+length;}
  assert.throws(()=>preflightHwpx(bytes),e=>e.code==='DECOMPRESSION_LIMIT');
});
test('public non-curriculum HWP and HWPX samples preserve real table structures',async()=>{
  for(const [name,format] of [['hwpjs-basics-report.hwp','hwp'],['kordoc-simple-form.hwpx','hwpx']]){
    const document=await parseDocument(await fixture('public/'+name),format,{enableHwpx:true});
    assert.ok(document.blocks.some(b=>b.kind==='table_cell'));
    assert.ok(document.blocks.some(b=>b.text.trim().length>0));
    assert.ok(document.warnings.some(w=>w.code==='VISUAL_CONTENT_NOT_INTERPRETED'));
    assert.equal(extractAchievements(document,'hash').records.length,0);
  }
});
test('parser applies block and byte limits',async()=>{
  await assert.rejects(parseDocument(syntheticHwp(),'hwp',{maxBlocks:3}),e=>e.code==='OUTPUT_LIMIT');
  await assert.rejects(parseDocument(new Uint8Array(10*1024*1024+1),'pdf'),e=>e.code==='INPUT_TOO_LARGE');
});

test('explicit single grades normalize to query aliases while raw evidence stays unchanged',()=>{
  for(const [raw,alias] of [['초등학교 6학년','초6'],['중학교 1학년','중1'],['고등학교 3학년','고3']]){
    const document=doc([heading(`${raw} 과학`,1),paragraph('상: 원문 수준 설명',2)]);
    const records=extractAchievements(document,'hash').records;
    assert.equal(records[0].grade.raw,raw);
    assert.equal(records[0].grade.normalized,alias);
    assertEvidence(document,records,'hash');
  }
  const document=doc(table([['학년','성취기준 코드','성취수준','설명'],['중학교  1 학년','[ 9과01-01 ]','상','첫 설명'],['중학교 1~2학년군','[9과01-01]','중','둘째 설명'],['1학년','[9과01-01]','하','셋째 설명'],['중학교 4학년','[9과01-01]','하','넷째 설명']]));
  const records=extractAchievements(document,'hash').records;
  assert.equal(records[0].grade.raw,'중학교  1 학년');
  assert.equal(records[0].grade.normalized,'중1');
  assert.equal(records[0].achievementStandardCode.raw,'[ 9과01-01 ]');
  assert.equal(records[0].achievementStandardCode.normalized,'[9과01-01]');
  assert.equal(records[1].grade.normalized,'중학교 1~2학년군');
  assert.equal(records[2].grade.normalized,'1학년');
  assert.equal(records[3].grade.normalized,'중학교 4학년');
  assertEvidence(document,records,'hash');
});
