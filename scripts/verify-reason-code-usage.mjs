#!/usr/bin/env node
/**
 * Verifies that the reason-code catalogue is *coherent with the code that uses it*.
 *
 * `verify-reason-codes.mjs` already checks the catalogue's internal shape (value equals
 * key, nothing published was removed). That is not enough after a multi-wave merge: waves
 * that each added their own denial vocabulary can leave the catalogue holding codes no
 * caller ever emits, and can leave a raised SQLite trigger name with no code to translate
 * it into. PRD §40 calls these strings the stable denial vocabulary — a code nobody emits
 * is a promise the runtime cannot keep, and a trigger nobody maps surfaces to the caller
 * as an opaque SQLITE_CONSTRAINT instead of a reason.
 *
 * Checks:
 *   1. every declared code is referenced somewhere in `src/**` outside its declaration
 *   2. every code referenced in `tests/**` is declared
 *   3. every string literal used as a `reasonCode` in `src/**`/`tests/**` is declared
 *   4. every `RAISE(ABORT, 'X')` name in production schema or migration DDL is mapped by
 *      TRIGGER_CODES in `src/db/database.ts`, so a trigger abort becomes a reason code
 *
 * Nothing here deletes or edits a code: `src/core/reason-codes.ts` is append-only by
 * contract, so an unused code is reported for a human decision, never removed.
 *
 * Dependency-free on purpose, like the other verify scripts: it must run in a disposable
 * worktree with no installed packages (PRD §17.4).
 *
 * Usage: node scripts/verify-reason-code-usage.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

const walk = (dir, out = []) => {
  for (const entry of readdirSync(join(repoRoot, dir)).sort()) {
    const rel = `${dir}/${entry}`;
    const stat = statSync(join(repoRoot, rel));
    if (stat.isDirectory()) walk(rel, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(rel);
  }
  return out;
};

// --- the catalogue ---------------------------------------------------------
const catalogueRel = "src/core/reason-codes.ts";
const catalogueSource = read(catalogueRel);
const catalogueBody = /export const ReasonCode = \{([\s\S]*?)\n\} as const;/.exec(catalogueSource);
if (!catalogueBody) {
  console.error("verify-reason-code-usage: could not locate the ReasonCode catalogue");
  process.exit(1);
}
// A code may be written on one line (`KEY: "KEY",`) or wrapped onto two when long.
const declared = new Map();
for (const match of catalogueBody[1].matchAll(/^\s{2}([A-Z0-9_]+):\s*(?:\n\s*)?"([^"]+)",$/gm)) {
  const line = catalogueSource.slice(0, catalogueBody.index + 1 + match.index).split("\n").length;
  declared.set(match[1], { value: match[2], line });
}
if (declared.size === 0) {
  console.error("verify-reason-code-usage: catalogue parsed as empty");
  process.exit(1);
}

// --- references ------------------------------------------------------------
const srcFiles = walk("src");
const testFiles = walk("tests");

/** The catalogue declaration is not its own consumer; the rest of its module still is. */
const referenceSource = (file) =>
  file === catalogueRel
    ? `${catalogueSource.slice(0, catalogueBody.index)}${catalogueSource.slice(
        catalogueBody.index + catalogueBody[0].length,
      )}`
    : read(file);

/** `ReasonCode.FOO` — the normal, type-checked way to reference a code. */
const memberRefs = (files) => {
  const hits = new Map();
  for (const file of files) {
    const text = referenceSource(file);
    for (const match of text.matchAll(/ReasonCode\.([A-Z0-9_]+)/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      if (!hits.has(match[1])) hits.set(match[1], []);
      hits.get(match[1]).push(`${file}:${line}`);
    }
  }
  return hits;
};

/**
 * A reason code written as a bare string rather than through the catalogue. Only literals
 * that are *bound to a reason code* count: an UPPER_SNAKE string elsewhere on the same
 * line is usually an audit kind, a run state or a doctor status, and matching those would
 * drown the real finding in noise.
 */
const REASON_LITERAL = [
  /reason[_C]ode:\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /reason[_C]ode\s*(?:===|!==|==)\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /reason[_C]ode\s*\)?\s*\.\s*(?:toBe|toEqual)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
];

