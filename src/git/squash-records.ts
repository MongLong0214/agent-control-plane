/**
 * The merge-records gate's own `examineSquash`, asked before a squash exists.
 *
 * This is the subprocess half of the daemon's squash check and lives outside `src/github` on
 * purpose: nothing on the GitHub path imports the means to spawn (P1-14, `tests/unit/github-r2.test.ts`),
 * so no child there can carry the App token. The children here get a minimal environment built
 * below, never the daemon's own, exactly as `git.ts` does for every other git call.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";

/**
 * `scripts/verify-merge-preserved-records.mjs`, the check `main`'s push CI runs. `src/git` and the
 * built `dist/git`, like `src/github` and `dist/github`, sit two levels under the root whose
 * `scripts/` the deployed generation ships, so this one address serves both.
 */
export const MERGE_RECORDS_GATE = new URL("../../scripts/verify-merge-preserved-records.mjs", import.meta.url);

/** A full commit sha, as the gate reads one. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A branch record line the squash's trailer block would not keep, and the branch commit that carried it. */
export interface UnpreservedRecordLine {
  readonly commit: string;
  readonly line: string;
}

/** What the merge-records gate would find, asked before the merge rather than after it. */
export interface SquashRecordPreservation {
  /** Record lines the branch carries, counted as the gate counts them. */
  readonly carried: number;
  /** The gate's own answer: each lost line once, with the one commit the gate maps it to. */
  readonly unpreserved: readonly UnpreservedRecordLine[];
  /**
   * The Record-Ids of every branch commit whose stored trailers carry a lost line, each once, in
   * branch order. Every carrier, not only the gate's one: two records sharing a line both lose it.
   */
  readonly recordIds: readonly string[];
  /** Commits carrying a lost line and no Record-Id to name it by. */
  readonly commitsWithoutRecordId: readonly string[];
}

const execFileAsync = promisify(execFile);
/** One bound for the whole examination, every process in it included, not one per process. */
export const PRESERVATION_TIMEOUT_MS = 120_000;

/**
 * The gate's `examineSquash`, run where its git calls land: a child whose cwd is the fixture
 * repository. The gate reads each commit with two `git` processes, `log -1 --format=%B <sha>` and
 * `interpret-trailers --parse` on that output, which on a 250-commit branch is 500 processes and
 * tens of seconds on a loaded host. Those two reads, and only those, are answered from `reads`: the
 * same commands' stdout, read for every commit at once (`gateReads`). The gate's code decides; a
 * call that matches no read answered here runs as `git` itself.
 */
const EXAMINE_SQUASH = [
  'import { readFileSync } from "node:fs";',
  'import { createRequire, syncBuiltinESMExports } from "node:module";',
  "const [gate, squash, pull, reads] = process.argv.slice(1);",
  'const answers = JSON.parse(readFileSync(reads, "utf8"));',
  "const messages = new Map(answers.messages);",
  "const trailers = new Map(answers.trailers);",
  'const childProcess = createRequire(import.meta.url)("node:child_process");',
  "const spawnSync = childProcess.spawnSync;",
  'const answered = (stdout) => ({ pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null });',
  "childProcess.spawnSync = (file, args, options, ...rest) => {",
  '  if (file === "git" && Array.isArray(args) && options?.encoding === "utf8") {',
  '    if (args.length === 4 && args[0] === "log" && args[1] === "-1" && args[2] === "--format=%B"',
  "      && options.input === undefined && messages.has(args[3])) return answered(messages.get(args[3]));",
  '    if (args.length === 2 && args[0] === "interpret-trailers" && args[1] === "--parse"',
  '      && typeof options.input === "string" && trailers.has(options.input)) return answered(trailers.get(options.input));',
  "  }",
  "  return spawnSync(file, args, options, ...rest);",
  "};",
  "syncBuiltinESMExports();",
  "const { examineSquash } = await import(gate);",
  "const { carried, missing } = examineSquash(squash, pull);",
  "process.stdout.write(JSON.stringify({ carried: carried.size, missing }));",
].join("\n");

/** A bounded `run` in `cwd`: every process gets what remains of one deadline, and none starts once it is spent. */
type Run = (file: string, args: readonly string[], input?: string) => Promise<string>;

const examinationTimedOut = (timeoutMs: number, started: boolean) =>
  acpError(
    ReasonCode.GIT_TIMEOUT,
    `the merge-records examination of the squash did not finish within its ${timeoutMs}ms bound`,
    { timeoutMs, started },
  );

