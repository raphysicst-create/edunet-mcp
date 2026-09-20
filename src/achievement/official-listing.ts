import { safeBoardListing } from "../worker/safe-download.js";
import type { ResourceIdentity, SearchAchievementInput } from "./contracts.js";

export const BOARD_LIST_PATH = "/main/cmnBoard/getCmnBoardPstList";
export interface BoardPage {resources: ResourceIdentity[]; hasNext: boolean; keyword: string; school?: string; keywordRelaxed?: boolean}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const clean = (value: unknown): string => typeof value === "string" ? value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000) : "";
const schools: Record<string, string> = {"3": "초등학교", "4": "중학교", "5": "중·고등학교", "58": "고등학교"};
const codeSubjects: Record<string, string> = {국: "국어", 수: "수학", 영: "영어", 사: "사회", 역: "역사", 과: "과학", 도: "도덕", 체: "체육", 음: "음악", 미: "미술", 정: "정보", 실: "실과", 기가: "기술가정", 한: "한문", 공국:"국어",공수:"수학",공영:"영어",한사:"역사",통사:"사회",통과:"과학"};

/** Code decoding supplies search hints only; it never creates extracted fields. */
export function listingConditions(input: SearchAchievementInput): {keyword: string; school?: string} {
  const text = [input.query, input.grade, input.subject, input.achievementStandardCode].filter(Boolean).join(" ").normalize("NFC");
  const code = /(?:^|[\s\[])([1-9]|1[0-2])([가-힣]{1,8})(?:\([가-힣]{1,8}\))?(?:[1-9]-)?\d{2}-\d{2}(?:\]|\s|$)/.exec(text);
  const school = /초등|\(초\)/.test(text) ? "3" : /중학교|중학|\(중\)/.test(text) ? "4" : /고등|\(고\)/.test(text) ? "58"
    : code ? Number(code[1]) <= 6 ? "3" : Number(code[1]) === 9 ? "4" : Number(code[1]) >= 10 ? "58" : undefined : undefined;
  const requestedSubject=input.subject?.trim();
  const subject = /기술[·ㆍ\s]?가정|즐거운 생활|슬기로운 생활|바른 생활|건강한 생활|한국사|물리학|생명과학|지구과학|통합과학|통합사회|국어|수학|영어|과학|사회|도덕|윤리|역사|체육|음악|미술|정보|실과|한문|화학|보건|환경|진로와\s*직업/.exec(requestedSubject || text)?.[0] || requestedSubject || (code ? codeSubjects[code[2]!] : undefined);
  // Common-course documents use subject-family titles, not course suffixes.
  const titleSubject=subject==='한국사'?'역사':subject==='통합과학'?'과학':subject==='통합사회'?'사회':subject?.replace(/진로와\s+직업/,'진로와직업');
  // Elementary titles group subjects by grade band instead of naming a subject.
  // Keep the school filter and bounded paging; a title keyword would exclude them.
  const groupedElementary = school === "3" && /^(국어|수학|영어|사회|과학|도덕|체육|음악|미술|실과|바른 생활|슬기로운 생활|즐거운 생활|건강한 생활)$/.test(subject ?? "");
  const keyword = groupedElementary ? "" : titleSubject?.replace(/기술[·ㆍ\s]가정/, "기술가정") || (code ? "" : (input.query ?? "").replace(/성취\s*(수준|기준)|평가\s*기준|초등학교|중학교|고등학교|자료|찾아\s*줘|알려\s*줘|보여\s*줘|\?|\./g, " ").trim());
  return {keyword: keyword.slice(0, 100), ...(school ? {school} : {})};
}

export function metadataRelevance(resource: ResourceIdentity, input: SearchAchievementInput): number {
  const conditions = listingConditions(input);
  const text = `${resource.title} ${resource.snippet ?? ""}`;
  let score = 0;
  if (conditions.keyword && text.includes(conditions.keyword)) score += 20;
  if (conditions.school) {
    const name = schools[conditions.school]!;
    const compact = conditions.school === "3" ? "초" : conditions.school === "4" ? "중" : "고";
    if (text.includes(name) || text.includes(`(${compact})`)) score += 20;
    else if (/초등학교|중학교|고등학교|\([초중고]\)/.test(text)) score -= 25;
  }
  // Preserve distinguishing title words, including elective subjects, without adding them as evidence.
  for (const token of new Set((input.query ?? "").split(/[\s()[\],]+/).filter(t => t.length >= 2))) {
    if (resource.title.includes(token)) score += 2;
  }
  return score;
}

export async function listOfficialAchievements(input: SearchAchievementInput, signal?: AbortSignal,
  fetchPage: typeof safeBoardListing = safeBoardListing): Promise<BoardPage> {
  let conditions = listingConditions(input), keywordRelaxed=false;
  const readPage=async():Promise<{data:ObjectValue;paging:ObjectValue}>=>{
    const payload=object(await fetchPage({page:input.page,pageSize:input.pageSize,...conditions},signal?{signal}:{}));
    const data=object(payload.data),paging=object(data.pagingProperty);
    if(payload.success!==true || !Array.isArray(data.list) || data.list.length>input.pageSize
      || paging.currentPage!==input.page || paging.maxResults!==input.pageSize
      || !Number.isSafeInteger(paging.countItem) || Number(paging.countItem)<0
      || data.list.length>Math.max(0,Number(paging.countItem)-(input.page-1)*input.pageSize)) throw new Error("invalid board response");
    return {data,paging};
  };
  let {data,paging}=await readPage();
  // A course name may only occur inside a subject collection. Relax exactly once
  // on a validated zero-total result, keeping school, page, size and time budget.
  if(conditions.school && conditions.keyword && paging.countItem===0){
    conditions={...conditions,keyword:""};keywordRelaxed=true;
    ({data,paging}=await readPage());
  }
  const resources: ResourceIdentity[] = [];
  for (const raw of data.list as unknown[]) {
    const row = object(raw), id = String(row.pstId ?? ""), title = clean(row.ttl);
    if (!/^\d{1,20}$/.test(id) || !title || String(row.bbsId) !== "19" || row.delYn !== "N"
      || row.secrYn === "Y" || row.shtotYn === "Y" || row.tmprStrgYn === "Y") throw new Error("invalid board row");
    const fields = typeof row.fieldVal === "string" ? row.fieldVal : "";
    const school = /(?:^|,)2:(3|4|5|58):schoolGradeSe:Y(?:,|$)/.exec(fields)?.[1];
    if (conditions.school && school !== conditions.school) throw new Error("board filter mismatch");
    resources.push({id, title, sourceUrl: `https://www.edunet.net/cmnBoard/view/57/${id}`,
      sourceType: "achievement_level", snippet: [school ? schools[school] : "", clean(row.cn)].filter(Boolean).join(" ").slice(0, 2000)});
  }
  return {resources, hasNext: input.page * input.pageSize < Number(paging.countItem), ...conditions,...(keywordRelaxed?{keywordRelaxed:true}:{})};
}
