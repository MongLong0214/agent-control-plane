#!/usr/bin/env node
/**
 * Fast, dependency-free checks for two CI-only failure shapes:
 *
 *   1. every statically visible workflow `pnpm` shorthand names either a package script or a
 *      pnpm command that does not dispatch through package.json; and
 *   2. every workflow `run:` command in this repository parses under Bash after GitHub
 *      expressions are replaced with an inert word.
 *
 * This deliberately does not claim that a workflow reaches a step or that a GitHub expression's
 * runtime value is safe shell input. It closes the local/CI shape that produced a missing script
 * and an unmatched quote before either change can leave the commit hook.
 *
 * sol-simplify: this exists because these two defects repeatedly reached CI; remove it when the
 * workflow runner or another pre-commit check supplies both facts from the working tree.
 *
 * Usage: node scripts/verify-ci-preflight.mjs [--repo-root=<path>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractRunCommands,
  pnpmCommandFrom,
  PNPM_NON_SCRIPT_COMMANDS,
  replaceGitHubExpressions,
  shellSegments,
} from "./lib/workflow-commands.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const rootArgument = process.argv.find((argument) => argument.startsWith("--repo-root="));
const repoRoot = rootArgument ? resolve(rootArgument.slice("--repo-root=".length)) : defaultRoot;

const packagePath = join(repoRoot, "package.json");
const workflowsDir = join(repoRoot, ".github", "workflows");

let packageScripts;
try {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));
} catch (error) {
  process.stderr.write(`ci-preflight: cannot read package.json: ${error.message}\n`);
  process.exit(1);
}

const workflowNames = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

const failures = [];
const runCommands = [];
try {
  for (const workflowName of workflowNames) {
    const source = `.github/workflows/${workflowName}`;
    runCommands.push(
      ...extractRunCommands(readFileSync(join(workflowsDir, workflowName), "utf8"), source),
    );
  }
} catch (error) {
  failures.push(error.message);
}

let pnpmInvocations = 0;
for (const run of runCommands) {
  const shellText = replaceGitHubExpressions(run.command);
  const syntax = spawnSync("bash", ["-n"], { input: shellText, encoding: "utf8" });
  if (syntax.error || syntax.status !== 0) {
    const detail = syntax.error?.message ?? syntax.stderr.trim().split("\n").at(-1) ?? "unknown error";
    failures.push(`${run.source}:${run.line}: run command fails bash -n: ${detail}`);
  }

  for (const segment of shellSegments(shellText)) {
    const invocation = pnpmCommandFrom(segment);
    if (!invocation) continue;
    pnpmInvocations++;
    const isPackageScript = packageScripts.has(invocation.name);
    if (isPackageScript) continue;
    if (!invocation.explicitRun && PNPM_NON_SCRIPT_COMMANDS.has(invocation.name)) continue;
    failures.push(
      `${run.source}:${run.line}: pnpm invokes missing package script ${JSON.stringify(invocation.name)}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`ci-preflight: ${failures.length} failure(s)\n`);
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `ci-preflight: ${workflowNames.length} workflow file(s), ${runCommands.length} run command(s), ` +
    `${pnpmInvocations} pnpm invocation(s); every package script exists and every run command parses under Bash.\n`,
);
