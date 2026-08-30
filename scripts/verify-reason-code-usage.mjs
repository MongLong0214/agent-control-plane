#!/usr/bin/env node
/**
 * Verifies a census of reason-code producers and trigger mappings.
 *
 * `verify-reason-codes.mjs` already checks the catalogue's internal shape (value equals
 * key, nothing published was removed). This census additionally detects a declaration with
 * no production producer in src and a raised SQLite trigger name with no TRIGGER_CODES mapping.
 *
 * Checks:
 *   1. every declared code has a production reference that can produce it: a denial/error,
 *      Decision, return, event, persisted reason or another executable value selection
 *   2. every `ReasonCode.X` member used in `src/**`/`tests/**` is declared
 *   3. every string literal used as a `reasonCode` in `src/**`/`tests/**` is declared
 *   4. every staleness-classification member is declared
 *   5. every `RAISE(ABORT, 'X')` name in production schema or migration DDL has a
 *      TRIGGER_CODES mapping in `src/db/database.ts`
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * Replaces comments, and optionally strings, with spaces while preserving lines.
 * A comment or quoted mention cannot produce a reason code. String contents stay visible to the
 * separate reason-code-literal scan, where only a literal bound to `reasonCode` is accepted.
 */
const codeSource = (source, maskStrings) => {
  const chars = [...source];
  let state = "code";
  let escaped = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        chars[i] = chars[i + 1] = " ";
        state = "line-comment";
        i += 1;
      } else if (char === "/" && next === "*") {
        chars[i] = chars[i + 1] = " ";
        state = "block-comment";
        i += 1;
      } else if (char === "'" || char === '"' || char === "`") {
        if (maskStrings) chars[i] = " ";
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        escaped = false;
      }
      continue;
    }
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      else chars[i] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        chars[i] = chars[i + 1] = " ";
        state = "code";
        i += 1;
      } else if (char !== "\n") {
        chars[i] = " ";
      }
      continue;
    }
    if (maskStrings && char !== "\n") chars[i] = " ";
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (
      (state === "single" && char === "'") ||
      (state === "double" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
  }
  return chars.join("");
};

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
const productionFiles = srcFiles.filter((file) => file !== catalogueRel);
const testFiles = walk("tests");

/** Executable `ReasonCode.FOO` matches; comments and quoted mentions are masked. */
const memberRefs = (files, accepts = () => true) => {
  const hits = new Map();
  for (const file of files) {
    const text = codeSource(read(file), true);
    for (const match of text.matchAll(/ReasonCode\.([A-Z0-9_]+)/g)) {
      if (!accepts(text, match.index, match[0].length)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      if (!hits.has(match[1])) hits.set(match[1], []);
      hits.get(match[1]).push(`${file}:${line}`);
    }
  }
  return hits;
};

/**
 * A production reference selects a code as a value that can leave the site. Pure consumers do
 * not: an equality check, membership query or switch label only asks about a code produced
 * elsewhere. The whole catalogue module is excluded by `productionFiles`; declarations and
 * classification entries are metadata, so the catalogue cannot vouch for itself.
 */
const producesReasonCode = (text, index, length) => {
  const before = text.slice(Math.max(0, index - 120), index);
  const after = text.slice(index + length, index + length + 120);
  if (/\bcase\s*$/.test(before)) return false;
  if (/(?:===|!==|==|!=)\s*\(*\s*$/.test(before)) return false;
  if (/^\s*\)*\s*(?:===|!==|==|!=)/.test(after)) return false;
  if (/\b(?:has|includes|indexOf)\s*\(\s*$/.test(before)) return false;
  return true;
};

/**
 * Textual reason-code-literal matches. An UPPER_SNAKE string elsewhere on the same line is
 * usually an audit kind, a run state or a doctor status, and matching those would drown the
 * real finding in noise.
 */
const REASON_LITERAL = [
  /reason[_C]ode:\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /reason[_C]ode\s*(?:===|!==|==)\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /reason[_C]ode\s*\)?\s*\.\s*(?:toBe|toEqual)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
];

const literalRefs = (files, patterns = REASON_LITERAL) => {
  const hits = new Map();
  for (const file of files) {
    const text = codeSource(read(file), false);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        if (!hits.has(match[1])) hits.set(match[1], []);
        hits.get(match[1]).push(`${file}:${line}`);
      }
    }
  }
  return hits;
};

const srcMembers = memberRefs(productionFiles);
const productionMembers = memberRefs(productionFiles, producesReasonCode);
const testMembers = memberRefs(testFiles);
const srcLiterals = literalRefs(srcFiles);
const productionLiterals = literalRefs(productionFiles, [REASON_LITERAL[0]]);
const testLiterals = literalRefs(testFiles);

/** Extra diagnostic: a plain-text source mention does not satisfy the production-reference check. */
const srcText = productionFiles.map(read).join("\n");

const problems = [];
const notes = [];

// 1 — declared but never produced in src.
const unreferenced = [];
for (const [code, meta] of declared) {
  if (productionMembers.has(code) || productionLiterals.has(code)) continue;
  unreferenced.push({
    code,
    declaredAt: `${catalogueRel}:${meta.line}`,
    alsoUsedInTests: testMembers.has(code) || testLiterals.has(code),
    mentionedAsTextInSrc: new RegExp(`\\b${code}\\b`).test(srcText),
  });
}
for (const entry of unreferenced) {
  problems.push(
    `declared but produced nowhere in src/**: ${entry.code} (${entry.declaredAt})` +
      (entry.alsoUsedInTests ? " — asserted by tests/** with no producer" : ""),
  );
}

// 2 — a ReasonCode member used in source or tests must be declared.
for (const [code, sites] of srcMembers) {
  if (declared.has(code)) continue;
  problems.push(`src/** references an undeclared ReasonCode member: ${code} (${sites[0]})`);
}
for (const [code, sites] of [...testMembers, ...testLiterals]) {
  if (declared.has(code)) continue;
  problems.push(`referenced in tests/** but not declared: ${code} (${sites[0]})`);
}

// 3 — a string literal used as a reason code in src that is not in the catalogue.
for (const [code, sites] of srcLiterals) {
  if (declared.has(code)) continue;
  problems.push(`src/** uses an undeclared reason-code literal: ${code} (${sites[0]})`);
}

// 4 — a classification entry must name an existing code.
const stalenessBody =
  /export const STALENESS_REASON_CODES: ReadonlySet<ReasonCode> = new Set\(\[([\s\S]*?)\n\]\);/.exec(
    catalogueSource,
  );
if (!stalenessBody) {
  problems.push(`${catalogueRel}: could not locate STALENESS_REASON_CODES`);
} else {
  const bodyOffset = stalenessBody.index + stalenessBody[0].indexOf(stalenessBody[1]);
  for (const match of stalenessBody[1].matchAll(/ReasonCode\.([A-Z0-9_]+)/g)) {
    if (declared.has(match[1])) continue;
    const line = catalogueSource.slice(0, bodyOffset + match.index).split("\n").length;
    problems.push(
      `STALENESS_REASON_CODES classifies undeclared code ${match[1]} (${catalogueRel}:${line})`,
    );
  }
}

// 5 — every trigger abort name must translate into a reason code.
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
        `schema raises '${name}' but src/db/database.ts TRIGGER_CODES does not map it (${at})`,
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
  console.log(`declared but unproduced in src/** (${unreferenced.length}):`);
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
    console.log("OK — production reason-code references and trigger DDL mappings agree");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
