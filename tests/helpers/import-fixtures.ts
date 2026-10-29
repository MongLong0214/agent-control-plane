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

const png = (compressed: Buffer, beforeData: readonly Buffer[] = []): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
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

/** A structurally valid, IDAT-backed PNG whose complete encoded size is exactly 50 MiB. */
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

const rebuildTrueType = (replacements: ReadonlyMap<string, Buffer>): Buffer => {
  const count = VALID_TTF.readUInt16BE(4);
  const tables = Array.from({ length: count }, (_, index) => {
    const record = 12 + index * 16;
    const tag = VALID_TTF.subarray(record, record + 4).toString("ascii");
    const offset = VALID_TTF.readUInt32BE(record + 8);
    const length = VALID_TTF.readUInt32BE(record + 12);
    return { tag, bytes: Buffer.from(replacements.get(tag) ?? VALID_TTF.subarray(offset, offset + length)) };
  });
  let size = (12 + count * 16 + 3) & ~3;
  for (const table of tables) size += (table.bytes.length + 3) & ~3;
  const font = Buffer.alloc(size);
  VALID_TTF.copy(font, 0, 0, 12);
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