const boundedRun = (cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Run => {
  const endsAt = performance.now() + timeoutMs;
  return async (file, args, input) => {
    const remaining = Math.floor(endsAt - performance.now());
    if (remaining < 1) throw examinationTimedOut(timeoutMs, false);
    try {
      const pending = execFileAsync(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: remaining });
      pending.child.stdin?.end(input ?? "");
      return (await pending).stdout;
    } catch (error) {
      // Node reports a child its `timeout` killed as `killed`, SIGTERM and no string code; an
      // overflowing `maxBuffer` is killed too, and carries its own code.
      const { killed, signal, code } = error as { killed?: unknown; signal?: unknown; code?: unknown };
      if (killed === true && signal === "SIGTERM" && typeof code !== "string") throw examinationTimedOut(timeoutMs, true);
      throw error;
    }
  };
};

/** What the gate's two per-commit reads answer, as each would print it. */
export interface GateReads {
  /** `git log -1 --format=%B <sha>`'s stdout, by sha. */
  readonly messages: ReadonlyMap<string, string>;
  /** `git interpret-trailers --parse`'s stdout, by the input it was given. */
  readonly trailers: ReadonlyMap<string, string>;
}

/**
 * The gate's two per-commit reads for every sha in `shas`, in two processes: one `git log` over
 * them all, and one `git interpret-trailers --parse` over one file per message with a separator
 * file between, which git parses one by one and prints in order. A delimiter is a fresh random
 * token; an answer that does not split into exactly the pieces asked for throws.
 */
const readGate = async (run: Run, cwd: string, shas: readonly string[]): Promise<GateReads> => {
  const token = randomBytes(16).toString("hex");
  const logged = (await run("git", ["log", "--no-walk=unsorted", `--format=${token}%H%n%B`, ...shas])).split(token);
  if (logged.length !== shas.length + 1 || logged[0] !== "") throw new Error("the branch's messages could not be read back");
  const messages = new Map<string, string>();
  for (const [index, sha] of shas.entries()) {
    const entry = logged[index + 1]!;
    if (!entry.startsWith(`${sha}\n`)) throw new Error("the branch's messages could not be read back");
    messages.set(sha, entry.slice(sha.length + 1));
  }

  const inputs = [...new Set(messages.values())];
  if (inputs.some((input) => input.includes(token))) throw new Error("the branch's messages could not be read back");
  const separator = `Acp-Read-${token}: end\n`;
  const folder = join(cwd, "trailer-inputs");
  mkdirSync(folder);
  writeFileSync(join(folder, "separator"), `separator\n\n${separator}`);
  const files: string[] = [];
  for (const [index, input] of inputs.entries()) {
    writeFileSync(join(folder, `message-${index}`), input);
    files.push(join("trailer-inputs", `message-${index}`), join("trailer-inputs", "separator"));
  }
  const parsed = (await run("git", ["interpret-trailers", "--parse", ...files])).split(separator);
  if (parsed.length !== inputs.length + 1 || parsed.at(-1) !== "") throw new Error("the branch's trailers could not be read back");
  return { messages, trailers: new Map(inputs.map((input, index) => [input, parsed[index]!])) };
};

/**
 * `readGate` in `cwd` with `env`, for the witness that holds it to the gate's own per-commit reads.
 * `shas` must be commits there.
 */
export const gateReads = (cwd: string, env: NodeJS.ProcessEnv, shas: readonly string[]): Promise<GateReads> =>
  readGate(boundedRun(cwd, env, PRESERVATION_TIMEOUT_MS), cwd, shas);

/** The lines the gate's `storedTrailers` reads from one `interpret-trailers --parse` answer. */
const storedLines = (parsed: string): string[] => parsed.split("\n").map((line) => line.trim()).filter(Boolean);

const isExamination = (value: unknown): value is { carried: number; missing: Array<[string, string]> } => {
  if (typeof value !== "object" || value === null) return false;
  const { carried, missing } = value as { carried?: unknown; missing?: unknown };
  return Number.isSafeInteger(carried) && Array.isArray(missing) && missing.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string");
};

/**
 * Whether the squash's own trailer block keeps every record line the branch carries, decided by the
 * merge-records gate's own `examineSquash` rather than by a second rule.
 *
 * The squash does not exist before the merge, so it is built: a private repository holding the
 * branch's messages as a chain of commits and `title`, a blank line and `message` as the squash on
 * their base — the bytes GitHub commits. The only change is the `Merged-Head` value, which must name
 * the fixture's head for the gate to read the branch. That repository has no notes ref, so the answer
 * is what the trailer block alone keeps: this daemon writes no CommitLore notes mirror.
 *
 * Every process shares one `timeoutMs` bound; exceeding it throws `GIT_TIMEOUT`. Any other failure
 * throws as well. The caller runs this before the merge is reserved.
 */
