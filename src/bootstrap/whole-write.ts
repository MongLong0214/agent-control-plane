import { writeSync } from "node:fs";

/**
 * #246 C3, review 1076-R4 — every byte of `text`, written to `descriptor` from its current position,
 * or a throw. `writeSync` may write less than it was given and say so only in the count it returns:
 * a file-size limit, a full disk or an interrupted call returns a short count, and the fsync after it
 * then succeeds on what was written. A durable record the bootstrap relies on before it sends a
 * request — the approval anchor, a withheld request and the consumption of its exemption, the GitHub
 * ledger — is reported written only when all of it was. The remainder is written until none is
 * left; a call that writes nothing, or fails, throws, and the caller then sends nothing. What was
 * written before the failure stays as it is: a record cut short is not a record, and its reader
 * refuses it.
 */
export const writeWholeSync = (descriptor: number, text: string): void => {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error(`a record write stopped after ${offset} of ${bytes.length} bytes`);
    }
    offset += written;
  }
};

/**
 * #246 C3, review 1076-R5 — the bytes a record is written as: its JSON, indented by two, and the
 * newline that ends it. Every record the bootstrap relies on before a request is written in exactly
 * this framing, so a reader can tell a record written whole from one cut short.
 */
export const frameRecord = (content: unknown): string => `${JSON.stringify(content, null, 2)}\n`;

/**
 * The content of a record read back, or null unless its bytes are exactly the framing of what they
 * parse to, the closing newline included. A write cut short leaves a prefix; the one prefix that
 * still parses — every byte but that final newline — is not the record, so it is refused rather than
 * repaired: nothing is appended, trimmed or otherwise normalised before the comparison.
 */
export const unframeRecord = (bytes: Buffer): unknown => {
  let content: unknown;
  try {
    content = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return Buffer.from(frameRecord(content), "utf8").equals(bytes) ? content : null;
};
