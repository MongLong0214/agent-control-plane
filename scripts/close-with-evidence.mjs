#!/usr/bin/env node
/**
 * Closes issues against evidence, and refuses to close the ones that lack it.
 *
 * The project's rule is that a closed issue names the commit that fixed it and the regression
 * test that proves it. An audit of all 436 tests found 26 that pass with their enforcement
 * deleted, and eight issues had been closed against exactly those — so "a test was named" is
 * not enough on its own. This script applies the checks that can be automated:
 *
 *   1. a delegate report says `fixed` (not `partial`, not `not-a-defect`)
 *   2. the test it names exists, by file and by test name
 *   3. that test file currently passes
 *   4. where a Grok verification of the lane exists, it did not say WRONG or REGRESSION
 *
 * Anything failing a check is listed as held, with the reason, and left open. Judgement that
 * cannot be automated — whether the test would fail if the enforcement were removed — stays with
 * the integrator and the independent reviewer.
 *
 * Usage:
 *   node scripts/close-with-evidence.mjs --reports=<dir> [--commit=<sha>] [--apply]
 */
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const apply = process.argv.includes("--apply");
const reportsDir = (process.argv.find((a) => a.startsWith("--reports=")) ?? "").slice("--reports=".length);
if (!reportsDir) {
  console.error("--reports=<dir> is required (a directory of delegate HANDOFF-REPORT copies)");
  process.exit(2);
}
const commit =
  (process.argv.find((a) => a.startsWith("--commit=")) ?? "").slice("--commit=".length) ||
  execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

const gh = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile("gh", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
    if (input !== undefined) child.stdin.end(input);
  });

/** One entry per issue, latest report wins — a later wave supersedes an earlier verdict. */
const claims = new Map();
for (const file of readdirSync(reportsDir).filter((f) => f.endsWith(".md")).sort()) {
  const lane = /w\d-([a-z]+)-report/.exec(file)?.[1] ?? file.replace(/\.md$/, "");
  const body = readFileSync(join(reportsDir, file), "utf8");
  for (const block of body.split(/\n(?=##\s)/)) {
    const header = /^##\s*#?(\d+)\s*[—\-–]\s*(fixed|partial|not-a-defect)/i.exec(block);
    if (!header) continue;
    const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(block)?.[1]?.trim() ?? null;
    claims.set(Number(header[1]), {
      lane,
      verdict: header[2].toLowerCase(),
      enforcement: field("Enforcement") ?? field("Why"),
      test: field("Test"),
      change: field("Change"),
      remaining: field("Remaining"),
    });
  }
}

/** Grok's per-lane verification, when one was run and completed. */
const grokVerdicts = new Map();
const logs = join(repoRoot, "..", "..");
for (const file of readdirSync(reportsDir).filter((f) => f.startsWith("grok-verify-"))) {
  const lane = file.replace(/^grok-verify-/, "").replace(/\.(md|txt)$/, "");
  const text = readFileSync(join(reportsDir, file), "utf8");
  for (const m of text.matchAll(/#(\d+)\s*[—\-–:]?\s*(CONFIRMED|UNPROVEN|WRONG|REGRESSION)/g)) {
    grokVerdicts.set(Number(m[1]), { lane, verdict: m[2] });
  }
}

const testLocation = (claim) => {
  if (!claim.test) return { ok: false, why: "the report names no test" };
  const path = /([\w./-]+\.test\.ts)/.exec(claim.test)?.[1];
  if (!path) return { ok: false, why: `no test file in "${claim.test.slice(0, 60)}"` };
  if (!existsSync(join(repoRoot, path))) return { ok: false, why: `${path} does not exist` };
  const quoted = /[`"']([^`"']{10,})[`"']/.exec(claim.test)?.[1] ?? "";
  const needle = quoted.split(">").pop()?.trim().replace(/^#\d+[/#\d]*\s*/, "").slice(0, 26) ?? "";
  const body = readFileSync(join(repoRoot, path), "utf8");
  if (needle && !body.includes(needle)) return { ok: false, why: `"${needle}" is not in ${path}`, path };
  return { ok: true, path };
};

const suiteCache = new Map();
const testFilePasses = (path) => {
  if (suiteCache.has(path)) return suiteCache.get(path);
  let passes = false;
  try {
    execFileSync("npx", ["vitest", "run", path, "--reporter=dot"], {
      cwd: repoRoot, encoding: "utf8", stdio: "pipe", timeout: 10 * 60 * 1000,
    });
    passes = true;
  } catch {
    passes = false;
  }
  suiteCache.set(path, passes);
  return passes;
};

const open = new Set(
  JSON.parse(await gh(["issue", "list", "--state", "open", "--limit", "400", "--json", "number"])).map((i) => i.number),
);

const closing = [];
const held = [];
for (const [issue, claim] of [...claims].sort((a, b) => a[0] - b[0])) {
  if (!open.has(issue)) continue;
  if (claim.verdict !== "fixed") {
    held.push([issue, `reported ${claim.verdict}${claim.remaining ? `: ${claim.remaining.slice(0, 90)}` : ""}`]);
    continue;
  }
  const grok = grokVerdicts.get(issue);
  if (grok && (grok.verdict === "WRONG" || grok.verdict === "REGRESSION")) {
    held.push([issue, `Grok said ${grok.verdict} on the ${grok.lane} lane`]);
    continue;
  }
  const located = testLocation(claim);
  if (!located.ok) {
    held.push([issue, located.why]);
    continue;
  }
  if (!testFilePasses(located.path)) {
    held.push([issue, `${located.path} does not pass`]);
    continue;
  }
  closing.push([issue, claim, located.path, grok]);
}

const body = (issue, claim, path, grok) =>
  [
    `**Fixed.**`,
    ``,
    `**Enforcement** ${claim.enforcement ?? "_not recorded_"}`,
    ``,
    `**Regression test** ${claim.test}`,
    `**Change** ${claim.change ?? "_not recorded_"}`,
    `**Commit** \`${commit}\``,
    ...(grok ? [`**Independent verification** Grok read the diff against this ticket and returned ${grok.verdict}.`] : []),
    ``,
    `Checked before closing: the test exists by file and by name, and \`${path}\` passes. The check`,
    `this cannot automate — whether that test would fail if the enforcement were deleted — is why`,
    `every closure is also read by an independent reviewer; eight issues were reopened when an`,
    `audit found their named test would pass either way.`,
  ].join("\n");

console.log(`claims parsed: ${claims.size} | open: ${open.size} | closing: ${closing.length} | held: ${held.length}\n`);
for (const [issue, claim, path, grok] of closing) {
  console.log(`close #${issue}  ${claim.lane}  ${path}${grok ? `  grok:${grok.verdict}` : ""}`);
  if (apply) {
    await gh(["issue", "comment", String(issue), "--body-file", "-"], body(issue, claim, path, grok));
    await gh(["issue", "close", String(issue), "--reason", "completed"]);
  }
}
console.log("");
for (const [issue, why] of held) console.log(`hold  #${issue}  ${why}`);
if (!apply) console.log("\ndry run — pass --apply to comment and close");
