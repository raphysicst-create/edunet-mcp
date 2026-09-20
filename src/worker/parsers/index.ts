import { parsePdf, parseHwp, parseHwpx, VERSION } from "kordoc";
import type { IRBlock, ParseResult } from "kordoc";
import type { EvidenceLocation, Warning } from "../../achievement/contracts.js";
import type { ParsedDocument, RawBlock } from "../intermediate/blocks.js";
import { ParseDocumentError } from "./errors.js";
import { preflightHwp, preflightHwpx } from "./preflight.js";
import { restorePdfRulingSpans } from "./pdf-ruled-tables.js";

export { ParseDocumentError } from "./errors.js";
export type { ParsedDocument, RawBlock } from "../intermediate/blocks.js";
export const PARSER_NAME = "kordoc";
export const PARSER_VERSION = VERSION;
export interface ParseDocumentOptions { enableHwpx?: boolean; maxBlocks?: number }

export async function parseDocument(bytes: Uint8Array, format: "pdf" | "hwp" | "hwpx", options: ParseDocumentOptions = {}): Promise<ParsedDocument> {
  if (bytes.byteLength === 0) throw new ParseDocumentError("EMPTY_INPUT", "Document is empty");
  if (bytes.byteLength > 10 * 1024 * 1024) throw new ParseDocumentError("INPUT_TOO_LARGE", "Document exceeds the 10 MiB parser input limit");
  if (format === "hwpx" && !options.enableHwpx) throw new ParseDocumentError("HWPX_DISABLED", "HWPX parsing requires the explicitly enabled validated profile", "unsupported_format");
  if (format === "hwp") preflightHwp(bytes);
  if (format === "hwpx") preflightHwpx(bytes);
  const parse = { pdf: parsePdf, hwp: parseHwp, hwpx: parseHwpx }[format];
  let result: ParseResult;
  try {
    result = await parse(Uint8Array.from(bytes).buffer, { ocr: false, formulaOcr: false, removeHeaderFooter: false, dedupeRunningHeaders: false, keepTrailingEmptyCols: true, keepEmptyParagraphs: true, inlineImages: false, tables: true });
  } catch { throw new ParseDocumentError("PARSE_ERROR", "Document parser failed"); }
  if (!result.success) {
    const noText = result.code === "IMAGE_BASED_PDF";
    throw new ParseDocumentError(noText ? "OCR_REQUIRED" : result.code ?? "PARSE_ERROR", noText ? "Document has no usable text layer; OCR is outside the supported scope" : "Document parser could not read this file", noText ? "no_text" : "parse_failed");
  }
  const warnings: Warning[] = (result.warnings ?? []).map(warning => ({ code: warning.code, message: warning.message }));
  if (format === "pdf") {
    try { warnings.push(...await restorePdfRulingSpans(bytes, result.blocks)); }
    catch { warnings.push({code: "PDF_TABLE_STRUCTURE_UNVERIFIED", message: "PDF 표의 선 기반 병합 검증을 완료하지 못했습니다. 불확실한 관계는 추정하지 않습니다."}); }
  }
  warnings.push({ code: "VISUAL_CONTENT_NOT_INTERPRETED", message: "이미지·그래프·도형의 의미와 OCR은 해석하지 않았습니다." });
  const exactPages = format === "pdf" || result.metadata?.pageMode === "layout";
  const blocks: RawBlock[] = [];
  let tableNumber = 0;
  let paragraphNumber = 0;
  let hasImpreciseLocations = !exactPages;
  let chars = 0;
  const maxBlocks = Math.min(options.maxBlocks ?? 50000, 50000);
  const add = (block: RawBlock) => {
    chars += block.text.length;
    if (blocks.length >= maxBlocks || chars > 4_000_000) throw new ParseDocumentError("OUTPUT_LIMIT", "Document text/block output limit exceeded");
    blocks.push(block);
  };
  const walk = (items: IRBlock[], parent: EvidenceLocation = {}, depth = 0): void => {
    if (depth > 32) throw new ParseDocumentError("STRUCTURE_LIMIT", "Document nesting limit exceeded");
    for (const item of items) {
      const page = exactPages ? item.pageNumber ?? item.bbox?.page ?? parent.page : undefined;
      const location: EvidenceLocation = { ...(page !== undefined ? { page } : {}), block: blocks.length + 1 };
      if (item.type === "table" && item.table) {
        const table = ++tableNumber;
        // HWP/HWPX tables may span physical pages; IR provides only table-start page.
        const tableLocation: EvidenceLocation = format === "pdf" ? location : { block: location.block };
        if (format !== "pdf") hasImpreciseLocations = true;
        const covered = new Set<string>();
        for (let row = 0; row < item.table.cells.length; row++) {
          const cells = item.table.cells[row]!;
          for (let column = 0; column < cells.length; column++) {
            if (covered.has(`${row}:${column}`)) continue;
            const cell = cells[column]!;
            const rowSpan = Math.max(1, cell.rowSpan);
            const columnSpan = Math.max(1, cell.colSpan);
            if (rowSpan > 1000 || columnSpan > 1000 || rowSpan * columnSpan > 10000) throw new ParseDocumentError("STRUCTURE_LIMIT", "Document merged-cell range exceeds the limit");
            for (let r = row; r < row + rowSpan; r++) for (let c = column; c < column + columnSpan; c++) covered.add(`${r}:${c}`);
            const cellLocation = { ...tableLocation, block: blocks.length + 1, table, row: row + 1, column: column + 1 };
            // A layout wrapper containing nested tables is not flattened into a second semantic table.
            const nested = cell.blocks?.some(child => child.type === "table");
            const text = nested ? (cell.blocks ?? []).filter(child => child.type !== "table").map(child => child.text ?? "").join("\n") : cell.text;
            add({ text, kind: "table_cell", location: cellLocation, rowSpan, columnSpan });
            if (cell.blocks) walk(cell.blocks.filter(child => child.type === "table"), tableLocation, depth + 1);
          }
        }
        if (item.table.captionBlocks) walk(item.table.captionBlocks, location, depth + 1);
      } else if (item.text !== undefined && item.type !== "image") {
        add({ text: item.text, kind: item.type === "heading" ? "heading" : "paragraph", location: { ...location, paragraph: ++paragraphNumber } });
      }
      if (item.children) walk(item.children, location, depth + 1);
    }
  };
  walk(result.blocks);
  if (!blocks.some(block => /\S/u.test(block.text))) throw new ParseDocumentError(format === "pdf" ? "OCR_REQUIRED" : "NO_TEXT_LAYER", "Document contains no usable text; OCR is outside the supported scope", "no_text");
  if (hasImpreciseLocations) warnings.push({ code: "LOCATION_PRECISION", message: "확정되지 않은 페이지 번호를 생략했습니다. 문단·블록·표·행·열 위치를 인용하세요." });
  const partialCodes = new Set(["PARTIAL_PARSE", "TRUNCATED_TABLE", "NEEDS_OCR", "UNSUPPORTED_ELEMENT", "BROKEN_ZIP_RECOVERY", "MALFORMED_XML", "HIDDEN_TEXT_FILTERED"]);
  const incomplete = (result.warnings ?? []).some(warning => partialCodes.has(warning.code)) || !!result.qualitySummary?.needsOcr;
  if (result.qualitySummary?.needsOcr) warnings.push({ code: "OCR_REQUIRED", message: "일부 PDF 페이지의 텍스트 품질이 부족하여 문서 전체 추출 완료로 표시하지 않았습니다." });
  return { blocks, parserName: PARSER_NAME, parserVersion: PARSER_VERSION, documentExtractionComplete: !incomplete, warnings };
}
