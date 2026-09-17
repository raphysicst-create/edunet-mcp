import { EdunetError } from "./errors.js";
import type { Logger } from "./logger.js";

export interface HttpResponse {
  readonly body: Uint8Array;
  readonly headers: Headers;
  readonly status: number;
}

export interface HttpOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
  /** Injectable lower limits for deterministic local verification. */
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new EdunetError("INVALID_INPUT");
  return Math.min(Math.floor(value), fallback);
}

function networkError(error: unknown): EdunetError {
  const candidate = error as { code?: string; cause?: { code?: string }; message?: string } | undefined;
  const code = candidate?.cause?.code ?? candidate?.code;
  const transient = code !== undefined
    ? TRANSIENT_CODES.has(code)
    : error instanceof TypeError && /fetch failed|terminated|network/i.test(candidate?.message ?? "");
  return new EdunetError("NETWORK", { retryable: transient });
}

function abortError(signal: AbortSignal): EdunetError {
  return signal.reason instanceof EdunetError ? signal.reason : new EdunetError("ABORTED");
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(abortError(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBounded(response: Response, signal: AbortSignal, maximum: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    void response.body?.cancel().catch(() => {});
    throw new EdunetError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    for (;;) {
      const chunk = await raceAbort(reader.read(), signal);
      if (chunk.done) { completed = true; break; }
      size += chunk.value.byteLength;
      if (size > maximum) throw new EdunetError("RESPONSE_TOO_LARGE");
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceAbort(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function retryDelay(header: string | null, attempt: number): number {
  const fallback = 250 * 2 ** attempt;
  if (!header) return fallback;
  const seconds = Number(header);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(requested) ? Math.max(fallback, requested) : fallback;
}

/** GET raw response bytes. Endpoint selection and text decoding belong to the API adapter. */
export async function requestBytes(url: string | URL, options: HttpOptions = {}): Promise<HttpResponse> {
  let target: URL;
  try { target = new URL(url); } catch { throw new EdunetError("INVALID_INPUT"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new EdunetError("INVALID_INPUT");
  }
  const attemptMs = limit(options.timeoutMs, 15_000);
  const totalMs = limit(options.totalTimeoutMs, 45_000);
  const maximum = limit(options.maxResponseBytes, 5 * 1024 * 1024);
  const retries = options.maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new EdunetError("INVALID_INPUT");
  const totalController = new AbortController();
  const cancel = (): void => { totalController.abort(new EdunetError("ABORTED")); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const totalTimer = setTimeout(() => totalController.abort(new EdunetError("TIMEOUT")), totalMs);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (totalController.signal.aborted) throw abortError(totalController.signal);
      const attemptController = new AbortController();
      const combined = AbortSignal.any([totalController.signal, attemptController.signal]);
      const attemptTimer = setTimeout(() => {
        attemptController.abort(new EdunetError("TIMEOUT", { retryable: true }));
      }, attemptMs);
      let nextDelay = 250 * 2 ** attempt;
      try {
        const response = await raceAbort(fetchImpl(target, {
          method: "GET", redirect: "manual", signal: combined,
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        }), combined);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          nextDelay = retryDelay(response.headers.get("retry-after"), attempt);
          const code = response.status === 401 || response.status === 403 ? "AUTHENTICATION"
            : response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP";
          throw new EdunetError(code, { status: response.status, retryable: RETRYABLE_STATUSES.has(response.status) });
        }
        const body = await readBounded(response, combined, maximum);
        if (combined.aborted) throw abortError(combined);
        options.logger?.debug("http_success", { attempt: attempt + 1, status: response.status, bytes: body.byteLength });
        return { body, headers: response.headers, status: response.status };
      } catch (error) {
        const safe = combined.aborted ? abortError(combined) : error instanceof EdunetError ? error : networkError(error);
        options.logger?.warn("http_failure", { attempt: attempt + 1, code: safe.code, status: safe.status });
        if (totalController.signal.aborted) throw abortError(totalController.signal);
        if (!safe.retryable || attempt === retries) throw safe;
      } finally {
        clearTimeout(attemptTimer);
      }
      // A long Retry-After consumes the remaining total budget instead of retrying early.
      await delay(Math.min(nextDelay, totalMs), totalController.signal);
    }
    throw new EdunetError("INTERNAL");
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
