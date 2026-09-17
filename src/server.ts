import { McpServer } from "@modelcontextprotocol/server";
import { searchEdunet } from "./client.js";
import { publicError } from "./errors.js";
import { createLogger } from "./logger.js";
import { searchInputSchema, searchOutputSchema } from "./schema.js";
import { missingSourceUrlGuidance, searchDescription, searchInstructions } from "./search-guidance.js";

/** Trusted dependency injection for offline evaluation; never supplied by a tool caller. */
export function createServer(search = searchEdunet, options: {
  errorFormatter?: (error: unknown) => { code: string; message: string; meta?: Record<string, unknown> };
} = {}): McpServer {
  const logger = createLogger();
  const server = new McpServer({ name: "edunet-mcp", version: "1.0.0-rc.1" }, {
    instructions: searchInstructions,
  });
  server.registerTool("search_edunet", {
    title: "에듀넷 교육자료 검색",
    description: searchDescription,
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input, context) => {
    try {
      const result = await search(input, context.mcpReq.signal);
      const p = result.pagination;
      const total = p.totalCount === null ? "전체 건수 미제공" : `전체 ${p.totalCount}건`;
      const next = p.pageLimitReached ? "도구 페이지 한도(50)에 도달했습니다. 이후 페이지를 호출하지 마세요."
        : p.hasNextPage === null ? "다음 페이지 존재 여부 미확인. 자동 페이지 이동을 멈추세요."
        : p.hasNextPage ? `다음 페이지 ${p.nextPage}. 추가 결과가 필요할 때만 같은 조건으로 조회하세요.`
        : "다음 페이지 없음. 같은 조건의 이후 페이지를 호출하지 마세요.";
      const action = p.totalCount === 0
        ? "해당 조건에서 0건입니다. 사용자가 검색어 개선 제안만 요청했거나 추가 검색을 금지하면 재검색 없이 결과 설명과 검색어 제안으로 종료하세요. 이 요청이 자동 재검색 안내보다 우선합니다. 그렇지 않으면 핵심 주제와 명시한 필터를 유지하며 부가 검색어를 줄여 1페이지부터 검색하세요(자동 수정 최대 2회). 학년·과목 적합성은 별도 확인이 필요합니다."
        : p.returnedCount > 0 ? "요청에 답할 관련 자료를 확보했으면 정리하고 종료하세요. 같은 검색을 반복하지 마세요."
        : "현재 페이지에 반환된 자료가 없습니다. 이를 전체 자료 부재로 일반화하지 마세요.";
      const sourceGuidance = result.items.some(item => item.url === null) ? ` ${missingSourceUrlGuidance}` : "";
      return { structuredContent: result, content: [{ type: "text", text: `${total}, ${p.page}페이지 ${p.returnedCount}건. ${next} ${action}${sourceGuidance}` }] };
    } catch (error) {
      const safe = (options.errorFormatter ?? publicError)(error);
      logger.warn("search_failed", { code: safe.code });
      return { isError: true, _meta: { ...("meta" in safe && safe.meta ? safe.meta : {}), "edunet/errorCode": safe.code }, content: [{ type: "text", text: `${safe.code}: ${safe.message}` }] };
    }
  });
  return server;
}
