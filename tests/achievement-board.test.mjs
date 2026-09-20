import test from 'node:test';
import assert from 'node:assert/strict';
import { listOfficialAchievements, listingConditions, BOARD_LIST_PATH } from '../dist/achievement/official-listing.js';
import { createAchievementSearch } from '../dist/achievement/search-orchestrator.js';
import { searchAchievementInputSchema } from '../dist/achievement/contracts.js';
import { loadSourceRegistry } from '../dist/achievement/source-registry.js';
import { resolveResource, resourceDetailUrl } from '../dist/resource/resolver.js';
import { ReferenceCodec } from '../dist/achievement/references.js';
import { createAchievementReader } from '../dist/achievement/read-service.js';

const registry=loadSourceRegistry().entries;
const resource={id:'602681',title:'(중)2022 개정 교육과정에 따른 성취수준(과학)',sourceUrl:'https://www.edunet.net/cmnBoard/view/57/602681',snippet:'중학교 과학',sourceType:'achievement_level'};
const parsed=x=>searchAchievementInputSchema.parse(x);
const row={pstId:602681,bbsId:19,ttl:resource.title,cn:'과학 성취수준',delYn:'N',fieldVal:'2:4:schoolGradeSe:Y'};
const payload=(rows=[row],page=1,total=rows.length)=>({success:true,data:{list:rows,pagingProperty:{currentPage:page,maxResults:10,countItem:total}}});
const detail=()=>({success:true,data:{pstInfo:{pstId:602681,bbsId:19,ttl:resource.title,cn:'과학',delYn:'N',secrYn:'N'},bbsInfo:{bbsId:19,useYn:'Y'},atchFileInfoList:[{pstId:602681,fileRscId:3063775,fileLgcNm:'과학.pdf',extn:'pdf',fileByte:4428117}]}});
const references=new ReferenceCodec('board-test-only-32-byte-reference-secret');

test('listing scopes school and subject for natural-language and code-only discovery without inventing grade',async()=>{
  for(const input of [{query:'중학교 과학 성취수준 자료 찾아줘'},{achievementStandardCode:'[9과05-01]'},{query:'중학교 과학에서 힘의 평형과 관련된 성취수준을 찾아줘'}]) {
    assert.deepEqual(listingConditions(parsed(input)),{keyword:'과학',school:'4'});
    const page=await listOfficialAchievements(parsed(input),undefined,async request=>{assert.equal(request.school,'4');assert.equal(request.keyword,'과학');return payload();});
    assert.equal(page.resources[0].id,'602681');assert.equal(page.hasNext,false);
    assert.ok(!JSON.stringify(page).includes('중2'));
  }
});

test('listing validates page, board, visibility and school scope and uses total to expose next page',async()=>{
  const input=parsed({subject:'과학',grade:'중학교'});
  assert.equal((await listOfficialAchievements(input,undefined,async()=>payload([row],1,11))).hasNext,true);
  assert.equal((await listOfficialAchievements({...input,page:2},undefined,async()=>payload([row],2,11))).hasNext,false);
  for(const bad of [{...row,bbsId:20},{...row,delYn:'Y'},{...row,secrYn:'Y'},{...row,fieldVal:'2:58:schoolGradeSe:Y'}]) await assert.rejects(listOfficialAchievements(input,undefined,async()=>payload([bad])));
  await assert.rejects(listOfficialAchievements(input,undefined,async()=>payload([row],2)));
});

test('board detail resolves public identity and rejects cross-post or missing attachment ownership',async()=>{
  assert.equal(resourceDetailUrl(resource).pathname,'/main/cmnBoard/getCmnBoardPstInfo/57/602681');
  for(const url of ['https://www.edunet.net/cmnBoard/view/58/602681','https://www.edunet.net/cmnBoard/view/57/999']) assert.equal(resourceDetailUrl({...resource,sourceUrl:url}),undefined);
  const result=await resolveResource(resource,undefined,{fetchJson:async()=>detail()});
  assert.equal(result.attachments[0].url,'https://api.edunet.net/main/fileRsc/downloadFile/3063775');
  for(const owner of [999,null]) {
    const data=detail();data.data.atchFileInfoList[0].pstId=owner;
    const r=await resolveResource(resource,undefined,{fetchJson:async()=>data});assert.equal(r.attachments.length,0);assert.ok(r.warnings.some(w=>w.code==='attachment_scope_mismatch'));
  }
  for(const field of ['bbsId','delYn','secrYn']) {
    const data=detail();data.data.pstInfo[field]=field==='bbsId'?20:'Y';
    const r=await resolveResource(resource,undefined,{fetchJson:async()=>data});assert.ok(r.warnings.some(w=>w.code==='attachment_metadata_unavailable'));
  }
});

