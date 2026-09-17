import type { EvidenceSpan, FieldValue } from "../../achievement/contracts.js";
import type { RawBlock } from "../intermediate/blocks.js";

export function evidence(block: RawBlock, sourceHash: string, raw = block.text): EvidenceSpan {
  const start = block.text.indexOf(raw);
  if (start < 0) throw new Error("Evidence must be an exact source substring");
  return {
    quote: raw,
    location: { ...block.location, charStart: start, charEnd: start + raw.length },
    sourceHash,
  };
}

export function field(block: RawBlock, sourceHash: string, raw = block.text): FieldValue {
  return { raw, normalized: raw.trim().replace(/\s+/g, " "), evidence: [evidence(block, sourceHash, raw)] };
}

export function uniqueEvidence(spans: EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter(span => {
    const key = JSON.stringify(span);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
