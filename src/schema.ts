import * as z from "zod/v4";
import { categorySchema } from "./categories.js";
import { categorySelectionGuidance, inputHelp, missingSourceUrlGuidance } from "./search-guidance.js";

export const searchInputSchema = z.strictObject({
  query: z.string({ error: inputHelp.query }).trim().min(1, inputHelp.query).max(300, inputHelp.query).describe("핵심 주제를 포함한 검색어. 예: 중2 과학 광합성. 제안만 요청하거나 추가 검색을 금지하면 재검색하지 마세요. 그 외 0건이면 광합성을 유지하며 부가 표현을 줄이세요. 학년 적합성은 별도 확인이 필요합니다."),
  categories: z.array(categorySchema, { error: inputHelp.categories }).max(20, inputHelp.categories).default([]).describe(`카테고리 코드 배열이며 한글 이름은 허용되지 않습니다. ${categorySelectionGuidance}`),
  sort: z.enum(["relevance", "latest"], { error: inputHelp.sort }).default("relevance").describe("relevance: 정확도순, latest: 등록순"),
  searchType: z.enum(["title_summary", "title"], { error: inputHelp.searchType }).default("title_summary").describe("title_summary: 제목+요약, title: 제목"),
  page: z.number({ error: inputHelp.page }).int(inputHelp.page).min(1, inputHelp.page).max(50, inputHelp.page).default(1).describe("1~50, 기본 1. 조건 변경 시 1로 초기화. 다음 페이지는 hasNextPage=true일 때만 nextPage를 사용하세요."),
  pageSize: z.number({ error: inputHelp.pageSize }).int(inputHelp.pageSize).min(1, inputHelp.pageSize).max(20, inputHelp.pageSize).default(10).describe("1~20, 기본 10. 100은 허용되지 않습니다. 페이지 이동 시 같은 값을 유지하세요."),
}, { error: inputHelp.object });

export type SearchInput = z.infer<typeof searchInputSchema>;

export const searchOutputSchema = z.object({
  conditions: searchInputSchema.extend({ query: z.string().describe("적용한 검색어. 인증키와 일치하는 부분은 마스킹됩니다.") }),
  items: z.array(z.object({
    id: z.string().nullable(),
    title: z.string().nullable().describe("검색 결과의 제목. url이 null이면 링크를 붙이지 않고 일반 텍스트로 표시합니다."),
    content: z.string(),
    contentTruncated: z.boolean(),
    url: z.string().nullable().describe(`API가 제공한 출처 URL이며 방문 여부를 뜻하지 않습니다. ${missingSourceUrlGuidance}`),
    category: z.string().nullable(),
  })),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    returnedCount: z.number().int(),
    totalCount: z.number().int().nonnegative().nullable(),
    hasNextPage: z.boolean().nullable(),
    nextPage: z.number().int().nullable(),
    pageLimitReached: z.boolean(),
  }),
  source: z.literal("EDUNET_SEARCH_API"),
  originalRead: z.literal(false),
  attachmentsRead: z.literal(false),
  integrationStatus: z.literal("live_verified").describe("실제 API 검색과 로컬 MCP 연결 검증 완료. 원문·첨부파일 접근성이나 검색 품질 평가를 뜻하지 않습니다."),
  warnings: z.array(z.string()),
});

export type SearchOutput = z.infer<typeof searchOutputSchema>;
