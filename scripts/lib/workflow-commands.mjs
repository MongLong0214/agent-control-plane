/**
 * The one reader of "what a workflow actually hands to the shell".
 *
 * This was inline in `scripts/verify-ci-preflight.mjs` and is now shared, because
 * `scripts/verify-ci-runs-the-gate-runner.mjs` asks a second question of the same text: not "does
 * this command name a script that exists" but "is this command a verification gate that the
 * pre-push runner does not own". Two answers derived from two hand-rolled parsers drift, and a
 * parser that drifts reports coverage of steps it can no longer see — the shape #739 exists to
 * remove, one layer down.
 *
 * What it adds over the original: every command carries the job id it belongs to and the line span
 * it occupies. The gate-parity check needs both — the job because `guards:falsifiable` legitimately
 * runs outside the runner in its own job, and the span because it cross-checks its own blind spots
 * by requiring every command-shaped line in the file to fall inside some captured command.
 *
 * It does not claim a step executes, that a matrix leg is reached, or that a GitHub expression's
 * runtime value is what a reader assumes. Those remain out of scope here as they were before.
 */
import { basename } from "node:path";

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

/**
 * The job id a line belongs to, by line number.
 *
 * `jobs:` is the only top-level key whose second-level keys are job ids; `on:` has `push:` and
 * `pull_request:` at the same indentation and they are not jobs. So the scan tracks which
 * top-level key it is under rather than keying off indentation alone.
 */
export const jobByLine = (lines) => {
  const jobs = new Array(lines.length).fill(null);
  let insideJobs = false;
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() !== "" && !line.startsWith("#")) {
      const topLevel = /^([A-Za-z0-9_.-]+):/.exec(line);
      if (topLevel) {
        insideJobs = topLevel[1] === "jobs";
        current = null;
      } else if (insideJobs) {
        const jobKey = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
        if (jobKey) current = jobKey[1];
      }
    }
    jobs[index] = insideJobs ? current : null;
  }
  return jobs;
};

/** Reads the command text GitHub gives the shell, not arbitrary mentions of `run:` in comments. */
export const extractRunCommands = (yamlText, source) => {
  const lines = yamlText.split(/\r?\n/);
  const jobs = jobByLine(lines);
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
        endLine: nextIndex,
        job: jobs[index] ?? null,
        command: scalar.startsWith(">") ? dedented.join(" ") : dedented.join("\n"),
      });
      index = nextIndex - 1;
      continue;
    }

    commands.push({
      source,
      line: index + 1,
      endLine: index + 1,
      job: jobs[index] ?? null,
      command: decodeInlineScalar(scalar, source, index + 1),
    });
  }
  return commands;
};

export const replaceGitHubExpressions = (command) =>
  command.replace(/\$\{\{[\s\S]*?\}\}/g, "GITHUB_EXPRESSION");

/** Splits at shell command boundaries without turning quoted operators into boundaries. */
export const shellSegments = (command) => {
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

export const shellWords = (segment) =>
  (segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? []).map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  });

const COMMAND_PREFIXES = new Set(["!", "command", "do", "elif", "else", "exec", "if", "then"]);
const isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** The script a `pnpm` segment dispatches, plus every word that follows it. */
export const pnpmCommandFrom = (segment) => {
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
    return words[at] ? { name: words[at], explicitRun: true, args: words.slice(at + 1) } : null;
  }
  return words[at] ? { name: words[at], explicitRun: false, args: words.slice(at + 1) } : null;
};

// These are pnpm operations, not shorthand for `pnpm run <name>`. Lifecycle aliases such as
// `test`, `start`, and `restart` are intentionally absent: they still require package scripts.
export const PNPM_NON_SCRIPT_COMMANDS = new Set([
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
