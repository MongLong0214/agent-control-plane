import {
  type Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { GIT_OUTPUT_MAX_BYTES } from "../git/git.ts";

/**
 * #1232 — files the CTO imports into a STANDARD_WORK task's write target.
 *
 * A worker writes only through its provider's patch tool inside the claimed checkout, so it cannot
 * add a font or an image, or reproduce a large generated file byte for byte. The task's recorded
 * write target may therefore carry `imports`: a manifest whose entries each name a path inside the
 * target's paths, the file's size and its sha256. The CTO stages the bytes in the task's staging
 * directory under the ACP state root, `<importRoot>/<runId>/<taskId>/<sha256 hex>`, so a source is
 * named by its digest and never by a host path.
 *
 * Before the task's worker is launched, the control plane reads every staged file once, checks its
 * size and every byte's sha256 against the manifest and every destination in the checkout, and only
 * then writes the bytes it read, create-only, through the Managed Write Guard. A missing, mismatched or
 * symlinked source, a path outside the target or a destination that is a symlink or already exists
 * refuses the whole import before anything is written. The files are committed with the worker's
 * change, and the success receipt binds the manifest.
 *
 * What review sees depends on the content (`classifyImport`). A file git reads as text is never bound
 * by its manifest: it stays in the candidate's patch and is reviewed like any other change, so a task's
 * text imports are bounded by what that patch can carry (`IMPORT_MAX_TEXT_BYTES`). A binary file may be
 * bound by its manifest only when its exact extension selects a bounded parser that consumes a
 * complete structurally valid PNG or TrueType font. Unknown, mismatched, malformed and trailing
 * bytes are refused; the reviewer reads the validated format of every bound file.
 */

/** One imported file: where it lands in the repository, its size in bytes and the sha256 of its bytes. */
export interface TaskImport {
  path: string;
  size: number;
  /** `sha256:<64 lowercase hex>` of the file's bytes. */
  sha256: string;
}

/** The bytes of one import, read from its staging directory and verified against its entry. */
export interface StagedImport extends TaskImport {
  bytes: Buffer;
}

export const IMPORT_MAX_FILES = 100;
/**
 * 50 MiB, GitHub's warning size, and never more than the git wrapper can hand back whole: the freeze
 * reads each imported blob through it to bind the file by sha256 (`buildCandidateSnapshot`), and the
 * receipt check in review reads it again. A bound (binary data) import's patch is never materialised;
 * a text import's is, and `IMPORT_MAX_TEXT_BYTES` bounds that.
 */
export const IMPORT_MAX_FILE_BYTES = Math.min(50 * 1024 * 1024, GIT_OUTPUT_MAX_BYTES);
/** The bytes one task imports, held in memory once while they are verified and written. */
export const IMPORT_MAX_TOTAL_BYTES = 4 * IMPORT_MAX_FILE_BYTES;
/** The audit log keeps an unlisted string field only up to 200 characters, and an entry's path is one. */
const IMPORT_PATH_MAX_CHARS = 200;
/**
 * The most patch one new text file adds besides its lines: `diff --git a/<path> b/<path>`, the mode and
 * full-index lines, `--- /dev/null`, `+++ b/<path>`, the hunk header and a no-newline marker.
 */
const TEXT_PATCH_HEADER_BYTES = 3 * IMPORT_PATH_MAX_CHARS + 256;
/**
 * The text one task may import, all files together. A new text file of n bytes is at most 2n bytes of
 * patch (were every byte a newline, each would become `+\n`) plus its header, and the candidate's whole
 * patch is read through the git wrapper, which hands back at most `GIT_OUTPUT_MAX_BYTES`. One task's
 * text imports may take half of that; the other half is left to everything else the candidate changes.
 * Review carries any text the patch carries, chunked and range-split.
 */
export const IMPORT_MAX_TEXT_BYTES = Math.floor((GIT_OUTPUT_MAX_BYTES / 2 - IMPORT_MAX_FILES * TEXT_PATCH_HEADER_BYTES) / 2);

/**
 * Git's own text/binary decision on content (`buffer_is_binary` in git's xdiff-interface.c): a NUL byte
 * within the first 8000 bytes makes a blob binary. The freeze also asks git for its decision on each
 * path, attributes included (`binaryPaths`), before it binds anything.
 */
const GIT_BINARY_PROBE_BYTES = 8000;
export const gitReadsAsBinary = (bytes: Buffer): boolean => bytes.subarray(0, GIT_BINARY_PROBE_BYTES).includes(0);

interface Format {
  name: string;
  /** Every signature must match: `[offset, bytes]`. */
  signatures: ReadonlyArray<readonly [number, Buffer]>;
  /** Matched only in content git reads as binary (a text script's shebang is reviewed as text). */
  binaryOnly?: boolean;
}

const format = (name: string, ...signatures: Array<readonly [number, string | number[]]>): Format => ({
  name,
  signatures: signatures.map(([offset, bytes]) => [offset, typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes)] as const),
});

