import { XMLParser, XMLValidator } from "fast-xml-parser";
import { EdunetError } from "./errors.js";
import { redact } from "./logger.js";

export interface ParsedEdunetItem {
  readonly id: string | null;
  readonly title: string | null;
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly url: string | null;
  readonly category: string | null;
}

export interface ParsedEdunetResponse {
  readonly items: ParsedEdunetItem[];
  readonly totalCount: number | null;
  readonly encoding: "utf-8" | "euc-kr";
}

type Encoding = ParsedEdunetResponse["encoding"];
type XmlPart = XmlElement | string;

interface XmlElement {
  readonly name: string;
  readonly children: XmlPart[];
}

const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);
const forbiddenXmlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  preserveOrder: true,
  processEntities: true,
  trimValues: false,
});

function invalidResponse(): never {
  throw new EdunetError("INVALID_RESPONSE");
}

function normalizeEncoding(label: string): Encoding {
  const normalized = label.trim().toLowerCase().replaceAll("_", "-");
  if (["utf-8", "utf8"].includes(normalized)) return "utf-8";
  if (["euc-kr", "euckr", "ks-c-5601-1987", "ks-c-5601", "cp949", "windows-949", "x-windows-949"].includes(normalized)) {
    return "euc-kr";
  }
  return invalidResponse();
}

function hasPrefix(body: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((value, index) => body[index] === value);
}

function declaredEncoding(body: Uint8Array): string | undefined {
  const ascii = Buffer.from(body.subarray(0, Math.min(body.byteLength, 1024))).toString("latin1");
  return /^\s*(?:ï»¿)?<\?xml\s+[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(ascii)?.[1];
}

function headerEncoding(headers?: Headers): string | undefined {
  const contentType = headers?.get("content-type");
  if (!contentType) return undefined;
  return /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
}

function decode(body: Uint8Array, headers?: Headers): { text: string; encoding: Encoding } {
  if (body.byteLength === 0) return invalidResponse();
  if ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) {
    return invalidResponse();
  }

  const bomEncoding = hasPrefix(body, utf8Bom) ? "utf-8" : undefined;
  const fromHeader = headerEncoding(headers);
  const fromDeclaration = declaredEncoding(body);
  const candidates = [
    bomEncoding,
    ...(fromHeader === undefined ? [] : [normalizeEncoding(fromHeader)]),
    ...(fromDeclaration === undefined ? [] : [normalizeEncoding(fromDeclaration)]),
  ].filter((value): value is Encoding => value !== undefined);
  if (new Set(candidates).size > 1) return invalidResponse();
  const encoding = candidates[0] ?? "utf-8";

  try {
    return { text: new TextDecoder(encoding, { fatal: true }).decode(body), encoding };
  } catch {
    return invalidResponse();
  }
}

function convertPart(value: unknown): XmlPart | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["#text"] === "string") return record["#text"];
  const name = Object.keys(record).find((key) => key !== ":@" && !key.startsWith("?"));
  if (name === undefined || name.startsWith("#")) return null;
  const rawChildren = record[name];
  if (!Array.isArray(rawChildren)) return { name, children: [] };
  return {
    name,
    children: rawChildren.map(convertPart).filter((part): part is XmlPart => part !== null),
  };
}

function child(element: XmlElement, name: string): XmlElement | undefined {
  const matches = children(element, name);
  // Only data entries repeat in the documented response. Selecting the first
  // singleton would conceal conflicting status, counts, or source links.
  if (matches.length > 1) return invalidResponse();
  return matches[0];
}

function children(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((part): part is XmlElement => typeof part !== "string" && part.name === name);
}

function textOf(part: XmlPart): string {
  return typeof part === "string" ? part : part.children.map(textOf).join("");
}

