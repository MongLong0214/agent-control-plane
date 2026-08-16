#!/usr/bin/env node
/**
 * The acceptance must configure its provider adapters with at least the options the deployment does.
 *
 * `ControlPlane` builds the adapters itself, but a caller may supply `adapters:` instead — and that
 * **replaces** them rather than merging. Every option `ControlPlane` would have passed then becomes
 * the caller's responsibility, and each omission is silent. Four were found one at a time, three of
 * them by a live run failing hundreds of seconds in:
 *
 *   reviewerEgress         surfaced as ISOLATION_LOST
 *   fallbacks              the preferred reviewer had nothing to fall through to
 *   providerCredentialDir  CLAUDE_CONFIG_DIR never exported, so the child read a denied directory
 *   denyReadPaths          still open — the acceptance denies its reviewer less than production does
 *
 * That last one is why key parity is worth enforcing rather than reviewing: an acceptance that
 * proves reviewer isolation under a weaker profile than the deployment ships is not proving the
 * deployment's isolation.
 *
 * **Keys, not values.** A test is expected to point at different paths, binaries and directories —
 * comparing values would fail on every legitimate difference and be switched off within a week.
 * What must not differ is *which* options are set: if production passes an option and the
 * acceptance does not, the acceptance is running a configuration nobody ships.
 *
 * Fails closed. If either construction site cannot be found or parsed, that is a failure rather
 * than a pass — a parity check that cannot see its subject would report agreement between nothing
 * and nothing, which is the defect this file exists to catch.
 *
 * Dependency-free, in the shape of the other verify scripts (PRD §17.4).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION = "src/app/control-plane.ts";
const ACCEPTANCE = "tests/e2e/real-component-integration.test.ts";
const ADAPTERS = ["ClaudeCliAdapter", "CodexCliAdapter"];

const fail = (message, detail) => {
  process.stdout.write(`verify-adapter-option-parity: ${message}\n`);
  if (detail) process.stdout.write(`${detail}\n`);
  process.exit(1);
};

/**
 * Remove comments and string/template literals, replacing each with spaces so every offset is
 * preserved. Without this the brace counter reads punctuation inside prose as code — the
 * acceptance's own comments contain parentheses and apostrophes, and counting them truncated the
 * object early, which reported options as missing that were plainly set a few lines below.
 *
 * A parity check that mis-parses is worse than none: it names correct code as broken, and a check
 * that cries wolf gets switched off.
 */
const stripNonCode = (source) => {
  const out = source.split("");
  let index = 0;
  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") out[at] = " ";
    }
  };
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (source[index] === '"' || source[index] === "'" || source[index] === "`") {
      const quote = source[index];
      let at = index + 1;
      while (at < source.length && source[at] !== quote) at += source[at] === "\\" ? 2 : 1;
      blank(index, at + 1);
      index = at + 1;
    } else {
      index += 1;
    }
  }
  return out.join("");
};

/** Top-level keys of the object literal passed to `new <adapter>({ … })`. */
const optionKeys = (rawSource, file, adapter) => {
  const source = stripNonCode(rawSource);
  const opener = `new ${adapter}({`;
  const start = source.indexOf(opener);
  if (start === -1) return null;

  let depth = 0;
  let index = start + opener.length - 1;
  const body = [];
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    body.push(character);
  }
  if (depth !== 0) fail(`could not find the end of ${adapter}'s options in ${file}`);

  // Only depth-1 identifiers immediately followed by a colon are this object's own keys; anything
  // deeper belongs to a nested literal such as `reviewerEgress: { … }`.
  const text = body.join("");
  const keys = new Set();
  let nesting = 0;
  for (const match of text.matchAll(/[{}[\]()]|(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) {
    const [token, key] = match;
    if (key === undefined) {
      nesting += "{[(".includes(token) ? 1 : -1;
      continue;
    }
    if (nesting === 1) keys.add(key);
  }
  return keys;
};

const read = (file) => readFileSync(new URL(file, `file://${ROOT}`), "utf8");
const production = read(PRODUCTION);
const acceptance = read(ACCEPTANCE);

const problems = [];
let compared = 0;
for (const adapter of ADAPTERS) {
  const shipped = optionKeys(production, PRODUCTION, adapter);
  const tested = optionKeys(acceptance, ACCEPTANCE, adapter);
  if (!shipped) fail(`no ${adapter} construction found in ${PRODUCTION}`);
  if (!tested) fail(`no ${adapter} construction found in ${ACCEPTANCE}`);
  compared += 1;
  const missing = [...shipped].filter((key) => !tested.has(key)).sort();
  if (missing.length > 0) problems.push({ adapter, missing: missing.join(", ") });
}

if (problems.length > 0) {
  process.stdout.write(
    "verify-adapter-option-parity: the acceptance omits options the deployment sets\n",
  );
  for (const problem of problems) {
    process.stdout.write(`  ${problem.adapter}: ${problem.missing}\n`);
  }
  process.stdout.write(
    "\nSupplying `adapters:` replaces what ControlPlane builds, so each of these is unset in the\n" +
      "run rather than defaulted to the shipped value. Set it in the acceptance, or — if the\n" +
      "difference is deliberate — say so where the adapter is constructed.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `verify-adapter-option-parity: ${compared} adapter(s) compared, acceptance sets every shipped option\n`,
);
process.stdout.write("Keys only; values are expected to differ and are not compared.\n");
