import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The blobs #762's evidence rests on, pinned by content (#763).
 *
 * These four files are the whole argument: the production migrations, the deployment's own v25
 * schema, the owner trace derived from running one against the other, and the receipts read out
 * of the preserved backup. Review's finding was not that any value in them is wrong — the CEO
 * compared the receipts field-for-field against the read-only backup and they match — but that
 * the tests read them as *both* the input and the standard, so a coordinated edit to a production
 * file and its fixture passes.
 *
 * An independent authority now fixes these digests. It was produced and verified outside this
 * repository against the preserved backup — private local artifact redacted — and reported the
 * receipts bound field-for-field and the typed owner trace at 42 expected / 42 observed with zero
 * missing, extra, type or owner mismatches.
 *
 * The digests below are that authority's, transcribed as constants. They are deliberately **not**
 * recomputed from the files they describe: a pin a run derives from its own input agrees with
 * whatever it is handed, which is the defect these replace. Nothing here reads a path outside the
 * repository, so the check is the same in CI as it is locally.
 */
/** The trace bytes the authority fixed. */
export const TRACE_BYTES_SHA256 =
  "652b8afcd407298f623e885b8fe016e135877ee684f43c7450859e3b32f1423b";

/** The receipt bytes the authority fixed, having compared them to the preserved backup. */
export const RECEIPT_BYTES_SHA256 =
  "aa90c6af77754fce9861cb4f57501879c24f66f5616cf46225c5375adfd2a19d";

export const FROZEN_BLOBS: ReadonlyArray<{ path: string; sha256: string }> = [
  {
    path: "src/db/migrations.ts",
    sha256: "23d35db447e90a79d487ea3cc0b01c354e75a7e42af4e604afdf981bf7506dfb",
  },
  {
    path: "tests/fixtures/schema-v25-lineage.sql",
    sha256: "77826a5a8704bd2bced279eebf5b6c1f1bd559e4a89ebb26d8042ade0a05c4aa",
  },
  {
    path: "tests/fixtures/v25-owner-trace.json",
    sha256: TRACE_BYTES_SHA256,
  },
  {
    path: "tests/fixtures/v25-lineage-receipts.json",
    sha256: RECEIPT_BYTES_SHA256,
  },
];

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const digestOfFile = (relativePath: string): string =>
  createHash("sha256").update(readFileSync(`${repoRoot}/${relativePath}`)).digest("hex");

/** `path: actual` for every pinned blob whose bytes no longer match. */
export const driftedBlobs = (): string[] =>
  FROZEN_BLOBS.flatMap((blob) => {
    const actual = digestOfFile(blob.path);
    return actual === blob.sha256 ? [] : [`${blob.path}: ${actual} (pinned ${blob.sha256})`];
  });

/**
 * A JSON parser that refuses the shapes an `as T` cast waves through.
 *
 * Three refusals, each for a way the trace could stop describing what it claims while still
 * parsing. `JSON.parse` keeps the last of two identical keys and discards the first silently, so
 * a duplicated object name loses an ownership; an escaped spelling (`alpha`) is the same key
 * to the parser and a different string to a regular expression over the raw text; and a field
 * nobody reads is a field nobody notices changing.
 */
export const parseClosedJson = <T>(
  text: string,
  shape: {
    allowedTopLevel: readonly string[];
    entriesKey: string;
    entryShape: Readonly<Record<string, "string" | "number">>;
  },
): T => {
  rejectDuplicateKeys(text);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frozen authority is not a JSON object");
  }
  const unknown = Object.keys(parsed).filter((key) => !shape.allowedTopLevel.includes(key));
  if (unknown.length > 0) {
    throw new Error(`frozen authority has unknown field(s): ${unknown.sort().join(", ")}`);
  }
  const entries = parsed[shape.entriesKey];
  if (typeof entries !== "object" || entries === null) {
    throw new Error(`frozen authority's ${shape.entriesKey} is not an object or array`);
  }
  // Both shapes are frozen bytes this cannot alter: the trace keys its entries by object name,
  // the receipts are an ordered list. Validating either the same way is what lets the pin stay on
  // the file rather than on a form convenient to check.
  const named: Array<[string, unknown]> = Array.isArray(entries)
    ? entries.map((entry, index) => [`[${index}]`, entry])
    : Object.entries(entries as Record<string, unknown>);
  for (const [name, entry] of named) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`frozen authority entry ${name} is not an object`);
    }
    const fields = entry as Record<string, unknown>;
    const extra = Object.keys(fields).filter((key) => !(key in shape.entryShape));
    if (extra.length > 0) {
      throw new Error(`frozen authority entry ${name} has unknown field(s): ${extra.sort().join(", ")}`);
    }
    for (const [field, kind] of Object.entries(shape.entryShape)) {
      if (typeof fields[field] !== kind) {
        throw new Error(
          `frozen authority entry ${name}.${field} is ${typeof fields[field]}, expected ${kind}`,
        );
      }
    }
  }
  return parsed as T;
};

/**
 * Duplicate keys, compared after unescaping — `alpha` and `alpha` are one key to the parser.
 *
 * Walks the text rather than matching a line shape: the previous version keyed on four spaces of
 * indentation, so the same duplicate written at a different depth went straight through.
 */
const rejectDuplicateKeys = (text: string): void => {
  const duplicates = new Set<string>();
  const stack: Array<Set<string>> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") {
      stack.push(new Set());
      index += 1;
      continue;
    }
    if (char === "}") {
      stack.pop();
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      index += text[index] === "\\" ? 2 : 1;
    }
    index += 1;
    const raw = text.slice(start, index);
    // A string is a key when the next non-space character is a colon.
    let lookahead = index;
    while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead += 1;
    if (text[lookahead] !== ":") continue;
    const key = JSON.parse(raw) as string;
    const scope = stack[stack.length - 1];
    if (!scope) continue;
    if (scope.has(key)) duplicates.add(key);
    scope.add(key);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `frozen authority has duplicate key(s): ${[...duplicates].sort().join(", ")}`,
    );
  }
};