const matches = (bytes: Buffer, candidate: Format): boolean =>
  candidate.signatures.every(([offset, signature]) =>
    bytes.length >= offset + signature.length && bytes.subarray(offset, offset + signature.length).equals(signature));

/** Executable or loadable code, and archives that can carry it, by magic number: never imported. */
const REFUSED_FORMATS: readonly Format[] = [
  format("ELF executable or library", [0, [0x7f, 0x45, 0x4c, 0x46]]),
  ...[[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]]
    .map((magic) => format("Mach-O executable or library", [0, magic])),
  format("Mach-O universal binary or Java class", [0, [0xca, 0xfe, 0xba, 0xbe]]),
  format("Mach-O universal binary", [0, [0xca, 0xfe, 0xba, 0xbf]]),
  format("Mach-O universal binary", [0, [0xbe, 0xba, 0xfe, 0xca]]),
  format("PE or DOS executable", [0, "MZ"]),
  format("WebAssembly module", [0, [0x00, 0x61, 0x73, 0x6d]]),
  { ...format("script with a shebang", [0, "#!"]), binaryOnly: true },
  format("Dalvik executable", [0, "dex\n"]),
  format("Lua bytecode", [0, [0x1b, 0x4c, 0x75, 0x61]]),
  ...["PK\x03\x04", "PK\x05\x06", "PK\x07\x08"].map((magic) => format("zip archive (JAR, APK and wheel included)", [0, magic])),
  format("gzip archive", [0, [0x1f, 0x8b]]),
  format("compress archive", [0, [0x1f, 0x9d]]),
  format("bzip2 archive", [0, "BZh"]),
  format("xz archive", [0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]]),
  format("zstd archive", [0, [0x28, 0xb5, 0x2f, 0xfd]]),
  format("7z archive", [0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]]),
  format("RAR archive", [0, "Rar!\x1a\x07"]),
  format("lzip archive", [0, "LZIP"]),
  format("LZ4 archive", [0, [0x04, 0x22, 0x4d, 0x18]]),
  format("cabinet archive", [0, "MSCF"]),
  format("ar archive (.deb and static libraries included)", [0, "!<arch>\n"]),
  format("xar archive", [0, "xar!"]),
  format("RPM package", [0, [0xed, 0xab, 0xee, 0xdb]]),
  ...["070707", "070701", "070702"].map((magic) => format("cpio archive", [0, magic])),
  format("cpio archive", [0, [0xc7, 0x71]]),
  format("cpio archive", [0, [0x71, 0xc7]]),
  format("tar archive", [257, "ustar"]),
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

const pngCrc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
};

