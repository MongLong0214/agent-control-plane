#!/usr/bin/env node
/**
 * Refuses a workflow that verifies something the pre-push runner does not own.
 *
 * This is the check #739 is actually about. A runner that runs a list is plumbing; the property
 * that matters is that **the local gate set and the CI gate set cannot drift apart**, and running
 * the runner does not test that. What tests it is this: CI's gate job may run setup, and it may
 * run the runner, and anything else it runs is a gate that exists in one place only.
 *
 * The failure it is built from: #736 was verified locally against a hand-made list of four checks
 * and failed CI on `pnpm lint`, which was not on the list. Nobody was careless — the set was not
 * written down anywhere that could be executed, so every attempt to state it was a reconstruction.
 * This repository has also had the mirror-image loss: a `--theirs` merge deleted the
 * `coordinates:stale` package script while `ci.yml` kept calling it, invisible locally, `Command
 * not found` in CI.
 *
 * The rejected alternative was to make `ci.yml` the source of truth and extract its `pnpm` strings
 * at run time. It moves the defect rather than removing it: whatever the parser fails to see is
 * silently absent from the local run. Note the asymmetry that makes *this* direction safe — this
 * script parses the workflow too, but a command it fails to attribute makes it **fail**, not
 * quietly shrink a list. That is what the unattributed-line pass at the end is for: every
 * command-shaped line in a workflow must fall inside a `run:` block this script parsed.
 *
 * What it does not claim: that a step is reached, that a matrix leg runs, or that any gate is
 * correct. It claims that CI cannot verify something the runner will not, and that the runner
 * cannot verify something CI will not.
 *
 * Usage: node scripts/verify-ci-runs-the-gate-runner.mjs [--repo-root=<path>]
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CI_GATE_JOB,
  CI_SETUP_COMMANDS,
  GATES,
  RUNNER_PATH,
  RUNNER_SCRIPT,
  VERIFICATION_OUTSIDE_THE_RUNNER,
} from "./lib/prepush-gates.mjs";
import {
  extractRunCommands,
  jobByLine,
  pnpmCommandFrom,
  PNPM_NON_SCRIPT_COMMANDS,
  replaceGitHubExpressions,
  shellSegments,
  shellWords,
} from "./lib/workflow-commands.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const rootArgument = process.argv.find((argument) => argument.startsWith("--repo-root="));
const repoRoot = rootArgument ? resolve(rootArgument.slice("--repo-root=".length)) : defaultRoot;

const failures = [];
const fail = (message) => failures.push(message);

let packageScripts = {};
try {
  packageScripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ?? {};
} catch (error) {
  process.stderr.write(`gates:ci-parity: cannot read package.json: ${error.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// The manifest has to be runnable before anything about CI matters.
// ---------------------------------------------------------------------------------------------
if (GATES.length === 0) fail("the gate manifest is empty; there is nothing for CI to share");

const seenScripts = new Set();
for (const gate of GATES) {
  if (seenScripts.has(gate.script)) fail(`the gate manifest lists ${JSON.stringify(gate.script)} twice`);
  seenScripts.add(gate.script);
  if (!(gate.script in packageScripts)) {
    fail(`the gate manifest names ${JSON.stringify(gate.script)}, which is not a package script`);
  }
  if (gate.script === RUNNER_SCRIPT) {
    fail(`the gate manifest names ${JSON.stringify(RUNNER_SCRIPT)}, which would run the runner inside itself`);
  }
}

const runnerScriptBody = packageScripts[RUNNER_SCRIPT];
if (runnerScriptBody === undefined) {
  fail(`package.json has no ${JSON.stringify(RUNNER_SCRIPT)} script, so \`pnpm ${RUNNER_SCRIPT}\` runs nothing`);
} else if (!runnerScriptBody.includes(RUNNER_PATH)) {
  // Without this, the whole contract is defeated by pointing the script somewhere else: CI would
  // still say `pnpm gates` and would run whatever that name had come to mean.
  fail(
    `the ${JSON.stringify(RUNNER_SCRIPT)} script does not invoke ${RUNNER_PATH} ` +
      `(it is ${JSON.stringify(runnerScriptBody)})`,
  );
}

// ---------------------------------------------------------------------------------------------
// What every workflow runs, classified.
// ---------------------------------------------------------------------------------------------
const workflowsDir = join(repoRoot, ".github", "workflows");
let workflowNames = [];
try {
  workflowNames = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
} catch (error) {
  process.stderr.write(`gates:ci-parity: cannot read ${workflowsDir}: ${error.message}\n`);
  process.exit(1);
}

const INTERPRETERS = new Set(["node", "tsx", "npx", "python3", "python", "sh", "bash"]);

/**
 * A stable name for a command, or null when the segment verifies nothing.
 *
 * `pnpm <script>` and `node scripts/<file>` are the two shapes this repository's checks take. A
 * pnpm operation (`install`, `rebuild`) is named too, because setup has to be declared rather than
 * assumed — an unrecognised command is a failure, so a new one cannot slip in unnamed.
 */
