#!/usr/bin/env node
/**
 * Verifies a census of reason-code static outflows and trigger mappings.
 *
 * `verify-reason-codes.mjs` already checks the catalogue's internal shape (value equals
 * key, nothing published was removed). This census additionally detects a declaration with
 * neither a positively recognized direct outflow nor a machine-verified indirect outflow, and a
 * raised SQLite trigger name with no TRIGGER_CODES mapping.
 *
 * Checks:
 *   1. every declared code is transferred as a reason-bearing value by direct return, throw,
 *      concise-arrow result, an audited write/egress call, or a verified indirect mechanism
 *   2. every `ReasonCode.X` member used in `src/**`/`tests/**` is declared
 *   3. every string literal used as a `reasonCode` in `src/**`/`tests/**` is declared
 *   4. every `ReasonCode.X` metadata reference anywhere in the catalogue module is declared
 *   5. every `RAISE(ABORT, 'X')` name in production schema or migration DDL has a
 *      TRIGGER_CODES mapping in `src/db/database.ts`
 *
 * This is deliberately not a reachability claim. The dependency-free scanner does not build a
 * call graph, so it cannot decide whether a function containing a static outflow is ever called.
 * A prose disposition is not evidence of an outflow and is never consulted by this check.
 *
 * Dependency-free on purpose, like the other verify scripts: it must run in a disposable
 * worktree with no installed packages (PRD §17.4).
 *
 * Usage: node scripts/verify-reason-code-usage.mjs [--json] [--root=<repository>]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const repoRoot = rootArg
  ? resolve(rootArg.slice("--root=".length))
  : fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

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
const productionFileSet = new Set(productionFiles);
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
const RESULT_CALLEES = new Set([
  "acpError",
  "allow",
  "deny",
  "refused",
  "this.direct",
  "this.outcomeWithReply",
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
 * A direct value position has no operator between the member and its surrounding argument,
 * property, return, or arrow boundary. This distinguishes returning a reason code from returning
 * the boolean result of comparing one.
 */
const isDirectValue = (text, index, length) => {
  const before = text.slice(Math.max(0, index - 160), index);
  const after = text.slice(index + length, index + length + 80);
  return (
    /(?:\b(?:return|throw)\s+|=>\s*|[([,:?]\s*|\breasonCode\s*:\s*)\(*\s*$/.test(before) &&
    /^\s*\)*(?:\s*[,;:?)}\]])/.test(after) &&
    !/(?:===|!==|==|!=|<=|>=|<|(?<!=)>)\s*\(*\s*$/.test(before)
  );
};

/** A literal-false block cannot execute even though it contains the spelling of a real sink. */
const isInsideLiteralFalseBlock = (text, index) => {
  if (
    /\bif\s*\(\s*false\s*\)[^;{}]*$/.test(text.slice(Math.max(0, index - 240), index))
  ) {
    return true;
  }
  let closed = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (text[cursor] === "}") {
      closed += 1;
      continue;
    }
    if (text[cursor] !== "{") continue;
    if (closed > 0) {
      closed -= 1;
      continue;
    }
    if (/\bif\s*\(\s*false\s*\)\s*$/.test(text.slice(Math.max(0, cursor - 80), cursor))) {
      return true;
    }
  }
  return false;
};

/**
 * A static outflow is included only by positive syntax: a direct reason-bearing value in a return
 * or throw expression, the expression body of a concise arrow, or an audited write/egress call.
 * Merely constructing, comparing, or classifying a value is not one of those transfers.
 */