/** A complete, bounded PNG parse. `null` means every byte belongs to one structurally valid PNG. */
const invalidPng = (bytes: Buffer): string | null => {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "the bytes are not a PNG";
  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let sawEnd = false;
  let gamma: number | null = null;
  let sawSrgb = false;
  const compressed: Buffer[] = [];
  while (cursor < bytes.length) {
    if (bytes.length - cursor < 12) return "the PNG ends inside a chunk";
    const length = bytes.readUInt32BE(cursor);
    if (length > 0x7fffffff || length > bytes.length - cursor - 12) return "a PNG chunk length leaves the file";
    const typeBytes = bytes.subarray(cursor + 4, cursor + 8);
    if (![...typeBytes].every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (typeBytes[2]! & 0x20) !== 0) {
      return "a PNG chunk type is invalid";
    }
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);
    if (pngCrc32(bytes.subarray(cursor + 4, cursor + 8 + length)) !== bytes.readUInt32BE(cursor + 8 + length)) return `the PNG ${type} checksum is invalid`;
    cursor += 12 + length;
    if (!sawHeader && type !== "IHDR") return "the PNG does not begin with IHDR";
    if (type === "IHDR") {
      if (sawHeader || length !== 13) return "the PNG has an invalid IHDR";
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8]!;
      const color = data[9]!;
      const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(color);
      const depths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]).get(color);
      if (width === 0 || height === 0 || channels === undefined || !depths?.includes(depth) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        return "the PNG IHDR fields are unsupported or invalid";
      }
      bitsPerPixel = channels * depth;
      bitDepth = depth;
      colorType = color;
      sawHeader = true;
    } else if (type === "PLTE") {
      const paletteLimit = colorType === 3 ? 3 * 2 ** bitDepth : 768;
      if (sawPalette || sawData || colorType === 0 || colorType === 4 || length === 0 || length % 3 !== 0 || length > paletteLimit) {
        return "the PNG has an invalid PLTE";
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (sawEnd || (colorType === 3 && !sawPalette)) return "the PNG IDAT chunks lack the required palette or follow IEND";
      sawData = true;
      compressed.push(data);
    } else if (type === "IEND") {
      if (!sawData || sawEnd || length !== 0 || cursor !== bytes.length) return "the PNG has an invalid IEND or trailing bytes";
      sawEnd = true;
    } else if (type === "gAMA") {
      if (gamma !== null || sawPalette || sawData || length !== 4 || data.readUInt32BE(0) === 0) return "the PNG has an invalid gAMA";
      gamma = data.readUInt32BE(0);
      if (sawSrgb && gamma !== 45_455) return "the PNG gAMA conflicts with sRGB";
    } else if (type === "sRGB") {
      if (sawSrgb || sawPalette || sawData || length !== 1 || data[0]! > 3 || (gamma !== null && gamma !== 45_455)) return "the PNG has an invalid sRGB";
      sawSrgb = true;
    } else {
      return (typeBytes[0]! & 0x20) === 0
        ? `the PNG has an unknown critical chunk ${type}`
        : `the PNG ancillary chunk ${type} is not in the structurally validated allowlist`;
    }
  }
  if (!sawEnd) return "the PNG has no IEND";
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const decodedLength = height * (rowBytes + 1);
  if (!Number.isSafeInteger(decodedLength) || decodedLength > IMPORT_MAX_TOTAL_BYTES) return "the decoded PNG exceeds the import bound";
  try {
    const encoded = Buffer.concat(compressed);
    // Node returns this documented shape for `info: true`; @types/node still declares only Buffer.
    const inflated = inflateSync(encoded, { maxOutputLength: decodedLength, info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const decoded = inflated.buffer;
    if (inflated.engine.bytesWritten !== encoded.length) return "the PNG pixel stream has trailing compressed bytes";
    if (decoded.length !== decodedLength) return "the PNG pixel stream has the wrong length";
    for (let offset = 0; offset < decoded.length; offset += rowBytes + 1) if (decoded[offset]! > 4) return "the PNG has an invalid row filter";
  } catch {
    return "the PNG pixel stream does not decode within its bound";
  }
  return null;
};

const sfntChecksum = (bytes: Buffer, zeroAdjustment = false): number => {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte += 1) {
      const position = offset + byte;
      const value = zeroAdjustment && position >= 8 && position < 12 ? 0 : (bytes[position] ?? 0);
      word = ((word << 8) | value) >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum;
};

interface SfntTable { tag: string; checksum: number; offset: number; length: number; bytes: Buffer }

const hasOnlyGlyphPadding = (glyph: Buffer, cursor: number): boolean =>
  glyph.length - cursor <= 3 && [...glyph.subarray(cursor)].every((byte) => byte === 0);

/** Validates one non-empty simple or composite `glyf` record and consumes it through zero padding. */
const invalidGlyph = (glyph: Buffer, glyphCount: number): string | null => {
  if (glyph.length < 10) return "a non-empty TrueType glyph is shorter than its header";
  const contours = glyph.readInt16BE(0);
  let cursor = 10;
  if (contours >= 0) {
    if (cursor + contours * 2 + 2 > glyph.length) return "a simple TrueType glyph ends inside its contour endpoints";
    let lastPoint = -1;
    for (let contour = 0; contour < contours; contour += 1) {
      const endpoint = glyph.readUInt16BE(cursor);
      cursor += 2;
      if (endpoint <= lastPoint) return "a simple TrueType glyph has unordered contour endpoints";
      lastPoint = endpoint;
    }
    const instructions = glyph.readUInt16BE(cursor);
    cursor += 2;
    if (instructions > glyph.length - cursor) return "a simple TrueType glyph ends inside its instructions";
    cursor += instructions;
    const points = lastPoint + 1;
    let flags = 0;
    let coordinateBytes = 0;
    while (flags < points) {
      if (cursor >= glyph.length) return "a simple TrueType glyph ends inside its flags";
      const flag = glyph[cursor++]!;
      let repeats = 1;
      if ((flag & 0x08) !== 0) {
        if (cursor >= glyph.length) return "a simple TrueType glyph lacks its flag repeat count";
        repeats += glyph[cursor++]!;
      }
      if (flags + repeats > points) return "a simple TrueType glyph repeats flags past its point count";
      const xBytes = (flag & 0x02) !== 0 ? 1 : (flag & 0x10) !== 0 ? 0 : 2;
      const yBytes = (flag & 0x04) !== 0 ? 1 : (flag & 0x20) !== 0 ? 0 : 2;
      coordinateBytes += repeats * (xBytes + yBytes);
      flags += repeats;
    }
    cursor += coordinateBytes;
    if (cursor > glyph.length || !hasOnlyGlyphPadding(glyph, cursor)) return "a simple TrueType glyph has truncated coordinates or hidden trailing bytes";
    return null;
  }
  let flags = 0;
  do {
    if (cursor + 4 > glyph.length) return "a composite TrueType glyph ends inside a component";
    flags = glyph.readUInt16BE(cursor);
    const componentGlyph = glyph.readUInt16BE(cursor + 2);
    cursor += 4;
    if (componentGlyph >= glyphCount) return "a composite TrueType glyph names a missing component";
    cursor += (flags & 0x0001) !== 0 ? 4 : 2;
    const transforms = [(flags & 0x0008) !== 0, (flags & 0x0040) !== 0, (flags & 0x0080) !== 0].filter(Boolean).length;
    if (transforms > 1) return "a composite TrueType glyph has conflicting transforms";
    if ((flags & 0x0008) !== 0) cursor += 2;
    else if ((flags & 0x0040) !== 0) cursor += 4;
    else if ((flags & 0x0080) !== 0) cursor += 8;
    if (cursor > glyph.length) return "a composite TrueType glyph ends inside its arguments or transform";
  } while ((flags & 0x0020) !== 0);
  if ((flags & 0x0100) !== 0) {
    if (cursor + 2 > glyph.length) return "a composite TrueType glyph lacks its instruction length";
    const instructions = glyph.readUInt16BE(cursor);
    cursor += 2;
    if (instructions > glyph.length - cursor) return "a composite TrueType glyph ends inside its instructions";
    cursor += instructions;
  }
  return hasOnlyGlyphPadding(glyph, cursor) ? null : "a composite TrueType glyph has hidden trailing bytes";
};

/** A complete TrueType sfnt parse. It rejects gaps, overlaps, trailing bytes and malformed core tables. */
const invalidTrueType = (bytes: Buffer): string | null => {
  if (bytes.length < 12 || bytes.readUInt32BE(0) !== 0x00010000) return "the bytes are not a TrueType sfnt";
  const count = bytes.readUInt16BE(4);
  if (count === 0 || count > 4095 || 12 + count * 16 > bytes.length) return "the TrueType table directory is invalid";
  const power = 2 ** Math.floor(Math.log2(count));
  if (bytes.readUInt16BE(6) !== power * 16 || bytes.readUInt16BE(8) !== Math.log2(power) || bytes.readUInt16BE(10) !== count * 16 - power * 16) {
    return "the TrueType table search fields are invalid";
  }
  const tables: SfntTable[] = [];
  let previousTag = "";
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tagBytes = bytes.subarray(at, at + 4);
    if (![...tagBytes].every((byte) => byte >= 0x20 && byte <= 0x7e)) return "a TrueType table tag is invalid";
    const tag = tagBytes.toString("ascii");
    const checksum = bytes.readUInt32BE(at + 4);
    const offset = bytes.readUInt32BE(at + 8);
    const length = bytes.readUInt32BE(at + 12);
    if (tag <= previousTag || length === 0 || offset % 4 !== 0 || offset < 12 + count * 16 || length > bytes.length - offset) {
      return "a TrueType table record is invalid";
    }
    previousTag = tag;
    tables.push({ tag, checksum, offset, length, bytes: bytes.subarray(offset, offset + length) });
  }
  let expectedOffset = (12 + count * 16 + 3) & ~3;
  for (const table of [...tables].sort((left, right) => left.offset - right.offset)) {
    if (table.offset !== expectedOffset || sfntChecksum(table.bytes, table.tag === "head") !== table.checksum) return "the TrueType tables overlap, have gaps or fail checksum";
    expectedOffset = (table.offset + table.length + 3) & ~3;
    if ([...bytes.subarray(table.offset + table.length, expectedOffset)].some((byte) => byte !== 0)) return "the TrueType table padding is nonzero";
  }
  if (expectedOffset !== bytes.length || sfntChecksum(bytes) !== 0xb1b0afba) return "the TrueType file has trailing bytes or an invalid whole-font checksum";
  const byTag = new Map(tables.map((table) => [table.tag, table]));
  const required = ["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"];
  if (required.some((tag) => !byTag.has(tag))) return "the TrueType font lacks a required table";
  const head = byTag.get("head")!.bytes;
  const hhea = byTag.get("hhea")!.bytes;
  const maxp = byTag.get("maxp")!.bytes;
  if (head.length < 54 || head.readUInt32BE(0) !== 0x00010000 || head.readUInt32BE(12) !== 0x5f0f3cf5 || head.readUInt16BE(18) < 16) return "the TrueType head table is invalid";
  if (maxp.length < 32 || maxp.readUInt32BE(0) !== 0x00010000 || maxp.readUInt16BE(4) === 0) return "the TrueType maxp table is invalid";
  const glyphs = maxp.readUInt16BE(4);
  if (hhea.length < 36 || hhea.readUInt32BE(0) !== 0x00010000 || hhea.readUInt16BE(34) === 0 || hhea.readUInt16BE(34) > glyphs) return "the TrueType hhea table is invalid";
  const longMetrics = hhea.readUInt16BE(34);
  const loca = byTag.get("loca")!.bytes;
  const glyf = byTag.get("glyf")!.bytes;
  const longLoca = head.readInt16BE(50);
  const locaWidth = longLoca === 0 ? 2 : longLoca === 1 ? 4 : 0;
  if (locaWidth === 0 || loca.length !== (glyphs + 1) * locaWidth || byTag.get("hmtx")!.length !== longMetrics * 4 + (glyphs - longMetrics) * 2) {
    return "the TrueType glyph index or metrics are invalid";
  }
  let previousLocation = 0;
  const locations: number[] = [];
  for (let index = 0; index <= glyphs; index += 1) {
    const location = locaWidth === 2 ? loca.readUInt16BE(index * 2) * 2 : loca.readUInt32BE(index * 4);
    if (location < previousLocation || location > glyf.length) return "the TrueType glyph locations are invalid";
    locations.push(location);
    previousLocation = location;
  }
  for (let index = 0; index < glyphs; index += 1) {
    const start = locations[index]!;
    const end = locations[index + 1]!;
    if (end > start) {
      const problem = invalidGlyph(glyf.subarray(start, end), glyphs);
      if (problem !== null) return problem;
    }
  }
  const glyfPadding = glyf.subarray(previousLocation);
  if (glyfPadding.length > 3 || [...glyfPadding].some((byte) => byte !== 0)) return "the TrueType glyf endpoint leaves non-padding bytes unindexed";
  const cmap = byTag.get("cmap")!.bytes;
  const name = byTag.get("name")!.bytes;
  const cmapCount = cmap.length >= 4 ? cmap.readUInt16BE(2) : 0;
  const cmapDirectoryEnd = 4 + cmapCount * 8;
  if (cmap.length < 12 || cmap.readUInt16BE(0) !== 0 || cmapCount === 0 || cmapDirectoryEnd > cmap.length) return "the TrueType cmap table is invalid";
  for (let index = 0; index < cmapCount; index += 1) {
    const subtableOffset = cmap.readUInt32BE(4 + index * 8 + 4);
    if (subtableOffset < cmapDirectoryEnd || subtableOffset + 4 > cmap.length) return "a TrueType cmap subtable offset is invalid";
    const formatNumber = cmap.readUInt16BE(subtableOffset);
    let subtableLength = 0;
    if ([0, 2, 4, 6].includes(formatNumber)) subtableLength = cmap.readUInt16BE(subtableOffset + 2);
    else if ([8, 10, 12, 13].includes(formatNumber)) {
      if (subtableOffset + 8 > cmap.length) return "a TrueType cmap subtable header is truncated";
      subtableLength = cmap.readUInt32BE(subtableOffset + 4);
    } else if (formatNumber === 14) {
      if (subtableOffset + 6 > cmap.length) return "a TrueType cmap subtable header is truncated";
      subtableLength = cmap.readUInt32BE(subtableOffset + 2);
    } else return "the TrueType cmap format is unsupported";
    if (subtableLength < 4 || subtableLength > cmap.length - subtableOffset) return "a TrueType cmap subtable length is invalid";
  }
  const nameCount = name.length >= 6 ? name.readUInt16BE(2) : 0;
  const nameRecordsEnd = 6 + nameCount * 12;
  const stringsOffset = name.length >= 6 ? name.readUInt16BE(4) : 0;
  if (name.length < 6 || name.readUInt16BE(0) !== 0 || nameCount === 0 || nameRecordsEnd > name.length || stringsOffset < nameRecordsEnd || stringsOffset > name.length) {
    return "the TrueType name table is invalid";
  }
  for (let index = 0; index < nameCount; index += 1) {
    const record = 6 + index * 12;
    const stringLength = name.readUInt16BE(record + 8);
    const stringOffset = name.readUInt16BE(record + 10);
    if (stringOffset > name.length - stringsOffset || stringLength > name.length - stringsOffset - stringOffset) {
      return "a TrueType name string leaves its table";
    }
  }
  if (byTag.get("OS/2")!.length < 78 || byTag.get("post")!.length < 32) return "a required TrueType table is truncated";
  return null;
};