const literalRefs = (files) => {
  const hits = new Map();
  for (const file of files) {
    const text = referenceSource(file);
    for (const pattern of REASON_LITERAL) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        if (!hits.has(match[1])) hits.set(match[1], []);
        hits.get(match[1]).push(`${file}:${line}`);
      }
    }
  }
  return hits;
};

const srcMembers = memberRefs(srcFiles);
const testMembers = memberRefs(testFiles);
const srcLiterals = literalRefs(srcFiles);
const testLiterals = literalRefs(testFiles);

/** Plain-text mention anywhere in src, which is how a code reaches a doc comment or SQL. */
const srcText = srcFiles.map(referenceSource).join("\n");

const problems = [];
const notes = [];

// 1 — declared but never referenced in src.
const unreferenced = [];
for (const [code, meta] of declared) {
  if (srcMembers.has(code) || srcLiterals.has(code)) continue;
  unreferenced.push({
    code,
    declaredAt: `${catalogueRel}:${meta.line}`,
    alsoUsedInTests: testMembers.has(code) || testLiterals.has(code),
    mentionedAsTextInSrc: new RegExp(`\\b${code}\\b`).test(srcText),
  });
}
for (const entry of unreferenced) {
  problems.push(
    `declared but referenced nowhere in src/**: ${entry.code} (${entry.declaredAt})` +
      (entry.alsoUsedInTests ? " — asserted by tests/** with no producer" : ""),
  );
}

// 2 — referenced by tests but not declared.
for (const [code, sites] of [...testMembers, ...testLiterals]) {
  if (declared.has(code)) continue;
  problems.push(`referenced in tests/** but not declared: ${code} (${sites[0]})`);
}

// 3 — a string literal used as a reason code in src that is not in the catalogue.
for (const [code, sites] of srcLiterals) {
  if (declared.has(code)) continue;
  problems.push(`src/** uses an undeclared reason-code literal: ${code} (${sites[0]})`);
}

// 4 — every trigger abort name must translate into a reason code.
const triggerSources = [
  ["src/db/schema.sql", read("src/db/schema.sql")],
  ["src/db/migrations.ts", read("src/db/migrations.ts")],
];
const raised = new Map();
for (const [file, source] of triggerSources) {
  for (const match of source.matchAll(/RAISE\(ABORT,\s*'([A-Z0-9_]+)'\)/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    if (!raised.has(match[1])) raised.set(match[1], `${file}:${line}`);
  }
}
const databaseSource = read("src/db/database.ts");
const triggerCodesBody = /const TRIGGER_CODES: Record<string, ReasonCode> = \{([\s\S]*?)\n\};/.exec(
  databaseSource,
);
if (!triggerCodesBody) {
  problems.push("src/db/database.ts: could not locate TRIGGER_CODES; trigger aborts cannot be checked");
} else {
  const mapped = new Set(
    [...triggerCodesBody[1].matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((m) => m[1]),
  );
  for (const [name, at] of raised) {
    if (!mapped.has(name)) {
      problems.push(
        `schema raises '${name}' but src/db/database.ts TRIGGER_CODES does not map it; ` +
          `callers see a raw SQLITE_CONSTRAINT (${at})`,
      );
    }
  }
  for (const name of mapped) {
    if (!raised.has(name)) {
      notes.push(`TRIGGER_CODES maps '${name}', which no production trigger raises`);
    }
  }
}

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        declaredCodes: declared.size,
        srcFiles: srcFiles.length,
        testFiles: testFiles.length,
        unreferenced,
        triggerAborts: [...raised.keys()],
        problems,
        notes,
      },
      null,
      2,
    )}\n`,
  );
} else {
  console.log(`reason codes declared: ${declared.size}`);
  console.log(`src files scanned:     ${srcFiles.length}`);
  console.log(`test files scanned:    ${testFiles.length}`);
  console.log("");
  console.log(`declared but unreferenced in src/** (${unreferenced.length}):`);
  for (const entry of unreferenced) {
    console.log(
      `  ${entry.code}  ${entry.declaredAt}` +
        (entry.alsoUsedInTests ? "  [asserted in tests/**]" : "") +
        (entry.mentionedAsTextInSrc ? "  [mentioned in prose only]" : ""),
    );
  }
  console.log("");
  for (const note of notes) console.log(`note: ${note}`);
  console.log("");
  if (problems.length === 0) {
    console.log("OK — catalogue is coherent with src/**, tests/** and production trigger DDL");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
