import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

interface BuildIdentity {sourceDigest: string; manifestDigest: string; sourceCommit: string | null}
let cached: BuildIdentity | null | undefined;
export function runtimeBuildIdentity(): BuildIdentity | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    const data = JSON.parse(readFileSync(new URL("./build-manifest.json", import.meta.url), "utf8"));
    const {manifestDigest, ...core} = data;
    if (core.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(core.sourceDigest)
      || manifestDigest !== createHash("sha256").update(JSON.stringify(core)).digest("hex")) throw new Error("Invalid manifest");
    cached = {sourceDigest: core.sourceDigest, manifestDigest, sourceCommit: /^[a-f0-9]{40}$/.test(core.sourceCommit) ? core.sourceCommit : null};
  } catch { cached = null; }
  return cached ?? undefined;
}
