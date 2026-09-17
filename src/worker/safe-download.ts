import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { DownloadError } from "./errors.js";

export { DownloadError } from "./errors.js";
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Trusted code/test injection only; never populate this object from MCP input. */
  dependencies?: {
    lookup?: (hostname: string) => Promise<LookupAddress[]>;
    request?: typeof request;
  };
  /** May only lower the production bounds. */
  maxBytes?: number;
  maxDecodedBytes?: number;
  timeoutMs?: number;
}

interface RequestContext {
  signal: AbortSignal;
  options: DownloadOptions;
  maxBytes: number;
  maxDecodedBytes: number;
  retries: { remaining: number };
}

type Purpose = "metadata" | "document";

/** Positive public-address policy; IPv6 transition, mapped and special-use ranges are denied. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const words = expandIpv6(address);
  // Only ordinary global unicast 2000::/3. This excludes loopback, ULA,
  // link-local, multicast, mapped IPv4, NAT64 and discard prefixes.
  return (words[0]! & 0xe000) === 0x2000
    && !(words[0] === 0x2001 && words[1]! < 0x200) // protocol assignments (Teredo etc.)
    && !(words[0] === 0x2001 && words[1] === 0xdb8) // documentation
    && words[0] !== 0x2002 // 6to4 can embed private IPv4
    && !(words[0] === 0x3fff && words[1]! <= 0xfff); // documentation 3fff::/20
}

function expandIpv6(address: string): number[] {
  const sides = address.toLowerCase().split("::");
  const left = sides[0] ? sides[0].split(":").map((word) => parseInt(word, 16)) : [];
  const right = sides[1] ? sides[1].split(":").map((word) => parseInt(word, 16)) : [];
  return sides.length === 1 ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function canonicalAddress(address: string): string {
  return isIP(address) === 6 ? expandIpv6(address).join(":") : address;
}

/** Paths verified from EDUNET's public bundle/API on 2026-09-18; new families fail closed. */
export function validateDownloadUrl(value: string | URL, purpose: Purpose = "document"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DownloadError("DOWNLOAD_BLOCKED"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash
    || /[\\\x00-\x20]/.test(String(value))) throw new DownloadError("DOWNLOAD_BLOCKED");
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new DownloadError("DOWNLOAD_BLOCKED"); }
  if (/[\\\x00-\x1f\x7f]/.test(path) || path.includes("%")
    || path.split("/").some((part) => part === "." || part === "..")) throw new DownloadError("DOWNLOAD_BLOCKED");
  const allowed = purpose === "metadata"
    ? url.hostname === "api.edunet.net" && (/^\/main\/(?:clssStdDt\/getClssStdDtInfo|fileRsc\/downloadFile)\/\d{1,20}$/.test(path)
      || path === "/main/conts/getContsData")
    : ["educon.edunet.net", "educdn.edunet.net", "edunet-data.kr.object.gov-ncloudstorage.com", "edunet-vod.kr.object.gov-ncloudstorage.com"].includes(url.hostname)
      && /^\/(?:CNEDU\/MANUAL\/clssStdDt|KEDNCM\/2022NEWEDU)\/(?:[^/]+\/)*[^/]+\.(?:pdf|hwp|hwpx)$/i.test(path);
  if (!allowed) throw new DownloadError("DOWNLOAD_BLOCKED");
  return url;
}

function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new DownloadError("DOWNLOAD_BLOCKED");
  return value;
}

async function withinBudget<T>(options: DownloadOptions, work: (context: RequestContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const maxBytes = bound(options.maxBytes, MAX_DOWNLOAD_BYTES);
  const maxDecodedBytes = bound(options.maxDecodedBytes, MAX_DOWNLOAD_BYTES);
  const timer = setTimeout(() => controller.abort(), bound(options.timeoutMs, DOWNLOAD_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    return await work({ signal, options, maxBytes, maxDecodedBytes, retries: { remaining: 1 } });
  } catch (error) {
    if (options.signal?.aborted) throw new DownloadError("DOWNLOAD_ABORTED");
    if (controller.signal.aborted) throw new DownloadError("DOWNLOAD_TIMEOUT");
    throw sanitize(error);
  } finally { clearTimeout(timer); }
}

function sanitize(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return new DownloadError("DOWNLOAD_FAILED", ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DownloadError("DOWNLOAD_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function pinnedRequest(url: URL, context: RequestContext): Promise<IncomingMessage> {
  const addresses = await abortable((context.options.dependencies?.lookup ?? ((hostname) => lookup(hostname, { all: true })))(url.hostname), context.signal);
  context.signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    throw new DownloadError("DOWNLOAD_BLOCKED");
  }
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  return new Promise((resolve, reject) => {
    const send = context.options.dependencies?.request ?? request;
    const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
      method: "GET", agent: false, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, signal: context.signal,
      maxHeaderSize: 16 * 1024,
      headers: { "accept-encoding": "identity", "user-agent": "edunet-mcp/1.0" },
      // No second DNS resolution between validation and the socket connection.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    };
    const req = send(url, requestOptions, (response) => {
      const actual = response.socket.remoteAddress;
      if (!actual || !isPublicAddress(actual) || canonicalAddress(actual) !== canonicalAddress(pinned.address)) {
        response.destroy();
        reject(new DownloadError("DOWNLOAD_BLOCKED"));
      } else resolve(response);
    });
    req.once("socket", (socket) => {
      socket.once("connect", () => {
        const actual = socket.remoteAddress;
        if (!actual || !isPublicAddress(actual) || canonicalAddress(actual) !== canonicalAddress(pinned.address)) {
          req.destroy(new DownloadError("DOWNLOAD_BLOCKED"));
        }
      });
    });
    req.once("error", reject);
    req.end();
  });
}

async function readBody(response: IncomingMessage, context: RequestContext): Promise<Uint8Array> {
  const length = response.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > context.maxBytes)) {
    response.destroy();
    throw new DownloadError("DOWNLOAD_TOO_LARGE");
  }
  const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : undefined;
  if (encoding !== "identity" && !decoder) {
    response.destroy();
    throw new DownloadError("INVALID_RESPONSE");
  }
  let wireBytes = 0;
  let decodedBytes = 0;
  const chunks: Buffer[] = [];
  const wireLimit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    wireBytes += chunk.length;
    done(wireBytes > context.maxBytes ? new DownloadError("DOWNLOAD_TOO_LARGE") : null, chunk);
  } });
  const collect = new Writable({ write(chunk: Buffer, _encoding, done) {
    decodedBytes += chunk.length;
    if (decodedBytes > context.maxDecodedBytes) return done(new DownloadError("DOWNLOAD_TOO_LARGE"));
    chunks.push(Buffer.from(chunk));
    done();
  } });
  if (decoder) await pipeline(response, wireLimit, decoder, collect, { signal: context.signal });
  else await pipeline(response, wireLimit, collect, { signal: context.signal });
  return Buffer.concat(chunks, decodedBytes);
}

