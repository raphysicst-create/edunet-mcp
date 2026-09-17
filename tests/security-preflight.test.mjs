import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { preflightHwpx } from "../dist/worker/parsers/preflight.js";

async function archive() {
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip");
  zip.file("Contents/section0.xml", "<section>" + "large payload ".repeat(1000) + "</section>", { createFolders: false });
  zip.file("Contents/section1.xml", "<section/>", { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function layout(bytes) {
  const locals = new Map();
  const central = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = bytes.readUInt16LE(offset + 26);
    locals.set(bytes.toString("utf8", offset + 30, offset + 30 + nameLength), offset);
    offset += 30 + nameLength + bytes.readUInt16LE(offset + 28) + bytes.readUInt32LE(offset + 18);
  }
  const directoryOffset = offset;
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    central.set(bytes.toString("utf8", offset + 46, offset + 46 + nameLength), offset);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return { locals, central, directoryOffset, directoryEnd: offset };
}

function aliasLargePayload(bytes) {
  const { locals, central } = layout(bytes);
  const target = locals.get("Contents/section0.xml");
  const alias = central.get("Contents/section1.xml");
  bytes.writeUInt16LE(bytes.readUInt16LE(target + 6), alias + 8);
  bytes.writeUInt16LE(bytes.readUInt16LE(target + 8), alias + 10);
  bytes.writeUInt32LE(bytes.readUInt32LE(target + 14), alias + 16);
  bytes.writeUInt32LE(bytes.readUInt32LE(target + 18), alias + 20);
  bytes.writeUInt32LE(bytes.readUInt32LE(target + 22), alias + 24);
  bytes.writeUInt32LE(target, alias + 42);
  return bytes;
}

test("HWPX central names cannot alias another local payload to bypass aggregate accounting", async () => {
  const bytes = await archive();
  assert.doesNotThrow(() => preflightHwpx(bytes));
  assert.throws(() => preflightHwpx(aliasLargePayload(bytes)), (error) => error.code === "CORRUPTED_ARCHIVE");
});

test("HWPX preflight must validate the terminal directory consumed by the ZIP parser", async () => {
  const original = await archive();
  const forged = aliasLargePayload(Buffer.from(original));
  const { directoryOffset, directoryEnd } = layout(original);
  const alternateDirectory = forged.subarray(directoryOffset, directoryEnd);
  const alternateEnd = Buffer.from(original.subarray(directoryEnd));
  alternateEnd.writeUInt32LE(original.length, 16);
  const appended = Buffer.concat([original, alternateDirectory, alternateEnd]);
  assert.throws(() => preflightHwpx(appended), (error) => error.code === "CORRUPTED_ARCHIVE");
});

test("HWPX EOCD sizes/counts must describe the checked directory while ordinary comments remain valid", async () => {
  const original = await archive();
  const { directoryEnd } = layout(original);
  for (const field of [8, 10, 12, 16]) {
    const forged = Buffer.from(original);
    if (field < 12) forged.writeUInt16LE(forged.readUInt16LE(directoryEnd + field) + 1, directoryEnd + field);
    else forged.writeUInt32LE(forged.readUInt32LE(directoryEnd + field) + 1, directoryEnd + field);
    assert.throws(() => preflightHwpx(forged), (error) => error.code === "CORRUPTED_ARCHIVE");
  }
  const comment = Buffer.from("verified archive comment");
  const withComment = Buffer.concat([original, comment]);
  withComment.writeUInt16LE(comment.length, directoryEnd + 20);
  assert.doesNotThrow(() => preflightHwpx(withComment));
});
