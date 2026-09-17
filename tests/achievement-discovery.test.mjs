import assert from 'node:assert/strict';
import test from 'node:test';
import { createAchievementSearch, buildAchievementQueryVariants } from '../dist/achievement/search-orchestrator.js';
import { searchAchievementInputSchema } from '../dist/achievement/contracts.js';
import { inspectSourceRegistry, loadSourceRegistry } from '../dist/achievement/source-registry.js';
import { resolveResource, resourceDetailUrl } from '../dist/resource/resolver.js';

const resource = {id:'2516662', title:'중학교 과학 성취수준', sourceUrl:'https://www.edunet.net/clssStdDt/view/150/2516662?sbjtClsf=77433&srvcClsf=59599&contents_openapi=search', sourceType:'평가자료'};
const file = {id:'3595179', fileName:'과학 성취수준.pdf', format:'pdf', url:'https://api.edunet.net/main/fileRsc/downloadFile/3595179'};
const references = {issue(kind, data) { return `${kind}:${data.resource.id}`; }};
const item = (overrides={}) => ({id:resource.id,title:resource.title,url:resource.sourceUrl,category:resource.sourceType,content:'[9과12-03] 성취수준',contentTruncated:false,...overrides});
const output = (input,items=[],hasNext=false) => ({conditions:input,items,pagination:{page:input.page,pageSize:input.pageSize,hasNextPage:hasNext},source:'EDUNET_SEARCH_API',originalRead:false,attachmentsRead:false});
const parsed = input => searchAchievementInputSchema.parse(input);
const validMetadata = () => ({success:true,data:{clssStdDtInfo:{contsId:2516662,contsNm:'중학교 과학 성취수준',contsCn:'<p>평가기준</p>',kywd:'9과12-03'},fileList:[{fileRscId:3595179,fileLgcNm:'과학 성취수준.pdf',extn:'pdf',fileByte:113952,fileUrl:'https://attacker.invalid/x'}]}});

test('discovery tries bounded variants, deduplicates and checks metadata without downloading', async () => {
  const calls = [], details = [];
  const search = createAchievementSearch({references,registry:[],search:async input => {calls.push(input); return output(input,[item()]);},resolveResource:async value => {details.push(value.id);return {resource:value,attachments:[file],warnings:[]};}});
  const result = await search(parsed({query:'중학교 과학',subject:'과학',grade:'고등학교'}));
  assert.equal(result.status,'ok');
  assert.equal(result.results.length,1);
  assert.equal(details.length,1);
  assert.ok(calls.length >= 4 && calls.length <= 5);
  assert.ok(calls.some(call => call.query.includes('성취수준')));
  assert.ok(calls.some(call => call.query.includes('성취기준')));
  assert.ok(calls.some(call => call.query.includes('평가기준')));
  assert.equal(result.coverage.attachmentMetadataChecked,true);
  assert.equal(result.results[0].achievementRef,'achievement:2516662');
  assert.equal(result.results[0].readCapability,'possible');
  assert.equal(result.results[0].gradeHint,undefined,'requested grade is not evidence');
  assert.equal(result.results[0].subjectHint,'과학');
  assert.equal(result.results[0].codeHint,'[9과12-03]');
  assert.ok(result.results[0].candidateReason.some(reason => reason.includes('candidate_unverified')));
});

test('zero indexed results report coverage, never universal absence', async () => {
  let metadataCalls = 0;
  const search = createAchievementSearch({references,registry:[],search:async input => output(input),resolveResource:async () => {metadataCalls++;throw new Error();}});
  const result = await search(parsed({query:'과학'}));
  assert.equal(result.status,'not_found_in_official_index');
  assert.equal(result.coverage.officialApiQueried,true);
  assert.ok(result.coverage.queryVariantsTried.length > 1);
  assert.equal(result.coverage.attachmentMetadataChecked,false);
  assert.match(result.coverage.limitation,/검색 누락/);
  assert.equal(metadataCalls,0);
});

