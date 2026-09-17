import { loadConfig, type EdunetConfig } from "./config.js";
import { EdunetError } from "./errors.js";
import { requestBytes, type HttpOptions } from "./http.js";
import { createLogger, redact } from "./logger.js";
import { parseEdunetResponse } from "./response.js";
import { searchInputSchema, searchOutputSchema, type SearchInput, type SearchOutput } from "./schema.js";
import { missingSourceUrlGuidance } from "./search-guidance.js";

export const EDUNET_SEARCH_ENDPOINT = "https://api.edunet.net/search/searchApi/search";

export function buildSearchUrl(input: SearchInput, config: EdunetConfig): URL {
  const url = new URL(EDUNET_SEARCH_ENDPOINT);
  url.search = new URLSearchParams({
    kwd: input.query,
    collection: input.categories.length === 0 ? "total" : input.categories.join(","),
    sort: input.sort === "latest" ? "d" : "r",
    searchType: input.searchType === "title" ? "title" : "all",
    pageNum: String(input.page),
    pageSize: String(input.pageSize),
    sno: config.apiKey,
    svc_version: "4.5",
    svc_domain: config.domain,
  }).toString();
  return url;
}

export interface SearchDependencies {
  config?: EdunetConfig;
  http?: HttpOptions;
}

/** The third argument is dependency injection for local verification, never a tool input. */
export async function searchEdunet(input: SearchInput, signal?: AbortSignal, deps: SearchDependencies = {}): Promise<SearchOutput> {
  const validated = searchInputSchema.safeParse(input);
  if (!validated.success) throw new EdunetError("INVALID_INPUT");
  const conditions = validated.data;
  conditions.categories = [...new Set(conditions.categories)];
  if (conditions.categories.includes("total")) conditions.categories = ["total"];
  const config = deps.config ?? loadConfig();
  const logger = createLogger({ secrets: [config.apiKey] });
  const response = await requestBytes(buildSearchUrl(conditions, config), {
    ...deps.http, logger, ...(signal ? { signal } : {}),
  });
  const parsed = parseEdunetResponse(response.body, response.headers, [config.apiKey]);
  // An upstream response must not be able to echo the credential into MCP output.
  const items = parsed.items.slice(0, conditions.pageSize).map(item => ({
    ...item,
    id: item.id === null ? null : redact(item.id, [config.apiKey]),
    title: item.title === null ? null : redact(item.title, [config.apiKey]),
    content: Array.from(redact(item.content, [config.apiKey])).slice(0, 500).join(""),
    contentTruncated: item.contentTruncated || Array.from(redact(item.content, [config.apiKey])).length > 500,
    category: item.category === null ? null : redact(item.category, [config.apiKey]),
    url: item.url !== null && redact(item.url, [config.apiKey]) === item.url ? item.url : null,
  }));
  const totalCount = parsed.totalCount;
  const hasNextPage = totalCount === null ? null : conditions.page * conditions.pageSize < totalCount;
  const pageLimitReached = conditions.page === 50;
  const warnings = ["검색 결과 메타데이터와 발췌만 제공합니다. 상세 원문과 첨부파일은 읽지 않았습니다."];
  if (items.some(item => item.url === null)) warnings.push(missingSourceUrlGuidance);
  if (totalCount === null) warnings.push("API가 전체 건수를 제공하지 않아 다음 페이지 존재 여부도 확인할 수 없습니다.");
  if (parsed.items.length > conditions.pageSize) warnings.push("API가 요청한 페이지 크기보다 많은 자료를 반환하여 요청 크기까지만 표시했습니다.");
  return searchOutputSchema.parse({
    conditions: { ...conditions, query: redact(conditions.query, [config.apiKey]) }, items,
    pagination: {
      page: conditions.page, pageSize: conditions.pageSize, returnedCount: items.length,
      totalCount, hasNextPage,
      nextPage: hasNextPage === true && !pageLimitReached ? conditions.page + 1 : null,
      pageLimitReached,
    },
    source: "EDUNET_SEARCH_API", originalRead: false, attachmentsRead: false,
    integrationStatus: "live_verified", warnings,
  });
}
