import { createRequire } from "node:module";
import { inflateRawSync, inflateSync } from "node:zlib";
import { ParseDocumentError } from "./errors.js";

const require = createRequire(import.meta.url);
const MAX_INFLATED = 64 * 1024 * 1024;
const MAX_STREAM = 32 * 1024 * 1024;
const MAX_ENTRIES = 500;
const fail = (code: string, message: string): never => { throw new ParseDocumentError(code, message); };

/** JSZip can replace the raw directory name with a Unicode path extra field. */
function validateZipExtras(data: Buffer, start: number, length: number, name: string): void {
  const end = start + length;
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) fail("CORRUPTED_ARCHIVE", "HWPX extra field is incomplete");
    const kind = data.readUInt16LE(offset);
    const size = data.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > end) fail("CORRUPTED_ARCHIVE", "HWPX extra field exceeds its entry");
    // A conflicting alias would bypass XML checks or overwrite a checked section.
    // Ordinary UTF-8 names and matching Unicode extras remain supported.
    if (kind === 0x7075 && (size < 5 || data[offset] === 1 && data.toString("utf8", offset + 5, offset + size) !== name)) {
      fail("CORRUPTED_ARCHIVE", "HWPX Unicode path differs from its validated entry");
    }
    offset += size;
  }
}

/** Validate actual decompressed bytes before handing an archive to a layout parser. */
export function preflightHwpx(bytes: Uint8Array): void {
  const data = Buffer.from(bytes);
  let offset = 0;
  let total = 0;
  let count = 0;
  let hasSection = false;
  let hasMime = false;
  const names = new Map<string, number>();
  while (offset + 4 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > data.length || ++count > MAX_ENTRIES) fail("ARCHIVE_LIMIT", "HWPX archive entry limit exceeded");
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const compressed = data.readUInt32LE(offset + 18);
    const declared = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    // Streaming descriptors, encryption and ZIP64 need a separately validated profile.
    if ((flags & 9) || compressed === 0xffffffff || declared === 0xffffffff) fail("ARCHIVE_UNSUPPORTED", "Encrypted, streaming, or ZIP64 HWPX archives are not supported");
    if (declared > MAX_STREAM || total + declared > MAX_INFLATED) fail("DECOMPRESSION_LIMIT", "HWPX expanded byte limit exceeded");
    const start = offset + 30 + nameLength + extraLength;
    const end = start + compressed;
    if (end > data.length) fail("CORRUPTED_ARCHIVE", "HWPX archive entry extends beyond the file");
    const name = data.toString("utf8", offset + 30, offset + 30 + nameLength);
    if (names.has(name) || name.includes("..") || name.startsWith("/")) fail("CORRUPTED_ARCHIVE", "HWPX archive has ambiguous entry paths");
    validateZipExtras(data, offset + 30 + nameLength, extraLength, name);
    names.set(name, offset);
    let expanded: Buffer;
    try {
      if (method === 0) expanded = data.subarray(start, end);
      else if (method === 8) expanded = inflateRawSync(data.subarray(start, end), { maxOutputLength: Math.min(MAX_STREAM, MAX_INFLATED - total) });
      else fail("ARCHIVE_UNSUPPORTED", "Unsupported HWPX compression method");
    } catch (error) {
      if (error instanceof ParseDocumentError) throw error;
      fail("DECOMPRESSION_LIMIT", "HWPX inflation failed or exceeded its limit");
    }
    if (expanded!.length !== declared) fail("CORRUPTED_ARCHIVE", "HWPX inflated length differs from metadata");
    total += expanded!.length;
    if (total > MAX_INFLATED) fail("DECOMPRESSION_LIMIT", "HWPX expanded byte limit exceeded");
    if (name === "mimetype" && expanded!.toString("utf8").trim() === "application/hwp+zip") hasMime = true;
    if (/^Contents\/section\d+\.xml$/u.test(name)) hasSection = true;
    if (name.endsWith(".xml") && /<!DOCTYPE|<!ENTITY/i.test(expanded!.toString("utf8"))) fail("XML_DTD_UNSUPPORTED", "HWPX DTD/entity declarations are not supported");
    offset = end;
  }
  if (!hasMime || !hasSection) fail("INVALID_HWPX", "Archive does not contain a supported HWPX document");
  if (offset + 4 > data.length || data.readUInt32LE(offset) !== 0x02014b50) fail("CORRUPTED_ARCHIVE", "HWPX central directory is missing");
  // Central entries must point to the same local entries. JSZip uses this directory.
  const centralStart = offset;
  let centralCount = 0;
  while (offset + 46 <= data.length && data.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength + extraLength + commentLength > data.length) fail("CORRUPTED_ARCHIVE", "HWPX directory entry extends beyond the file");
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLength);
    validateZipExtras(data, offset + 46 + nameLength, extraLength, name);
    const local = data.readUInt32LE(offset + 42);
    // Bind each name to its own validated payload, not merely any local header.
    if (names.get(name) !== local) fail("CORRUPTED_ARCHIVE", "HWPX directory differs from local entries");
    names.delete(name);
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt32LE(local + 18) !== data.readUInt32LE(offset + 20) || data.readUInt32LE(local + 22) !== data.readUInt32LE(offset + 24) || data.readUInt16LE(local + 8) !== data.readUInt16LE(offset + 10)) fail("CORRUPTED_ARCHIVE", "HWPX central and local metadata disagree");
    offset += 46 + nameLength + extraLength + commentLength;
    centralCount++;
  }
  if (names.size || centralCount !== count) fail("CORRUPTED_ARCHIVE", "HWPX directory entry count differs");
  // JSZip starts from the final EOCD. It must select exactly the directory above,
  // never an appended alternate directory or offsets relative to hidden data.
  if (offset + 22 > data.length || data.readUInt32LE(offset) !== 0x06054b50
    || data.lastIndexOf(Buffer.from("504b0506", "hex")) !== offset
    || data.readUInt16LE(offset + 4) !== 0 || data.readUInt16LE(offset + 6) !== 0
    || data.readUInt16LE(offset + 8) !== centralCount || data.readUInt16LE(offset + 10) !== centralCount
    || data.readUInt32LE(offset + 12) !== offset - centralStart || data.readUInt32LE(offset + 16) !== centralStart
    || offset + 22 + data.readUInt16LE(offset + 20) !== data.length) fail("CORRUPTED_ARCHIVE", "HWPX end record does not identify the validated directory");
}

