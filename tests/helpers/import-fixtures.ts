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

/** A complete 1x1 RGBA PNG; `payload` lives in one valid private ancillary chunk. */
export const validPng = (payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("raNd", payload),
    chunk("IDAT", deflateSync(Buffer.from([0, 0xff, 0, 0, 0xff]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** A structurally valid PNG whose complete encoded size is exactly `size`. */
export const validPngOfSize = (size: number, fill: number): Buffer => {
  const empty = validPng();
  if (size < empty.length) throw new Error(`PNG size ${size} is below fixture overhead ${empty.length}`);
  return validPng(Buffer.alloc(size - empty.length, fill));
};

/** A tiny valid TrueType font generated with fontTools FontBuilder, embedded for hermetic tests. */
export const VALID_TTF = Buffer.from(
  "AAEAAAAKAIAAAwAgT1MvMkUAQ7AAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZC0m1HwAAACsAAAANmhoZWEDIgEuAAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lDSdWxAAAAdAAAAEIcG9zdAAHAAAAAALYAAAAJgABAAAAAQAAnKO6rF8PPPUAAwPoAAAAAOcISc4AAAAA5whJzgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAAH0AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAAAAAAAAAAAAAAKAH4AAQAAAAAAAQAIAAAAAQAAAAAAAgAHAAgAAQAAAAAAAwAQAA8AAQAAAAAABAAQAA8AAQAAAAAABgAPAB8AAwABBAkAAQAQAC4AAwABBAkAAgAOAD4AAwABBAkAAwAgAEwAAwABBAkABAAgAEwAAwABBAkABgAeAGxBQ1AgVGVzdFJlZ3VsYXJBQ1AgVGVzdCBSZWd1bGFyQUNQVGVzdC1SZWd1bGFyAEEAQwBQACAAVABlAHMAdABSAGUAZwB1AGwAYQByAEEAQwBQACAAVABlAHMAdAAgAFIAZQBnAHUAbABhAHIAQQBDAFAAVABlAHMAdAAtAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAwAA",
  "base64",
);
