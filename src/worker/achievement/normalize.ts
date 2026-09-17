import type { FieldValue } from "../../achievement/contracts.js";
import type { RawBlock } from "../intermediate/blocks.js";
import { field } from "./evidence.js";

/** A short grade alias is safe only when both school and one valid grade are explicit. */
export function gradeField(block: RawBlock, sourceHash: string, raw = block.text): FieldValue {
  const value = field(block, sourceHash, raw);
  const match = /^(초등학교|중학교|고등학교)\s*([1-6])\s*학년$/u.exec(raw.trim());
  const school = match?.[1];
  const grade = match?.[2];
  const aliases: Record<string, string> = { 초등학교: "초", 중학교: "중", 고등학교: "고" };
  const valid = school && grade && (school === "초등학교" || Number(grade) <= 3);
  return { ...value, normalized: valid ? `${aliases[school]}${grade}` : raw };
}

/** Called only after the configured source-code pattern matched, never to create a code. */
export function codeField(block: RawBlock, sourceHash: string, raw: string): FieldValue {
  return { ...field(block, sourceHash, raw), normalized: raw.replace(/\s+/gu, "") };
}
