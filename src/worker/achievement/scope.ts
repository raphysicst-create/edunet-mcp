import type {WorkerResult} from "../../achievement/contracts.js";
import {matchesAchievementCode} from "../../achievement/code.js";

/** Scope a signed code-only request before IPC, without increasing output limits. */
export function scopeCodeResult(result:WorkerResult,job:Record<string,unknown>):void {
  if(job.mode!=="achievement" || job.structuredCodeOnly!==true
    || typeof job.achievementStandardCode!=="string" || !job.achievementStandardCode || job.achievementStandardCode.length>200) return;
  const code=job.achievementStandardCode;
  const matching=result.records.filter(record=>matchesAchievementCode(record.achievementStandardCode,code));
  result.records=matching.filter(record=>record.achievementLevel?.rawLabel.trim() && record.description?.raw.trim());
  if(!result.records.length && result.status==="verified_extraction") result.status="metadata_only";
  if(result.records.length<matching.length) result.warnings.push({code:"STANDARD_ONLY_RECORDS_OMITTED",message:"수준 라벨과 설명이 함께 없는 성취기준은 검증된 성취수준 레코드에서 제외했습니다."});
  // The main reader does not use raw fallback for complete, in-budget levels.
  // Keep it for no matches, oversized records, and every unscoped request.
  if(result.records.length && result.records.every(record=>JSON.stringify(record).length<=20000)) result.rawBlocks=[];
}