test('public board finds the expected source when search is empty or unconfigured; refs reach the reader',async()=>{
  for(const missing of [false,true]) {
    const search=createAchievementSearch({references,registry,search:async()=>{if(missing)throw {code:'CONFIGURATION'};return {items:[],pagination:{hasNextPage:false}};},listOfficial:async()=>({resources:[resource],keyword:'과학',school:'4',hasNext:false}),resolveResource:r=>resolveResource(r,undefined,{fetchJson:async()=>detail()})});
    const found=await search(parsed({achievementStandardCode:'[9과05-01]'}));
    assert.equal(found.results[0].sourceUrl,resource.sourceUrl);assert.equal(found.results[0].codeHint,undefined);assert.equal(found.status,missing?'partial':'ok');
    assert.equal(found.coverage.officialApiQueried,!missing);assert.equal(found.coverage.officialListing.status,'ok');
    const reader=createAchievementReader({references,config:{pdfReadEnabled:true},gateway:{run:async()=>{throw Error('must not parse listing');}},resolveResource:r=>resolveResource(r,undefined,{fetchJson:async()=>detail()})});
    const list=await reader({achievementRef:found.results[0].achievementRef});assert.equal(list.status,'attachment_selection_required');assert.equal(list.attachments[0].fileName,'과학.pdf');
  }
});

test('disabled board entries stop list and detail requests; timeout is bounded',async()=>{
  let calls=0;
  const disabled=registry.map(e=>({...e,enabled:!e.pathPattern.includes('cmnBoard')}));
  const search=createAchievementSearch({references,registry:disabled,search:async()=>({items:[],pagination:{hasNextPage:false}}),listOfficial:async()=>{calls++;throw Error();}});
  await search(parsed({subject:'과학'}));await resolveResource(resource,undefined,{registry:disabled,fetchJson:async()=>{calls++;throw Error();}});assert.equal(calls,0);
  const stuck=createAchievementSearch({references,registry,timeoutMs:30,search:async()=>({items:[],pagination:{hasNextPage:false}}),listOfficial:()=>new Promise(()=>{})});
  const result=await stuck(parsed({subject:'과학'}));assert.equal(result.status,'partial');assert.equal(result.coverage.officialListing.status,'unavailable');
});

test('board and content with identical numeric IDs remain separate; relevant board beats unrelated candidates',async()=>{
  const legacy={...resource,title:'고등학교 국어 성취수준',snippet:'고등학교 국어',sourceUrl:'https://www.edunet.net/clssStdDt/view/150/602681'};
  const search=createAchievementSearch({references,registry,search:async()=>({items:[{id:legacy.id,title:legacy.title,content:legacy.snippet,url:legacy.sourceUrl}],pagination:{hasNextPage:false}}),listOfficial:async()=>({resources:[resource],keyword:'과학',school:'4',hasNext:false}),resolveResource:async r=>({resource:r,attachments:[],warnings:[]})});
  const found=await search(parsed({subject:'과학',grade:'중학교'}));assert.equal(found.results[0].sourceUrl,resource.sourceUrl);assert.equal(found.results.length,2);
});

test('oversized attachment is explained before any worker is started',async()=>{
  const data=detail();data.data.atchFileInfoList[0].fileByte=11*1024*1024;
  let calls=0;const reader=createAchievementReader({references,config:{pdfReadEnabled:true},gateway:{run:async()=>{calls++;throw Error();}},resolveResource:r=>resolveResource(r,undefined,{fetchJson:async()=>data})});
  const achievementRef=references.issue('achievement',{resource});const list=await reader({achievementRef});
  assert.equal(list.attachments[0].readCapability,'unsupported');assert.match(list.attachments[0].selectionReason,/DOWNLOAD_TOO_LARGE/);
  const result=await reader({achievementRef,attachmentRef:list.attachments[0].attachmentRef});assert.equal(result.status,'source_unavailable');assert.ok(result.warnings.some(w=>w.code==='DOWNLOAD_TOO_LARGE'));assert.equal(calls,0);
});
