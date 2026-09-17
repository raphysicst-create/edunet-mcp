import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { ReferenceCodec } from '../dist/achievement/references.js';

// Anonymous, read-only public-document smoke test; NOT discovery recall or education quality validation.
const secret=randomBytes(32).toString('hex');
const references=new ReferenceCodec(secret);
const resource={id:'2516662',title:'광합성 산물의 저장과 이용',sourceUrl:'https://www.edunet.net/clssStdDt/view/150/2516662?sbjtClsf=77433&srvcClsf=59599&contents_openapi=search'};
const config={searchEnabled:true,pdfReadEnabled:true,hwpReadEnabled:true,hwpxReadEnabled:false,resourceReadEnabled:false,autoAttachmentSelectionEnabled:false,referenceSecret:secret};
const server=createServer(undefined,{achievement:{config,references}});
const client=new Client({name:'achievement-public-verification',version:'1'});
const [ct,st]=InMemoryTransport.createLinkedPair();
try {
  await server.connect(st);await client.connect(ct);
  const achievementRef=references.issue('achievement',{resource});
  const listed=await client.callTool({name:'read_edunet_achievement',arguments:{achievementRef}});
  assert.equal(listed.isError,undefined);assert.equal(listed.structuredContent.status,'attachment_selection_required');
  const summaries=[];
  for(const format of ['pdf','hwp']) {
    const attachment=listed.structuredContent.attachments.find(item=>item.format===format);
    assert.ok(attachment,`public ${format} attachment present`);
    const start=performance.now();
    const result=await client.callTool({name:'read_edunet_achievement',arguments:{achievementRef,attachmentRef:attachment.attachmentRef,maxChars:20000,maxItems:100}});
    assert.equal(result.isError,undefined);
    const read=result.structuredContent;
    assert.ok(['metadata_only','verified_extraction','no_text'].includes(read.status),JSON.stringify({status:read.status,warnings:read.warnings}));
    assert.equal(read.attachment.downloadStatus,'downloaded');assert.equal(read.attachment.format,format);assert.ok(read.source.contentHash);
    summaries.push({format,status:read.status,parser:read.attachment.parserName,version:read.attachment.parserVersion,bytes:read.attachment.byteSize,records:read.records.length,rawBlocks:read.rawBlocks?.length ?? 0,documentExtractionComplete:read.documentExtractionComplete,hasMore:read.pagination?.hasMore ?? false,elapsedMs:Math.round(performance.now()-start),warnings:read.warnings.map(w=>w.code)});
  }
  console.log(JSON.stringify({kind:'public_document_smoke',resourceId:resource.id,checkedAt:new Date().toISOString(),educationalQualityValidated:false,results:summaries},null,2));
} finally {await client.close();await server.close();}