function entityCodePoint(digits: string, radix: 10 | 16): string {
  const point = Number.parseInt(digits, radix);
  if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
    return invalidResponse();
  }
  const value = String.fromCodePoint(point);
  if (forbiddenXmlCharacters.test(value)) return invalidResponse();
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, digits: string) => entityCodePoint(digits, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => entityCodePoint(digits, 16))
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanText(element: XmlElement | undefined): string {
  if (element === undefined) return "";
  return decodeHtmlEntities(textOf(element))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function nullableText(element: XmlElement | undefined): string | null {
  const value = cleanText(element);
  return value.length === 0 ? null : value;
}

function firstChild(element: XmlElement, names: readonly string[]): XmlElement | undefined {
  // Every spelling represents the same singleton. Check all aliases before
  // selecting one so a preferred spelling cannot conceal conflicting data.
  const matches = names.map(name => child(element, name)).filter((match): match is XmlElement => match !== undefined);
  if (new Set(matches.map(cleanText)).size > 1) return invalidResponse();
  return matches[0];
}

function safeLink(value: string | null): string | null {
  if (value === null) return null;
  // URL() repairs missing slashes, backslashes and raw whitespace. Returning
  // the unrepaired input would give clients an ambiguous provenance link.
  if (!/^https?:\/\/[^/\\]/i.test(value) || /[\s\u0000-\u0020\u007f\\<>]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null;
  } catch {
    return null;
  }
}

function truncate(value: string): { content: string; truncated: boolean } {
  const points = Array.from(value);
  return points.length <= 500
    ? { content: value, truncated: false }
    : { content: points.slice(0, 500).join(""), truncated: true };
}

function protectedText(element: XmlElement | undefined, secrets: readonly string[]): string | null {
  const value = nullableText(element);
  return value === null ? null : redact(value, secrets);
}

function parseItem(data: XmlElement, secrets: readonly string[]): ParsedEdunetItem {
  const id = protectedText(firstChild(data, ["contents_id", "conts_id"]), secrets);
  const title = protectedText(child(data, "ttl"), secrets);
  const contentValue = redact(cleanText(child(data, "cn")), secrets);
  const category = protectedText(firstChild(data, ["category_nm", "ctgry_nm"]), secrets);
  const link = child(data, "conts_link");
  // Source URLs are identifiers, not highlighted display text. Removing tags
  // or whitespace could fabricate a different, apparently valid source URL.
  const rawUrl = link === undefined || link.children.some(part => typeof part !== "string")
    ? null
    : decodeHtmlEntities(textOf(link));
  const protectedUrl = rawUrl === null ? null : redact(rawUrl, secrets);
  // A link containing a credential is not a usable provenance link after
  // redaction, so omit it instead of returning a syntactically altered URL.
  const url = rawUrl === protectedUrl ? safeLink(rawUrl) : null;
  if (id === null && title === null && contentValue.length === 0 && category === null && url === null) {
    return invalidResponse();
  }
  const content = truncate(contentValue);
  return { id, title, content: content.content, contentTruncated: content.truncated, url, category };
}

/**
 * Decode and normalize the documented EDUNET search Open API v4.5 XML response.
 * The adapter intentionally accepts the field-name aliases that conflict between
 * the official field table and its adjacent sample XML.
 */
export function parseEdunetResponse(
  body: Uint8Array,
  headers?: Headers,
  secrets: readonly string[] = [],
): ParsedEdunetResponse {
  const decoded = decode(body, headers);
  // The XML validator accepts some forbidden literal controls; do not let
  // these enter MCP text or source links even when tag syntax is valid.
  if (forbiddenXmlCharacters.test(decoded.text)) return invalidResponse();
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(decoded.text)) return invalidResponse();
  // fast-xml-parser drops some invalid numeric references (including NUL and
  // surrogates). Validate them before parsing can silently erase the evidence.
  // Comments and CDATA contain literal text, not XML entity references.
  const entityText = decoded.text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/&#(?!(?:\d+|x[0-9a-f]+);)/i.test(entityText)) return invalidResponse();
  for (const match of entityText.matchAll(/&#(x[0-9a-f]+|\d+);/gi)) {
    const reference = match[1]!;
    if (reference[0]?.toLowerCase() === "x") entityCodePoint(reference.slice(1), 16);
    else entityCodePoint(reference, 10);
  }
  if (XMLValidator.validate(decoded.text, { allowBooleanAttributes: false }) !== true) return invalidResponse();

  let raw: unknown;
  try {
    raw = parser.parse(decoded.text);
  } catch {
    return invalidResponse();
  }
  if (!Array.isArray(raw)) return invalidResponse();
  const roots = raw.map(convertPart).filter((part): part is XmlElement => part !== null && typeof part !== "string");
  if (roots.length !== 1 || roots[0]?.name !== "search") return invalidResponse();
  const search = roots[0];
  const conditions = child(search, "conditions");
  const responseType = nullableText(conditions === undefined ? undefined : child(conditions, "responseType"));
  if (responseType !== null && responseType.toLowerCase() !== "success") return invalidResponse();

  const totalResults = child(search, "totalResults");
  const dataList = totalResults === undefined ? undefined : child(totalResults, "dataList");
  if (totalResults === undefined || dataList === undefined) return invalidResponse();
  if (dataList.children.some((part) => typeof part === "string" ? part.trim().length > 0 : part.name !== "data")) {
    return invalidResponse();
  }
  // Live v4.5 places totalCount directly under search; the manual nests it
  // under totalResults. Accept both, but do not hide contradictory counts.
  const rootTotal = nullableText(child(search, "totalCount"));
  const nestedTotal = nullableText(child(totalResults, "totalCount"));
  if (rootTotal !== null && nestedTotal !== null && rootTotal !== nestedTotal) return invalidResponse();
  const totalValue = rootTotal ?? nestedTotal;
  let totalCount: number | null = null;
  if (totalValue !== null) {
    if (!/^\d+$/.test(totalValue)) return invalidResponse();
    totalCount = Number(totalValue);
    if (!Number.isSafeInteger(totalCount)) return invalidResponse();
  }

  const entries = children(dataList, "data");
  // Contradictory zero/small totals must not trigger empty-result guidance
  // while actual materials are present in the same response.
  if (totalCount !== null && entries.length > totalCount) return invalidResponse();

  return {
    items: entries.map((data) => parseItem(data, secrets)),
    totalCount,
    encoding: decoded.encoding,
  };
}
