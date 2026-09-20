import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { IRBlock } from "kordoc";
import type { Warning } from "../../achievement/contracts.js";

export interface Ruling {x1: number; y1: number; x2: number; y2: number}
const tolerance = 0.8;
const near = (a: number, b: number): boolean => Math.abs(a - b) < tolerance;
function positions(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) if (!result.length || !near(value, result.at(-1)!)) result.push(value);
  return result;
}
function ncicTable(block: IRBlock): boolean {
  return block.type === "table" && block.table?.cols === 3
    && block.table.cells[0]?.[0]?.text.trim() === "성취기준"
    && /^성취기준별\s*성취수준$/.test(block.table.cells[0]?.[1]?.text.trim() ?? "")
    && block.table.cells[0]?.[1]?.colSpan === 2;
}

/** Restore only vertical merges demonstrated by painted PDF ruling segments.
 * Blank cells, labels, and code order are never used to guess a span. */
export function restoreRuledStandardCells(block: IRBlock, lines: Ruling[]): boolean {
  if (!ncicTable(block) || !block.bbox || !block.table) return false;
  const box = block.bbox, table = block.table;
  if (table.rows < 2 || table.rows > 1000 || table.cells.length !== table.rows) return false;
  const left = box.x, right = box.x + box.width, bottom = box.y, top = box.y + box.height;
  const inside = lines.filter(l => Math.min(l.x1, l.x2) >= left - tolerance && Math.max(l.x1, l.x2) <= right + tolerance
    && Math.min(l.y1, l.y2) >= bottom - tolerance && Math.max(l.y1, l.y2) <= top + tolerance);
  const horizontal = inside.filter(l => near(l.y1, l.y2) && Math.abs(l.x2 - l.x1) > 5);
  const vertical = inside.filter(l => near(l.x1, l.x2) && Math.abs(l.y2 - l.y1) > 5);
  // The official tables have open outer sides; their full-width top/bottom
  // rulings, not imaginary vertical borders, establish the two outer edges.
  const xs = positions([left, right, ...vertical.map(l => l.x1)]);
  const ys = positions(horizontal.map(l => l.y1)).reverse();
  if (xs.length !== 4 || ys.length !== table.rows + 1 || !near(xs[0]!, left) || !near(xs[3]!, right)
    || !near(ys[0]!, top) || !near(ys.at(-1)!, bottom)) return false;
  const covers = (y: number, x1: number, x2: number): boolean => horizontal.some(l => near(l.y1, y)
    && Math.min(l.x1, l.x2) <= x1 + tolerance && Math.max(l.x1, l.x2) >= x2 - tolerance);
  // Labels establish physical rows; adjacent descriptions can explicitly span
  // several labels (for example A/B share one cell). Inspect each column's lines.
  if (ys.some(y => !covers(y, xs[1]!, xs[2]!))) return false;
  const spans: {column: number; start: number; end: number; text: string}[] = [];
  for (const column of [0, 2]) {
    const x1=xs[column]!, x2=xs[column+1]!;
    if (![ys[0]!,ys[1]!,ys.at(-1)!].every(y=>covers(y,x1,x2))) return false;
    let start = 1;
    for (let boundary = 2; boundary < ys.length; boundary++) {
      if (!covers(ys[boundary]!, x1, x2)) {
        // A line that enters only part of the cell is ambiguous, not a merge.
        if (horizontal.some(l => near(l.y1,ys[boundary]!)
          && Math.max(l.x1,l.x2)>x1+tolerance && Math.min(l.x1,l.x2)<x2-tolerance)) return false;
        continue;
      }
      const cells = table.cells.slice(start, boundary).map(row => row[column]);
      if (cells.some(c => !c || c.colSpan !== 1)) return false;
      const text = cells.map(c => c!.text).filter(t => t.trim()).join("\n");
      spans.push({column,start,end:boundary,text}); start=boundary;
    }
    if (start !== table.rows) return false;
  }
  for (const span of spans) {
    table.cells[span.start]![span.column] = {text: span.text, rowSpan: span.end - span.start, colSpan: 1};
    for (let row = span.start + 1; row < span.end; row++) table.cells[row]![span.column] = {text: "", rowSpan: 1, colSpan: 1};
  }
  return true;
}

export function paintedLines(operators: {fnArray: number[]; argsArray: unknown[][]}): Ruling[] {
  let matrix: number[] = [1,0,0,1,0,0];
  const stack: number[][] = [], lines: Ruling[] = [];
  let pending: Ruling[] = [];
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i];
    if (op === OPS.save) stack.push([...matrix]);
    else if (op === OPS.restore) matrix = stack.pop() ?? [1,0,0,1,0,0];
    else if (op === OPS.transform) matrix = Util.transform(matrix, args as number[]);
    else if (op === OPS.constructPath) {
      const pathOps = args?.[0] as number[], coordinates = args?.[1] as number[];
      let offset = 0, point: number[] | undefined;
      for (const command of pathOps) {
        if (command === OPS.moveTo || command === OPS.lineTo) {
          const next = Util.applyTransform([coordinates[offset]!, coordinates[offset + 1]!], matrix);
          if (command === OPS.lineTo && point) pending.push({x1: point[0]!, y1: point[1]!, x2: next[0]!, y2: next[1]!});
          point = next; offset += 2;
        } else if (command === OPS.rectangle) {
          offset += 4; point = undefined;
        } else if (command === OPS.curveTo) { offset += 6; point = undefined; }
        else if (command === OPS.curveTo2 || command === OPS.curveTo3) { offset += 4; point = undefined; }
        else { point = undefined; }
      }
    } else if ([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op!)) {
      lines.push(...pending); pending = [];
    } else if ([OPS.endPath, OPS.fill, OPS.eoFill].includes(op!)) pending = [];
    if (lines.length > 100000 || pending.length > 100000) throw new Error("PDF ruling limit");
  }
  return lines;
}

export async function restorePdfRulingSpans(bytes: Uint8Array, blocks: IRBlock[]): Promise<Warning[]> {
  const targets = blocks.filter(ncicTable);
  if (!targets.length) return [];
  const warnings: Warning[] = [];
  const task = getDocument({data: Uint8Array.from(bytes), isEvalSupported: false, useSystemFonts: true, disableFontFace: true});
  try {
    const pdf = await task.promise;
    const pages = new Map<number, Ruling[]>();
    for (const block of targets) {
      const number = block.pageNumber ?? block.bbox?.page;
      if (!number) continue;
      if (!pages.has(number)) {
        const page = await pdf.getPage(number);
        pages.set(number, paintedLines(await page.getOperatorList()));
        page.cleanup();
      }
      if (!restoreRuledStandardCells(block, pages.get(number)!)) warnings.push({code: "PDF_TABLE_STRUCTURE_UNVERIFIED", message: `PDF ${number}쪽 성취수준 표의 병합 범위를 선 정보로 확인하지 못했습니다.`});
    }
  } finally { await task.destroy(); }
  return warnings;
}