type CfbEntry = { name: string; type: number; content?: Uint8Array };
type CfbFile = { FileIndex: CfbEntry[]; FullPaths: string[] };
export function preflightHwp(bytes: Uint8Array): void {
  const cfb = require("cfb") as { read(input: Buffer, options: { type: string }): CfbFile };
  let file: CfbFile;
  try { file = cfb.read(Buffer.from(bytes), { type: "buffer" }); }
  catch { return fail("INVALID_HWP", "HWP compound document could not be read"); }
  if (file.FileIndex.length > MAX_ENTRIES) fail("ARCHIVE_LIMIT", "HWP stream count limit exceeded");
  const header = file.FileIndex.find(entry => entry.name === "FileHeader")?.content;
  if (!header || header.length < 40 || Buffer.from(header).toString("ascii", 0, 17) !== "HWP Document File") fail("INVALID_HWP", "Compound document has no valid HWP FileHeader");
  const flags = Buffer.from(header!).readUInt32LE(36);
  if (flags & (2 | 4)) fail("PROTECTED_HWP_UNSUPPORTED", "Password-protected and distribution HWP documents are not supported");
  let total = 0;
  for (let i = 0; i < file.FileIndex.length; i++) {
    const entry = file.FileIndex[i]!;
    if (entry.type !== 2 || !entry.content) continue;
    const content = Buffer.from(entry.content);
    if (content.length > MAX_STREAM) fail("DECOMPRESSION_LIMIT", "HWP stream byte limit exceeded");
    let size = content.length;
    const path = file.FullPaths[i] ?? "";
    if ((flags & 1) && (entry.name === "DocInfo" || /^Section\d+$/u.test(entry.name) || /\/BinData\//u.test(path))) {
      const inflateOptions = { maxOutputLength: Math.min(MAX_STREAM, MAX_INFLATED - total) };
      try {
        // Match the parser's accepted zlib-wrapped and raw DEFLATE streams.
        if (content[0] === 0x78) {
          try { size = inflateSync(content, inflateOptions).length; }
          catch (error) {
            if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw error;
            size = inflateRawSync(content, inflateOptions).length;
          }
        } else size = inflateRawSync(content, inflateOptions).length;
      }
      catch (error) {
        // Some BinData streams are intentionally uncompressed. Body/DocInfo are not.
        if (!path.includes("/BinData/") || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") fail("DECOMPRESSION_LIMIT", "HWP inflation failed or exceeded its limit");
      }
    }
    total += size;
    if (total >= MAX_INFLATED) fail("DECOMPRESSION_LIMIT", "HWP aggregate expanded byte limit exceeded");
  }
}
