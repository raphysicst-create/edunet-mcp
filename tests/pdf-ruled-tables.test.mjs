import test from 'node:test';
import assert from 'node:assert/strict';
import {OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {restoreRuledStandardCells,paintedLines} from '../dist/worker/parsers/pdf-ruled-tables.js';
import {extractAchievements} from '../dist/worker/achievement/extract.js';
import {codePattern} from '../dist/worker/achievement/profile.js';

const cell=(text,colSpan=1)=>({text,rowSpan:1,colSpan});
const fixture=()=>({type:'table',bbox:{page:1,x:0,y:0,width:300,height:140},table:{rows:7,cols:3,cells:[
 [cell('성취기준'),cell('성취기준별 성취수준',2),cell('')],
 [cell(''),cell('A'),cell('근거를 비교한다.')],
 [cell('[9과01-01] 실험의'),cell('B'),cell('근거를 찾는다.')],
 [cell('결과를 설명한다.'),cell('C'),cell('결과를 읽는다.')],
 [cell(''),cell('D'),cell('결과를 나열한다.')],
 [cell(''),cell('E'),cell('결과를 확인한다.')],
 [cell('[9과01-02] 다른 실험.'),cell('A'),cell('다른 설명.')],
]}});
const rulings=()=>[...Array.from({length:8},(_,i)=>({x1:[0,1,6,7].includes(i)?0:100,y1:140-i*20,x2:300,y2:140-i*20})),{x1:100,y1:140,x2:100,y2:0},{x1:120,y1:120,x2:120,y2:0}];
function blocks(table){let n=3;return table.table.cells.flatMap((row,r)=>row.map((cell,c)=>({text:cell.text,kind:'table_cell',rowSpan:cell.rowSpan,columnSpan:cell.colSpan,location:{block:n++,page:1,table:1,row:r+1,column:c+1}}))).filter(b=>b.text||b.location.column!==1);}
function document(table){return {parserName:'test',parserVersion:'1',documentExtractionComplete:true,warnings:[],blocks:[
 {text:'중학교 과학 성취수준',kind:'heading',location:{block:1,page:1}},
 {text:'초‧중학교 국어, 수학, 사회, 과학, 영어(초1~중3)에서 최소 기준이 제시된다.',kind:'heading',location:{block:2,page:1}},
 ...blocks(table),
]};}

test('painted ruling geometry restores the whole merged standard for all five levels without cross-standard leakage',()=>{
 const table=fixture();assert.equal(restoreRuledStandardCells(table,rulings()),true);assert.equal(table.table.cells[1][0].rowSpan,5);
 const result=extractAchievements(document(table),'hash');const records=result.records.filter(r=>r.achievementStandardCode?.raw==='[9과01-01]');
 assert.deepEqual(records.map(r=>r.achievementLevel.rawLabel),['A','B','C','D','E']);
 assert.ok(records.every(r=>r.subject.raw==='과학'&&r.grade.raw==='중학교'));
 assert.ok(records.every(r=>r.achievementStandardText.normalized==='실험의 결과를 설명한다.'));
 assert.equal(result.records.find(r=>r.achievementStandardCode.raw==='[9과01-02]').description.raw,'다른 설명.');
});

test('missing or inconsistent ruling evidence never guesses a merged cell from the level sequence',()=>{
 for(const lines of [[],rulings().filter(l=>l.y1!==120),[...rulings(),{x1:20,y1:100,x2:110,y2:100}]]) {
  const table=fixture(),before=JSON.stringify(table);assert.equal(restoreRuledStandardCells(table,lines),false);assert.equal(JSON.stringify(table),before);
  assert.equal(extractAchievements(document(table),'hash').records.length,0);
 }
});

test('only painted straight paths are considered; transforms and save/restore preserve coordinates',()=>{
 const lines=paintedLines({fnArray:[OPS.save,OPS.transform,OPS.constructPath,OPS.stroke,OPS.restore,OPS.constructPath,OPS.endPath],argsArray:[[],[1,0,0,1,100,200],[[OPS.moveTo,OPS.lineTo],[0,0,20,0]],[],[],[[OPS.moveTo,OPS.lineTo],[0,0,99,0]],[]]});
 assert.deepEqual(lines,[{x1:100,y1:200,x2:120,y2:200}]);
});

test('independent painted description spans preserve shared A/B and C/D text and evidence anchors',()=>{
 const table=fixture();
 table.table.cells[1][2].text='공통 첫 설명.';table.table.cells[2][2].text='';
 table.table.cells[3][2].text='공통 둘째';table.table.cells[4][2].text='설명.';
 const lines=rulings().map(l=>[100,60].includes(l.y1)&&l.y1===l.y2?{...l,x2:120}:l);
 assert.equal(restoreRuledStandardCells(table,lines),true);
 assert.equal(table.table.cells[1][2].rowSpan,2);assert.equal(table.table.cells[3][2].rowSpan,2);
 const records=extractAchievements(document(table),'hash').records.filter(r=>r.achievementStandardCode?.raw==='[9과01-01]');
 assert.deepEqual(records.map(r=>r.description.normalized),['공통 첫 설명.','공통 첫 설명.','공통 둘째 설명.','공통 둘째 설명.','결과를 확인한다.']);
 assert.equal(records[0].description.evidence[0].location.row,records[1].description.evidence[0].location.row);
});

test('an incomplete line inside a description cell rejects the whole repair without mutations',()=>{
 const table=fixture(),before=JSON.stringify(table);
 const lines=rulings().map(l=>l.y1===100&&l.y2===100?{...l,x2:170}:l);
 assert.equal(restoreRuledStandardCells(table,lines),false);assert.equal(JSON.stringify(table),before);
});

test('explicit parenthesized subject codes remain literal and malformed parentheses are rejected',()=>{
 const table=fixture();table.table.cells[2][0].text='[9사(지리)01-01] 자료의';
 assert.equal(restoreRuledStandardCells(table,rulings()),true);
 const records=extractAchievements(document(table),'hash').records.filter(r=>r.achievementStandardCode?.raw==='[9사(지리)01-01]');
 assert.equal(records.length,5);assert.ok(records.every(r=>r.achievementStandardCode.normalized==='[9사(지리)01-01]'));
 for(const code of ['[9사(지리01-01]','[9사)지리(01-01]','[9사((지리))01-01]'])assert.equal(codePattern.test(code),false);
});

test('numbered common-course codes preserve the original course separator',()=>{
 const table=fixture();table.table.cells[2][0].text='[10공영1-01-01] 내용을';
 assert.equal(restoreRuledStandardCells(table,rulings()),true);
 const records=extractAchievements(document(table),'hash').records.filter(r=>r.achievementStandardCode?.raw==='[10공영1-01-01]');
 assert.equal(records.length,5);assert.ok(records.every(r=>r.achievementStandardCode.normalized==='[10공영1-01-01]'));
 assert.equal(codePattern.test('[10공영12-01-01]'),false);
});