async function retrieve(value: string | URL, purpose: Purpose, context: RequestContext): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const initial = validateDownloadUrl(value, purpose);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let url = initial;
      for (let redirect = 0; ; redirect++) {
        context.signal.throwIfAborted();
        const response = await pinnedRequest(url, context);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirect >= MAX_REDIRECTS) throw new DownloadError("DOWNLOAD_BLOCKED");
          // Revalidate host, path, DNS and actual connection for EVERY redirect.
          let next: URL;
          try { next = new URL(location, url); } catch { throw new DownloadError("DOWNLOAD_BLOCKED"); }
          url = validateDownloadUrl(next, purpose);
          continue;
        }
        if (status !== 200) {
          response.destroy();
          throw new DownloadError("DOWNLOAD_FAILED", [502, 503, 504].includes(status));
        }
        const bytes = await readBody(response, context);
        const contentType = response.headers["content-type"];
        return { bytes, ...(contentType ? { contentType } : {}) };
      }
    } catch (error) {
      const safe = sanitize(error);
      if (attempt !== 0 || !safe.retryable || context.signal.aborted || context.retries.remaining < 1) throw safe;
      context.retries.remaining--;
    }
  }
  throw new DownloadError("DOWNLOAD_FAILED");
}

async function metadata(value: string | URL, context: RequestContext): Promise<unknown> {
  const result = await retrieve(value, "metadata", {
    ...context, maxBytes: Math.min(context.maxBytes, MAX_METADATA_BYTES), maxDecodedBytes: Math.min(context.maxDecodedBytes, MAX_METADATA_BYTES),
  });
  if (!/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(result.contentType ?? "")) throw new DownloadError("INVALID_RESPONSE");
  try { return JSON.parse(Buffer.from(result.bytes).toString("utf8")) as unknown; }
  catch { throw new DownloadError("INVALID_RESPONSE"); }
}

export async function safeMetadataJson(url: string | URL, options: DownloadOptions = {}): Promise<unknown> {
  return withinBudget(options, (context) => metadata(url, context));
}

/** Only trusted signed attachment metadata may reach this internal Worker API. */
export async function safeDownload(url: string, options: DownloadOptions = {}): Promise<{ bytes: Uint8Array; contentType?: string }> {
  return withinBudget(options, async (context) => {
    let target: URL;
    try { target = new URL(url); } catch { throw new DownloadError("DOWNLOAD_BLOCKED"); }
    if (target.hostname === "api.edunet.net") {
      validateDownloadUrl(target, "metadata");
      if (!/^\/main\/fileRsc\/downloadFile\/\d{1,20}$/.test(target.pathname)) throw new DownloadError("DOWNLOAD_BLOCKED");
      const result = await metadata(target, context);
      if (!result || typeof result !== "object" || !("success" in result) || result.success !== true
        || !("data" in result) || typeof result.data !== "string") throw new DownloadError("INVALID_RESPONSE");
      target = validateDownloadUrl(result.data);
      // Same public CDN mapping used by the official EDUNET bundle. Do not retain
      // the temporary storage signature or include it in errors/references.
      if (target.hostname === "edunet-data.kr.object.gov-ncloudstorage.com") target.hostname = "educon.edunet.net";
      if (target.hostname === "edunet-vod.kr.object.gov-ncloudstorage.com") target.hostname = "educdn.edunet.net";
      target.search = "";
    }
    return retrieve(target, "document", context);
  });
}
