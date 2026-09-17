import { readFileSync } from "node:fs";
import type { Warning } from "./contracts.js";

export interface AchievementSourceRegistryEntry {
  sourceType: string;
  officialHost: string;
  pathPattern: string;
  discoveryMethod: "api" | "official_listing" | "known_detail";
  checkedAt: string;
  enabled: boolean;
}

const knownPaths = new Map<string, AchievementSourceRegistryEntry["discoveryMethod"]>([
  ["/search/searchApi/search?collection=evl_data", "api"],
  ["/search/searchApi/search?collection=crclm", "api"],
  ["/main/clssStdDt/getClssStdDtInfo/{id}", "known_detail"],
  ["/main/conts/getContsData?contsId={id}&prgrmId=0", "known_detail"],
]);

/** A registry change cannot turn discovery into an arbitrary network client. */
export function inspectSourceRegistry(entries: readonly AchievementSourceRegistryEntry[], now = Date.now()): {
  entries: AchievementSourceRegistryEntry[];
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  const valid: AchievementSourceRegistryEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.enabled !== true) continue;
    if (entry.officialHost !== "api.edunet.net" || knownPaths.get(entry.pathPattern) !== entry.discoveryMethod || typeof entry.sourceType !== "string") {
      warnings.push({code: "registry_invalid", message: "검증된 EDUNET 경로와 일치하지 않는 registry 항목을 제외했습니다."});
      continue;
    }
    const checkedAt = Date.parse(entry.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > now + 86400_000 || now - checkedAt > 90 * 86400_000) {
      warnings.push({code: "registry_stale", message: `공식 경로 ${entry.pathPattern}의 검증일이 오래되었거나 유효하지 않습니다.`});
    }
    if (!valid.some(item => item.pathPattern === entry.pathPattern)) valid.push(entry);
  }
  return {entries: valid, warnings};
}

export function loadSourceRegistry(now = Date.now()): ReturnType<typeof inspectSourceRegistry> {
  try {
    const raw: unknown = JSON.parse(readFileSync(new URL("../../config/achievement-source-registry.json", import.meta.url), "utf8"));
    if (!raw || typeof raw !== "object" || !("schemaVersion" in raw) || raw.schemaVersion !== 1 || !("entries" in raw) || !Array.isArray(raw.entries)) throw new Error("registry shape");
    return inspectSourceRegistry(raw.entries as AchievementSourceRegistryEntry[], now);
  } catch {
    return {entries: [], warnings: [{code: "registry_unavailable", message: "공식 경로 registry를 읽지 못해 검색 API 결과만 사용합니다."}]};
  }
}

export function registryCollection(entry: AchievementSourceRegistryEntry): "evl_data" | "crclm" | undefined {
  if (entry.discoveryMethod !== "api") return undefined;
  return entry.pathPattern === "/search/searchApi/search?collection=evl_data" ? "evl_data"
    : entry.pathPattern === "/search/searchApi/search?collection=crclm" ? "crclm" : undefined;
}

export function detailRegistryPath(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || !["www.edunet.net", "edunet.net"].includes(url.hostname) || url.port || url.username || url.password) return undefined;
    if (/^\/clssStdDt\/view\/\d+\/\d+\/?$/.test(url.pathname)) return "/main/clssStdDt/getClssStdDtInfo/{id}";
    if (/^\/contsMvGllry\/view\/\d+\/\d+\/?$/.test(url.pathname)) return "/main/conts/getContsData?contsId={id}&prgrmId=0";
  } catch { /* Unsupported provenance is preserved without being fetched. */ }
  return undefined;
}
