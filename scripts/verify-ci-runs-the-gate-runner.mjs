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
  CI_GATE_JOB_ACTIONS,
  CI_GATE_JOB_KEYS,
  CI_GATE_JOB_KEYS_REFUSED,
  CI_GATE_JOB_STRATEGY,
  CI_SETUP_COMMANDS,
  GATES,
  RUNNER_SCRIPT,
  RUNNER_SCRIPT_WORDS,
  RUNNER_STEP_ENV,
  RUNNER_STEP_KEYS,
  VERIFICATION_OUTSIDE_THE_RUNNER,
} from "./lib/prepush-gates.mjs";
import {
  extractRunCommands,
  jobByLine,
  parseJob,
  pnpmCommandFrom,
  PNPM_NON_SCRIPT_COMMANDS,
  replaceGitHubExpressions,
  shellSegments,
  plainScalar,
  shellWords,
  topLevelKeys,
} from "./lib/workflow-commands.mjs";

const indentOf = (line) => (/^(\s*)/.exec(line) ?? ["", ""])[1].length;

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

/**
 * The `gates` script has to *be* the runner's invocation, not mention it.
 *
 * This check used to ask whether the script text contained the runner's path. An independent
 * review broke it in one move: `"gates": "echo scripts/run-prepush-gates.mjs"` contains the path,
 * runs nothing, and the check passed. A substring test is defeated by including the substring, and
 * that is the first thing someone routing around a guard reaches for, not the last.
 *
 * "Exact" here means: the script is one shell command, and its words are exactly the runner's
 * argv — `node scripts/run-prepush-gates.mjs`. That definition cannot be satisfied by a script
 * that does not run the runner, because there is nowhere for anything else to go. A second command
 * needs an operator (`&&`, `;`, `|`, a newline), which makes a second segment. A different program
 * changes word 0. A wrapper, a redirect, a leading `VAR=` assignment, an extra flag, or a path that
 * only resembles the runner's changes the word list. Word-for-word equality leaves no room that a
 * substring match leaves open.
 *
 * The limit, stated rather than implied: this is a claim about the argv, not about the file it
 * names. It does not prove `node` on PATH is Node, and it does not prove
 * `scripts/run-prepush-gates.mjs` still runs the manifest — that is what the runner's own
 * falsifiability rows are for.
 */
