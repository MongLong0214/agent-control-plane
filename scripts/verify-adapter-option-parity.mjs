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

/**
 * Options the acceptance deliberately does not set, with the reason it cannot.
 *
 * An exemption is not the same as an omission, and the difference has to be visible: these are
 * printed on success, so a reader sees what the run is *not* configured with rather than reading a
 * green line as full parity. Adding an entry here is a claim someone signs.
 */
const DECLARED_EXEMPTIONS = {
  managedWriteBroker:
    "GuardedInvocationWriteBroker wraps the guard ControlPlane constructs, and these adapters are " +
    "built before it exists. Absent, every managed write is refused WRITE_REQUIRES_MANAGED_RUN, so " +
    "the acceptance cannot exercise the local-write path — fail-closed, and a real coverage gap.",
};

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

/**
 * Top-level keys of the object literal passed to `new <adapter>({ … })`.
 *
 * Segment-based rather than one regex over the whole body. The regex version dropped the first
 * property of every object — the opening brace was consumed matching the nesting token, leaving
 * nothing for the following key's separator to match — and it could not see shorthand at all.
 * Both sides lost the same keys, so the comparison agreed by accident while seeing less than it
 * reported. A fifth gap landing on a first or shorthand property would have passed.
 *
 * Throws on `...spread` at the top level instead of skipping it. A spread cannot be resolved by
 * reading one file, and reporting keys as if it were absent is the failure this file exists to
 * catch, one level in: the object would have been found, the braces would have balanced, and the
 * answer would have been confidently short.
 */
export const optionKeys = (rawSource, file, adapter) => {
  const source = stripNonCode(rawSource);
  const opener = `new ${adapter}({`;
  const start = source.indexOf(opener);
  if (start === -1) return null;

  // Start *inside* the brace so the first property is an ordinary segment like the rest.
  let depth = 1;
  let index = start + opener.length;
  const body = [];
  for (; index < source.length && depth > 0; index += 1) {
    const character = source[index];
    if ("{[(".includes(character)) depth += 1;
    else if ("}])".includes(character)) {
      depth -= 1;
      if (depth === 0) break;
    }
    body.push(character);
  }
  if (depth !== 0) fail(`could not find the end of ${adapter}'s options in ${file}`);

  // Split on commas that belong to this object, not to a nested literal or call.
  const segments = [];
  let current = "";
  let nesting = 0;
  for (const character of body) {
    if ("{[(".includes(character)) nesting += 1;
    else if ("}])".includes(character)) nesting -= 1;
    if (character === "," && nesting === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);

  const keys = new Set();
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("...")) {
      fail(
        `${adapter} in ${file} spreads into its options`,
        "  A spread cannot be resolved from this file, so the key set is unknown rather than\n" +
          "  smaller. Name the options explicitly, or teach this check how to resolve it.",
      );
    }
    // `key:` and shorthand `key` both count; anything else is not a property of this object.
    const match = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(trimmed);
    if (match) keys.add(match[1]);
  }
  return keys;
};

const read = (file) => readFileSync(new URL(file, `file://${ROOT}`), "utf8");
const production = read(PRODUCTION);
const acceptance = read(ACCEPTANCE);

const problems = [];
const exempted = new Set();
let compared = 0;
for (const adapter of ADAPTERS) {
  const shipped = optionKeys(production, PRODUCTION, adapter);
  const tested = optionKeys(acceptance, ACCEPTANCE, adapter);
  if (!shipped) fail(`no ${adapter} construction found in ${PRODUCTION}`);
  if (!tested) fail(`no ${adapter} construction found in ${ACCEPTANCE}`);
  compared += 1;
  const absent = [...shipped].filter((key) => !tested.has(key)).sort();
  const missing = absent.filter((key) => !(key in DECLARED_EXEMPTIONS));
  for (const key of absent.filter((key) => key in DECLARED_EXEMPTIONS)) exempted.add(key);
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
for (const key of [...exempted].sort()) {
  process.stdout.write(`  not set, declared: ${key} — ${DECLARED_EXEMPTIONS[key]}\n`);
}
