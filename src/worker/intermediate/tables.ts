import type { RawBlock } from "./blocks.js";

/** Expand only parser-reported merged cells. Blank cells never inherit a guessed value. */
export function tableRows(blocks: RawBlock[]): Map<number, Map<number, RawBlock>> {
  const rows = new Map<number, Map<number, RawBlock>>();
  for (const block of blocks) {
    const row = block.location.row;
    const column = block.location.column;
    if (row === undefined || column === undefined) continue;
    const rowSpan = Math.min(block.rowSpan ?? 1, 1000);
    const columnSpan = Math.min(block.columnSpan ?? 1, 1000);
    for (let r = row; r < row + rowSpan; r++) {
      const cells = rows.get(r) ?? new Map<number, RawBlock>();
      rows.set(r, cells);
      for (let c = column; c < column + columnSpan; c++) {
        if (!cells.has(c)) cells.set(c, block);
      }
    }
  }
  return new Map([...rows].sort(([a], [b]) => a - b));
}
