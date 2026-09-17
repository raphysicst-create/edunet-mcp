import { createHash } from "node:crypto";
import type { AchievementLevelValue, AchievementRecord, DocumentProfile, Warning } from "../../achievement/contracts.js";
import type { RawBlock, ParsedDocument } from "../intermediate/blocks.js";
import { tableRows } from "../intermediate/tables.js";
import { evidence, field, uniqueEvidence } from "./evidence.js";
import { codePattern, headers, knownLevel, documentProfile } from "./profile.js";

type Context = Partial<Pick<AchievementRecord, "grade" | "subject" | "domain">>;
type RecordFields = Omit<AchievementRecord, "id" | "evidence" | "extraction">;
const gradePattern = /(?:(?:초등학교|중학교|고등학교)\s*)?\d\s*(?:[~∼～·ㆍ,-]\s*\d\s*)?학년(?:군)?|초등학교|중학교|고등학교/u;
const subjectPattern = /(?<![가-힣A-Za-z0-9])((?:통합|공통)?과학|국어|수학|영어|사회|도덕|역사|체육|음악|미술|실과|기술[·ㆍ]가정|정보|물리학|화학|생명과학|지구과학)(?=$|[\s·/()])/u;

function label(block: RawBlock, hash: string, raw = block.text, header?: RawBlock): AchievementLevelValue {
  const normalized = raw.trim().replace(/\s+/g, " ");
  return {
    rawLabel: raw,
    normalizedLabel: normalized,
    labelSystem: /^[A-E]$/.test(normalized) ? "abc" : /^[상중하]$/.test(normalized) ? "상중하" : /^\d+$/.test(normalized) ? "numeric" : knownLevel.test(normalized) ? "descriptive" : "document_defined",
    evidence: uniqueEvidence([evidence(block, hash, raw), ...(header && header !== block ? [evidence(header, hash)] : [])]),
  };
}

function standard(block: RawBlock | undefined, hash: string): Pick<RecordFields, "achievementStandardCode" | "achievementStandardText"> {
  if (!block) return {};
  const match = codePattern.exec(block.text);
  if (!match) return block.text.trim() ? { achievementStandardText: field(block, hash) } : {};
  const text = block.text.slice(match.index + match[0].length).trim();
  return {
    achievementStandardCode: field(block, hash, match[0]),
    ...(text ? { achievementStandardText: field(block, hash, text) } : {}),
  };
}

function updateContext(block: RawBlock, previous: Context, hash: string, warnings: Warning[]): Context {
  // Context is accepted only from headings or explicit metadata lines, never arbitrary descriptions.
  const explicit = /^(?:학년(?:군)?|과목|교과|영역)\s*[:：]/u.test(block.text.trim());
  if (block.kind !== "heading" && !explicit) return previous;
  const next = { ...previous };
  const grades = [...block.text.matchAll(new RegExp(gradePattern.source, "gu"))];
  const grade = grades[0];
  if (grade && grade[0] !== previous.grade?.raw) { delete next.subject; delete next.domain; }
  if (new Set(grades.map(match => match[0])).size > 1) {
    delete next.grade;
    warnings.push({ code: "AMBIGUOUS_GRADE_CONTEXT", message: "머리글에 학년이 여러 개 있어 단일 학년으로 연결하지 않았습니다." });
  } else if (grade) next.grade = field(block, hash, grade[0]);
  const subjects = [...block.text.matchAll(new RegExp(subjectPattern.source, "gu"))];
  const subject = subjects[0]?.[1];
  if (new Set(subjects.map(match => match[1])).size > 1) {
    delete next.subject; delete next.domain;
    warnings.push({ code: "AMBIGUOUS_SUBJECT_CONTEXT", message: "머리글에 과목이 여러 개 있어 단일 과목으로 연결하지 않았습니다." });
  } else if (subject) {
    if (previous.subject?.raw !== subject) delete next.domain;
    next.subject = field(block, hash, subject);
  }
  const domain = /^영역\s*[:：]\s*(.+)$/u.exec(block.text.trim());
  if (domain?.[1]) next.domain = field(block, hash, domain[1]);
  return next;
}

function makeRecord(fields: RecordFields, method: AchievementRecord["extraction"]["method"], hash: string, lowConfidence = false): AchievementRecord {
  const spans = uniqueEvidence(Object.values(fields).flatMap(value => value?.evidence ?? []));
  const id = createHash("sha256").update(hash).update(JSON.stringify(spans)).digest("hex").slice(0, 24);
  return { id: `achievement-${id}`, ...fields, evidence: spans, extraction: {
    method,
    confidence: lowConfidence ? "low" : method === "paragraph" ? "medium" : "high",
    ...(lowConfidence ? { parserWarnings: ["STRUCTURE_AMBIGUOUS"] } : {}),
  } };
}

type Header = { columns: Map<string, number>; levels: Map<number, RawBlock>; cells: Map<number, RawBlock> };
function detectHeader(cells: Map<number, RawBlock>): Header | undefined {
  const columns = new Map<string, number>();
  const levels = new Map<number, RawBlock>();
  for (const [column, cell] of cells) {
    const value = cell.text.trim().replace(/\s+/g, " ");
    for (const [key, pattern] of Object.entries(headers)) if (pattern.test(value)) columns.set(key, column);
    if (knownLevel.test(value)) levels.set(column, cell);
  }
  if ((columns.has("level") && columns.has("description")) || (levels.size >= 2 && (columns.has("standard") || columns.has("code"))) || columns.has("standard")) return { columns, levels, cells };
  return undefined;
}

