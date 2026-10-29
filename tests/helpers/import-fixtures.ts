import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

const crc32 = (parts: readonly Buffer[]): number => {
  let crc = 0xffffffff;
  for (const bytes of parts) for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32([typeBytes, data]), 8 + data.length);
  return output;
};

const png = (compressed: Buffer, beforeData: readonly Buffer[] = [], width = 1): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...beforeData,
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** A complete 1x1 RGBA PNG; up to four supplied bytes select its one pixel. */
export const validPng = (pixel: Buffer = Buffer.alloc(0)): Buffer => {
  if (pixel.length > 4) throw new Error("the fixture pixel has at most four bytes");
  const rgba = Buffer.from([0, 0, 0, 0xff]);
  pixel.copy(rgba);
  return png(deflateSync(Buffer.concat([Buffer.from([0]), rgba])));
};

/** Harmless bytes the polyglot fixtures carry where a payload would be: nothing here is an archive or a program. */
export const INERT_MARKER = Buffer.from("ACP-INERT-TEST-MARKER", "ascii");
/** The four-byte zip local-file and end-of-central-directory record signatures, alone. */
export const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const ZIP_END_OF_DIRECTORY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** A valid one-row RGBA PNG whose pixels are `pixels`, deflate-stored so they appear verbatim in its IDAT. */
export const pngWithStoredPixels = (pixels: Buffer): Buffer => {
  const width = Math.ceil(pixels.length / 4);
  const row = Buffer.alloc(1 + width * 4);
  pixels.copy(row, 1);
  return png(deflateSync(row, { level: 0 }), [], width);
};

/** CRC-valid PNG whose one IDAT contains a valid stream followed by bytes the inflater may ignore. */
export const pngWithIdatSuffix = (suffix: Buffer): Buffer =>
  png(Buffer.concat([deflateSync(Buffer.from([0, 0xff, 0, 0, 0xff])), suffix]));

/** Structurally framed PNG with executable text hidden in a private ancillary chunk. */
export const pngWithPrivateAncillary = (payload: Buffer): Buffer =>
  png(deflateSync(Buffer.from([0, 0xff, 0, 0, 0xff])), [chunk("raNd", payload)]);

