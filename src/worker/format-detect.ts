import { DownloadError } from "./errors.js";

export type DocumentFormat = "pdf" | "hwp" | "hwpx" | "unknown";

const mimeFormats: Record<string, Exclude<DocumentFormat, "unknown">> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/hwp": "hwp",
  "application/x-hwp": "hwp",
  "application/haansofthwp": "hwp",
  "application/vnd.hancom.hwp": "hwp",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/vnd.hancom.hwpx+zip": "hwpx",
  "application/hwp+zip": "hwpx",
};
const genericMime = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download"]);

/** Container signatures are preliminary; the isolated parser must validate HWP/HWPX internals. */
export function detectFormat(bytes: Uint8Array, fileName: string, declaredMimeType?: string): DocumentFormat {
  const extension = /\.([^.\\/]+)$/.exec(fileName.trim())?.[1]?.toLowerCase();
  const expected = extension === "pdf" || extension === "hwp" || extension === "hwpx" ? extension : undefined;
  const mime = (declaredMimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const declared = mimeFormats[mime];
  const prefix = Buffer.from(bytes.subarray(0, 16));
  const magic = /^%PDF-[12]\.\d/.test(prefix.toString("ascii")) ? "pdf"
    : prefix.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")) ? "ole"
    : prefix.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) ? "zip" : undefined;

  const claim = expected ?? declared;
  if (!claim) return "unknown";
  const expectedMagic = claim === "hwp" ? "ole" : claim === "hwpx" ? "zip" : "pdf";
  const compatibleContainerMime = claim === "hwpx" && (mime === "application/zip" || mime === "application/x-zip-compressed");
  if (magic !== expectedMagic || (expected && declared && expected !== declared)
    || (extension && !expected)
    || (!declared && !genericMime.has(mime) && !compatibleContainerMime)) {
    throw new DownloadError("FORMAT_MISMATCH");
  }
  return claim;
}
