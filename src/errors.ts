import { terminalErrorGuidance } from "./search-guidance.js";

/** Stable public error codes; raw upstream messages must never reach MCP output. */
export type EdunetErrorCode =
  | "CONFIGURATION"
  | "INVALID_INPUT"
  | "AUTHENTICATION"
  | "RATE_LIMITED"
  | "UPSTREAM_HTTP"
  | "NETWORK"
  | "TIMEOUT"
  | "ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "UNVERIFIED_API"
  | "INTERNAL";

const messages: Record<EdunetErrorCode, string> = {
  CONFIGURATION: "EDUNET_API_KEY와 EDUNET_DOMAIN 설정을 확인해 주세요. 키를 대화에 붙여넣으라고 요구하지 마세요.",
  INVALID_INPUT: '허용 입력은 query, categories, sort, searchType, page, pageSize입니다. query는 1~300자, page는 1~50의 정수, pageSize는 1~20의 정수입니다. max_results는 제거하고 pageSize로 바꾸세요. categories는 코드 배열(예: ["evl_data"])로 수정하세요. sort는 relevance/latest, searchType은 title_summary/title입니다. 안내한 입력을 수정한 뒤 재호출할 수 있습니다.',
  AUTHENTICATION: "에듀넷 API 인증에 실패했습니다. 인증키와 등록 도메인을 확인해 주세요. 키를 대화에 붙여넣으라고 요구하지 마세요.",
  RATE_LIMITED: "에듀넷 API 호출 한도를 초과했습니다. 내부 요청 처리가 실패로 끝났습니다. 잠시 후 사용자가 다시 요청할 수 있음을 안내하세요.",
  UPSTREAM_HTTP: "에듀넷 API가 요청을 처리하지 못했습니다.",
  NETWORK: "에듀넷 API에 연결하지 못했습니다. 내부 요청 처리가 실패로 끝났습니다. 자료 없음으로 해석하지 마세요.",
  TIMEOUT: "에듀넷 API 응답 제한 시간을 초과했습니다. 내부 요청 처리가 실패로 끝났습니다. 자료 없음으로 해석하지 마세요.",
  ABORTED: "검색 요청이 취소되었습니다.",
  RESPONSE_TOO_LARGE: "에듀넷 API 응답이 허용된 크기를 초과했습니다.",
  INVALID_RESPONSE: "에듀넷 API 응답을 해석하지 못했습니다.",
  UNVERIFIED_API: "실제 에듀넷 API 응답 검증이 아직 완료되지 않았습니다.",
  INTERNAL: "검색 처리 중 오류가 발생했습니다.",
};

function publicMessage(code: EdunetErrorCode): string {
  return code === "INVALID_INPUT" ? messages[code] : `${messages[code]} ${terminalErrorGuidance}`;
}

/** Only controlled messages are attached to this error; no URL, key, or body. */
export class EdunetError extends Error {
  readonly code: EdunetErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: EdunetErrorCode, options: { status?: number; retryable?: boolean } = {}) {
    super(publicMessage(code));
    this.name = "EdunetError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export function publicError(error: unknown): { code: EdunetErrorCode; message: string } {
  const code = error instanceof EdunetError ? error.code : "INTERNAL";
  return { code, message: publicMessage(code) };
}