export const squashRecordPreservation = async (
  commits: readonly { readonly sha: string; readonly message: string }[],
  title: string,
  message: string,
  mergedHead: string,
  pullNumber: number,
  timeoutMs: number = PRESERVATION_TIMEOUT_MS,
): Promise<SquashRecordPreservation> => {
  if (commits.length === 0) throw new Error("a squash with no branch commits cannot be examined");
  const declared = `Merged-Head: ${mergedHead}`;
  const lines = `${title}\n\n${message}`.split("\n");
  if (lines.filter((line) => line === declared).length !== 1) {
    throw new Error("the squash message does not name the head this merge fences on exactly once");
  }

  const dir = acpScratchDir("squash-records-");
  // No operator or system configuration: a trailer or identity setting there would make this answer
  // differ from the gate's on CI. The identity is the fixture's own.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_AUTHOR_NAME: "acp",
    GIT_AUTHOR_EMAIL: "acp@invalid",
    GIT_COMMITTER_NAME: "acp",
    GIT_COMMITTER_EMAIL: "acp@invalid",
  };
  const run = boundedRun(dir, env, timeoutMs);
  try {
    await run("git", ["init", "--quiet"]);
    // The base, then the branch as one chain on it, in one process: one `git` per commit costs
    // seconds on a 250-commit pull. Every commit has the empty tree; the gate reads only messages.
    const stamp = "committer acp <acp@invalid> 0 +0000\n";
    const data = (text: string): string => `data ${Buffer.byteLength(text, "utf8")}\n${text}\n`;
    const stream = [
      `commit refs/heads/base\nmark :1\n${stamp}${data("base\n")}`,
      ...commits.map((commit, index) =>
        `commit refs/heads/branch\nmark :${index + 2}\n${stamp}${data(commit.message)}from :${index + 1}\n`),
      "done\n",
    ].join("");
    await run("git", ["fast-import", "--quiet", "--done", "--export-marks=marks"], stream);
    const marks = new Map(readFileSync(join(dir, "marks"), "utf8").split("\n").filter(Boolean).map((line) => {
      const [mark, sha] = line.split(" ");
      return [Number(mark?.slice(1)), sha ?? ""] as const;
    }));
    const base = marks.get(1);
    const branch = commits.map((_, index) => marks.get(index + 2) ?? "");
    const head = branch.at(-1)!;
    if (base === undefined || branch.some((sha) => !FULL_SHA.test(sha))) {
      throw new Error("the squash fixture's commits could not be read back");
    }

    writeFileSync(join(dir, "squash"), lines.map((line) => (line === declared ? `Merged-Head: ${head}` : line)).join("\n"));
    const squash = (await run("git", ["commit-tree", "-p", base, "-F", "squash", `${head}^{tree}`])).trim();

    const reads = await readGate(run, dir, [...branch, squash]);
    writeFileSync(join(dir, "reads.json"), JSON.stringify({ messages: [...reads.messages], trailers: [...reads.trailers] }));
    const examined: unknown = JSON.parse(await run(process.execPath, [
      "--input-type=module", "-e", EXAMINE_SQUASH, MERGE_RECORDS_GATE.href, squash, String(pullNumber), join(dir, "reads.json"),
    ]));
    if (!isExamination(examined)) throw new Error("the merge-records gate's examination could not be read");

    // The gate's verdict is `missing`, each line mapped to the one (newest) commit carrying it. Who
    // loses it is every commit whose stored trailers carry it, read as the gate read them (S9-R1).
    const stored = branch.map((sha) => storedLines(reads.trailers.get(reads.messages.get(sha)!)!));
    const unpreserved = examined.missing.map(([line, from]) => {
      const index = branch.indexOf(from);
      if (index === -1) throw new Error("the merge-records gate named a commit outside the branch");
      if (!stored[index]!.includes(line)) throw new Error("the merge-records gate named a line its commit does not store");
      return { index, line };
    });
    const lost = new Set(unpreserved.map(({ line }) => line));
    const recordIds: string[] = [];
    const commitsWithoutRecordId: string[] = [];
    for (const [index, trailers] of stored.entries()) {
      if (!trailers.some((line) => lost.has(line))) continue;
      const ids = trailers
        .filter((line) => line.startsWith("Record-Id:"))
        .map((line) => line.slice("Record-Id:".length).trim())
        .filter((id) => id !== "");
      if (ids.length === 0) commitsWithoutRecordId.push(commits[index]!.sha);
      for (const id of ids) if (!recordIds.includes(id)) recordIds.push(id);
    }
    return {
      carried: examined.carried,
      unpreserved: unpreserved.map(({ index, line }) => ({ commit: commits[index]!.sha, line })),
      recordIds,
      commitsWithoutRecordId,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