test('verified registry collection finds candidates when broad index queries miss', async () => {
  const registry = [{sourceType:'assessment_criteria',officialHost:'api.edunet.net',pathPattern:'/search/searchApi/search?collection=evl_data',discoveryMethod:'api',checkedAt:'2026-09-17T00:00:00Z',enabled:true}];
  const search = createAchievementSearch({references,registry,now:()=>Date.parse('2026-09-18'),search:async input => output(input,input.categories[0] === 'evl_data' ? [item()] : []),resolveResource:async value => ({resource:value,attachments:[file],warnings:[]})});
  const result = await search(parsed({query:'과학 성취수준'}));
  assert.equal(result.status,'ok');
  assert.deepEqual(result.coverage.registryPathsChecked,['/search/searchApi/search?collection=evl_data']);
  assert.ok(result.results[0].candidateReason.some(reason => reason.includes('컬렉션')));
});

test('metadata failures retain source, mark unknown capability and partial coverage', async () => {
  const search = createAchievementSearch({references,registry:[],search:async input => output(input,[item()]),resolveResource:async value => ({resource:value,attachments:[],warnings:[{code:'attachment_metadata_unavailable',message:'failed'}]})});
  const result = await search(parsed({query:'과학'}));
  assert.equal(result.status,'partial');
  assert.equal(result.results[0].readCapability,'unknown');
  assert.equal(result.results[0].sourceUrl,resource.sourceUrl);
  assert.equal(result.coverage.attachmentMetadataChecked,false);
});

test('search rejection and hard timeout are bounded even if injected dependency ignores abort', async () => {
  const failing = createAchievementSearch({references,registry:[],search:async () => {throw new Error('do not echo this error');}});
  const failure = await failing(parsed({query:'과학'}));
  assert.equal(failure.status,'search_unavailable');
  assert.ok(!JSON.stringify(failure).includes('do not echo'));
  const hanging = createAchievementSearch({references,registry:[],timeoutMs:50,search:() => new Promise(()=>{})});
  const started = performance.now();
  const timeout = await hanging(parsed({query:'과학'}));
  assert.equal(timeout.status,'search_unavailable');
  assert.ok(performance.now()-started < 1000);
  assert.ok(timeout.warnings.some(warning => warning.code === 'discovery_search_timeout'));
});

test('unavailable signing does not return unusable candidate refs or break legacy search', async () => {
  const search = createAchievementSearch({references:{issue(){throw new Error('missing key');}},registry:[],search:async input => output(input,[item()]),resolveResource:async value => ({resource:value,attachments:[file],warnings:[]})});
  const result = await search(parsed({query:'과학'}));
  assert.equal(result.status,'partial');
  assert.equal(result.results.length,0);
  assert.ok(result.warnings.some(warning => warning.code === 'reference_unavailable'));
});

test('query input forbids arbitrary URLs, paths, empty filters and overlong variants', () => {
  for (const input of [{},{query:'https://example.com/a'},{query:'C:\\secret.pdf'},{subject:'/tmp/file'},{query:' '},{query:'과학',url:'https://example.com'}]) assert.equal(searchAchievementInputSchema.safeParse(input).success,false);
  const variants = buildAchievementQueryVariants(parsed({query:'가'.repeat(300),grade:'중학교',subject:'과학'}));
  assert.ok(variants.every(value => value.length <= 300));
  assert.ok(variants.some(value => value.endsWith('평가기준')));
});

test('registry rejects unverified paths, warns stale entries and loads versioned config', () => {
  const configured = loadSourceRegistry(Date.parse('2026-09-18'));
  assert.equal(configured.entries.length,4);
  assert.deepEqual(configured.warnings,[]);
  const stale = {...configured.entries[0],checkedAt:'2020-01-01'};
  const inspected = inspectSourceRegistry([stale,{...stale,officialHost:'127.0.0.1'},{...stale,pathPattern:'/unverified'}],Date.parse('2026-09-18'));
  assert.equal(inspected.entries.length,1);
  assert.ok(inspected.warnings.some(warning => warning.code === 'registry_stale'));
  assert.equal(inspected.warnings.filter(warning => warning.code === 'registry_invalid').length,2);
});