function extractTable(blocks: RawBlock[], context: Context, hash: string): { records: AchievementRecord[]; orientations: Set<DocumentProfile["tableOrientation"]>; matched: boolean } {
  const records: AchievementRecord[] = [];
  const orientations = new Set<DocumentProfile["tableOrientation"]>();
  let header: Header | undefined;
  for (const [, cells] of tableRows(blocks)) {
    const candidate = detectHeader(cells);
    if (candidate) { header = candidate; continue; } // Includes repeated page headers.
    if (!header) continue;
    const cell = (key: string): RawBlock | undefined => {
      const column = header?.columns.get(key);
      return column === undefined ? undefined : cells.get(column);
    };
    const rowContext = { ...context };
    for (const key of ["grade", "subject", "domain"] as const) {
      const value = cell(key);
      if (value?.text.trim()) rowContext[key] = field(value, hash);
    }
    const fields: RecordFields = { ...rowContext, ...standard(cell("standard") ?? cell("code"), hash) };
    const codeCell = cell("code");
    const code = codeCell && codePattern.exec(codeCell.text);
    if (code && codeCell) fields.achievementStandardCode = field(codeCell, hash, code[0]);
    if (header.levels.size >= 2) {
      orientations.add("levels_in_columns");
      for (const [column, labelCell] of header.levels) {
        const description = cells.get(column);
        if (!description?.text.trim() || description === labelCell) continue;
        records.push(makeRecord({ ...fields, achievementLevel: label(labelCell, hash), description: field(description, hash) }, "table", hash));
      }
    } else if (header.columns.has("level") && header.columns.has("description")) {
      orientations.add("levels_in_rows");
      const level = cell("level");
      const description = cell("description");
      const levelHeader = header.cells.get(header.columns.get("level")!);
      if (!level?.text.trim() || !description?.text.trim()) continue;
      records.push(makeRecord({ ...fields, achievementLevel: label(level, hash, level.text, levelHeader), description: field(description, hash) }, "table", hash));
    } else if (fields.achievementStandardCode && fields.achievementStandardText) {
      records.push(makeRecord(fields, "table", hash));
    }
  }
  return { records, orientations, matched: header !== undefined };
}

export function extractAchievements(document: ParsedDocument, sourceHash: string): { records: AchievementRecord[]; documentProfile: DocumentProfile; warnings: Warning[] } {
  const records: AchievementRecord[] = [];
  const warnings: Warning[] = [];
  const matchedBy: string[] = [];
  const orientations = new Set<DocumentProfile["tableOrientation"]>();
  const handledTables = new Set<number>();
  let context: Context = {};
  let paragraphStandard: ReturnType<typeof standard> = {};
  let paragraphHasLevel = false;
  const flushStandard = () => {
    if (!paragraphHasLevel && paragraphStandard.achievementStandardCode && paragraphStandard.achievementStandardText) records.push(makeRecord({ ...context, ...paragraphStandard }, "paragraph", sourceHash));
    paragraphStandard = {};
    paragraphHasLevel = false;
  };
  for (const block of document.blocks) {
    if (block.kind === "table_cell") {
      flushStandard();
      const table = block.location.table;
      if (table === undefined || handledTables.has(table)) continue;
      handledTables.add(table);
      const extracted = extractTable(document.blocks.filter(value => value.location.table === table && value.kind === "table_cell"), context, sourceHash);
      records.push(...extracted.records);
      for (const orientation of extracted.orientations) orientations.add(orientation);
      if (extracted.matched) matchedBy.push("explicit_table_headers");
      else warnings.push({ code: "TABLE_PROFILE_UNMATCHED", message: `표 ${table}의 머리글을 확정할 수 없어 원문 블록만 보존했습니다.` });
      continue;
    }
    if (block.kind === "heading") flushStandard();
    context = updateContext(block, context, sourceHash, warnings);
    if (codePattern.test(block.text)) {
      flushStandard();
      paragraphStandard = standard(block, sourceHash);
      matchedBy.push("explicit_standard_code");
      continue;
    }
    // The delimiter is mandatory: a prose sentence starting with "상" is not a level.
    const match = /^\s*([A-E]|상|중|하|매우 우수|우수|보통|매우 미흡|미흡|도달|미도달)\s*[:：]\s*([\s\S]+)$/u.exec(block.text);
    if (!match?.[1] || !match[2]?.trim()) continue;
    paragraphHasLevel = true;
    matchedBy.push("explicit_level_paragraph");
    records.push(makeRecord({ ...context, ...paragraphStandard, achievementLevel: label(block, sourceHash, match[1]), description: field(block, sourceHash, match[2]) }, "paragraph", sourceHash));
  }
  flushStandard();
  if (records.length === 0) warnings.push({ code: "NO_ACHIEVEMENT_RECORDS", message: "텍스트는 읽었지만 근거를 갖춘 성취수준 또는 성취기준 레코드를 확정하지 못했습니다." });
  if (records.some(record => !record.achievementStandardCode)) warnings.push({ code: "STANDARD_CODE_NOT_PRESENT", message: "일부 레코드에 명시된 성취기준 코드가 없어 코드를 채우지 않았습니다." });
  if (records.some(record => !record.grade)) warnings.push({ code: "GRADE_NOT_PRESENT", message: "일부 레코드에 연결할 수 있는 명시된 학년 근거가 없습니다." });
  if (records.some(record => !record.subject)) warnings.push({ code: "SUBJECT_NOT_PRESENT", message: "일부 레코드에 연결할 수 있는 명시된 과목 근거가 없습니다." });
  const orientation = orientations.size === 1 ? [...orientations][0]! : "unknown";
  return { records, documentProfile: documentProfile(orientation, matchedBy), warnings };
}
