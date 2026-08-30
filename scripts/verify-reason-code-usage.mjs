#!/usr/bin/env node
/**
 * Verifies a census of reason-code static outflows and trigger mappings.
 *
 * `verify-reason-codes.mjs` already checks the catalogue's internal shape (value equals
 * key, nothing published was removed). This census additionally detects a declaration with
 * neither a positively recognized static outflow nor an explicit reviewed no-outflow disposition,
 * and a raised SQLite trigger name with no TRIGGER_CODES mapping.
 *
 * Checks:
 *   1. every declared code is transferred by direct return, throw, concise-arrow result,
 *      always-throwing `fail`, or an audited write/egress call; otherwise it has an explicit
 *      reviewed no-outflow disposition
 *   2. every `ReasonCode.X` member used in `src/**`/`tests/**` is declared
 *   3. every string literal used as a `reasonCode` in `src/**`/`tests/**` is declared
 *   4. every `ReasonCode.X` metadata reference anywhere in the catalogue module is declared
 *   5. every `RAISE(ABORT, 'X')` name in production schema or migration DDL has a
 *      TRIGGER_CODES mapping in `src/db/database.ts`
 *
 * This is deliberately not a reachability claim. The dependency-free scanner does not build a
 * call graph, so it cannot decide whether a function containing a static outflow is ever called.
 * Nothing here deletes or edits a code: published codes are append-only, so a code without a
 * static outflow is reported for a human disposition, never removed automatically.
 *
 * Dependency-free on purpose, like the other verify scripts: it must run in a disposable
 * worktree with no installed packages (PRD §17.4).
 *
 * Usage: node scripts/verify-reason-code-usage.mjs [--json] [--fresh-census] [--root=<repository>]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const repoRoot = rootArg
  ? resolve(rootArg.slice("--root=".length))
  : fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");
const freshCensus = process.argv.includes("--fresh-census");

const limitations = [
  "reachability: cannot decide — no call graph is built; a static outflow inside an uncalled function may satisfy this census",
];

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
 * Calls whose contract transfers the supplied value across a module boundary: by throwing,
 * resolving an outward result, recording an event, or writing durable state. This is a positive
 * list of sinks, not a list of comparison/container shapes to ignore.
 */
const OUTFLOW_CALLEES = new Set([
  "fail",
  "finish",
  "settle",
  "this.audit.record",
  "this.cp.audit.record",
  "this.cp.db.run",
  "this.db.run",
  "this.insert",
]);

const enclosingCalls = (text, index) => {
  const calls = [];
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === ")") {
      depth += 1;
      continue;
    }
    if (text[i] !== "(") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const callee = /([A-Za-z_$][\w$#]*(?:\s*\.\s*[A-Za-z_$][\w$#]*)*)\s*$/.exec(
      text.slice(Math.max(0, i - 100), i),
    );
    if (callee) calls.push(callee[1].replace(/\s+/g, ""));
  }
  return calls;
};

/**
 * A static outflow is included only by positive syntax: the member is part of a direct return or
 * throw expression, the expression body of a concise arrow, an always-throwing `fail` call, or an
 * argument to an audited write/egress call above. Merely constructing, comparing or classifying a
 * value is not one of those transfers.
 */