test('resolver maps only official detail paths, strips arbitrary query params and matches IDs', async () => {
  const url = resourceDetailUrl({...resource,sourceUrl:`${resource.sourceUrl}&url=https://evil.invalid&token=secret`});
  assert.equal(url.hostname,'api.edunet.net');
  assert.equal(url.pathname,'/main/clssStdDt/getClssStdDtInfo/2516662');
  assert.deepEqual([...url.searchParams.keys()],['sbjtClsf','srvcClsf']);
  for (const sourceUrl of ['https://www.edunet.net.evil.invalid/clssStdDt/view/150/2516662','http://www.edunet.net/clssStdDt/view/150/2516662','https://user@www.edunet.net/clssStdDt/view/150/2516662','https://www.edunet.net/clssStdDt/view/150/999','https://www.edunet.net/unknown/2516662']) {
    assert.equal(resourceDetailUrl({...resource,sourceUrl}),undefined);
    const details = await resolveResource({...resource,sourceUrl},undefined,{fetchJson:async()=>{throw new Error('must not call');}});
    assert.equal(details.warnings[0].code,'detail_path_unverified');
  }
});

test('resolver returns trusted ID downloads, precise metadata, no source-provided URLs', async () => {
  const calls=[];
  const details = await resolveResource(resource,undefined,{fetchJson:async url=>{calls.push(url.href);return validMetadata();}});
  assert.equal(calls.length,1);
  assert.equal(details.attachments.length,1);
  assert.equal(details.attachments[0].url,file.url);
  assert.equal(details.attachments[0].byteSize,113952);
  assert.equal(details.attachments[0].declaredMimeType,undefined,'do not fabricate declared MIME from extension');
  assert.equal(details.attachments[0].format,'pdf');
  assert.match(details.resource.snippet,/평가기준 9과12-03/);
  assert.ok(!JSON.stringify(details).includes('attacker.invalid'));
});

test('resolver treats upstream status/errors and malformed envelope as unavailable', async () => {
  for(const fetchJson of [async()=>{throw new Error('HTTP 404');},async()=>{throw new Error('HTTP 403');},async()=>{throw new Error('HTTP 500');},async()=>({success:false}),async()=>({success:true,data:{}}),async()=>{const data=validMetadata();data.data.clssStdDtInfo.contsId=999;return data;}]) {
    const details=await resolveResource(resource,undefined,{fetchJson});
    assert.equal(details.warnings[0].code,'attachment_metadata_unavailable');
    assert.deepEqual(details.resource,resource);
    assert.deepEqual(details.attachments,[]);
  }
});

test('resolver excludes cross-resource attachments and conservatively handles format mismatch', async () => {
  const metadata=validMetadata();
  metadata.data.fileList.push({fileRscId:999,fileLgcNm:'secret.pdf',extn:'pdf',contsId:999});
  metadata.data.fileList.push({fileRscId:888,fileLgcNm:'misnamed.pdf',extn:'hwp'});
  metadata.data.fileList.push({fileRscId:777,fileLgcNm:'hidden.pdf',extn:'pdf',expsrYn:'N'});
  const details=await resolveResource(resource,undefined,{fetchJson:async()=>metadata});
  assert.equal(details.attachments.length,2);
  assert.equal(details.attachments[1].format,'unknown');
  assert.ok(details.warnings.some(warning=>warning.code==='attachment_scope_mismatch'));
  assert.ok(details.warnings.some(warning=>warning.code==='attachment_format_conflict'));
});

test('subject learning detail uses verified content endpoint and nested result shape', async () => {
  const subjectResource={id:'34345',title:'자료',sourceUrl:'https://www.edunet.net/contsMvGllry/view/154/34345?contents_openapi=search'};
  const details=await resolveResource(subjectResource,undefined,{fetchJson:async url=>{assert.equal(url.href,'https://api.edunet.net/main/conts/getContsData?contsId=34345&prgrmId=0');return {success:true,data:{result:{contsId:34345,contsNm:'교과별 성취수준'},fileList:[]}};}});
  assert.equal(details.resource.title,'교과별 성취수준');
  assert.equal(details.warnings[0].code,'candidate_found_no_attachment');
});