const runnerScriptBody = packageScripts[RUNNER_SCRIPT];
if (runnerScriptBody === undefined) {
  fail(`package.json has no ${JSON.stringify(RUNNER_SCRIPT)} script, so \`pnpm ${RUNNER_SCRIPT}\` runs nothing`);
} else {
  const segments = shellSegments(runnerScriptBody);
  const words = segments.length === 1 ? shellWords(segments[0]) : [];
  const isExactly =
    segments.length === 1 &&
    words.length === RUNNER_SCRIPT_WORDS.length &&
    words.every((word, at) => word.replace(/^\.\//, "") === RUNNER_SCRIPT_WORDS[at]);
  if (!isExactly) {
    fail(
      `the ${JSON.stringify(RUNNER_SCRIPT)} script is ${JSON.stringify(runnerScriptBody)}, which is not ` +
        `exactly \`${RUNNER_SCRIPT_WORDS.join(" ")}\`. It must be that one command and nothing else — ` +
        "a script that merely mentions the runner's path passes a substring test while running `echo`.",
    );
  }
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

  // ---------------------------------------------------------------------------------------------
  // Reach-in from above the job.
  //
  // A top-level `defaults:` sets `working-directory` for every step of every job, and a top-level
  // `env:` changes what every command in the file means. Neither appears inside the gate job, so a
  // job-scoped check cannot see either — the same blind spot as `working-directory`, one level up.
  // ---------------------------------------------------------------------------------------------
  if (jobs.includes(CI_GATE_JOB)) {
    for (const key of topLevelKeys(lines)) {
      if (key.name !== "defaults" && key.name !== "env") continue;
      fail(
        `${source}:${key.line}: the workflow that holds ${CI_GATE_JOB} sets a top-level ` +
          `${JSON.stringify(key.name)}, which reaches into every step of the gate job — ` +
          `${key.name === "defaults" ? "moving the directory it verifies" : "changing what its commands mean"}. ` +
          "The gate job must run on the tree and the environment `pnpm gates` runs on locally.",
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The gate job, enumerated rather than sampled.
  //
  // Reading `run:` text and nothing else is what let four separate mutations through: `if: false`,
  // a `working-directory:`, a `uses:` action doing the verification, and — in another file — a
  // package script that only mentioned the runner. None of them is a command. So every key of the
  // job, every step, every key of every step, and every `with:` input is either named in the
  // manifest or fails here, and a line the parser could not place fails too.
  // ---------------------------------------------------------------------------------------------
  const job = parseJob(lines, jobs, CI_GATE_JOB);
  if (job !== null) {
    for (const stray of job.unplaced) {
      fail(
        `${source}:${stray.line}: a line inside ${CI_GATE_JOB} this check could not place: ` +
          `${JSON.stringify(stray.text.trim())}. It refuses rather than pass over a shape it does ` +
          "not understand — an unread line is how `if:`, `uses:` and `working-directory:` got in.",
      );
    }

    for (const key of job.jobKeys) {
      if (CI_GATE_JOB_KEYS.has(key.name)) continue;
      const refused = CI_GATE_JOB_KEYS_REFUSED.get(key.name);
      fail(
        `${source}:${key.line}: ${CI_GATE_JOB} sets ${JSON.stringify(key.name)}, which is not one of ` +
          `the job keys the gate job may carry${refused ? ` — it ${refused}` : ""}. Declare it in ` +
          "CI_GATE_JOB_KEYS with the reason it cannot change what CI verifies, or remove it.",
      );
    }

    const strategy = job.jobKeys.find((key) => key.name === "strategy");
    if (strategy) {
      for (const entry of job.mappingAt(strategy.body[0], strategy.body[1], indentOf(lines[strategy.line - 1]) + 2)) {
        if (!CI_GATE_JOB_STRATEGY.keys.has(entry.name)) {
          fail(`${source}:${entry.line}: ${CI_GATE_JOB}'s strategy sets ${JSON.stringify(entry.name)}`);
          continue;
        }
        if (entry.name !== "matrix") continue;
        const matrixIndent = indentOf(lines[entry.line - 1]) + 2;
        const dimensions = job.mappingAt(entry.body[0], entry.body[1], matrixIndent);
        for (const dimension of dimensions) {
          if (CI_GATE_JOB_STRATEGY.matrixKeys.has(dimension.name)) continue;
          // `include:` and `exclude:` decide which legs exist at all. A matrix that excludes every
          // leg produces a job that runs no gates and reports `skipped`, not `failure`.
          fail(
            `${source}:${dimension.line}: ${CI_GATE_JOB}'s matrix declares ${JSON.stringify(dimension.name)}, ` +
              "which changes which legs exist. Only the declared dimensions may vary; the gate set may not.",
          );
        }
      }
    }

    let runnerSteps = 0;
    for (const step of job.steps) {
      const keyNames = step.keys.map((key) => key.name);
      const runKey = step.keys.find((key) => key.name === "run");
      const usesKey = step.keys.find((key) => key.name === "uses");
      const at = `${source}:${step.line}`;

      if (usesKey) {
        const uses = plainScalar(usesKey.inline);
        const [action, ref] = uses.split("@");
        const declared = CI_GATE_JOB_ACTIONS.get(action);
        if (declared === undefined) {
          fail(
            `${at}: ${CI_GATE_JOB} uses the action ${JSON.stringify(uses)}, which is not ` +
              "declared in CI_GATE_JOB_ACTIONS. An action can verify anything a gate can, and no " +
              "`run:` line says so — so an undeclared one is a gate CI holds and `pnpm gates` does not.",
          );
          continue;
        }
        if (!/^[0-9a-f]{40}$/.test(ref ?? "")) {
          fail(`${at}: ${JSON.stringify(uses)} is not pinned to a 40-character commit SHA`);
        }
        const allowedKeys = new Set(["uses", "with", ...(declared.if ? ["if"] : [])]);
        for (const name of keyNames) {
          if (!allowedKeys.has(name)) {
            fail(`${at}: the ${JSON.stringify(action)} step carries ${JSON.stringify(name)}, which it may not`);
          }
        }
        const withKey = step.keys.find((key) => key.name === "with");
        if (withKey) {
          const withIndent = indentOf(lines[withKey.line - 1]) + 2;
          for (const input of job.mappingAt(withKey.body[0], withKey.body[1], withIndent)) {
            if (declared.with.has(input.name)) continue;
            // `repository`, `ref` and `path` on a checkout each make CI verify a tree that is not
            // this commit — the `working-directory` defect arriving through an action's inputs.
            fail(
              `${at}: ${JSON.stringify(action)} is given ${JSON.stringify(input.name)} at ` +
                `${source}:${input.line}, which is not one of the inputs it may take here. ` +
                "An input that moves or replaces the tree makes CI verify something else.",
            );
          }
        }
        continue;
      }

      if (!runKey) {
        fail(`${at}: a step in ${CI_GATE_JOB} that is neither a \`run:\` nor a \`uses:\``);
        continue;
      }

      const isRunner = shellSegments(replaceGitHubExpressions(runKey.inline)).some((segment) => {
        const command = commandKeyFor(segment);
        return command !== null && command.key === `pnpm ${RUNNER_SCRIPT}`;
      });

      if (isRunner) {
        runnerSteps++;
        for (const name of keyNames) {
          if (RUNNER_STEP_KEYS.has(name)) continue;
          // This is the whole class the review found: `if:` decides whether the runner runs,
          // `working-directory:` decides which tree it runs on, `shell:` decides how its exit
          // status is read, `continue-on-error:` decides whether its failure counts. None of them
          // is a command, and all four leave CI running something other than the manifest.
          fail(
            `${at}: the \`pnpm ${RUNNER_SCRIPT}\` step carries ${JSON.stringify(name)}. The runner ` +
              "step may carry only `run` and `env`: anything else decides whether it runs, which " +
              "tree it runs on, or whether its failure counts — while the command still reads " +
              "`pnpm gates`.",
          );
        }
        const envKey = step.keys.find((key) => key.name === "env");
        if (envKey) {
          const envIndent = indentOf(lines[envKey.line - 1]) + 2;
          for (const variable of job.mappingAt(envKey.body[0], envKey.body[1], envIndent)) {
            if (RUNNER_STEP_ENV.has(variable.name)) continue;
            fail(
              `${source}:${variable.line}: the gate step sets ${JSON.stringify(variable.name)}; only ` +
                `${[...RUNNER_STEP_ENV].join(", ")} may be supplied by the workflow, because a gate's ` +
                "behaviour must not depend on which side invoked it.",
            );
          }
        }
        continue;
      }

      for (const name of keyNames) {
        if (name === "run") continue;
        fail(
          `${at}: a setup step in ${CI_GATE_JOB} carries ${JSON.stringify(name)}; setup steps may ` +
            "carry only `run`, so none of them can move, skip, or reinterpret what follows.",
        );
      }
    }

    if (runnerSteps !== 1) {
      fail(
        `${source}: ${CI_GATE_JOB} has ${runnerSteps} step(s) running \`pnpm ${RUNNER_SCRIPT}\`; ` +
          "it must have exactly one.",
      );
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
