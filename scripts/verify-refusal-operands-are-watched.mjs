#!/usr/bin/env node
/**
 * Reports every operand of a multi-condition refusal that no falsifiability row names.
 *
 * Three of the four findings in this branch's final review came from one question, asked by hand:
 * take a `&&`/`||` chain that decides a refusal, replace each operand with `true`, and see what
 * dies. It found the retry rule's completion count (which I had documented as unkillable), the
 * per-actor boundary of the adjudication door, and, indirectly, a receipt condition whose row had
 * been deleted by a copy-paste.
 *
 * The falsifiability harness answers "is this guard tested" for the lines someone thought to write
 * a row for. It cannot answer "which lines has nobody written a row for", because its subject is
 * its own table. This asks that, over the operands — the pieces most likely to be covered by a
 * neighbour and therefore to look tested when they are not.
 *
 * What it does NOT do, and this matters as much as what it does: it does not run anything. An
 * operand named by a row may still be unwatched if the row's test passes for another reason, and
 * only the sweep can say. This narrows where to look; it does not certify.
 *
 * Usage: verify-refusal-operands-are-watched.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where a refusal is decided. Listed rather than discovered, because "a condition that decides a
 * refusal" is not a syntactic property — and a list that is wrong is visible, while a heuristic
 * that quietly skips a file is the failure this whole set is about.
 */
const DECIDING_FILES = [
  "src/conversation/turn-coordinator.ts",
  "src/acceptance/disposable-realm.ts",
  "src/daemon/daemon.ts",
];

/**
 * Operands this check has reported and nobody has answered yet.
 *
 * Named individually, with what they decide, so the list cannot grow by someone adding a file
 * pattern. Each is a real answer owed — an operand of a refusal that no row names — and the
 * reason it is here rather than fixed is written beside it.
 */
const UNANSWERED = new Map([
  [
    "src/daemon/daemon.ts:1028",
    "capacity failover, outside the ledger work this table was built for. Reported rather than " +
      "silenced: it is one operand of whether a session still covers its role.",
  ],
]);

const harness = readFileSync(join(ROOT, "scripts/verify-guards-are-falsifiable.mjs"), "utf8");
const table = /const GUARDS = \[([\s\S]*?)\n\];/.exec(harness);
if (table === null) {
  process.stdout.write("  could not read the GUARDS table\n\nRESULT: FAIL — nothing was compared.\n");
  process.exit(2);
}
/** Every `find:` anchor, so an operand appearing inside one counts as named. */
const anchors = [...table[1].matchAll(/find:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)].map(
  (m) => (m[1] ?? m[2] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
);

const unnamed = [];
let operands = 0;

for (const file of DECIDING_FILES) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    // An operand of a chain: a line ending in `&&` or `||`, or the line that closes one with `;`
    // or `) {`. Comments and strings are skipped — a `&&` inside prose is not a condition.
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    const isOperand =
      /(&&|\|\|)\s*$/.test(trimmed) ||
      (/^[^/]*\b(?:===|!==|<|>|<=|>=|\?\?)\b/.test(trimmed) && /(;|\)\s*\{)\s*$/.test(trimmed) &&
        /(&&|\|\|)\s*$/.test((lines[index - 1] ?? "").trim()));
    if (!isOperand) return;
    operands += 1;
    // A row's anchor is often several lines, and an operand belongs to it when the anchor contains
    // that line *or* an adjacent one — a mutation replacing a whole `every(...)` covers each
    // operand inside it. Comparing the trimmed line against the anchor's own trimmed lines is what
    // makes that true; the first version compared raw text and called two watched operands
    // unnamed, which is a report that sends someone to write a test that already exists.
    const anchorLines = anchors.flatMap((anchor) => anchor.split("\n").map((one) => one.trim()));
    if (anchorLines.some((one) => one !== "" && (one === trimmed || one.includes(trimmed)))) return;
    // And an operand inside a block a row replaces wholesale: look for the nearest enclosing call
    // an anchor names.
    const enclosing = lines.slice(Math.max(0, index - 6), index).map((one) => one.trim());
    if (enclosing.some((one) => one !== "" && anchorLines.some((a) => a.includes(one)))) return;
    unnamed.push({ file, line: index + 1, text: trimmed });
  });
}

const answered = unnamed.filter(({ file, line }) => !UNANSWERED.has(`${file}:${line}`));

if (unnamed.length > 0) {
  for (const { file, line, text } of unnamed) {
    const known = UNANSWERED.get(`${file}:${line}`);
    process.stdout.write(`  ${file}:${line}${known ? "  (known)" : ""}\n    ${text}\n`);
    if (known) process.stdout.write(`    ${known}\n`);
  }
}

if (answered.length > 0) {
  process.stdout.write(
    `\nEach of these is one operand of a refusal, and no falsifiability row names it. Replace it\n` +
      `with \`true\` and run the suite: if nothing dies, the refusal it belongs to is decided by a\n` +
      `line nothing is watching.\n` +
      `RESULT: FAIL — ${answered.length} of ${operands} refusal operand(s) are named by no row.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — ${operands - UNANSWERED.size} of ${operands} refusal operand(s) in ` +
    `${DECIDING_FILES.length} file(s) are named by a falsifiability row, ` +
    `${UNANSWERED.size} known and unanswered. Named is not tested; only the full sweep says that.\n`,
);
