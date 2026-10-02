#!/usr/bin/env node
/**
 * Runs the gate set in `scripts/lib/prepush-gates.mjs`, in order, stopping at the first failure.
 *
 * This is the executor half of #739. The manifest is data owned by the repository; this file is
 * the one thing that turns it into processes, and `.github/workflows/ci.yml` calls it rather than
 * listing the steps again. Two lists drift — this repository has already paid for that once, when
 * a `--theirs` merge deleted the `coordinates:stale` package script while `ci.yml` went on calling
 * it, invisible locally until CI said `Command not found`.
 *
 * Design notes that are load-bearing rather than taste:
 *
 *   - `stdio: "inherit"`. A gate's own output is the reason to run it. A runner that captures and
 *     summarises turns a lint error with a file and a line into "lint failed".
 *   - fail-fast, no `--only`, no `--skip`, no subset flag. GitHub stops a job at its first failing
 *     step, so stopping here is what makes the local run the same run. A subset flag would also
 *     rebuild by hand exactly the partial list that made #736 fail — the runner exists so that
 *     "what CI runs" is not a thing anyone assembles.
 *   - the whole set, including `pnpm test`. Measured on this machine: the eighteen structural
 *     checks total about twenty seconds, `build` three, and the suite about two and a half
 *     minutes. Roughly three minutes buys the answer CI gives in fifteen, and there is no
 *     omission to defend.
 *   - an exit code is printed for every gate, and a gate that fails is never folded into a
 *     summary line that reads as success.
 *
 * Usage:
 *   node scripts/run-prepush-gates.mjs            (run every gate, stop at the first failure)
 *   node scripts/run-prepush-gates.mjs --list     (print the manifest, run nothing)
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GATES } from "./lib/prepush-gates.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const onGitHub = process.env.GITHUB_ACTIONS === "true";
const RULE = "─".repeat(78);

const unknown = process.argv.slice(2).filter((argument) => argument !== "--list");
if (unknown.length > 0) {
  process.stderr.write(
    `gates: unrecognised argument(s): ${unknown.join(" ")}\n` +
      "gates runs the whole set; there is deliberately no way to run part of it.\n",
  );
  process.exit(2);
}

const width = String(GATES.length).length;
const label = (index) => `${String(index + 1).padStart(width, "0")}/${GATES.length}`;

const commandOf = (gate) => {
  const value = gate.argumentFrom ? (process.env[gate.argumentFrom] ?? "").trim() : "";
  return value === "" ? [gate.script] : [gate.script, value];
};

if (process.argv.includes("--list")) {
  for (const [index, gate] of GATES.entries()) {
    process.stdout.write(`${label(index)}  pnpm ${commandOf(gate).join(" ")}\n`);
  }
  process.exit(0);
}

process.stdout.write(
  `${RULE}\ngates: ${GATES.length} gate(s) from scripts/lib/prepush-gates.mjs, ` +
    `run by scripts/run-prepush-gates.mjs\n` +
    "This is the same runner .github/workflows/ci.yml invokes; `pnpm gates:ci-parity` is what\n" +
    "refuses a workflow that verifies anything this manifest does not own.\n" +
    `${RULE}\n`,
);

const results = [];
let failure = null;

for (const [index, gate] of GATES.entries()) {
  const words = commandOf(gate);
  const printed = `pnpm ${words.join(" ")}`;
  process.stdout.write(`\n${RULE}\ngate ${label(index)}  ${printed}\n${RULE}\n`);

  const startedAt = Date.now();
  const child = spawnSync("pnpm", words, { cwd: ROOT, stdio: "inherit" });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  // A child killed by a signal reports `status: null`. Reading that as anything but a failure is
  // the "intermediate failure folded into success" the contract forbids, so it is named as one.
  const status = child.error ? 1 : child.signal ? 128 : (child.status ?? 1);
  const detail = child.error
    ? `could not spawn pnpm: ${child.error.message}`
    : child.signal
      ? `killed by ${child.signal}`
      : null;

  results.push({ printed, status, seconds, detail });
  process.stdout.write(
    status === 0
      ? `\nPASS  ${printed}  exit ${status}  ${seconds}s\n`
      : `\nFAIL  ${printed}  exit ${status}  ${seconds}s${detail ? `  (${detail})` : ""}\n`,
  );

  if (status !== 0) {
    failure = { printed, status, detail, index };
    break;
  }
}

const notRun = GATES.slice(results.length);
const lines = [
  "",
  RULE,
  failure
    ? `gates: FAILED at ${failure.printed} (exit ${failure.status})`
    : `gates: PASSED — ${results.length} of ${GATES.length} gate(s)`,
  RULE,
  ...results.map((r) => `${r.status === 0 ? "PASS" : "FAIL"}  exit ${r.status}  ${r.seconds}s  ${r.printed}`),
  ...notRun.map((gate) => `SKIP  not run   —      pnpm ${commandOf(gate).join(" ")}`),
];
if (failure) {
  lines.push(
    "",
    `The output above ${failure.printed} says why. Nothing after it ran: this stops at the first`,
    "failure, the way the CI job's steps do.",
  );
}
process.stdout.write(`${lines.join("\n")}\n`);

if (onGitHub) {
  if (failure) {
    process.stdout.write(
      `::error title=gate failed: ${failure.printed}::exit ${failure.status}` +
        `${failure.detail ? ` (${failure.detail})` : ""} — ${notRun.length} later gate(s) did not run\n`,
    );
  }
  // The step summary is the readback that this job ran the runner rather than its own step list:
  // it names every gate the manifest holds and what each one did, on the run's summary page.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const rows = [
      ...results.map((r) => `| \`${r.printed}\` | ${r.status === 0 ? "pass" : "**fail**"} | ${r.status} | ${r.seconds}s |`),
      ...notRun.map((gate) => `| \`pnpm ${commandOf(gate).join(" ")}\` | not run | — | — |`),
    ];
    try {
      appendFileSync(
        summaryPath,
        [
          `### \`pnpm gates\` — ${failure ? "failed" : "passed"}`,
          "",
          "Manifest: `scripts/lib/prepush-gates.mjs`. Runner: `scripts/run-prepush-gates.mjs`.",
          "The identical command runs locally as `pnpm gates`.",
          "",
          "| gate | result | exit | time |",
          "| --- | --- | --- | --- |",
          ...rows,
          "",
        ].join("\n"),
      );
    } catch (error) {
      process.stdout.write(`gates: could not write the step summary: ${error.message}\n`);
    }
  }
}

process.exit(failure ? failure.status : 0);
