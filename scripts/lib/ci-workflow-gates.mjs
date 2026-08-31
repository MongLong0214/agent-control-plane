/**
 * Shared, dependency-free GitHub Actions workflow parsing for two callers:
 *
 *   - scripts/verify-ci-preflight.mjs: every `run:` command in every workflow file, checked for
 *     Bash syntax and package-script existence.
 *   - scripts/run-gates.mjs (`pnpm gates`): the ordered list of `pnpm` gates the `verify` job
 *     runs before `pnpm test`, derived from this same parse.
 *
 * One parser, so the two callers cannot disagree about what a workflow file says. A hand-copied
 * second list is the defect this module exists to rule out: a merge resolution once dropped the
 * `coordinates:stale` package script while `ci.yml` still invoked it, invisibly locally and only
 * visible in CI as `Command not found` — two parsers that quietly disagreed would recreate that
 * shape one layer up.
 *
 * This is not a general YAML parser. It recognizes exactly the block-mapping and block-sequence
 * shapes this repository's workflows use (the same trade-off verify-ci-preflight.mjs already
 * made, for the same reason: dependency-free, PRD §17.4). A workflow shape it does not recognize
 * should get a real parser, not a silently-taught special case here.
 */
import { readFileSync } from "node:fs";

export const indentationOf = (line) => (/^(\s*)/.exec(line) ?? ["", ""])[1].length;

export const decodeInlineScalar = (scalar, source, line) => {
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
export const extractRunCommands = (yamlText, source) => {
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

export const pnpmCommandFrom = (segment) => {
  const words = shellWords(segment);
  let at = 0;
  while (isAssignment(words[at] ?? "") || COMMAND_PREFIXES.has(words[at])) at++;
  if (basenameOf(words[at] ?? "") === "env") {
    at++;
    while (isAssignment(words[at] ?? "")) at++;
  }
  if (basenameOf(words[at] ?? "") !== "pnpm") return null;
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

// A minimal `basename` so this module has no dependency on node:path beyond what callers already
// pull in for their own purposes; kept local and simple since it only ever sees shell words.
function basenameOf(word) {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

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

// ---------------------------------------------------------------------------
// Job/step-scoped extraction, for `pnpm gates`. `extractRunCommands` above answers "every `run:`
// command in this text"; the functions below answer "which job is this step in, in what order,
// and what else does the step declare (`if:`, `env:`, `name:`)" — the extra structure a single
// verify-job gate runner needs that a flat command scan does not carry.
// ---------------------------------------------------------------------------

/**
 * Line range `[start, end)` of one top-level job's block inside a workflow's `jobs:` mapping.
 *
 * Recognizes exactly this repository's convention: `jobs:` at column 0, one bare key per job at a
 * single consistent indent, nothing else at that indent until the `jobs:` block ends (a line at a
 * shallower indent, or end of file).
 */
export const findJobLineRange = (lines, jobId) => {
  const jobsLine = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsLine === -1) return null;

  let jobIdIndent = null;
  const jobStarts = [];
  let jobsEnd = lines.length;
  for (let index = jobsLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = indentationOf(line);
    if (jobIdIndent === null) jobIdIndent = indent;
    if (indent < jobIdIndent) {
      jobsEnd = index;
      break;
    }
    if (indent !== jobIdIndent) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim());
    if (!match) continue;
    jobStarts.push({ name: match[1], index });
  }

  const target = jobStarts.find((job) => job.name === jobId);
  if (!target) return null;
  const next = jobStarts.find((job) => job.index > target.index);
  return { start: target.index, end: next ? next.index : jobsEnd };
};

/** `steps:`'s block-sequence item ranges `[start, end)` within one job's own line range. */
export const findStepRanges = (lines, jobStart, jobEnd) => {
  let stepsIndent = null;
  let stepsLine = null;
  for (let index = jobStart; index < jobEnd; index++) {
    if (lines[index].trim() === "steps:") {
      stepsLine = index;
      stepsIndent = indentationOf(lines[index]);
      break;
    }
  }
  if (stepsLine === null) return [];

  let itemIndent = null;
  const starts = [];
  for (let index = stepsLine + 1; index < jobEnd; index++) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = indentationOf(line);
    if (indent <= stepsIndent) break;
    if (itemIndent === null) {
      if (!/^-(\s|$)/.test(line.trim())) return [];
      itemIndent = indent;
    }
    if (indent === itemIndent) {
      if (!/^-(\s|$)/.test(line.trim())) continue;
      starts.push(index);
    }
  }
  return starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1] : jobEnd }));
};

/**
 * One step's own top-level keys: `name:`, `if:`, `env:` (as a flat key/value map of its raw
 * scalars), and the line number of its `run:` key, if it has one. Everything else a step can
 * carry (`uses:`, `with:`, the `run:` value itself) is the caller's job, or `extractRunCommands`'s.
 */
export const parseStepMeta = (lines, start, end) => {
  const dashIndent = indentationOf(lines[start]);
  const contentIndent = dashIndent + 2;
  const meta = { name: null, ifCondition: null, env: null, runLine: null };
  let envIndent = null;

  for (let index = start; index < end; index++) {
    const raw =
      index === start ? lines[start].replace(/^\s*-\s?/, " ".repeat(contentIndent)) : lines[index];
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
    const indent = indentationOf(raw);

    if (envIndent !== null) {
      if (indent >= envIndent) {
        const child = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw.trim());
        if (child) (meta.env ??= {})[child[1]] = child[2];
        continue;
      }
      envIndent = null;
    }

    if (indent !== contentIndent) continue;
    const keyed = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(raw.trim());
    if (!keyed) continue;
    const [, key, rest] = keyed;
    if (key === "name") meta.name = rest.trim();
    else if (key === "if") meta.ifCondition = rest.trim();
    else if (key === "run") meta.runLine = index + 1;
    else if (key === "env" && rest.trim() === "") {
      for (let peek = index + 1; peek < end; peek++) {
        if (lines[peek].trim() === "") continue;
        envIndent = indentationOf(lines[peek]);
        break;
      }
    }
  }
  return meta;
};

/**
 * Every `run:` step in one job, in file order, each with its step-level `name:`/`if:`/`env:`.
 *
 * Returns `null` when the job does not exist in this workflow text — distinct from `[]`, which
 * means the job exists but declares no `run:` steps. A caller that cannot tell "job missing" from
 * "job empty" cannot report a wrong `--job` the way this module's own callers need to.
 */
export const extractJobGateSteps = (yamlText, source, jobId) => {
  const lines = yamlText.split(/\r?\n/);
  const jobRange = findJobLineRange(lines, jobId);
  if (!jobRange) return null;

  const runCommands = extractRunCommands(yamlText, source);
  const byLine = new Map(runCommands.map((run) => [run.line, run]));

  const steps = [];
  for (const { start, end } of findStepRanges(lines, jobRange.start, jobRange.end)) {
    const meta = parseStepMeta(lines, start, end);
    if (meta.runLine === null) continue;
    const runCommand = byLine.get(meta.runLine);
    if (!runCommand) continue;
    steps.push({
      source,
      line: meta.runLine,
      command: runCommand.command,
      stepName: meta.name,
      ifCondition: meta.ifCondition,
      env: meta.env,
    });
  }
  return steps;
};

/** Loads a workflow file's text, given the repository root and its path relative to it. */
export const readWorkflow = (repoRoot, relativePath) =>
  readFileSync(`${repoRoot}/${relativePath}`, "utf8");