const isStaticOutflow = (text, index, length) => {
  if (!isDirectValue(text, index, length)) return false;
  if (isInsideLiteralFalseBlock(text, index)) return false;
  const before = text.slice(0, index);
  const statement = before.slice(before.lastIndexOf(";") + 1);
  const after = text.slice(index + length);
  const returned = /\b(?:return|throw)\b([\s\S]*)$/.exec(statement);

  const arrow = before.lastIndexOf("=>");
  const arrowBody = arrow >= 0 ? before.slice(arrow + 2) : "";
  const conciseArrow = arrow >= 0 && !/^\s*\{/.test(arrowBody) && !/[;}]/.test(arrowBody);
  const calls = enclosingCalls(text, index);
  const nearestCall = calls[0];

  const outflowCall = calls.findIndex((callee) => OUTFLOW_CALLEES.has(callee));
  if (
    outflowCall >= 0 &&
    calls.slice(0, outflowCall).every((callee) => RESULT_CALLEES.has(callee))
  ) {
    return true;
  }
  if (
    nearestCall &&
    RESULT_CALLEES.has(nearestCall) &&
    (returned !== null || conciseArrow)
  ) {
    return true;
  }

  const directReturn =
    returned !== null &&
    /^\s*\(*\s*$/.test(returned[1]) &&
    /^\s*\)*\s*[;,}]/.test(after);
  const directArrow =
    conciseArrow && /^\s*\(*\s*$/.test(arrowBody) && /^\s*\)*\s*[,;)}]/.test(after);
  if (directReturn || directArrow) return true;

  const returnedTernary =
    returned !== null &&
    !/[{[]/.test(returned[1]) &&
    /[?:]\s*\(*\s*$/.test(returned[1]);
  const arrowTernary =
    conciseArrow && !/[{[]/.test(arrowBody) && /[?:]\s*\(*\s*$/.test(arrowBody);
  if (returnedTernary || arrowTernary) return true;

  const propertySegment = before.slice(
    Math.max(before.lastIndexOf("{"), before.lastIndexOf(","), before.lastIndexOf(";")),
  );
  const reasonCodeProperty = /\breasonCode\s*:/.test(propertySegment);
  if (
    reasonCodeProperty &&
    (returned !== null || conciseArrow) &&
    (!nearestCall || RESULT_CALLEES.has(nearestCall) || OUTFLOW_CALLEES.has(nearestCall))
  ) {
    return true;
  }

  return false;
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
const staticOutflowMembers = memberRefs(productionFiles, (text, index, length) =>
  isStaticOutflow(text, index, length),
);
const testMembers = memberRefs(testFiles);
const srcLiterals = literalRefs(srcFiles);
const testLiterals = literalRefs(testFiles);

/** Extra diagnostic: any source-text mention does not itself satisfy the static-outflow check. */
const srcText = productionFiles.map(read).join("\n");

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

const matchingClose = (text, openIndex, open, close) => {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const splitTopLevelArguments = (source) => {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
};

const bodyFor = (text, signature) => {
  const match = signature.exec(text);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("{");
  const close = matchingClose(text, open, "{", "}");
  return close === -1 ? null : { source: text.slice(open + 1, close), start: open + 1 };
};

/**
 * Indirect outflows are derived from production syntax. Each recognizer verifies both the source
 * member and the concrete path that carries its value to a return, durable write, or exception.
 * There is no per-code prose allowlist.
 */
const verifiedIndirect = new Map();
const recordIndirect = (code, mechanism, evidence) => {
  if (!verifiedIndirect.has(code)) verifiedIndirect.set(code, []);
  verifiedIndirect.get(code).push({ mechanism, evidence });
};

// A credential-file code reaches deny through a typed helper parameter, and the helper result is
// returned by each caller. Derive the codes from those argument positions instead of naming them.
const credentialRel = "src/github/credential-store.ts";
const credentialText = productionFileSet.has(credentialRel)
  ? codeSource(read(credentialRel), true)
  : "";
const credentialHelper = bodyFor(
  credentialText,
  /#inspectCredentialFile\([\s\S]*?\):\s*Decision<void>\s*\{/,
);
if (credentialHelper) {
  const forwardedParameters = [];
  if (/\bdeny\(\s*missingCode\s*,/.test(credentialHelper.source)) {
    forwardedParameters.push([2, "missingCode"]);
  }
  if (/\bdeny\(\s*insecureCode\s*,/.test(credentialHelper.source)) {
    forwardedParameters.push([4, "insecureCode"]);
  }
  for (const call of credentialText.matchAll(/this\s*\.\s*#inspectCredentialFile\s*\(/g)) {
    const open = call.index + call[0].lastIndexOf("(");
    const close = matchingClose(credentialText, open, "(", ")");
    if (close === -1) continue;
    const assignment = /const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      credentialText.slice(Math.max(0, call.index - 100), call.index),
    );
    if (!assignment) continue;
    const resultName = assignment[1];
    const returned = new RegExp(
      `^\\s*;\\s*if\\s*\\(\\s*!${resultName}\\.allowed\\s*\\)\\s*return\\s+${resultName}\\b`,
    ).test(credentialText.slice(close + 1));
    if (!returned) continue;
    const args = splitTopLevelArguments(credentialText.slice(open + 1, close));
    for (const [argumentIndex, parameter] of forwardedParameters) {
      const member = /^\s*ReasonCode\.([A-Z0-9_]+)\s*$/.exec(args[argumentIndex] ?? "");
      if (!member) continue;
      recordIndirect(member[1], `credential helper ${parameter} denial`, [
        `${credentialRel}:${lineAt(credentialText, call.index)}`,
        `${credentialRel}:${lineAt(credentialText, credentialHelper.start)}`,
      ]);
    }
  }
}

// SQLite trigger strings and unique-index violations originate outside TypeScript. Count a mapped
// code only when the DDL producer, the mapping entry, and translate's acpError path all exist.
const triggerSources = [
  ["src/db/schema.sql", read("src/db/schema.sql")],
  ["src/db/migrations.ts", read("src/db/migrations.ts")],
];
const raised = new Map();
for (const [file, source] of triggerSources) {
  for (const match of source.matchAll(/RAISE\(ABORT,\s*'([A-Z0-9_]+)'\)/g)) {
    if (!raised.has(match[1])) raised.set(match[1], `${file}:${lineAt(source, match.index)}`);
  }
}
const databaseRel = "src/db/database.ts";
const databaseSource = read(databaseRel);
const databaseText = codeSource(databaseSource, true);
const translateBody = bodyFor(
  databaseText,
  /export\s+const\s+translate\s*=\s*\(err:\s*unknown\):\s*unknown\s*=>\s*\{/,
);
const triggerCodesBody = /const TRIGGER_CODES: Record<string, ReasonCode> = \{([\s\S]*?)\n\};/.exec(
  databaseSource,
);
const triggerMappings = new Map();
if (triggerCodesBody) {
  for (const match of triggerCodesBody[1].matchAll(
    /^\s{2}([A-Z0-9_]+):\s*ReasonCode\.([A-Z0-9_]+),/gm,
  )) {
    const index = triggerCodesBody.index + triggerCodesBody[0].indexOf(triggerCodesBody[1]) + match.index;
    triggerMappings.set(match[1], {
      code: match[2],
      at: `${databaseRel}:${lineAt(databaseSource, index)}`,
    });
  }
}
const translatesTriggerCodes =
  translateBody !== null &&
  /for\s*\(const\s*\[key,\s*code\]\s*of\s*Object\.entries\(TRIGGER_CODES\)\)/.test(
    translateBody.source,
  ) &&
  /if\s*\(msg\.includes\(key\)\)\s*return\s+acpError\(code,/.test(translateBody.source);
if (translatesTriggerCodes) {
  for (const [sentinel, producedAt] of raised) {
    const mapping = triggerMappings.get(sentinel);
    if (!mapping) continue;
    recordIndirect(mapping.code, `SQLite trigger ${sentinel} translation`, [
      producedAt,
      mapping.at,
      `${databaseRel}:${lineAt(databaseText, translateBody.start)}`,
    ]);
  }
}

const indexCodesBody = /const INDEX_CODES: Array<\[RegExp, ReasonCode, string\]> = \[([\s\S]*?)\n\];/.exec(
  databaseSource,
);
const translatesIndexCodes =
  translateBody !== null &&
  /for\s*\(const\s*\[pattern,\s*code,\s*message\]\s*of\s*INDEX_CODES\)/.test(
    translateBody.source,
  ) &&
  /if\s*\(pattern\.test\(msg\)\)\s*return\s+acpError\(code,\s*message,/.test(
    translateBody.source,
  );
if (indexCodesBody && translatesIndexCodes) {
  for (const match of indexCodesBody[1].matchAll(
    /^\s*\[\/([A-Za-z_]+)\\\.([A-Za-z_]+)\/,\s*ReasonCode\.([A-Z0-9_]+),/gm,
  )) {
    const [, table, column, code] = match;
    const ddlPattern = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX[\\s\\S]{0,300}?ON\\s+${table}\\s*\\([^)]*\\b${column}\\b`,
      "i",
    );
    const producer = triggerSources
      .map(([file, source]) => {
        const found = ddlPattern.exec(source);
        return found ? `${file}:${lineAt(source, found.index)}` : null;
      })
      .find(Boolean);
    if (!producer) continue;
    const mappingIndex = indexCodesBody.index + indexCodesBody[0].indexOf(indexCodesBody[1]) + match.index;
    recordIndirect(code, `SQLite unique index ${table}.${column} translation`, [
      producer,
      `${databaseRel}:${lineAt(databaseSource, mappingIndex)}`,
      `${databaseRel}:${lineAt(databaseText, translateBody.start)}`,
    ]);
  }
}

// A pushed reason-code property is an outflow only when the same method returns that collection.
const recordReturnedCollection = (file, signature, collection, mechanism) => {
  if (!productionFileSet.has(file)) return;
  const text = codeSource(read(file), true);
  const body = bodyFor(text, signature);
  if (!body) return;
  if (!new RegExp(`\\bconst\\s+${collection}[^=]*=\\s*\\[\\s*\\]`).test(body.source)) return;
  if (!new RegExp(`\\breturn\\s+(?:\\{[^}]*\\b)?${collection}\\b`).test(body.source)) return;
  const pushes = new RegExp(`\\b${collection}\\.push\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, "g");
  for (const push of body.source.matchAll(pushes)) {
    const member = /\b(?:code|reasonCode)\s*:\s*ReasonCode\.([A-Z0-9_]+)/.exec(push[1]);
    if (!member) continue;
    recordIndirect(member[1], mechanism, [
      `${file}:${lineAt(text, body.start + push.index)}`,
      `${file}:${lineAt(text, body.start + body.source.lastIndexOf(`return`))}`,
    ]);
  }
};
recordReturnedCollection(
  "src/doctor/doctor.ts",
  /private\s+checkCapacitySensorFiles\(\):\s*Finding\[\]\s*\{/,
  "findings",
  "checkCapacitySensorFiles returned finding",
);
recordReturnedCollection(
  "src/continuity/continuity-kernel.ts",
  /async\s+restore\(\):\s*Promise<\{[\s\S]*?\}>\s*\{/,
  "deferred",
  "restore returned deferred result",
);

// collectCi persists and returns each locally constructed record. Derive reason codes only from a
// record for which both operations are present.
const verificationRel = "src/verify/verification-engine.ts";
const verificationText = productionFileSet.has(verificationRel)
  ? codeSource(read(verificationRel), true)
  : "";
const collectCi = bodyFor(
  verificationText,
  /private\s+async\s+collectCi\([\s\S]*?\):\s*Promise<VerificationResultRecord>\s*\{/,
);
if (collectCi) {
  for (const record of collectCi.source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
    const name = record[1];
    const open = record.index + record[0].lastIndexOf("{");
    const close = matchingClose(collectCi.source, open, "{", "}");
    if (close === -1) continue;
    const object = collectCi.source.slice(open + 1, close);
    const after = collectCi.source.slice(close + 1);
    const persistedAndReturned = new RegExp(
      `^\\s*;\\s*this\\.writeResultRow\\([^;]*\\b${name}\\s*\\);\\s*return\\s+${name}\\s*;`,
    ).test(after);
    if (!persistedAndReturned) continue;
    const reasonValue = /\breasonCode\s*:\s*([\s\S]*?)(?:,\s*\n|$)/.exec(object);
    if (!reasonValue) continue;
    for (const member of reasonValue[1].matchAll(/ReasonCode\.([A-Z0-9_]+)/g)) {
      recordIndirect(member[1], "collectCi persisted and returned record", [
        `${verificationRel}:${lineAt(verificationText, collectCi.start + record.index)}`,
      ]);
    }
  }
}

// markAttemptFailed writes terminalReason to durable state and returns it in a denial. Both uses
// must remain for the codes selected into that local variable to count.
const outboxRel = "src/outbox/outbox.ts";
const outboxText = productionFileSet.has(outboxRel) ? codeSource(read(outboxRel), true) : "";
const markAttemptFailed = bodyFor(
  outboxText,
  /markAttemptFailed\([\s\S]*?\):\s*Decision<void>\s*\{/,
);
if (markAttemptFailed) {
  const terminal = /const\s+terminalReason\s*=([\s\S]*?);/.exec(markAttemptFailed.source);
  const writesTerminal = /this\.db\.run\([\s\S]*?\bterminalReason\b[\s\S]*?\)\.changes/.test(
    markAttemptFailed.source,
  );
  const returnsTerminal = /return\s+deny\(\s*terminalReason\s*,/.test(markAttemptFailed.source);
  if (terminal && writesTerminal && returnsTerminal) {
    for (const member of terminal[1].matchAll(/ReasonCode\.([A-Z0-9_]+)/g)) {
      recordIndirect(member[1], "markAttemptFailed persisted and returned terminalReason", [
        `${outboxRel}:${lineAt(outboxText, markAttemptFailed.start + terminal.index)}`,
      ]);
    }
  }
}

const verifiedIndirectOutflows = [...verifiedIndirect]
  .map(([code, mechanisms]) => ({ code, mechanisms }))
  .sort((left, right) => left.code.localeCompare(right.code));

const problems = [];
const notes = [];

// 1 — declared without a positively recognized static outflow in src.
const withoutStaticOutflow = [];
for (const [code, meta] of declared) {
  if (staticOutflowMembers.has(code) || verifiedIndirect.has(code)) continue;
  withoutStaticOutflow.push({
    code,
    declaredAt: `${catalogueRel}:${meta.line}`,
    alsoUsedInTests: testMembers.has(code) || testLiterals.has(code),
    mentionedAnywhereInSrc: new RegExp(`\\b${code}\\b`).test(srcText),
  });
}
for (const entry of withoutStaticOutflow) {
  problems.push(
    `declared with no verified static outflow: ${entry.code} (${entry.declaredAt})` +
      (entry.alsoUsedInTests ? " — asserted by tests/** with no static outflow" : ""),
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

// 4 is enforced by the srcMembers loop above: it scans the entire catalogue module too.

// 5 — every trigger abort name must translate into a reason code.
if (!triggerCodesBody) {
  problems.push("src/db/database.ts: could not locate TRIGGER_CODES; trigger aborts cannot be checked");
} else {
  for (const [name, at] of raised) {
    if (!triggerMappings.has(name)) {
      problems.push(
        `schema raises '${name}' but src/db/database.ts TRIGGER_CODES does not map it (${at})`,
      );
    }
  }
  for (const name of triggerMappings.keys()) {
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
        verifiedIndirectOutflows,
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
  console.log(`without a verified static outflow (${withoutStaticOutflow.length}):`);
  for (const entry of withoutStaticOutflow) {
    console.log(
      `  ${entry.code}  ${entry.declaredAt}` +
        (entry.alsoUsedInTests ? "  [asserted in tests/**]" : "") +
        (entry.mentionedAnywhereInSrc ? "  [mentioned somewhere in src/**]" : ""),
    );
  }
  console.log("");
  console.log(`machine-verified indirect outflows (${verifiedIndirectOutflows.length}):`);
  for (const entry of verifiedIndirectOutflows) {
    console.log(
      `  ${entry.code} — ${entry.mechanisms.map((mechanism) => mechanism.mechanism).join("; ")}`,
    );
  }
  console.log("");
  for (const limitation of limitations) console.log(`limitation: ${limitation}`);
  console.log("");
  for (const note of notes) console.log(`note: ${note}`);
  console.log("");
  if (problems.length === 0) {
    console.log("OK — verified reason-code static outflows and trigger DDL mappings agree");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
