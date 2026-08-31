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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const indentationOf = (line) => (/^(\s*)/.exec(line) ?? ["", ""])[1].length;

const decodeInlineScalar = (scalar, source, line) => {
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      return JSON.parse(scalar);
    } catch (error) {
      throw new Error(`${source}:${line}: cannot decode the quoted run scalar: ${error.message}`);
    }
  }
  return scalar;
};

/** Reads the command text GitHub gives the shell, not arbitrary mentions of `run:` in comments. */
const extractRunCommands = (yamlText, source) => {
  const lines = yamlText.split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!match) continue;

    const keyIndent = indentationOf(line);
    const scalar = match[2].trim();
    if (/^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(scalar)) {
      const block = [];
      let nextIndex = index + 1;
      for (; nextIndex < lines.length; nextIndex++) {
        const next = lines[nextIndex];
        if (next.trim() !== "" && indentationOf(next) <= keyIndent) break;
        block.push(next);
      }
      const contentIndent = block
        .filter((entry) => entry.trim() !== "")
        .reduce((least, entry) => Math.min(least, indentationOf(entry)), Number.POSITIVE_INFINITY);
      const dedented = block.map((entry) =>
        entry.trim() === "" || !Number.isFinite(contentIndent) ? "" : entry.slice(contentIndent),
      );
      commands.push({
        source,
        line: index + 1,
        command: scalar.startsWith(">") ? dedented.join(" ") : dedented.join("\n"),
      });
      index = nextIndex - 1;
      continue;
    }

    commands.push({ source, line: index + 1, command: decodeInlineScalar(scalar, source, index + 1) });
  }
  return commands;
};

const replaceGitHubExpressions = (command) =>
  command.replace(/\$\{\{[\s\S]*?\}\}/g, "GITHUB_EXPRESSION");

/** Splits at shell command boundaries without turning quoted operators into boundaries. */
const shellSegments = (command) => {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flush();
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#" && (current === "" || /\s$/.test(current))) {
      comment = true;
      continue;
    }
    if (character === "\n" || character === ";" || character === "|" || character === "&") {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return segments;
};

const shellWords = (segment) =>
  (segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? []).map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  });

const COMMAND_PREFIXES = new Set(["!", "command", "do", "elif", "else", "exec", "if", "then"]);
const isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const pnpmCommandFrom = (segment) => {
  const words = shellWords(segment);
  let at = 0;
  while (isAssignment(words[at] ?? "") || COMMAND_PREFIXES.has(words[at])) at++;
  if (basename(words[at] ?? "") === "env") {
    at++;
    while (isAssignment(words[at] ?? "")) at++;
  }
  if (basename(words[at] ?? "") !== "pnpm") return null;
  at++;

  const globalOptionsWithValues = new Set(["--dir", "-C", "--filter", "-F"]);
  while ((words[at] ?? "").startsWith("-")) {
    const option = words[at];
    at++;
    if (globalOptionsWithValues.has(option)) at++;
  }
  if (words[at] === "run") {
    at++;
    while ((words[at] ?? "").startsWith("-")) at++;
    return words[at] ? { name: words[at], explicitRun: true } : null;
  }
  return words[at] ? { name: words[at], explicitRun: false } : null;
};

// These are pnpm operations, not shorthand for `pnpm run <name>`. Lifecycle aliases such as
// `test`, `start`, and `restart` are intentionally absent: they still require package scripts.
const PNPM_NON_SCRIPT_COMMANDS = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "config",
  "create",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "help",
  "import",
  "init",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "root",
  "setup",
  "store",
  "uninstall",
  "update",
  "version",
  "why",
]);

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