const validatedBinary = (path: string, bytes: Buffer): { type: string } | { why: string } => {
  const extension = path.slice(path.lastIndexOf("."));
  const validation = extension === ".png"
    ? { type: "PNG", problem: invalidPng(bytes) }
    : extension === ".ttf"
      ? { type: "font (TrueType)", problem: invalidTrueType(bytes) }
      : null;
  if (validation === null) return { why: "the path does not have an allowed image or font extension (.png or .ttf)" };
  return validation.problem === null ? { type: validation.type } : { why: validation.problem };
};

/** How review can see one imported file, from its bytes and path. */
export type ImportContent =
  | { kind: "text" }
  | { kind: "data"; type: string }
  | { kind: "refused"; why: string };

/**
 * Text (git reads it as text) is reviewed as the patch it is. Binary bytes are bound by their manifest
 * only when an exact allowed extension selects a bounded parser that validates the complete file.
 */
export const classifyImport = (path: string, bytes: Buffer): ImportContent => {
  const binary = gitReadsAsBinary(bytes);
  const refused = REFUSED_FORMATS.find((candidate) => (binary || candidate.binaryOnly !== true) && matches(bytes, candidate));
  if (refused !== undefined) return { kind: "refused", why: `${refused.name}: executable or loadable code, or an archive that can carry it` };
  if (!binary) return { kind: "text" };
  const validated = validatedBinary(path, bytes);
  return "type" in validated
    ? { kind: "data", type: validated.type }
    : { kind: "refused", why: `binary bytes are not a complete structurally valid allowed image or font: ${validated.why}` };
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * A path segment an import may use: ASCII letters, digits and `._@+-`. Nothing here is a glob, a
 * separator, a control character or a character a filesystem may normalise into another name.
 */
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
/** `.git`, in any case and with any trailing dots, names the git dir on a case-insensitive filesystem. */
const GIT_DIR_SEGMENT = /^\.git\.*$/i;
const RUN_OR_TASK_ID = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const insideAny = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => root === "." || path === root || path.startsWith(`${root}/`));

const isImportPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= IMPORT_PATH_MAX_CHARS &&
  path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== ".." && !GIT_DIR_SEGMENT.test(segment));

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A declared import manifest, checked and sorted by path, or why it is refused: 1 to IMPORT_MAX_FILES
 * entries of exactly `{path, size, sha256}`; each path repository-relative in normal form, no `.git`
 * segment, inside one of the write target's `paths`; no path twice or below another; each size and
 * the total within their limits.
 */
export const parseImportManifest = (declared: unknown, paths: readonly string[]): Decision<TaskImport[]> => {
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > IMPORT_MAX_FILES) {
    return deny(ReasonCode.INVALID_ARGUMENT, `the write target's imports must list 1 to ${IMPORT_MAX_FILES} files`, {
      reason: "IMPORT_MANIFEST_INVALID",
      count: Array.isArray(declared) ? declared.length : null,
    });
  }
  const imports: TaskImport[] = [];
  const invalid: Array<string | number> = [];
  for (const [index, item] of declared.entries()) {
    const shaped = isRecord(item) && Object.keys(item).sort().join(",") === "path,sha256,size";
    if (
      !shaped ||
      !isImportPath(item["path"]) ||
      !Number.isSafeInteger(item["size"]) ||
      (item["size"] as number) < 0 ||
      (item["size"] as number) > IMPORT_MAX_FILE_BYTES ||
      typeof item["sha256"] !== "string" ||
      !DIGEST.test(item["sha256"])
    ) {
      invalid.push(isRecord(item) && typeof item["path"] === "string" && item["path"].length <= IMPORT_PATH_MAX_CHARS ? item["path"] : index);
      continue;
    }
    imports.push({ path: item["path"], size: item["size"] as number, sha256: item["sha256"] });
  }
  if (invalid.length > 0) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      `an import entry must be exactly {path, size, sha256}: a repository-relative path of [A-Za-z0-9._@+-] segments with no '.', '..' or .git segment, a size of at most ${IMPORT_MAX_FILE_BYTES} bytes and a sha256:<64 hex> digest`,
      { reason: "IMPORT_MANIFEST_INVALID", invalid: invalid.slice(0, 50) },
    );
  }
  imports.sort(byPath);
  const overlapping = imports
    .filter((entry, index) => imports.some((other, at) => at !== index && (other.path === entry.path || entry.path.startsWith(`${other.path}/`))))
    .map((entry) => entry.path);
  if (overlapping.length > 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "an import path is listed twice or lies below another import path", {
      reason: "IMPORT_MANIFEST_INVALID",
      overlapping: [...new Set(overlapping)].slice(0, 50),
    });
  }
  const outOfScope = imports.filter((entry) => !insideAny(entry.path, paths)).map((entry) => entry.path);
  if (outOfScope.length > 0) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "an import path lies outside the task's write-target paths", {
      reason: "IMPORT_OUT_OF_SCOPE",
      outOfScope: outOfScope.slice(0, 50),
      paths: [...paths],
    });
  }
  const total = imports.reduce((sum, entry) => sum + entry.size, 0);
  if (total > IMPORT_MAX_TOTAL_BYTES) {
    return deny(ReasonCode.INVALID_ARGUMENT, `a task imports at most ${IMPORT_MAX_TOTAL_BYTES} bytes`, { reason: "IMPORT_MANIFEST_INVALID", total });
  }
  return allow(ReasonCode.OK, imports);
};

