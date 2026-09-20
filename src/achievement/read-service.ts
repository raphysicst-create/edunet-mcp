import { createHash } from "node:crypto";
import type { AchievementConfig } from "./config.js";
import { readAchievementInputSchema, readAchievementResponseSchema, resourceIdentitySchema, workerResultSchema, type ReadAchievementInput, type ReadAchievementResponse, type ResourceDetails, type ResourceIdentity, type ResolvedAttachment, type WorkerResult } from "./contracts.js";
import { ReferenceCodec, ReferenceError } from "./references.js";
import { WorkerUnavailableError, type WorkerGateway } from "./gateway.js";
import { EdunetError } from "../errors.js";
import { MAX_DOWNLOAD_BYTES } from "../worker/safe-download.js";
import { matchesAchievementCode, normalizeAchievementCode } from "./code.js";

export interface ReadDependencies {references:ReferenceCodec;gateway:WorkerGateway;config:AchievementConfig;resolveResource:(resource:ResourceIdentity,signal?:AbortSignal)=>Promise<ResourceDetails>}
const identity = (resource:ResourceIdentity):string=>`${resource.id}|${resource.sourceUrl ?? ""}`;
const enabled = (format:string,config:AchievementConfig):boolean=>format==="pdf" ? config.pdfReadEnabled : format==="hwp" ? config.hwpReadEnabled : format==="hwpx" && config.hwpxReadEnabled;
const filtersKey = (input:ReadAchievementInput):string=>createHash("sha256").update(JSON.stringify([input.grade,input.subject,input.achievementStandardCode ? normalizeAchievementCode(input.achievementStandardCode) : undefined,input.levelLabel])).digest("hex");
async function cancellable<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  if(signal?.aborted) throw new EdunetError("ABORTED");
  if(!signal) return work();
  let abort:(()=>void)|undefined;
  try {
    const pending=work();
    const value=await Promise.race([pending,new Promise<never>((_,reject)=>{
      abort=()=>reject(new EdunetError("ABORTED"));
      if(signal.aborted) abort();else signal.addEventListener("abort",abort,{once:true});
    })]);
    if(signal.aborted) throw new EdunetError("ABORTED");
    return value;
  } finally {if(abort) signal.removeEventListener("abort",abort);}
}
function matches(record:WorkerResult["records"][number], input:ReadAchievementInput):boolean {
  for(const name of ["grade","subject"] as const) {
    if(input[name] && record[name]?.raw!==input[name] && record[name]?.normalized!==input[name]) return false;
  }
  if(input.achievementStandardCode && !matchesAchievementCode(record.achievementStandardCode,input.achievementStandardCode)) return false;
  return !input.levelLabel || record.achievementLevel?.rawLabel===input.levelLabel || record.achievementLevel?.normalizedLabel===input.levelLabel;
}
export function createAchievementReader(deps:ReadDependencies) {
  return async (rawInput:ReadAchievementInput,signal?:AbortSignal,mode:"achievement"|"resource"="achievement"):Promise<ReadAchievementResponse>=>{
    if(signal?.aborted) throw new EdunetError("ABORTED");
    const input=readAchievementInputSchema.parse(rawInput);
    const payload=deps.references.verify(input.achievementRef,"achievement");
    const resource=resourceIdentitySchema.parse(payload.resource);
    // Reject locally invalid references before spending any upstream metadata budget.
    const requestedAttachment=input.attachmentRef?deps.references.verify(input.attachmentRef,"attachment"):undefined;
    const requestedCursor=input.cursor?deps.references.verify(input.cursor,"cursor"):undefined;
    if(requestedAttachment && requestedAttachment.resourceId!==identity(resource) || requestedCursor && requestedCursor.resourceId!==identity(resource)) throw new ReferenceError();
    const resourceRef=deps.references.issue("resource",{resource});
    const base:ReadAchievementResponse={kind:"edunet_achievement_read",status:"metadata_only",source:{resourceRef,achievementRef:input.achievementRef,title:resource.title,...(resource.sourceUrl?{sourceUrl:resource.sourceUrl}:{}),sourceSystem:"edunet",retrievedAt:new Date().toISOString(),...(resource.snippet?{searchEvidence:[{quote:resource.snippet,location:{anchor:"metadata-snippet"}}]}:{})},records:[],warnings:[],visualContentInterpreted:false};
    let details:ResourceDetails;
    try {details=await cancellable(()=>deps.resolveResource(resource,signal),signal);}
    catch(error) {
      if(signal?.aborted || error instanceof EdunetError && error.code==="ABORTED") throw new EdunetError("ABORTED");
      return {...base,status:"source_unavailable",warnings:[{code:"SOURCE_UNAVAILABLE",message:"자료 상세·첨부 목록을 확인할 수 없습니다. 원문 링크를 확인하세요."}]};
    }
    base.warnings.push(...details.warnings);
    if(details.warnings.some(w=>["attachment_metadata_unavailable","attachment_metadata_timeout","detail_path_unverified"].includes(w.code))) return {...base,status:"source_unavailable"};
    base.source.title=details.resource.title;
    let listOffset=0;
    const attachmentListHash=createHash("sha256").update(JSON.stringify(details.attachments.map(item=>[item.id,item.fileName,item.format,item.byteSize,item.declaredMimeType,item.url]))).digest("hex");
    if(input.cursor && !input.attachmentRef) {
      const cursor=requestedCursor!;
      if(cursor.mode!=="attachments" || cursor.resourceId!==identity(resource) || cursor.attachmentListHash!==attachmentListHash || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset)<0) throw new ReferenceError();
      listOffset=Number(cursor.offset);
    }
    base.attachments=[];
    let listChars=0;
    for(const item of details.attachments.slice(listOffset,listOffset+Math.min(input.maxItems,20))) {
      const candidate={attachmentRef:deps.references.issue("attachment",{resourceId:identity(resource),attachmentId:item.id}),fileName:item.fileName,format:item.format,...(item.byteSize!==undefined?{byteSize:item.byteSize}:{}),readCapability:enabled(item.format,deps.config)?"possible" as const:"unsupported" as const,selectionReason:enabled(item.format,deps.config)?"지원 형식 후보입니다. 실제 바이트 검증과 파싱은 아직 하지 않았습니다.":"지원하지 않거나 기능 플래그가 꺼진 형식입니다."};
      if(item.byteSize!==undefined && item.byteSize>MAX_DOWNLOAD_BYTES) {
        candidate.readCapability="unsupported";
        candidate.selectionReason="DOWNLOAD_TOO_LARGE: 첨부 메타데이터의 크기가 10MiB 다운로드 제한을 초과합니다. 원문 링크에서 확인하세요.";
      }
      const cost=JSON.stringify(candidate).length;
      if(base.attachments.length && listChars+cost>12000) break;
      base.attachments.push(candidate);listChars+=cost;
    }
    const nextListOffset=listOffset+base.attachments.length;
    base.pagination={hasMore:nextListOffset<details.attachments.length,...(nextListOffset<details.attachments.length?{cursor:deps.references.issue("cursor",{mode:"attachments",resourceId:identity(resource),attachmentListHash,offset:nextListOffset})}:{})};
    let attachment:ResolvedAttachment|undefined,attachmentRef=input.attachmentRef;
    if(attachmentRef) {
      const scoped=requestedAttachment!;
      if(scoped.resourceId!==identity(resource)) throw new ReferenceError();
      attachment=details.attachments.find(item=>item.id===scoped.attachmentId);
      if(!attachment) throw new ReferenceError();
    } else {
      // Deliberately require MIME and a single total attachment, including unsupported siblings.
      const only=details.attachments[0];
      const expectedMime=only?.format==="pdf"?"application/pdf":only?.format==="hwp"?"application/x-hwp":only?.format==="hwpx"?"application/hwp+zip":"";
      if(deps.config.autoAttachmentSelectionEnabled && !details.warnings.length && !input.cursor && details.attachments.length===1 && only && enabled(only.format,deps.config) && only.declaredMimeType===expectedMime) {
        attachment=only;attachmentRef=base.attachments[0]!.attachmentRef;
      } else return {...base,status:details.attachments.length?"attachment_selection_required":"metadata_only",warnings:[...base.warnings,{code:details.attachments.length?"ATTACHMENT_SELECTION_REQUIRED":"CANDIDATE_FOUND_NO_ATTACHMENT",message:details.attachments.length?"목록에서 읽을 첨부를 선택하여 attachmentRef와 함께 호출하세요.":"자료는 확인했지만 공개 첨부를 찾지 못했습니다."}]};
    }
    base.attachment={attachmentRef:attachmentRef!,fileName:attachment.fileName,format:attachment.format,...(attachment.declaredMimeType?{declaredMimeType:attachment.declaredMimeType}:{}),downloadStatus:"blocked"};
    delete base.attachments;delete base.pagination;
    if(!enabled(attachment.format,deps.config)) return {...base,status:"unsupported_format",warnings:[...base.warnings,{code:"FORMAT_DISABLED",message:"이 형식은 검증·기능 플래그 정책에 따라 읽기가 비활성화되었습니다."}]};
    if(attachment.byteSize!==undefined && attachment.byteSize>MAX_DOWNLOAD_BYTES) return {...base,status:"source_unavailable",warnings:[...base.warnings,{code:"DOWNLOAD_TOO_LARGE",message:"첨부 크기가 10MiB 다운로드 제한을 초과합니다. 원문 링크에서 확인하세요."}]};
    let offset=0,rawOffset=0,rawCharOffset=0,prior:Record<string,unknown>|undefined;
    if(input.cursor) {
      prior=requestedCursor!;
      if(prior.resourceId!==identity(resource)||prior.attachmentId!==attachment.id||prior.mode!==mode||prior.filters!==filtersKey(input)||!Number.isSafeInteger(prior.offset)||Number(prior.offset)<0||!Number.isSafeInteger(prior.rawOffset)||Number(prior.rawOffset)<0) throw new ReferenceError();
      if(!Number.isSafeInteger(prior.rawCharOffset)||Number(prior.rawCharOffset)<0) throw new ReferenceError();
      offset=Number(prior.offset);rawOffset=Number(prior.rawOffset);rawCharOffset=Number(prior.rawCharOffset);
    }
    let result:WorkerResult;
    try {
      const codeOnly=mode==="achievement" && input.achievementStandardCode && !input.grade && !input.subject && !input.levelLabel;
      const handle=deps.references.issue("worker",{resource,attachmentId:attachment.id,attachmentRef,mode,
        ...(codeOnly?{structuredCodeOnly:true,achievementStandardCode:input.achievementStandardCode}:{}),
        formats:{pdf:deps.config.pdfReadEnabled,hwp:deps.config.hwpReadEnabled,hwpx:deps.config.hwpxReadEnabled}},60_000);
      result=workerResultSchema.parse(await cancellable(()=>deps.gateway.run(handle,signal),signal));
      if(result.status==="verified_extraction" && (!result.records.length || !result.contentHash || result.attachment?.downloadStatus!=="downloaded")) throw new WorkerUnavailableError("WORKER_INVALID_RESPONSE");
      if(result.attachment && (result.attachment.attachmentRef!==attachmentRef || result.attachment.fileName!==attachment.fileName || result.attachment.format!==attachment.format)) throw new WorkerUnavailableError("WORKER_INVALID_RESPONSE");
      const spans=result.records.flatMap(record=>[...record.evidence,...Object.values(record).flatMap(value=>value && typeof value==="object" && "evidence" in value && Array.isArray(value.evidence)?value.evidence:[])]);
      if(spans.some(span=>span.sourceHash && span.sourceHash!==result.contentHash)) throw new WorkerUnavailableError("WORKER_INVALID_RESPONSE");
    } catch(error) {
      if(signal?.aborted || (error instanceof EdunetError || error instanceof WorkerUnavailableError) && error.code==="ABORTED") throw new EdunetError("ABORTED");
      return {...base,status:error instanceof WorkerUnavailableError && error.code==="WORKER_TIMEOUT"?"parse_failed":"worker_unavailable",warnings:[...base.warnings,{code:error instanceof WorkerUnavailableError?error.code:"WORKER_UNAVAILABLE",message:"문서 Worker에서 읽기를 완료하지 못했습니다. 검색 기능과 원문 링크는 계속 사용할 수 있습니다."}]};
    }
    const {contentHash,...read}=result;
    const output:ReadAchievementResponse={...base,...read,warnings:[...base.warnings,...read.warnings],source:{...base.source,...(contentHash?{contentHash}:{})},records:[],rawBlocks:[]};
    if(prior && (prior.contentHash!==contentHash || prior.parserVersion!==result.attachment?.parserVersion || prior.profileVersion!==result.documentProfile?.profileVersion)) throw new ReferenceError();
    const matching=mode==="resource"?[]:result.records.filter(record=>matches(record,input));
    // The parser also recognizes bare curriculum standards. Those remain source
    // text, but cannot establish an achievement level without its description.
    // Accept older Workers while keeping the public label name unambiguous.
    const records=matching.filter(record=>record.achievementLevel?.rawLabel.trim() && record.description?.raw.trim())
      .map(record=>record.achievementLevel?.labelSystem==="abc"
        ? {...record,achievementLevel:{...record.achievementLevel,labelSystem:"alphabetic" as const}} : record);
    if(records.length<matching.length) output.warnings.push({code:"STANDARD_ONLY_RECORDS_OMITTED",message:"수준 라벨과 설명이 함께 없는 성취기준은 검증된 성취수준 레코드에서 제외했습니다. 성취수준이 없으면 원문 블록으로 제공합니다."});
    const hardOversize=records.some(record=>JSON.stringify(record).length>20000);
    if(mode==="resource" && result.status==="verified_extraction") output.status="metadata_only";
    if(mode==="achievement" && ["verified_extraction","metadata_only"].includes(result.status) && !records.length) {
      output.status="metadata_only";
      output.warnings.push({code:"NO_MATCHING_RECORDS",message:"요청 조건에 일치하는 검증된 레코드가 없습니다. 원문 블록에는 다른 코드·과목이 포함될 수 있습니다. 요청 코드와 원문 코드를 확인하고, 다른 코드를 요청 코드의 정정이나 동일 기준으로 대체하지 마세요."});
    }
    let chars=0;
    for(;offset<records.length && output.records.length<input.maxItems;offset++) {
      const record=records[offset]!;
      const length=JSON.stringify(record).length;
      if(length>20000) {output.warnings.push({code:"RECORD_EXCEEDS_HARD_LIMIT",message:"레코드와 전체 근거가 최대 20,000자 한도를 초과하여 구조화 반환에서 제외했습니다. 원문 블록을 이어 읽으세요."});continue;}
      if(chars+length>input.maxChars) {
        if(!output.records.length && length>input.maxChars) output.warnings.push({code:"RECORD_EXCEEDS_RESPONSE_LIMIT",message:"다음 레코드의 근거 전체가 maxChars를 초과합니다. maxChars를 높이거나 조건을 좁히세요."});
        break;
      }
      output.records.push(record);chars+=length;
    }
    // Raw previews are useful when structure cannot be verified. They have their own cursor offset.
    const blocks=mode==="achievement" && records.length && !hardOversize ? [] : result.rawBlocks ?? [];
    for(;rawOffset<blocks.length && output.rawBlocks!.length<input.maxItems;) {
      const block=blocks[rawOffset]!;
      if(rawCharOffset>block.text.length) throw new ReferenceError();
      const remaining=input.maxChars-chars;
      let take=block.text.length-rawCharOffset;
      const fragment=(count:number)=>({...block,text:block.text.slice(rawCharOffset,rawCharOffset+count),location:{...block.location,charStart:(block.location.charStart ?? 0)+rawCharOffset,charEnd:(block.location.charStart ?? 0)+rawCharOffset+count}});
      const minimum=take?String.fromCodePoint(block.text.codePointAt(rawCharOffset)!).length:0;
      if(JSON.stringify(fragment(minimum)).length>20000) {
        if(!output.warnings.some(warning=>warning.code==="RAW_BLOCK_EXCEEDS_HARD_LIMIT")) output.warnings.push({code:"RAW_BLOCK_EXCEEDS_HARD_LIMIT",message:"원문 블록의 위치 정보가 최대 20,000자 한도를 초과하여 해당 블록을 제외했습니다. 원문 링크를 확인하세요."});
        rawOffset++;rawCharOffset=0;continue;
      }
      let piece=fragment(take);
      if(JSON.stringify(piece).length>remaining) {
        let lo=0,hi=take;
        while(lo<hi) {const mid=Math.ceil((lo+hi)/2);if(JSON.stringify(fragment(mid)).length<=remaining) lo=mid;else hi=mid-1;}
        take=lo;
        if(take && /[\uD800-\uDBFF]/u.test(block.text[rawCharOffset+take-1]!)) take--;
        if(take===0) {
          if(!chars) output.warnings.push({code:"RAW_BLOCK_EXCEEDS_RESPONSE_LIMIT",message:"다음 원문 블록의 위치 정보가 maxChars를 초과합니다. maxChars를 높여 이어 읽으세요."});
          break;
        }
        piece=fragment(take);
      }
      output.rawBlocks!.push(piece);chars+=JSON.stringify(piece).length;
      rawCharOffset+=take;
      if(rawCharOffset>=block.text.length) {rawOffset++;rawCharOffset=0;} else break;
    }
    const hasMore=offset<records.length || rawOffset<blocks.length;
    if(mode==="achievement") {
      const labels=[...new Set(records.map(record=>record.achievementLevel!.rawLabel))];
      const boundedLabels=labels.filter(label=>label.length<=100).slice(0,20);
      const omittedRecordCount=records.filter(record=>JSON.stringify(record).length>20000).length;
      output.levelCoverage={scope:"attachment_and_filters",extractedLabels:boundedLabels,labelsTruncated:boundedLabels.length<labels.length,
        matchingRecordCount:records.length,returnedRecordCount:output.records.length,remainingRecordCount:records.length-offset,omittedRecordCount,
        allMatchingRecordsDelivered:records.length>0 && offset===records.length && omittedRecordCount===0,
        levelLabelFilterApplied:!!input.levelLabel,sourceCompleteness:"unverified"};
      if(offset<records.length) output.warnings.push({code:"LEVEL_RECORDS_REMAIN",message:"요청 조건에 맞는 성취수준 레코드가 뒤에 더 있습니다. 같은 첨부·필터와 cursor로 이어 읽고, 현재 응답의 라벨만으로 전체 수준 개수를 단정하지 마세요."});
      if(input.levelLabel) output.warnings.push({code:"LEVEL_LABEL_FILTER_APPLIED",message:"특정 수준 라벨로 제한된 결과입니다. 전체 수준이 필요하면 levelLabel과 cursor를 빼고 다시 읽으세요."});
      if(result.documentExtractionComplete!==true) output.warnings.push({code:"DOCUMENT_EXTRACTION_INCOMPLETE",message:"문서 텍스트 추출이 완료되지 않았습니다. 이어 읽기가 끝나도 원문의 모든 수준을 확인한 것으로 볼 수 없습니다."});
    }
    output.responseTruncated=hasMore;
    output.pagination={hasMore,...(hasMore?{cursor:deps.references.issue("cursor",{resourceId:identity(resource),attachmentId:attachment.id,mode,filters:filtersKey(input),offset,rawOffset,rawCharOffset,contentHash,parserVersion:result.attachment?.parserVersion,profileVersion:result.documentProfile?.profileVersion})}:{})};
    return readAchievementResponseSchema.parse(output);
  };
}
