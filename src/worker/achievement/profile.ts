import { readFileSync } from "node:fs";
import type { DocumentProfile } from "../../achievement/contracts.js";

interface ProfileConfig {
  profileId: string;
  profileVersion: string;
  headerPatterns: Record<string, string>;
  codePattern: string;
  levelPatterns: string[];
  knownLimitations: string[];
}

const config = JSON.parse(readFileSync(new URL("../../../config/document-profiles/korean-achievement-v1.json", import.meta.url), "utf8")) as ProfileConfig;
export const codePattern = new RegExp(config.codePattern, "u");
export const knownLevel = new RegExp(`^(?:${config.levelPatterns.join("|")})$`, "u");
export const headers = Object.fromEntries(Object.entries(config.headerPatterns).map(([key, pattern]) => [key, new RegExp(pattern, "u")]));

export function documentProfile(orientation: DocumentProfile["tableOrientation"], matchedBy: string[]): DocumentProfile {
  return {
    profileId: config.profileId,
    profileVersion: config.profileVersion,
    matchedBy: [...new Set(matchedBy)],
    headerPatterns: Object.values(config.headerPatterns),
    codePatterns: [config.codePattern],
    levelPatterns: config.levelPatterns,
    tableOrientation: orientation,
    knownLimitations: config.knownLimitations,
  };
}
