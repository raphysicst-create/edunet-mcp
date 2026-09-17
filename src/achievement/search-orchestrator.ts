import { createHash } from "node:crypto";
import { searchEdunet } from "../client.js";
import { EdunetError } from "../errors.js";
import type { SearchInput, SearchOutput } from "../schema.js";
import { resolveResource, resourceDetailUrl } from "../resource/resolver.js";
import {
  searchAchievementInputSchema, type AchievementCandidate, type AchievementSearchResponse,
  type ResourceDetails, type ResourceIdentity, type SearchAchievementInput, type Warning,
} from "./contracts.js";
import { detailRegistryPath, inspectSourceRegistry, loadSourceRegistry, registryCollection, type AchievementSourceRegistryEntry } from "./source-registry.js";

export interface AchievementSearchDependencies {
  references: {issue(kind: "resource" | "achievement", data: Record<string, unknown>): string};
  search?: (input: SearchInput, signal?: AbortSignal) => Promise<SearchOutput>;
  resolveResource?: (resource: ResourceIdentity, signal?: AbortSignal) => Promise<ResourceDetails>;
  registry?: readonly AchievementSourceRegistryEntry[];
  now?: () => number;
  timeoutMs?: number;
}

const achievementTerms = /성취\s*(?:수준|기준)|평가\s*기준/g;
const codePattern = /\[?\d{1,2}[가-힣]{1,8}\d{2}-\d{2}\]?/;
const normalize = (value: string): string => value.normalize("NFC").replace(/\s+/g, " ").trim();
const clipQuery = (value: string): string => normalize(value).slice(0, 300);