const isStaticOutflow = (text, index) => {
  const before = text.slice(0, index);
  const statement = before.slice(before.lastIndexOf(";") + 1);
  if (/\b(?:return|throw)\b/.test(statement)) return true;

  const arrow = before.lastIndexOf("=>");
  if (arrow >= 0) {
    const arrowBody = before.slice(arrow + 2);
    if (!/^\s*\{/.test(arrowBody) && !/[;}]/.test(arrowBody)) return true;
  }

  return enclosingCalls(text, index).some((callee) => OUTFLOW_CALLEES.has(callee));
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

const srcMembers = memberRefs(srcFiles);
const staticOutflowMembers = memberRefs(productionFiles, (text, index) =>
  isStaticOutflow(text, index),
);
const testMembers = memberRefs(testFiles);
const srcLiterals = literalRefs(srcFiles);
const testLiterals = literalRefs(testFiles);

/** Extra diagnostic: any source-text mention does not itself satisfy the static-outflow check. */
const srcText = productionFiles.map(read).join("\n");

const problems = [];
const notes = [];

/**
 * Human dispositions from the last census. An entry here explicitly says that the code has no
 * recognized static outflow; it never makes the code count as one. The census fails for any new
 * no-outflow code until a reviewer records a reasoned disposition.
 */
const RETAINED_WITHOUT_SOURCE_REFERENCE =
  "no src/** or tests/** reference; restored because this branch had no evidence that removing the external-contract spelling was safe";
const REVIEWED_WITHOUT_STATIC_OUTFLOW = new Map([
  ["DIRECT_MUTATION_DENIED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "GITHUB_APP_ENV_FILE_MISSING",
    "passed as missingCode to inspectCredentialFile, which returns deny(missingCode) to readEnvironmentFile",
  ],
  [
    "GITHUB_APP_ENV_FILE_INSECURE",
    "passed as insecureCode to inspectCredentialFile, which returns deny(insecureCode) to readEnvironmentFile",
  ],
  [
    "GITHUB_APP_PRIVATE_KEY_MISSING",
    "passed as missingCode to inspectCredentialFile, whose denial is returned by loadConfiguration",
  ],
  [
    "GITHUB_APP_PRIVATE_KEY_INSECURE",
    "passed as insecureCode to inspectCredentialFile, whose denial is returned by loadConfiguration",
  ],
  ["HEAD_MOVED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  ["RUN_CANCELLED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "SESSION_INCARNATION_IMMUTABLE",
    "TRIGGER_CODES maps the raised SESSION_INCARNATION_IMMUTABLE sentinel; translate returns acpError(code)",
  ],
  [
    "PRIMARY_CTO_ALREADY_BOUND",
    "INDEX_CODES maps the assignments.project_id constraint; translate returns acpError(code)",
  ],
  [
    "SESSION_BUZZ_ACTOR_ALREADY_BOUND",
    "INDEX_CODES maps the sessions.buzz_actor_id constraint; translate returns acpError(code)",
  ],
  [
    "CLAIM_PATH_CONFLICT",
    "findConflict selects it into code and returns deny(code); INDEX_CODES also maps the declared_path constraint",
  ],
  ["CLAIM_EXPIRED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "VERIFICATION_CI_HEAD_MISMATCH",
    "assigned to record.reasonCode before writeResultRow persists the record and collectCi returns it",
  ],
  ["SANDBOX_SECRET_STRIPPED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  ["REVIEW_INPUT_CONTAMINATED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "GITHUB_RECEIPT_PROTOCOL_VIOLATION",
    "TRIGGER_CODES maps the raised GITHUB_RECEIPT_PROTOCOL_VIOLATION sentinel; translate returns acpError(code)",
  ],
  ["CAPACITY_PROBE_STALE", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "CAPACITY_SENSOR_FILE_MISSING",
    "checkCapacitySensorFiles pushes it into findings and returns that findings array",
  ],
  [
    "CAPACITY_SENSOR_FILE_INVALID",
    "checkCapacitySensorFiles pushes it into findings and returns that findings array",
  ],
  ["CAPACITY_BUCKET_EXHAUSTED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER",
    "restore pushes it into the deferred result and returns that result to its caller",
  ],
  ["INGRESS_NONCE_EXPIRED", RETAINED_WITHOUT_SOURCE_REFERENCE],
  [
    "ATTESTATION_GENERATION_MISMATCH",
    "TRIGGER_CODES maps the raised ATTESTATION_GENERATION_MISMATCH sentinel; translate returns acpError(code)",
  ],
  [
    "ACTOR_SESSION_INCARNATION_MISMATCH",
    "TRIGGER_CODES maps the raised ACTOR_SESSION_INCARNATION_MISMATCH sentinel; translate returns acpError(code)",
  ],
  [
    "OUTBOX_DELIVERY_REJECTED",
    "selected into terminalReason, written to outbox.reason_code, and returned through deny(terminalReason)",
  ],
  [
    "OUTBOX_RETRY_POLICY_UNAVAILABLE",
    "selected into terminalReason, written to outbox.reason_code, and returned through deny(terminalReason)",
  ],
  ["BOOTSTRAP_MANIFEST_ABSOLUTE_PATH", RETAINED_WITHOUT_SOURCE_REFERENCE],
]);

// 1 — declared without a positively recognized static outflow in src.
const withoutStaticOutflow = [];
const reviewedWithoutStaticOutflow = [];
for (const [code, meta] of declared) {
  if (staticOutflowMembers.has(code)) continue;
  const entry = {
    code,
    declaredAt: `${catalogueRel}:${meta.line}`,
    alsoUsedInTests: testMembers.has(code) || testLiterals.has(code),
    mentionedAnywhereInSrc: new RegExp(`\\b${code}\\b`).test(srcText),
  };
  const disposition = freshCensus ? undefined : REVIEWED_WITHOUT_STATIC_OUTFLOW.get(code);
  if (disposition) reviewedWithoutStaticOutflow.push({ ...entry, disposition });
  else withoutStaticOutflow.push(entry);
}
for (const entry of withoutStaticOutflow) {
  problems.push(
    `declared with no reviewed static outflow disposition: ${entry.code} (${entry.declaredAt})` +
      (entry.alsoUsedInTests ? " — asserted by tests/** with no static outflow" : ""),
  );
}
if (!freshCensus) {
  for (const code of REVIEWED_WITHOUT_STATIC_OUTFLOW.keys()) {
    if (!declared.has(code)) {
      problems.push(`reviewed no-outflow disposition names undeclared code: ${code}`);
    } else if (staticOutflowMembers.has(code)) {
      problems.push(`reviewed no-outflow disposition is stale because ${code} now has a static outflow`);
    }
  }
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

// 4 is enforced by the srcMembers loop above: it scans the entire catalogue module too.

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
        withoutStaticOutflow,
        reviewedWithoutStaticOutflow,
        limitations,
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
  console.log(`without a reviewed static outflow disposition (${withoutStaticOutflow.length}):`);
  for (const entry of withoutStaticOutflow) {
    console.log(
      `  ${entry.code}  ${entry.declaredAt}` +
        (entry.alsoUsedInTests ? "  [asserted in tests/**]" : "") +
        (entry.mentionedAnywhereInSrc ? "  [mentioned somewhere in src/**]" : ""),
    );
  }
  console.log("");
  console.log(`reviewed without a static outflow (${reviewedWithoutStaticOutflow.length}):`);
  for (const entry of reviewedWithoutStaticOutflow) {
    console.log(`  ${entry.code} — ${entry.disposition}`);
  }
  console.log("");
  for (const limitation of limitations) console.log(`limitation: ${limitation}`);
  console.log("");
  for (const note of notes) console.log(`note: ${note}`);
  console.log("");
  if (problems.length === 0) {
    console.log("OK — static reason-code outflow dispositions and trigger DDL mappings agree");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
