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

/**
 * #760 round 3 §5(a) — reviewed re-pin, not a silent one.
 *
 * `src/db/migrations.ts` changed: `SCHEMA_VERSION` 36 → 37, one new `v37` entry appended to the
 * end of the frozen `MIGRATIONS` array (a doc comment plus a single-statement `apply`:
 * `INSERT OR IGNORE INTO executor_kinds (executor_kind) VALUES ('claude-cli')`), and a prose-only
 * correction to that comment's migration-id reference (v21 → v22) after review found the first
 * name wrong. No existing migration's `id`, `fromVersion`, `toVersion`, or `apply` body was
 * altered — the exact property `#762` and `verify-migrations-are-immutable.mjs` both check.
 *
 * Reviewed by the coordinator against `git diff <pre-#760-round-3>..HEAD -- src/db/migrations.ts`
 * (27 insertions, 1 deletion against the base before the `v37` commit): confirmed the diff is
 * exactly the three changes above, appends rather than rewrites the frozen array, and adds one row
 * to an existing table without altering any `sqlite_master` ownership fact. This pin is that
 * review's conclusion, transcribed — not a hash this repository derived from its own input and
 * therefore agrees with by construction, which is the defect this file's own pins exist to avoid.
 */
export const FROZEN_BLOBS: ReadonlyArray<{ path: string; sha256: string }> = [
  {
    path: "src/db/migrations.ts",
    sha256: "e434753a3ff129cde765f6f17566fe7c99c68be085272c72a96cdad1b9c538a1",
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

/** What a closed schema has to state, so that "closed" is a property and not a hope. */
export interface ClosedSchema {
  /** Required top-level fields and their exact runtime kinds. Missing or wrong is a failure. */
  topLevel: Readonly<Record<string, "string" | "number">>;
  /** The field holding the entries, and whether it is a keyed record or an ordered array. */
  entriesKey: string;
  entriesKind: "record" | "array";
  entryShape: Readonly<Record<string, "string" | "number">>;
}

/** Own-property test that a `__proto__` or `constructor` key cannot satisfy. */
const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/**
 * A JSON parser that refuses the shapes an `as T` cast waves through.
 *
 * The first version of this was called closed and was not. Review found four ways through, each
 * of which this now states rather than assumes:
 *
 *   - it listed *allowed* top-level fields and never required any, so a document with only its
 *     entries — no provenance, no baseline version — parsed;
 *   - it took the entries as either a record or an array, so the trace's keyed map and the
 *     receipts' ordered list were interchangeable;
 *   - it tested field membership with `in`, which walks the prototype chain, so `__proto__`,
 *     `constructor` and `toString` were allowed fields on every entry;
 *   - and one consumer bypassed it entirely with its own cast.
 *
 * The duplicate-key walk below is scope-aware on purpose: the same field name in two different
 * objects is ordinary JSON, and only a repeat within one object loses a value.
 */
export const parseClosedJson = <T>(text: string, shape: ClosedSchema): T => {
  rejectDuplicateKeys(text);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frozen authority is not a JSON object");
  }
  const document = parsed as Record<string, unknown>;

  const allowed = new Set([...Object.keys(shape.topLevel), shape.entriesKey]);
  const unknown = Object.keys(document).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`frozen authority has unknown field(s): ${unknown.sort().join(", ")}`);
  }
  for (const [field, kind] of Object.entries(shape.topLevel)) {
    if (!hasOwn(document, field)) {
      throw new Error(`frozen authority is missing required field ${field}`);
    }
    if (typeof document[field] !== kind) {
      throw new Error(
        `frozen authority field ${field} is ${typeof document[field]}, expected ${kind}`,
      );
    }
  }
  if (!hasOwn(document, shape.entriesKey)) {
    throw new Error(`frozen authority is missing required field ${shape.entriesKey}`);
  }

  const entries = document[shape.entriesKey];
  if (typeof entries !== "object" || entries === null) {
    throw new Error(`frozen authority's ${shape.entriesKey} is not an object or array`);
  }
  // Record and array are different documents, and a parser that accepts either cannot say which
  // one it read.
  const isArray = Array.isArray(entries);
  if (isArray !== (shape.entriesKind === "array")) {
    throw new Error(
      `frozen authority's ${shape.entriesKey} is ${isArray ? "an array" : "a record"}, ` +
        `expected ${shape.entriesKind === "array" ? "an array" : "a record"}`,
    );
  }

  const named: Array<[string, unknown]> = isArray
    ? (entries as unknown[]).map((entry, index) => [`[${index}]`, entry])
    : Object.entries(entries as Record<string, unknown>);
  const allowedFields = new Set(Object.keys(shape.entryShape));
  for (const [name, entry] of named) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`frozen authority entry ${name} is not an object`);
    }
    const fields = entry as Record<string, unknown>;
    const extra = Object.keys(fields).filter((key) => !allowedFields.has(key));
    if (extra.length > 0) {
      throw new Error(`frozen authority entry ${name} has unknown field(s): ${extra.sort().join(", ")}`);
    }
    for (const [field, kind] of Object.entries(shape.entryShape)) {
      if (!hasOwn(fields, field)) {
        throw new Error(`frozen authority entry ${name} is missing ${field}`);
      }
      if (typeof fields[field] !== kind) {
        throw new Error(
          `frozen authority entry ${name}.${field} is ${typeof fields[field]}, expected ${kind}`,
        );
      }
    }
  }
  return document as T;
};

/** The owner trace, as every consumer must read it — one parser, no second spelling. */
export interface OwnerTrace {
  _provenance: string;
  baselineVersion: number;
  baselineFixture: string;
  objects: Record<string, { type: string; owner: number }>;
}

export const parseOwnerTrace = (text: string): OwnerTrace =>
  parseClosedJson<OwnerTrace>(text, {
    topLevel: { _provenance: "string", baselineVersion: "number", baselineFixture: "string" },
    entriesKey: "objects",
    entriesKind: "record",
    entryShape: { type: "string", owner: "number" },
  });

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