const commandKeyFor = (segment) => {
  const pnpm = pnpmCommandFrom(segment);
  if (pnpm) {
    return {
      key: `pnpm ${pnpm.name}`,
      args: pnpm.args,
      isPnpmScript: pnpm.explicitRun || !PNPM_NON_SCRIPT_COMMANDS.has(pnpm.name),
    };
  }
  const words = shellWords(segment).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const head = basename(words[0] ?? "");
  if (!INTERPRETERS.has(head)) return null;
  const operand = words.slice(1).find((word) => !word.startsWith("-"));
  if (operand === undefined) return null;
  const normalised = operand.replace(/^\.\//, "");
  if (!normalised.startsWith("scripts/")) return null;
  return { key: `${head} ${normalised}`, args: [], isPnpmScript: false };
};

const gateJobRunnerInvocations = [];
const declarationsUsed = new Set();
let gateJobSeen = false;
let gateJobSource = null;

for (const workflowName of workflowNames) {
  const source = `.github/workflows/${workflowName}`;
  const text = readFileSync(join(workflowsDir, workflowName), "utf8");
  const lines = text.split(/\r?\n/);
  const jobs = jobByLine(lines);
  const runs = extractRunCommands(text, source);

  if (jobs.includes(CI_GATE_JOB)) {
    gateJobSeen = true;
    gateJobSource = source;
  }

  for (const run of runs) {
    for (const segment of shellSegments(replaceGitHubExpressions(run.command))) {
      const command = commandKeyFor(segment);
      const where = `${run.source}:${run.line}`;
      if (command === null) {
        // Outside the gate job an unrecognised command is not this check's business. Inside it,
        // it is the hole: `npx eslint .`, `node --test`, `make check` and a shell one-liner are
        // all verification this file would otherwise wave through while claiming the two sides
        // hold the same set. The gate job runs setup and the runner, and nothing it cannot name.
        if (run.job === CI_GATE_JOB) {
          fail(
            `${where}: ${CI_GATE_JOB} runs ${JSON.stringify(segment)}, which is neither the gate ` +
              "runner nor a declared setup command. The gate job may only build the environment " +
              "and run `pnpm gates`; anything else is a gate that exists on one side only.",
          );
        }
        continue;
      }

      const setupReason = CI_SETUP_COMMANDS.get(command.key);
      const isRunner = command.key === `pnpm ${RUNNER_SCRIPT}`;

      if (isRunner) {
        if (run.job !== CI_GATE_JOB) {
          fail(`${where}: job ${JSON.stringify(run.job)} runs the gate runner; only ${CI_GATE_JOB} may`);
          continue;
        }
        if (command.args.length > 0) {
          // An argument is how a subset gets in: `pnpm gates --only lint` would be a second,
          // shorter list, which is the thing this file exists to make impossible.
          fail(
            `${where}: the gate runner is invoked with ${JSON.stringify(command.args.join(" "))}; ` +
              "it must be invoked with no arguments so that CI runs the whole manifest",
          );
        }
        gateJobRunnerInvocations.push({ ...run, index: runs.indexOf(run) });
        continue;
      }

      if (setupReason !== undefined) {
        declarationsUsed.add(`setup:${command.key}`);
        continue;
      }

      if (run.job === CI_GATE_JOB) {
        fail(
          `${where}: ${CI_GATE_JOB} runs ${JSON.stringify(command.key)} as its own step. ` +
            "A gate CI runs and `pnpm gates` does not is exactly the drift #739 removes — put it " +
            "in GATES in scripts/lib/prepush-gates.mjs, or declare it as setup with a reason.",
        );
        continue;
      }

      if (!command.isPnpmScript && command.key.startsWith("pnpm ")) continue;

      const declarationKey = `${run.job}:${command.key}`;
      const reason = VERIFICATION_OUTSIDE_THE_RUNNER.get(declarationKey);
      if (reason === undefined) {
        fail(
          `${where}: job ${JSON.stringify(run.job)} runs ${JSON.stringify(command.key)}, which is ` +
            "neither in the gate manifest nor declared in VERIFICATION_OUTSIDE_THE_RUNNER. " +
            `Add it to GATES, or declare ${JSON.stringify(declarationKey)} with the reason it is ` +
            "not a pre-push gate.",
        );
        continue;
      }
      if (reason.trim() === "") fail(`${declarationKey} is declared with a blank reason`);
      declarationsUsed.add(`outside:${declarationKey}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The pass that makes a parser blind spot loud instead of silent.
  //
  // Everything above is derived from what `extractRunCommands` could see. If it misses a `run:`
  // form, the classification above sees nothing there and reports a clean result — the exact
  // silent-omission failure that made run-time extraction of `ci.yml` the rejected design. So
  // every command-shaped line has to land inside a block that was parsed.
  // ---------------------------------------------------------------------------------------------
  const covered = new Set();
  for (const run of runs) {
    for (let line = run.line; line <= run.endLine; line++) covered.add(line);
  }
  for (const [index, line] of lines.entries()) {
    if (covered.has(index + 1)) continue;
    if (line.trim().startsWith("#")) continue;
    if (/(?:^|[\s"'`(=])(?:pnpm|npx|tsx)\s+\S/.test(line) || /(?:^|[\s"'`(=])node\s+\S*scripts\//.test(line)) {
      fail(
        `${source}:${index + 1}: a command-shaped line outside every parsed run block: ` +
          `${JSON.stringify(line.trim())}. This check could not classify it, so it refuses rather ` +
          "than report a coverage it does not have.",
      );
    }
  }

  // A step allowed to fail is not a gate. `continue-on-error` anywhere in the gate job would let
  // the whole manifest report green after failing.
  for (const [index, line] of lines.entries()) {
    if (jobs[index] !== CI_GATE_JOB) continue;
    if (line.trim().startsWith("#")) continue;
    if (/^\s*continue-on-error:/.test(line)) {
      fail(`${source}:${index + 1}: ${CI_GATE_JOB} sets continue-on-error, so its gates cannot fail the job`);
    }
  }
}

if (!gateJobSeen) {
  fail(`no workflow defines the job ${JSON.stringify(CI_GATE_JOB)}, so nothing in CI runs the gate manifest`);
} else if (gateJobRunnerInvocations.length === 0) {
  fail(
    `${gateJobSource}: ${CI_GATE_JOB} never runs \`pnpm ${RUNNER_SCRIPT}\`. CI would then have its ` +
      "own gate list, which is the second source of truth #739 exists to remove.",
  );
} else if (gateJobRunnerInvocations.length > 1) {
  fail(`${gateJobSource}: ${CI_GATE_JOB} runs \`pnpm ${RUNNER_SCRIPT}\` more than once`);
}

// A declaration that names nothing is a hole that reads as a decision. Checks in this repository
// have gone stale exactly this way — an allow-list entry outliving the thing it allowed.
for (const key of CI_SETUP_COMMANDS.keys()) {
  if (!declarationsUsed.has(`setup:${key}`)) {
    fail(`CI_SETUP_COMMANDS declares ${JSON.stringify(key)}, which no workflow runs; remove it`);
  }
}
for (const key of VERIFICATION_OUTSIDE_THE_RUNNER.keys()) {
  if (!declarationsUsed.has(`outside:${key}`)) {
    fail(`VERIFICATION_OUTSIDE_THE_RUNNER declares ${JSON.stringify(key)}, which no workflow runs; remove it`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`gates:ci-parity: ${failures.length} failure(s)\n`);
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `gates:ci-parity: ${workflowNames.length} workflow file(s); ${CI_GATE_JOB} runs \`pnpm ${RUNNER_SCRIPT}\` ` +
    `and nothing else that verifies, so its gate set is exactly the ${GATES.length} in ` +
    "scripts/lib/prepush-gates.mjs that `pnpm gates` runs locally.\n" +
    `${VERIFICATION_OUTSIDE_THE_RUNNER.size} verification command(s) run outside the runner, each declared with a reason.\n` +
    "This does not claim a step is reached or that any gate is correct — only that neither side can hold a gate the other does not.\n",
);