/** The staging directory of one task, under the ACP-owned import root. */
export const importStagingDir = (root: string, runId: string, taskId: string): string => join(root, runId, taskId);

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
};

/** Why a staging directory is not one this daemon's user owns alone, or null when it is. */
const unownedDirectory = (stat: Stats): string | null => {
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (!stat.isDirectory()) return "not a directory";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "owned by another user";
  if ((stat.mode & 0o022) !== 0) return "writable by group or others";
  return null;
};

/** Reads one staged file without following a symlink or blocking on a fifo, and only up to its declared size. */
const readStaged = (path: string, size: number): { bytes: Buffer } | { problem: "missing" | "mismatch" | string } => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { problem: "missing" };
    return { problem: code === "ELOOP" ? "a symbolic link" : `unreadable (${code ?? "error"})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: "not a regular file" };
    if (stat.size !== size) return { problem: "mismatch" };
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) return { problem: "mismatch" };
      offset += read;
    }
    // Grown since the stat: not the declared size, so not the declared bytes.
    if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) return { problem: "mismatch" };
    return { bytes };
  } finally {
    closeSync(fd);
  }
};

/**
 * Every import's bytes, read once from the task's staging directory and verified against its entry,
 * or the refusal naming every file that is missing, insecure or not the declared bytes. The root, the
 * run's and the task's directories must be real directories this daemon's user owns and only it can
 * write; a staged file must be a regular file, not a symlink, named by the hex of its sha256.
 */
export const readStagedImports = (input: {
  root: string | null;
  runId: string;
  taskId: string;
  imports: readonly TaskImport[];
}): Decision<StagedImport[]> => {
  if (input.root === null) {
    return deny(ReasonCode.INVALID_ARGUMENT, "this control plane has no import staging root, so a task that declares imports is not run", {
      reason: "IMPORT_STAGING_UNCONFIGURED",
    });
  }
  if (!RUN_OR_TASK_ID.test(input.runId) || !RUN_OR_TASK_ID.test(input.taskId)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the run or task id cannot name a staging directory", { reason: "IMPORT_STAGING_INVALID" });
  }
  const stagingDir = importStagingDir(input.root, input.runId, input.taskId);
  for (const dir of [input.root, join(input.root, input.runId), stagingDir]) {
    const stat = lstatOrNull(dir);
    if (stat === null) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the task's import staging directory does not exist; stage each file there under the hex of its sha256", {
        reason: "IMPORT_SOURCE_MISSING",
        stagingDir,
        missing: input.imports.map((entry) => entry.path).slice(0, 50),
      });
    }
    const problem = unownedDirectory(stat);
    if (problem !== null) {
      return deny(ReasonCode.STATE_PATH_INSECURE, `the import staging directory ${dir} is ${problem}`, {
        reason: "IMPORT_STAGING_INSECURE",
        stagingDir,
        problem,
      });
    }
  }
  const staged: StagedImport[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  const insecure: Array<{ path: string; problem: string }> = [];
  for (const entry of input.imports) {
    const read = readStaged(join(stagingDir, entry.sha256.slice("sha256:".length)), entry.size);
    if ("problem" in read) {
      if (read.problem === "missing") missing.push(entry.path);
      else if (read.problem === "mismatch") mismatched.push(entry.path);
      else insecure.push({ path: entry.path, problem: read.problem });
      continue;
    }
    if (sha256(read.bytes) !== entry.sha256) {
      mismatched.push(entry.path);
      continue;
    }
    staged.push({ ...entry, bytes: read.bytes });
  }
  const named = { stagingDir, missing: missing.slice(0, 50), mismatched: mismatched.slice(0, 50), insecure: insecure.slice(0, 50) };
  const refused: Array<{ path: string; why: string }> = [];
  const text: StagedImport[] = [];
  for (const entry of staged) {
    const content = classifyImport(entry.path, entry.bytes);
    if (content.kind === "refused") refused.push({ path: entry.path, why: content.why });
    else if (content.kind === "text") text.push(entry);
  }
  const textBytes = text.reduce((sum, entry) => sum + entry.size, 0);
  if (insecure.length > 0) {
    return deny(ReasonCode.STATE_PATH_INSECURE, "a staged import is not a regular file in its staging directory; nothing is imported", {
      reason: "IMPORT_SOURCE_INSECURE",
      ...named,
    });
  }
  if (mismatched.length > 0) {
    return deny(ReasonCode.IMPORT_DIGEST_MISMATCH, "a staged import is not the size or sha256 its manifest entry declares; nothing is imported", {
      reason: "IMPORT_DIGEST_MISMATCH",
      ...named,
    });
  }
  if (missing.length > 0) {
    return deny(ReasonCode.EVIDENCE_MISSING, "a manifest entry has no staged file; nothing is imported", { reason: "IMPORT_SOURCE_MISSING", ...named });
  }
  if (refused.length > 0) {
    return deny(ReasonCode.IMPORT_CONTENT_REFUSED, "an import is not a complete structurally valid allowed image or font; nothing is imported", {
      reason: "IMPORT_NOT_REVIEWABLE",
      refused: refused.slice(0, 50),
    });
  }
  if (textBytes > IMPORT_MAX_TEXT_BYTES) {
    return deny(ReasonCode.IMPORT_CONTENT_REFUSED, `a task imports at most ${IMPORT_MAX_TEXT_BYTES} bytes of text, which review reads as patch; nothing is imported`, {
      reason: "IMPORT_TEXT_TOO_LARGE",
      textBytes,
      limit: IMPORT_MAX_TEXT_BYTES,
      text: text.map((entry) => entry.path).slice(0, 50),
    });
  }
  return allow(ReasonCode.OK, staged);
};

/**
 * Whether every import can be created in the checkout: no directory on its path is a symlink or a
 * file, and nothing stands at the path itself. An import never replaces a file.
 */
export const checkImportDestinations = (worktree: string, imports: readonly TaskImport[]): Decision<void> => {
  const symlinked: string[] = [];
  const occupied: string[] = [];
  for (const entry of imports) {
    let cursor = worktree;
    let blocked = false;
    for (const segment of entry.path.split("/").slice(0, -1)) {
      cursor = join(cursor, segment);
      const stat = lstatOrNull(cursor);
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        symlinked.push(entry.path);
        blocked = true;
        break;
      }
      if (!stat.isDirectory()) {
        occupied.push(entry.path);
        blocked = true;
        break;
      }
    }
    if (!blocked && lstatOrNull(join(worktree, entry.path)) !== null) occupied.push(entry.path);
  }
  if (symlinked.length > 0) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "a directory on an import's path is a symbolic link; nothing is imported", {
      reason: "IMPORT_DESTINATION_SYMLINK",
      symlinked: symlinked.slice(0, 50),
    });
  }
  if (occupied.length > 0) {
    return deny(ReasonCode.CONFLICT, "something already stands at an import's path or one of its directories; an import only adds files", {
      reason: "IMPORT_DESTINATION_EXISTS",
      occupied: occupied.slice(0, 50),
    });
  }
  return allow(ReasonCode.OK, undefined);
};

/** What one import attempt created, each with the identity it was created with. */
export interface WrittenImports {
  files: Array<{ path: string; dev: number; ino: number }>;
  directories: Array<{ path: string; dev: number; ino: number }>;
}

/**
 * Creates every import in the checkout: missing directories one at a time, each file create-only
 * (`O_EXCL`, never through a symlink) with exactly the verified bytes. Stops at the first error and
 * returns what it created, so the caller can take back exactly that.
 */
export const writeImports = (worktree: string, staged: readonly StagedImport[]): { written: WrittenImports; error: string | null } => {
  const written: WrittenImports = { files: [], directories: [] };
  try {
    for (const entry of staged) {
      const segments = entry.path.split("/");
      let relative = "";
      for (const segment of segments.slice(0, -1)) {
        relative = relative ? `${relative}/${segment}` : segment;
        const full = join(worktree, relative);
        const stat = lstatOrNull(full);
        if (stat === null) {
          mkdirSync(full, { mode: 0o755 });
          const made = lstatSync(full);
          written.directories.push({ path: relative, dev: made.dev, ino: made.ino });
        } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`${relative} is not a directory`);
        }
      }
      const fd = openSync(join(worktree, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        const made = fstatSync(fd);
        written.files.push({ path: entry.path, dev: made.dev, ino: made.ino });
        let offset = 0;
        while (offset < entry.bytes.length) offset += writeSync(fd, entry.bytes, offset, entry.bytes.length - offset, offset);
      } finally {
        closeSync(fd);
      }
    }
    return { written, error: null };
  } catch (error) {
    return { written, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
};

/**
 * Takes back what one import attempt created: a file or directory is removed only while it is still
 * the one this attempt created (same device and inode), and a directory only when empty. Returns the
 * paths left in place.
 */
export const undoImports = (worktree: string, written: WrittenImports): string[] => {
  const left: string[] = [];
  const same = (path: string, created: { dev: number; ino: number }, kind: "file" | "directory"): boolean => {
    const stat = lstatOrNull(join(worktree, path));
    return stat !== null && stat.dev === created.dev && stat.ino === created.ino && (kind === "file" ? stat.isFile() : stat.isDirectory());
  };
  for (const file of [...written.files].reverse()) {
    try {
      if (same(file.path, file, "file")) unlinkSync(join(worktree, file.path));
      else if (lstatOrNull(join(worktree, file.path)) !== null) left.push(file.path);
    } catch {
      left.push(file.path);
    }
  }
  for (const directory of [...written.directories].reverse()) {
    try {
      if (same(directory.path, directory, "directory")) rmdirSync(join(worktree, directory.path));
      else if (lstatOrNull(join(worktree, directory.path)) !== null) left.push(directory.path);
    } catch {
      left.push(directory.path);
    }
  }
  return left;
};

/**
 * The imports a scan of the checkout against its base (`scanAgainst` entries) does not show as
 * imported: each must be a regular, non-executable file with its declared sha256. After the import
 * this names one git does not see (an ignored path, say); after a turn, one the worker changed.
 */
export const importsNotHeld = (
  imports: readonly TaskImport[],
  entries: readonly { path: string; mode: string | null; sha256: string | null }[],
): string[] => {
  const scanned = new Map(entries.map((entry) => [entry.path, entry]));
  return imports
    .filter((entry) => scanned.get(entry.path)?.mode !== "100644" || scanned.get(entry.path)?.sha256 !== entry.sha256)
    .map((entry) => entry.path);
};
