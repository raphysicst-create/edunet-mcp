import type { ResourceIdentity, ResourceDetails, ResolvedAttachment, Warning } from "../achievement/contracts.js";
import { detailRegistryPath, inspectSourceRegistry, loadSourceRegistry, type AchievementSourceRegistryEntry } from "../achievement/source-registry.js";
import { safeMetadataJson } from "../worker/safe-download.js";

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const clean = (value: unknown, maximum = 2000): string => typeof value === "string" || typeof value === "number"
  ? String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";

export interface ResolveResourceDependencies {
  fetchJson?: (url: URL, signal?: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  registry?: readonly AchievementSourceRegistryEntry[];
}

/** Builds only verified public metadata endpoints, never requests the supplied URL. */
export function resourceDetailUrl(resource: ResourceIdentity): URL | undefined {
  const path = detailRegistryPath(resource.sourceUrl);
  if (!path || !resource.sourceUrl || !/^\d{1,20}$/.test(resource.id)) return undefined;
  const source = new URL(resource.sourceUrl);
  const pathId = source.pathname.replace(/\/$/, "").split("/").at(-1);
  if (pathId !== resource.id) return undefined;
  if (path.startsWith("/main/clssStdDt/")) {
    const url = new URL(`https://api.edunet.net/main/clssStdDt/getClssStdDtInfo/${resource.id}`);
    for (const name of ["sbjtClsf", "srvcClsf"]) {
      const value = source.searchParams.get(name);
      if (value && /^\d{1,20}$/.test(value)) url.searchParams.set(name, value);
    }
    return url;
  }
  const url = new URL("https://api.edunet.net/main/conts/getContsData");
  url.search = new URLSearchParams({contsId: resource.id, prgrmId: "0"}).toString();
  return url;
}

function attachmentFrom(raw: unknown, resourceId: string, warnings: Warning[]): ResolvedAttachment | undefined {
  const file = object(raw);
  if (file.useYn === "N" || file.expsrYn === "N") return undefined;
  const owner = clean(file.contsId);
  if (owner && owner !== resourceId) {
    warnings.push({code: "attachment_scope_mismatch", message: "자료 ID가 다른 첨부 메타데이터를 제외했습니다."});
    return undefined;
  }
  const id = clean(file.fileRscId);
  const fileName = clean(file.fileLgcNm ?? file.orgnlFileNm ?? file.fileNm);
  if (!/^\d{1,20}$/.test(id) || !fileName) {
    warnings.push({code: "attachment_metadata_invalid", message: "식별자 또는 파일명이 없는 첨부를 제외했습니다."});
    return undefined;
  }
  const namedExtension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const declaredExtension = clean(file.extn ?? file.fileExtn, 20).replace(/^\./, "").toLowerCase();
  const extension = declaredExtension || namedExtension;
  const conflict = !!declaredExtension && !!namedExtension && declaredExtension !== namedExtension;
  if (conflict) warnings.push({code: "attachment_format_conflict", message: "파일명과 첨부 메타데이터의 확장자가 일치하지 않습니다."});
  const format = !conflict && (extension === "pdf" || extension === "hwp" || extension === "hwpx") ? extension : "unknown";
  const size = file.fileByte ?? file.fileSize ?? file.fileSz;
  const byteSize = typeof size === "number" ? size : typeof size === "string" && /^\d+$/.test(size) ? Number(size) : undefined;
  const mime = clean(file.mimeType ?? file.contentType, 200);
  return {
    id, fileName, url: `https://api.edunet.net/main/fileRsc/downloadFile/${id}`, format,
    ...(byteSize !== undefined && Number.isSafeInteger(byteSize) && byteSize >= 0 ? {byteSize} : {}),
    ...(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime) ? {declaredMimeType: mime} : {}),
  };
}

/** Reads metadata only; neither document bytes nor temporary download URLs are requested. */
export async function resolveResource(resource: ResourceIdentity, signal?: AbortSignal, deps: ResolveResourceDependencies = {}): Promise<ResourceDetails> {
  const url = resourceDetailUrl(resource);
  if (!url) return {resource, attachments: [], warnings: [{code: "detail_path_unverified", message: "공식 상세 경로 또는 자료 ID를 검증할 수 없어 첨부를 조회하지 않았습니다."}]};
  const registry = deps.registry === undefined ? loadSourceRegistry() : inspectSourceRegistry(deps.registry);
  if (!registry.entries.some(entry => entry.pathPattern === detailRegistryPath(resource.sourceUrl))) {
    return {resource, attachments: [], warnings: [...registry.warnings, {code: "detail_path_unverified", message: "해당 공식 상세 경로가 registry에서 비활성화되어 첨부를 조회하지 않았습니다."}]};
  }
  const timeout = new AbortController();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(1, Math.min(deps.timeoutMs!, 4000)) : 4000;
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const fetchJson = deps.fetchJson ?? ((target: URL, requestSignal?: AbortSignal) => safeMetadataJson(target, requestSignal ? {signal: requestSignal} : {}));
  let abort: (() => void) | undefined;
  try {
    const payload = await Promise.race([
      fetchJson(url, combined),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("metadata aborted"));
        if (combined.aborted) abort(); else combined.addEventListener("abort", abort, {once: true});
      }),
    ]);
    const envelope = object(payload);
    if (envelope.success !== true) throw new Error("metadata response rejected");
    const data = object(envelope.data);
    const info = object(data.clssStdDtInfo ?? data.result ?? data.contsInfo);
    if (clean(info.contsId) !== resource.id) throw new Error("metadata resource mismatch");
    const title = clean(info.contsNm ?? info.shrtNm);
    if (!title) throw new Error("metadata title absent");
    if (info.useYn === "N") throw new Error("resource unpublished");
    const warnings: Warning[] = [...registry.warnings];
    const rawFiles = data.fileList ?? info.fileList;
    if (!Array.isArray(rawFiles)) throw new Error("metadata file list absent");
    const attachments = rawFiles.slice(0, 100).map(file => attachmentFrom(file, resource.id, warnings)).filter((file): file is ResolvedAttachment => !!file);
    if (rawFiles.length > 100) warnings.push({code: "attachment_list_truncated", message: "첨부 목록을 처음 100개로 제한했습니다."});
    const unique = attachments.filter((item, index) => attachments.findIndex(other => other.id === item.id) === index);
    if (!unique.length) warnings.push({code: "candidate_found_no_attachment", message: "자료는 확인했지만 읽을 수 있는 첨부 메타데이터가 없습니다."});
    const metadata = clean([info.contsCn, info.kywd, info.displayName].map(value => clean(value)).filter(Boolean).join(" "), 2000);
    const snippet = [resource.snippet, metadata].filter((value, index, values) => !!value && values.indexOf(value) === index).join(" ").slice(0, 4000);
    return {resource: {...resource, title, ...(snippet ? {snippet} : {})}, attachments: unique, warnings};
  } catch {
    return {resource, attachments: [], warnings: [{code: combined.aborted ? "attachment_metadata_timeout" : "attachment_metadata_unavailable", message: "공식 상세·첨부 메타데이터를 확인하지 못했습니다. 검색 결과와 원문 링크는 유지합니다."}]};
  } finally {
    clearTimeout(timer);
    if (abort) combined.removeEventListener("abort", abort);
  }
}