export function buildAchievementQueryVariants(input: SearchAchievementInput): string[] {
  const original = clipQuery([input.query, input.grade, input.subject, input.achievementStandardCode].filter(Boolean).join(" "));
  const context = normalize(original.replace(achievementTerms, " ")) || original;
  const preferred = input.resourceType === "achievement_standard" ? "성취기준" : input.resourceType === "assessment_criteria" ? "평가기준" : "성취수준";
  // Keep the distinguishing context when appending a term to a near-limit query.
  const queries = [original, ...[preferred, "성취수준", "성취기준", "평가기준", "교과별 성취수준"].map(term => clipQuery(`${context.slice(0, 280)} ${term}`))];
  return [...new Set(queries)].slice(0, 5);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(new Error("discovery aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("discovery aborted"));
    signal.addEventListener("abort", abort, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function resourceFrom(item: SearchOutput["items"][number]): ResourceIdentity {
  const pathId = detailRegistryPath(item.url ?? undefined) ? new URL(item.url!).pathname.replace(/\/$/, "").split("/").at(-1) : undefined;
  const idFromPath = pathId && /^\d{1,20}$/.test(pathId) ? pathId : undefined;
  const upstreamId = item.id && item.id.length <= 300 ? item.id : undefined;
  return {
    id: upstreamId || idFromPath || `search:${createHash("sha256").update(`${item.id ?? ""}\n${item.url ?? ""}\n${item.title ?? ""}\n${item.content}`).digest("hex").slice(0, 32)}`,
    title: (item.title || "제목 미제공").slice(0, 2000),
    ...(item.url && item.url.length <= 4000 ? {sourceUrl: item.url} : {}),
    ...(item.content ? {snippet: item.content.slice(0, 2000)} : {}),
    ...(item.category ? {sourceType: item.category.slice(0, 200)} : {}),
  };
}

function identity(resource: ResourceIdentity): string {
  const detail = resourceDetailUrl(resource);
  if (detail) return `${detail.pathname}?${detail.searchParams.get("contsId") ?? ""}`;
  if (resource.sourceUrl) {
    try {
      const url = new URL(resource.sourceUrl);
      // Unknown/legacy paths can carry their actual document identity in the query.
      url.hash = "";
      url.searchParams.delete("contents_openapi");
      url.searchParams.sort();
      return `${resource.id}|${url.href}`;
    } catch { /* Use the API ID. */ }
  }
  return resource.id;
}

function utf8Prefix(value: string, limit: number): string {
  let bytes = 0, result = "";
  for (const point of value) {
    bytes += Buffer.byteLength(point);
    if (bytes > limit) break;
    result += point;
  }
  return result;
}

function referenceResource(resource: ResourceIdentity): ResourceIdentity {
  const compact = {...resource, title: utf8Prefix(resource.title, 600),
    ...(resource.snippet ? {snippet: utf8Prefix(resource.snippet, 1000)} : {}),
    ...(resource.sourceType ? {sourceType: utf8Prefix(resource.sourceType, 200)} : {}),
  };
  if (Buffer.byteLength(JSON.stringify(compact)) > 8000) throw new Error("reference provenance limit");
  return compact;
}

function score(resource: ResourceIdentity, details?: ResourceDetails): {score: number; reasons: string[]; text: string} {
  const filenames = details?.attachments.map(item => item.fileName).join(" ") ?? "";
  const text = normalize([resource.title, resource.snippet, filenames].filter(Boolean).join(" "));
  const reasons: string[] = [];
  let value = 0;
  if (/성취\s*수준/.test(text)) { value += 10; reasons.push("제목·발췌·첨부 파일명에 성취수준 표현이 있습니다."); }
  if (/성취\s*기준/.test(text)) { value += 7; reasons.push("제목·발췌·첨부 파일명에 성취기준 표현이 있습니다."); }
  if (/평가\s*기준/.test(text)) { value += 6; reasons.push("제목·발췌·첨부 파일명에 평가기준 표현이 있습니다."); }
  if (codePattern.test(text)) { value += 5; reasons.push("메타데이터에 성취기준 코드 형식의 문자열이 있습니다."); }
  if (/평가자료|평가기준|evl_data/.test(resource.sourceType ?? "")) { value += 2; reasons.push("공식 검색에서 평가자료 유형으로 분류되었습니다."); }
  if (details?.attachments.some(item => item.format === "pdf" || item.format === "hwp")) {
    value += 1; reasons.push("PDF 또는 HWP 첨부 목록을 확인했습니다. 원문 내용은 아직 읽지 않았습니다.");
  }
  return {score: value, reasons, text};
}

function metadataChecked(details: ResourceDetails): boolean {
  return !details.warnings.some(warning => ["detail_path_unverified", "attachment_metadata_unavailable", "attachment_metadata_timeout"].includes(warning.code));
}

function uniqueWarnings(warnings: Warning[]): Warning[] {
  return warnings.filter((warning, index) => warnings.findIndex(other => other.code === warning.code && other.message === warning.message) === index).slice(0, 40);
}

/** Independent metadata discovery; parser packages and attachment bytes never enter this path. */
export function createAchievementSearch(deps: AchievementSearchDependencies): (input: SearchAchievementInput, signal?: AbortSignal) => Promise<AchievementSearchResponse> {
  return async (unvalidated, externalSignal) => {
    const checkCancellation = (): void => { if (externalSignal?.aborted) throw new EdunetError("ABORTED"); };
    checkCancellation();
    const input = searchAchievementInputSchema.parse(unvalidated);
    const queryVariants = buildAchievementQueryVariants(input);
    const now = deps.now?.() ?? Date.now();
    const registry = deps.registry === undefined ? loadSourceRegistry(now) : inspectSourceRegistry(deps.registry, now);
    const warnings: Warning[] = [...registry.warnings];
    const coverage: AchievementSearchResponse["coverage"] = {
      officialApiQueried: false, queryVariantsTried: [], attachmentMetadataChecked: false, registryPathsChecked: [],
      limitation: "공식 검색 API와 검증된 상세·컬렉션 경로만 조회했습니다. 후보는 원문 검증 결과가 아니며 검색 누락 가능성이 있습니다. 페이지는 각 공식 질의의 같은 페이지를 합친 범위입니다.",
    };
    const budget = new AbortController();
    const milliseconds = Math.max(1, Math.min(deps.timeoutMs ?? 10000, 10000));
    const timer = setTimeout(() => budget.abort(), milliseconds);
    const signal = externalSignal ? AbortSignal.any([externalSignal, budget.signal]) : budget.signal;
    const searchPhase = new AbortController();
    const searchTimer = setTimeout(() => searchPhase.abort(), Math.max(1, Math.floor(milliseconds * 0.65)));
    const searchSignal = AbortSignal.any([signal, searchPhase.signal]);
    const search = deps.search ?? searchEdunet;
    const resolver = deps.resolveResource ?? ((resource: ResourceIdentity, requestSignal?: AbortSignal) => resolveResource(resource, requestSignal, deps.registry === undefined ? {} : {registry: deps.registry}));
    const resources = new Map<string, {resource: ResourceIdentity; achievementQuery: boolean; registry?: string}>();
    let successes = 0;
    let failed = false;
    let upstreamHasNext = false;
    let upstreamPaginationUnknown = false;
    try {
      const plans: {query: string; categories: SearchInput["categories"]; registryPath?: string}[] = queryVariants.map(query => ({query, categories: []}));
      const broadQuery = clipQuery(queryVariants[0]!.replace(achievementTerms, " ")) || queryVariants[0]!;
      for (const entry of registry.entries) {
        const collection = registryCollection(entry);
        if (collection) plans.push({query: broadQuery, categories: [collection], registryPath: entry.pathPattern});
      }
      const recordAttempt = (plan: typeof plans[number]): void => {
        coverage.officialApiQueried = true;
        if (!coverage.queryVariantsTried.includes(plan.query)) coverage.queryVariantsTried.push(plan.query);
        if (plan.registryPath && !coverage.registryPathsChecked.includes(plan.registryPath)) coverage.registryPathsChecked.push(plan.registryPath);
      };
      await Promise.all(plans.map(async plan => {
        if (searchSignal.aborted) return;
        try {
          const result = await abortable(search({query: plan.query, categories: plan.categories, sort: "relevance", searchType: "title_summary", page: input.page, pageSize: input.pageSize}, searchSignal), searchSignal);
          recordAttempt(plan);
          successes++;
          upstreamHasNext ||= result.pagination.hasNextPage === true;
          upstreamPaginationUnknown ||= result.pagination.hasNextPage === null;
          for (const item of result.items) {
            const resource = resourceFrom(item);
            if (item.url && !resource.sourceUrl) warnings.push({code: "source_link_limit", message: "API 출처 URL이 길이 한도를 초과하여 제외했습니다. 잘린 주소를 원문 링크로 제공하지 않습니다."});
            const key = identity(resource);
            const achievementQuery = /성취\s*(?:수준|기준)|평가\s*기준/.test(plan.query);
            const existing = resources.get(key);
            if (existing) { existing.achievementQuery ||= achievementQuery; continue; }
            resources.set(key, {resource, achievementQuery, ...(plan.registryPath ? {registry: plan.registryPath} : {})});
          }
        } catch (error) {
          checkCancellation();
          const configurationMissing = error !== null && typeof error === "object" && "code" in error && error.code === "CONFIGURATION";
          if (!configurationMissing) recordAttempt(plan);
          failed = true;
          warnings.push({code: configurationMissing ? "search_configuration_unavailable" : searchSignal.aborted ? "discovery_search_timeout" : "official_search_unavailable", message: "일부 공식 검색 질의를 완료하지 못했습니다. 성공한 조회 범위만 반환합니다."});
        }
      }));
      checkCancellation();
      clearTimeout(searchTimer);
      const priority = (candidate: {resource: ResourceIdentity; achievementQuery: boolean}): number => score(candidate.resource).score + (candidate.achievementQuery ? 2 : 0);
      const ranked = [...resources.values()].sort((a, b) => priority(b) - priority(a) || a.resource.id.localeCompare(b.resource.id));
      const inspected = ranked.slice(0, 20);
      const resolved = new Map<string, ResourceDetails>();
      let index = 0;
      await Promise.all(Array.from({length: Math.min(4, inspected.length)}, async () => {
        while (index < inspected.length && !signal.aborted) {
          const current = inspected[index++]!;
          const registryPath = resourceDetailUrl(current.resource) ? detailRegistryPath(current.resource.sourceUrl) : undefined;
          if (registryPath && registry.entries.some(entry => entry.pathPattern === registryPath) && !coverage.registryPathsChecked.includes(registryPath)) coverage.registryPathsChecked.push(registryPath);
          try {
            const details = await abortable(resolver(current.resource, signal), signal);
            // A dependency or upstream failure must not silently switch the selected resource.
            if (details.resource.id !== current.resource.id || details.resource.sourceUrl !== current.resource.sourceUrl) throw new Error("resource mismatch");
            resolved.set(identity(current.resource), details);
            if (metadataChecked(details)) coverage.attachmentMetadataChecked = true;
            else failed = true;
            warnings.push(...details.warnings);
          } catch {
            checkCancellation();
            failed = true;
            warnings.push({code: "attachment_metadata_unavailable", message: "일부 후보의 첨부를 확인하지 못했습니다. 검색 결과의 출처는 유지합니다."});
          }
        }
      }));
      checkCancellation();
      if (ranked.length > inspected.length) {
        failed = true;
        warnings.push({code: "candidate_metadata_limit", message: "요청 시간과 크기 제한으로 상위 20개 후보의 첨부 메타데이터만 조회했습니다."});
      }
      const candidates: {value: AchievementCandidate; score: number}[] = [];
      for (const current of inspected) {
        const details = resolved.get(identity(current.resource));
        const resource = details?.resource ?? current.resource;
        const rankedCandidate = score(resource, details);
        if (rankedCandidate.score < 2 && !current.achievementQuery) continue;
        const reason = rankedCandidate.reasons;
        if (current.achievementQuery) reason.push("성취 관련 질의의 공식 검색 결과에 포함되었습니다.");
        if (current.registry) reason.push(`검증된 컬렉션 경로 ${current.registry}에서 발견했습니다.`);
        reason.push("candidate_unverified: 원문 성취수준 레코드는 읽기 도구에서 확인해야 합니다.");
        const checked = details !== undefined && metadataChecked(details);
        const possible = details?.attachments.some(file => file.format === "pdf" || file.format === "hwp");
        const readCapability = !checked ? "unknown" : possible ? "possible" : details.attachments.length ? "unsupported" : "unknown";
        const hasHint = (hint: string | undefined): hint is string => !!hint && rankedCandidate.text.includes(hint);
        const codeHint = codePattern.exec(rankedCandidate.text)?.[0];
        try {
          const refResource = referenceResource(resource);
          const resourceRef = deps.references.issue("resource", {resource: refResource});
          const achievementRef = deps.references.issue("achievement", {resource: refResource});
          if (resourceRef.length > 16000 || achievementRef.length > 16000) throw new Error("reference length limit");
          candidates.push({score: rankedCandidate.score, value: {
            resourceRef, achievementRef,
            title: resource.title, ...(resource.snippet ? {snippet: resource.snippet} : {}), ...(resource.sourceUrl ? {sourceUrl: resource.sourceUrl} : {}),
            ...(resource.sourceType ? {sourceType: resource.sourceType} : {}),
            ...(hasHint(input.grade) ? {gradeHint: input.grade} : {}), ...(hasHint(input.subject) ? {subjectHint: input.subject} : {}),
            ...(codeHint ? {codeHint} : {}), ...(hasHint(input.levelLabel) ? {levelLabelHint: input.levelLabel} : {}),
            candidateReason: reason, readCapability,
          }});
        } catch {
          failed = true;
          warnings.push({code: "reference_unavailable", message: "일부 후보의 안전한 읽기 참조를 발급하지 못했습니다."});
        }
      }
      candidates.sort((a, b) => b.score - a.score || a.value.title.localeCompare(b.value.title, "ko"));
      const results: AchievementCandidate[] = [];
      let resultBytes = 0;
      for (const candidate of candidates) {
        const bytes = Buffer.byteLength(JSON.stringify(candidate.value));
        if (results.length >= input.pageSize || resultBytes + bytes > 96000) break;
        results.push(candidate.value);
        resultBytes += bytes;
      }
      const mergedOverflow = results.length < candidates.length || ranked.length > inspected.length;
      if (mergedOverflow) {
        failed = true;
        warnings.push({code: "candidate_response_limit", message: "결합한 후보가 반환 한도를 초과했습니다. 다음 공식 페이지는 생략된 후보를 복구하지 못하므로 nextPage를 발급하지 않습니다. 조건을 좁혀 다시 검색하세요."});
      }
      if (signal.aborted) {
        failed = true;
        warnings.push({code: "discovery_timeout", message: "성취수준 발견의 시간 예산 내에 완료한 범위만 반환합니다."});
      }
      const hasNext = upstreamHasNext && input.page < 50 && !mergedOverflow;
      const paginationUnknown = upstreamPaginationUnknown && !upstreamHasNext && !mergedOverflow && input.page < 50;
      if (paginationUnknown) warnings.push({code: "pagination_unknown", message: "공식 API가 전체 건수를 제공하지 않아 다음 페이지 존재 여부를 확인할 수 없습니다."});
      return {
        kind: "edunet_achievement_search",
        status: successes === 0 ? "search_unavailable" : results.length === 0 ? (failed ? "partial" : "not_found_in_official_index") : failed ? "partial" : "ok",
        results, ...(!paginationUnknown ? {pagination: {page: input.page, pageSize: input.pageSize, hasNext, ...(hasNext ? {nextPage: input.page + 1} : {})}} : {}),
        coverage, warnings: uniqueWarnings(warnings),
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(searchTimer);
      budget.abort();
      searchPhase.abort();
    }
  };
}