/** A truecolor PNG whose optional palette has 257 entries, one beyond the universal PNG maximum. */
export const pngWithOversizedPalette = (): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 16;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", Buffer.alloc(257 * 3)),
    chunk("IDAT", deflateSync(Buffer.alloc(9))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const storedZlibZeros = (length: number): Buffer => {
  const blocks = Math.ceil(length / 0xffff);
  const output = Buffer.alloc(length + 6 + blocks * 5);
  output[0] = 0x78;
  output[1] = 0x01;
  let cursor = 2;
  let remaining = length;
  while (remaining > 0) {
    const block = Math.min(remaining, 0xffff);
    output[cursor] = remaining === block ? 1 : 0;
    output.writeUInt16LE(block, cursor + 1);
    output.writeUInt16LE(0xffff ^ block, cursor + 3);
    cursor += 5 + block;
    remaining -= block;
  }
  output.writeUInt32BE(((length % 65521) << 16) | 1, cursor);
  return output;
};

/** A selected-check-admitted, IDAT-backed PNG whose encoded size is exactly 50 MiB. */
export const validPngOfSize = (size: number, fill: number): Buffer => {
  if (size !== 50 * 1024 * 1024) throw new Error("the maximum-size PNG fixture is defined only at 50 MiB");
  const width = 100;
  const height = 130_732;
  const rawLength = height * (1 + 4 * width);
  const compressed = storedZlibZeros(rawLength);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const dataChunks = Array.from({ length: 99 }, (_, index) => {
    const start = Math.floor((index * compressed.length) / 99);
    const end = Math.floor(((index + 1) * compressed.length) / 99);
    return chunk("IDAT", compressed.subarray(start, end));
  });
  const output = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("gAMA", Buffer.from([0x00, 0x00, 0xb1, 0x8f])),
    chunk("sRGB", Buffer.from([fill & 3])),
    ...dataChunks,
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (output.length !== size) throw new Error(`maximum-size PNG is ${output.length}, expected ${size}`);
  return output;
};

/** A tiny valid TrueType font generated with fontTools FontBuilder, embedded for hermetic tests. */
export const VALID_TTF = Buffer.from(
  "AAEAAAAKAIAAAwAgT1MvMkUAQ7AAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZC0m1HwAAACsAAAANmhoZWEDIgEuAAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lDSdWxAAAAdAAAAEIcG9zdAAHAAAAAALYAAAAJgABAAAAAQAAnKO6rF8PPPUAAwPoAAAAAOcISc4AAAAA5whJzgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAAH0AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAAAAAAAAAAAAAAKAH4AAQAAAAAAAQAIAAAAAQAAAAAAAgAHAAgAAQAAAAAAAwAQAA8AAQAAAAAABAAQAA8AAQAAAAAABgAPAB8AAwABBAkAAQAQAC4AAwABBAkAAgAOAD4AAwABBAkAAwAgAEwAAwABBAkABAAgAEwAAwABBAkABgAeAGxBQ1AgVGVzdFJlZ3VsYXJBQ1AgVGVzdCBSZWd1bGFyQUNQVGVzdC1SZWd1bGFyAEEAQwBQACAAVABlAHMAdABSAGUAZwB1AGwAYQByAEEAQwBQACAAVABlAHMAdAAgAFIAZQBnAHUAbABhAHIAQQBDAFAAVABlAHMAdAAtAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAwAA",
  "base64",
);

const tableRecord = (font: Buffer, wanted: string): { record: number; offset: number; length: number } => {
  const count = font.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (font.subarray(record, record + 4).toString("ascii") === wanted) {
      return { record, offset: font.readUInt32BE(record + 8), length: font.readUInt32BE(record + 12) };
    }
  }
  throw new Error(`fixture has no ${wanted} table`);
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

const repairTrueTypeChecksums = (font: Buffer, changedTag: string): Buffer => {
  const changed = tableRecord(font, changedTag);
  const head = tableRecord(font, "head");
  font.writeUInt32BE(0, head.offset + 8);
  font.writeUInt32BE(sfntChecksum(font.subarray(changed.offset, changed.offset + changed.length), changedTag === "head"), changed.record + 4);
  font.writeUInt32BE((0xb1b0afba - sfntChecksum(font)) >>> 0, head.offset + 8);
  return font;
};

/** The valid font with tables replaced and others added, its directory, offsets and checksums rebuilt. */
const rebuildTrueType = (replacements: ReadonlyMap<string, Buffer>, added: ReadonlyMap<string, Buffer> = new Map()): Buffer => {
  const tables = [
    ...Array.from({ length: VALID_TTF.readUInt16BE(4) }, (_, index) => {
      const record = 12 + index * 16;
      const tag = VALID_TTF.subarray(record, record + 4).toString("ascii");
      const offset = VALID_TTF.readUInt32BE(record + 8);
      const length = VALID_TTF.readUInt32BE(record + 12);
      return { tag, bytes: Buffer.from(replacements.get(tag) ?? VALID_TTF.subarray(offset, offset + length)) };
    }),
    ...[...added].map(([tag, bytes]) => ({ tag, bytes: Buffer.from(bytes) })),
  ].sort((left, right) => (left.tag < right.tag ? -1 : 1));
  const count = tables.length;
  let size = (12 + count * 16 + 3) & ~3;
  for (const table of tables) size += (table.bytes.length + 3) & ~3;
  const font = Buffer.alloc(size);
  const power = 2 ** Math.floor(Math.log2(count));
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(count, 4);
  font.writeUInt16BE(power * 16, 6);
  font.writeUInt16BE(Math.log2(power), 8);
  font.writeUInt16BE(count * 16 - power * 16, 10);
  let offset = (12 + count * 16 + 3) & ~3;
  let headOffset = 0;
  for (const [index, table] of tables.entries()) {
    const record = 12 + index * 16;
    font.write(table.tag, record, 4, "ascii");
    if (table.tag === "head") {
      table.bytes.writeUInt32BE(0, 8);
      headOffset = offset;
    }
    font.writeUInt32BE(sfntChecksum(table.bytes, table.tag === "head"), record + 4);
    font.writeUInt32BE(offset, record + 8);
    font.writeUInt32BE(table.bytes.length, record + 12);
    table.bytes.copy(font, offset);
    offset += (table.bytes.length + 3) & ~3;
  }
  font.writeUInt32BE((0xb1b0afba - sfntChecksum(font)) >>> 0, headOffset + 8);
  return font;
};

/** The valid font with one more, checksum-valid table under `tag` holding `data`. */
export const ttfWithExtraTable = (tag: string, data: Buffer): Buffer => rebuildTrueType(new Map(), new Map([[tag, data]]));

/** The valid font with `bytes` written over the start of its first name string, which it references. */
export const ttfWithNameStringBytes = (bytes: Buffer): Buffer => {
  const font = Buffer.from(VALID_TTF);
  const name = tableRecord(font, "name");
  if (bytes.length > font.readUInt16BE(name.offset + 6 + 8)) throw new Error("the fixture bytes exceed the first name string");
  bytes.copy(font, name.offset + font.readUInt16BE(name.offset + 4) + font.readUInt16BE(name.offset + 6 + 10));
  return repairTrueTypeChecksums(font, "name");
};

export const ttfWithNonzeroGlyfPadding = (): Buffer => {
  const font = Buffer.from(VALID_TTF);
  const glyf = tableRecord(font, "glyf");
  font[glyf.offset + glyf.length - 1] = 0x41;
  return repairTrueTypeChecksums(font, "glyf");
};

export const ttfWithCmapSubtableOutside = (): Buffer => {
  const font = Buffer.from(VALID_TTF);
  const cmap = tableRecord(font, "cmap");
  font.writeUInt32BE(0xfffffff0, cmap.offset + 8);
  return repairTrueTypeChecksums(font, "cmap");
};

export const ttfWithNameStringOutside = (): Buffer => {
  const font = Buffer.from(VALID_TTF);
  const name = tableRecord(font, "name");
  font.writeUInt16BE(0xffff, name.offset + 16);
  return repairTrueTypeChecksums(font, "name");
};

export const ttfWithShortGlyphRecords = (): Buffer => {
  const loca = Buffer.alloc(6);
  loca.writeUInt16BE(0, 0);
  loca.writeUInt16BE(2, 2);
  loca.writeUInt16BE(6, 4);
  return rebuildTrueType(new Map([
    ["glyf", Buffer.from("MZPAYLOAD!!!")],
    ["loca", loca],
  ]));
};

export const ttfWithHiddenHmtxPayload = (): Buffer => {
  const original = tableRecord(VALID_TTF, "hmtx");
  const payload = Buffer.alloc(24, 0x41);
  Buffer.from("MZPAYLOAD").copy(payload);
  return rebuildTrueType(new Map([
    ["hmtx", Buffer.concat([VALID_TTF.subarray(original.offset, original.offset + original.length), payload])],
  ]));
};

const mutateSharedFormat4 = (mutate: (font: Buffer, subtable: number) => void): Buffer => {
  const font = Buffer.from(VALID_TTF);
  const cmap = tableRecord(font, "cmap");
  const subtable = cmap.offset + font.readUInt32BE(cmap.offset + 8);
  mutate(font, subtable);
  return repairTrueTypeChecksums(font, "cmap");
};

export const ttfWithShortFormat4 = (): Buffer =>
  mutateSharedFormat4((font, subtable) => font.writeUInt16BE(4, subtable + 2));

export const ttfWithBadFormat4Search = (): Buffer =>
  mutateSharedFormat4((font, subtable) => font.writeUInt16BE(0, subtable + 8));

export const ttfWithFormat4RangeOutside = (): Buffer =>
  mutateSharedFormat4((font, subtable) => {
    const segments = font.readUInt16BE(subtable + 6) / 2;
    const rangeOffsets = subtable + 16 + segments * 6;
    font.writeUInt16BE(0xfffe, rangeOffsets);
  });

export const ttfWithUncoveredCmapPayload = (): Buffer => {
  const cmap = tableRecord(VALID_TTF, "cmap");
  return rebuildTrueType(new Map([
    ["cmap", Buffer.concat([VALID_TTF.subarray(cmap.offset, cmap.offset + cmap.length), Buffer.from("MZPAYLOAD")])],
  ]));
};

const ttfWithExtendedFormat4 = (glyph: number, referenced: boolean): Buffer => {
  const cmapRecord = tableRecord(VALID_TTF, "cmap");
  const cmap = Buffer.concat([
    VALID_TTF.subarray(cmapRecord.offset, cmapRecord.offset + cmapRecord.length),
    Buffer.from([glyph >>> 8, glyph & 0xff]),
  ]);
  const subtable = cmap.readUInt32BE(8);
  cmap.writeUInt16BE(cmap.length - subtable, subtable + 2);
  if (referenced) {
    const segments = cmap.readUInt16BE(subtable + 6) / 2;
    const rangeOffsets = subtable + 16 + segments * 6;
    cmap.writeUInt16BE(cmap.length - (rangeOffsets + 2), rangeOffsets);
  }
  return rebuildTrueType(new Map([["cmap", cmap]]));
};

export const ttfWithUnreferencedFormat4Glyph = (): Buffer => ttfWithExtendedFormat4(0x4d5a, false);
export const ttfWithMissingFormat4Glyph = (): Buffer => ttfWithExtendedFormat4(0xffff, true);

const compositeGlyph = (component: number): Buffer => {
  const glyph = Buffer.alloc(18);
  glyph.writeInt16BE(-1, 0);
  glyph.writeUInt16BE(0x0003, 10);
  glyph.writeUInt16BE(component, 12);
  return glyph;
};

const ttfWithGlyphZero = (glyph: Buffer, configureMaxp?: (maxp: Buffer) => void): Buffer => {
  if (glyph.length % 2 !== 0) throw new Error("short loca needs an even glyph record");
  const loca = Buffer.alloc(6);
  loca.writeUInt16BE(0, 0);
  loca.writeUInt16BE(glyph.length / 2, 2);
  loca.writeUInt16BE(glyph.length / 2, 4);
  const maxpSource = tableRecord(VALID_TTF, "maxp");
  const maxp = Buffer.from(VALID_TTF.subarray(maxpSource.offset, maxpSource.offset + maxpSource.length));
  configureMaxp?.(maxp);
  return rebuildTrueType(new Map([
    ["glyf", glyph],
    ["loca", loca],
    ["maxp", maxp],
  ]));
};

const oneComponentGlyph = (flags: number, component: number, firstArg = 0, secondArg = 0, contours = -1): Buffer => {
  const words = (flags & 0x0001) !== 0;
  const glyph = Buffer.alloc(10 + 4 + (words ? 4 : 2));
  glyph.writeInt16BE(contours, 0);
  glyph.writeUInt16BE(flags, 10);
  glyph.writeUInt16BE(component, 12);
  if (words) {
    glyph.writeUInt16BE(firstArg, 14);
    glyph.writeUInt16BE(secondArg, 16);
  } else {
    glyph[14] = firstArg;
    glyph[15] = secondArg;
  }
  return glyph;
};

export const ttfWithCompositeContoursMinusTwo = (): Buffer =>
  ttfWithGlyphZero(oneComponentGlyph(0x0003, 1, 0, 0, -2));

export const ttfWithCompositeReservedFlag = (): Buffer =>
  ttfWithGlyphZero(oneComponentGlyph(0x8003, 1));

export const ttfWithConflictingOffsetFlags = (): Buffer =>
  ttfWithGlyphZero(oneComponentGlyph(0x1803, 1));

export const ttfWithNonfinalInstructions = (): Buffer => {
  const glyph = Buffer.alloc(26);
  glyph.writeInt16BE(-1, 0);
  glyph.writeUInt16BE(0x0123, 10);
  glyph.writeUInt16BE(1, 12);
  glyph.writeUInt16BE(0x0003, 18);
  glyph.writeUInt16BE(1, 20);
  return ttfWithGlyphZero(glyph);
};

export const ttfWithPointArgsOutside = (): Buffer =>
  ttfWithGlyphZero(oneComponentGlyph(0x0001, 1, 0xffff, 0xffff));

const simplePointGlyph = (flag: number, xBytes: Buffer): Buffer => {
  const glyph = Buffer.alloc(10 + 2 + 2 + 1 + xBytes.length);
  glyph.writeInt16BE(1, 0);
  glyph.writeUInt16BE(0, 10);
  glyph.writeUInt16BE(0, 12);
  glyph[14] = flag;
  xBytes.copy(glyph, 15);
  return glyph;
};

const pointMaxp = (maxp: Buffer): void => {
  maxp.writeUInt16BE(1, 6);
  maxp.writeUInt16BE(1, 8);
};

export const ttfWithReservedSimpleFlag = (): Buffer =>
  ttfWithGlyphZero(simplePointGlyph(0xb1, Buffer.from([0])), pointMaxp);

export const ttfWithWrongSimpleBbox = (): Buffer =>
  ttfWithGlyphZero(simplePointGlyph(0x33, Buffer.from([0xff])), pointMaxp);

export const ttfWithInstructionsPastMaxp = (): Buffer => {
  const glyph = Buffer.alloc(16);
  glyph.writeInt16BE(0, 0);
  glyph.writeUInt16BE(4, 10);
  Buffer.from([0xb0, 0x00, 0x2b, 0x2d]).copy(glyph, 12);
  return ttfWithGlyphZero(glyph);
};

export const ttfWithActiveInstructions = (): Buffer => {
  const glyph = Buffer.alloc(16);
  glyph.writeInt16BE(0, 0);
  glyph.writeUInt16BE(4, 10);
  Buffer.from([0xb0, 0x00, 0x2b, 0x2d]).copy(glyph, 12);
  return ttfWithGlyphZero(glyph, (maxp) => maxp.writeUInt16BE(4, 26));
};

export const pngWithActivePixelBytes = (): Buffer => {
  const pixels = Buffer.from("<?php echo 'EXECUTED'; ?>");
  const width = Math.ceil(pixels.length / 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  pixels.copy(row, 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(row)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const ttfWithCompositeLinks = (links: readonly number[]): Buffer => {
  const glyphCount = links.length + 1;
  const glyf = Buffer.concat(links.map(compositeGlyph));
  const loca = Buffer.alloc((glyphCount + 1) * 2);
  for (let index = 0; index <= glyphCount; index += 1) loca.writeUInt16BE((Math.min(index, links.length) * 18) / 2, index * 2);
  const maxpSource = tableRecord(VALID_TTF, "maxp");
  const maxp = Buffer.from(VALID_TTF.subarray(maxpSource.offset, maxpSource.offset + maxpSource.length));
  maxp.writeUInt16BE(glyphCount, 4);
  maxp.writeUInt16BE(1, 28);
  maxp.writeUInt16BE(links.length, 30);
  const hmtxSource = tableRecord(VALID_TTF, "hmtx");
  const hmtx = Buffer.alloc(4 + (glyphCount - 1) * 2);
  VALID_TTF.copy(hmtx, 0, hmtxSource.offset, hmtxSource.offset + 4);
  // A version 3.0 post header names no glyphs, so it holds for any glyph count.
  const postSource = tableRecord(VALID_TTF, "post");
  const post = Buffer.from(VALID_TTF.subarray(postSource.offset, postSource.offset + 32));
  post.writeUInt32BE(0x00030000, 0);
  return rebuildTrueType(new Map([
    ["glyf", glyf],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["post", post],
  ]));
};

export const ttfWithSelfComposite = (): Buffer => ttfWithCompositeLinks([0]);
export const ttfWithCompositeCycle = (): Buffer => ttfWithCompositeLinks([1, 0]);
export const ttfWithCompositeChain = (links: number): Buffer =>
  ttfWithCompositeLinks(Array.from({ length: links }, (_, index) => index + 1));
