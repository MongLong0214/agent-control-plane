import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * #1189 §2.A — the two developer audit scripts, `scripts/production-review.mjs` and
 * `scripts/grok-review.mjs`, review one pinned commit from a disposable checkout and write every
 * run into its own directory, attributed by a manifest.
 *
 * Each test copies the scripts under test into a throwaway git repository and runs them there with
 * a fake `codex` and `grok` first on PATH, so no real model or CLI is ever reached. The scripts find
 * the repository they review from their own location, which is why copying them in is enough: the
 * same tests run unchanged against the scripts as they were at a680e971, and fail there.
 */
const ACP_SCRIPTS = fileURLToPath(new URL("../../scripts/", import.meta.url));
const SCRIPTS = ["production-review.mjs", "grok-review.mjs"] as const;
type Script = (typeof SCRIPTS)[number];
const CLI: Record<Script, string> = { "production-review.mjs": "codex", "grok-review.mjs": "grok" };
/** Where a680e971 wrote every run. Read only when a run names no directory of its own. */
const FIXED_OUTPUT: Record<Script, string> = {
  "production-review.mjs": join("evidence", "review"),
  "grok-review.mjs": join("evidence", "review-grok"),
};

const RUN_BUDGET_MS = 20_000;
const GIT_BUDGET_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_LOCATION) delete env[name];
  return {
    ...env,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "ACP Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "ACP Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
};

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: baseEnv(), timeout: GIT_BUDGET_MS }).trim();

const gitDirectory = (): string => {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, "git"), constants.X_OK);
      return dir;
    } catch {
      // not here
    }
  }
  throw new Error("no git on PATH");
};

/**
 * One fake for both CLIs, told apart by the name it was started as. Each invocation appends one
 * line to the log: the area, the directory the reviewer was pointed at, and what `src/subject.txt`
 * held there when it looked. The plan file says how each area's review ends.
 */
const FAKE_REVIEWER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cli = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(cli + " fake-reviewer 0.0.0\n");
  process.exit(0);
}
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_REVIEWER_PLAN, "utf8"));
const after = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const outPath = cli === "codex" ? after("-o") : undefined;
const area = cli === "codex" ? path.basename(outPath).replace(/\.json$/, "") : path.basename(after("--leader-socket")).split(".")[0];
const viewDir = cli === "codex" ? process.cwd() : after("--cwd");
const mode = (plan.areas || {})[area] || plan.default || "pass";
if (plan.mutateOriginal) fs.writeFileSync(path.join(plan.mutateOriginal, "src", "subject.txt"), "mutated while the review ran\n");
let subject = null;
try { subject = fs.readFileSync(path.join(viewDir, "src", "subject.txt"), "utf8"); } catch {}
const nonce = Math.random().toString(36).slice(2) + "-" + process.pid;
const model = after("-m") ?? null;
fs.appendFileSync(process.env.FAKE_REVIEWER_LOG, JSON.stringify({ cli, area, mode, viewDir, subject, model }) + "\n");
const reportOf = (verdict, tag) => ({
  verdict,
  filesExamined: ["src/subject.txt", tag],
  omittedItems: [],
  findings: verdict === "PASS" ? [] : [{ severity: "MAJOR", category: "correctness", file: "src/subject.txt", line: 1, summary: "s", detail: "d", suggestedFix: "f" }],
});
const textOf = (report) => cli === "codex" ? JSON.stringify(report) : JSON.stringify({ text: "narration", structuredOutput: report, stopReason: "end_turn", ...(plan.reportedModel ? { model: plan.reportedModel } : {}) });
const emit = (text) => { if (cli === "codex") fs.writeFileSync(outPath, text); else process.stdout.write(text); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = textOf(reportOf(mode === "revise" ? "REVISE" : mode === "block" ? "BLOCK" : "PASS", "nonce " + nonce));
(async () => {
  switch (mode) {
    case "pass":
    case "revise":
    case "block":
      emit(report);
      process.exit(0);
    case "chmod-off":
    case "chmod-on":
      // Changes only the executable bit of a committed file in the checkout it was given.
      fs.chmodSync(path.join(viewDir, "src", mode === "chmod-off" ? "tool.sh" : "subject.txt"), mode === "chmod-off" ? 0o644 : 0o755);
      emit(report);
      process.exit(0);
    case "fifo": {
      // A FIFO where the report goes, fed by a detached writer that hands successive readers
      // different reports. grok's report path is one the script writes, so it is named in the plan.
      const cp = require("node:child_process");
      const target = cli === "codex" ? outPath : path.join(plan.fifoDir, area + ".json");
      cp.execFileSync("mkfifo", [target], { timeout: 5000 });
      cp.spawn(process.execPath, [plan.feeder, cli, target], { stdio: "ignore", detached: true }).unref();
      if (cli === "grok") process.stdout.write(textOf(reportOf("BLOCK", "fifo")));
      process.exit(0);
    }
    case "fail":
      process.stderr.write("fake reviewer: failed\n");
      process.exit(1);
    case "pass-then-fail":
      emit(report);
      process.exit(1);
    case "partial":
      emit(report.slice(0, Math.floor(report.length / 2)));
      process.exit(0);
    case "pass-then-hang":
      emit(report);
      setTimeout(() => process.exit(0), 60000);
      return;
    case "tamper": {
      // Once this run has recorded core's report, replace it with another invocation's PASS and
      // plant a PASS for an area nobody selected. A script with no manifest gets one second.
      const dir = path.join(plan.tamperRepo, plan.tamperOut);
      const begun = Date.now();
      for (;;) {
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch {}
        if (manifest && manifest.results && manifest.results.core) break;
        if (!manifest && Date.now() - begun > 1000) break;
        if (Date.now() - begun > 10000) break;
        await sleep(50);
      }
      fs.writeFileSync(path.join(dir, "core.json"), JSON.stringify(reportOf("PASS", "another invocation")));
      fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(reportOf("PASS", "planted")));
      emit(report);
      process.exit(0);
    }
    default:
      process.exit(97);
  }
})();
`;

/**
 * Feeds the FIFO: a BLOCK to the first reader (or, for grok, accepts the runner's own write), then
 * another invocation's PASS to each later reader. Opens without O_CREAT so it never leaves a
 * regular file behind, and exits after three seconds whatever it is waiting on.
 */
const FIFO_FEEDER = String.raw`
const fs = require("node:fs");
const [kind, file] = process.argv.slice(2);
const block = JSON.stringify({ verdict: "BLOCK", filesExamined: ["fifo"], omittedItems: [], findings: [{ severity: "MAJOR", category: "correctness", file: "src/subject.txt", line: 1, summary: "s", detail: "d", suggestedFix: "f" }] });
const pass = JSON.stringify({ verdict: "PASS", filesExamined: ["another invocation"], omittedItems: [], findings: [] });
setTimeout(() => process.exit(0), 3000);
const nap = () => new Promise((done) => setTimeout(done, 200));
const write = async (text) => { const handle = await fs.promises.open(file, fs.constants.O_WRONLY); try { await handle.writeFile(text); } finally { await handle.close(); } };
const read = async () => { const handle = await fs.promises.open(file, fs.constants.O_RDONLY); try { await handle.readFile(); } finally { await handle.close(); } };
(async () => {
  try {
    if (kind === "grok") await read(); else await write(block);
    await nap();
    await write(pass);
    await nap();
    await write(pass);
  } catch {}
})();
`;

/**
 * Loaded into the script with `--import`. The first time the runner reads or writes a BLOCK report
 * at `core.json` — by path or through a descriptor opened on it — another writer atomically
 * replaces that path with a different invocation's PASS. Whatever the runner captured before that
 * moment is all it may vouch for; the marker file proves the replacement happened.
 */
const SWAP_PRELOAD = String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = { openSync: fs.openSync, closeSync: fs.closeSync, readFileSync: fs.readFileSync, readSync: fs.readSync, writeFileSync: fs.writeFileSync };
const opened = new Map();
let swapped = false;
const isReport = (path) => typeof path === "string" && path.endsWith("/core.json");
const holdsBlock = (data) => {
  try { return (Buffer.isBuffer(data) || data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : String(data)).includes('"BLOCK"'); } catch { return false; }
};
const pathOf = (target) => (typeof target === "number" ? opened.get(target) : target);
const swap = (path) => {
  if (swapped) return;
  swapped = true;
  original.writeFileSync(path + ".swap", JSON.stringify({ verdict: "PASS", filesExamined: ["another invocation"], omittedItems: [], findings: [] }));
  fs.renameSync(path + ".swap", path);
  original.writeFileSync(process.env.SWAP_MARKER, path);
};
fs.openSync = function (path, ...rest) { const fd = original.openSync.call(this, path, ...rest); if (isReport(path)) opened.set(fd, path); return fd; };
fs.closeSync = function (fd, ...rest) { opened.delete(fd); return original.closeSync.call(this, fd, ...rest); };
fs.readFileSync = function (target, ...rest) {
  const result = original.readFileSync.call(this, target, ...rest);
  if (isReport(pathOf(target)) && holdsBlock(result)) swap(pathOf(target));
  return result;
};
fs.readSync = function (fd, buffer, ...rest) {
  const result = original.readSync.call(this, fd, buffer, ...rest);
  if (isReport(pathOf(fd)) && holdsBlock(buffer)) swap(pathOf(fd));
  return result;
};
fs.writeFileSync = function (target, data, ...rest) {
  const result = original.writeFileSync.call(this, target, data, ...rest);
  if (isReport(pathOf(target)) && holdsBlock(data)) swap(pathOf(target));
  return result;
};
syncBuiltinESMExports();
`;

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly bin: string;
  readonly plan: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
}

interface Call {
  readonly cli: string;
  readonly area: string;
  readonly viewDir: string;
  readonly subject: string | null;
  readonly model: string | null;
}

interface Plan {
  readonly default?: string;
  readonly areas?: Record<string, string>;
  readonly mutateOriginal?: string;
  readonly tamperRepo?: string;
  readonly tamperOut?: string;
  readonly reportedModel?: string;
  readonly fifoDir?: string;
  readonly feeder?: string;
}

/**
 * `smudged`: the commit carries a `.gitattributes` filter and the repository's own config defines
 * it to rewrite `src/subject.txt` on checkout. The original checkout stays clean — its file was
 * written before the filter existed — while any new checkout reads bytes the commit does not hold.
 * `executable`: the commit also holds `src/tool.sh` as `100755`. `symlinksOff`: the commit holds
 * `src/link` as a symbolic link and the repository's config then sets `core.symlinks=false`, so
 * any new checkout writes it as a plain file while the original keeps its link.
 */
const makeFixture = (options: { smudged?: boolean; executable?: boolean; symlinksOff?: boolean } = {}): Fixture => {
  // Physical path: a script resolves its own location through symlinks (`/var` -> `/private/var`).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acp-audit-scripts-")));
  roots.push(base);
  const root = join(base, "repo");
  const bin = join(base, "bin");
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: baseEnv(), timeout: GIT_BUDGET_MS });
  git(root, "config", "--local", "maintenance.auto", "false");
  git(root, "config", "--local", "commit.gpgsign", "false");
  const files: Record<string, string> = {
    ".gitignore": "evidence/local/\n",
    "src/subject.txt": "pinned v1\n",
    ...(options.smudged === true ? { ".gitattributes": "src/subject.txt filter=inject\n" } : {}),
    "docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md": "# fixture PRD\n",
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  if (options.executable === true) {
    writeFileSync(join(root, "src", "tool.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "src", "tool.sh"), 0o755);
  }
  if (options.symlinksOff === true) symlinkSync("subject.txt", join(root, "src", "link"));
  for (const name of [...SCRIPTS, join("lib", "audit-run.mjs")]) {
    if (!existsSync(join(ACP_SCRIPTS, name))) continue; // a680e971 had no shared helper
    mkdirSync(dirname(join(root, "scripts", name)), { recursive: true });
    copyFileSync(join(ACP_SCRIPTS, name), join(root, "scripts", name));
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "base");
  if (options.symlinksOff === true) git(root, "config", "--local", "core.symlinks", "false");
  if (options.smudged === true) {
    git(root, "config", "--local", "filter.inject.smudge", "sed 's/pinned v1/NOT IN PINNED COMMIT/'");
    git(root, "config", "--local", "filter.inject.clean", "cat");
  }
  for (const cli of Object.values(CLI)) {
    writeFileSync(join(bin, cli), `#!${process.execPath}\n${FAKE_REVIEWER}`);
    chmodSync(join(bin, cli), 0o755);
  }
  const plan = join(base, "plan.json");
  const log = join(base, "reviewer.log");
  writeFileSync(log, "");
  const path = [...new Set([bin, gitDirectory(), "/usr/bin", "/bin"])].join(delimiter);
  return { base, root, bin, plan, log, env: { ...baseEnv(), PATH: path, FAKE_REVIEWER_PLAN: plan, FAKE_REVIEWER_LOG: log } };
};

const setPlan = (fixture: Fixture, plan: Plan): void => writeFileSync(fixture.plan, JSON.stringify(plan));

const callsOf = (fixture: Fixture): Call[] =>
  readFileSync(fixture.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);

interface Run {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The script runs in its own process group, and the bound reaps that group. A script that waits on
 * a hung reviewer forever — a680e971 waited 45 minutes — fails here with a message naming the bound.
 */
interface Launch {
  readonly nodeArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Started through `/bin/sh` with this umask, which then `exec`s node. */
  readonly umask?: string;
}

const start = (
  fixture: Fixture,
  script: Script,
  argv: readonly string[],
  launch: Launch = {},
): { child: ChildProcess; done: Promise<Run> } => {
  const nodeArgv = [...(launch.nodeArgs ?? []), join(fixture.root, "scripts", script), ...argv];
  const [file, args] =
    launch.umask === undefined
      ? [process.execPath, nodeArgv]
      : ["/bin/sh", ["-c", `umask ${launch.umask}; exec "$0" "$@"`, process.execPath, ...nodeArgv]];
  const child = spawn(file, args, {
    cwd: fixture.root,
    env: { ...fixture.env, ...launch.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((settle, fail) => {
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      fail(new Error(`${script} ${argv.join(" ")} did not finish within ${RUN_BUDGET_MS}ms; its process group was killed. This is the bound, not a verdict`));
    }, RUN_BUDGET_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      settle({ status, signal, stdout, stderr });
    });
  });
  return { child, done };
};

const run = (fixture: Fixture, script: Script, argv: readonly string[], launch: Launch = {}): Promise<Run> =>
  start(fixture, script, argv, launch).done;

const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + RUN_BUDGET_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${RUN_BUDGET_MS}ms`);
    await new Promise((done) => setTimeout(done, 25));
  }
};

/** The directory a run says it wrote; a680e971 named none and wrote one fixed directory. */
const runDirectoryOf = (fixture: Fixture, script: Script, result: Run): string =>
  /^run directory: (.+)$/m.exec(result.stdout)?.[1] ?? join(fixture.root, FIXED_OUTPUT[script]);

interface SummaryEntry {
  readonly key: string;
  readonly result?: string;
  readonly verdict?: string;
  readonly execution?: string;
  readonly report?: string | null;
}
interface Summary {
  readonly results: readonly SummaryEntry[];
  readonly revision?: { readonly commit: string; readonly tree: string };
  readonly execution?: string;
  readonly findingsVerdict?: string;
  readonly mergeApproval?: boolean;
  readonly unattributedFiles?: readonly string[];
  readonly reviewerModel?: string | null;
  readonly reviewerModelIdentity?: string;
  readonly reviewerModelNote?: string;
  readonly workingTree?: { readonly dirty: boolean; readonly uncommittedWorkReviewed: boolean };
}

const summaryIn = (dir: string): Summary | null =>
  existsSync(join(dir, "summary.json")) ? (JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Summary) : null;

/** What a summary says about one area: `result` where it has one, a680e971's `verdict` where not. */
const resultOf = (summary: Summary | null, key: string): string => {
  const entry = summary?.results.find((candidate) => candidate.key === key);
  return entry === undefined ? "ABSENT" : (entry.result ?? entry.verdict ?? "ABSENT");
};

const entryOf = (summary: Summary | null, key: string): SummaryEntry | undefined =>
  summary?.results.find((candidate) => candidate.key === key);

const manifestIn = (dir: string): Record<string, unknown> & {
  revision: { commit: string; tree: string };
  selectedAreas: string[];
  reviewer: { cli: string; path: string; version: string | null; model: string | null; modelIdentity?: string };
  results: Record<
    string,
    {
      execution: string;
      report: string;
      verdict: string | null;
      findings: number | null;
      reportedModel?: string | null;
      artifacts: { name: string; sha256: string | null }[];
    }
  >;
  status: string;
  runId: string;
  startedAt: string;
  endedAt: string;
  artifacts: { name: string; sha256: string }[];
  workingTree: { dirty: boolean; uncommittedWorkReviewed: boolean };
  checkout: { removed: boolean; trackedChangesDuringRun?: boolean; changedDuringRun?: string[] };
} => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]),
  );

const samePath = (a: string, b: string): boolean => {
  const physical = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
  return physical(a) === physical(b);
};

const SUBJECT = join("src", "subject.txt");

describe.each(SCRIPTS)("%s", (script) => {
  const cli = CLI[script];

  it(
    "refuses a dirty checkout, an unknown ref and an unrecognised option instead of reviewing",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      const head = git(fixture.root, "rev-parse", "HEAD");

      writeFileSync(join(fixture.root, SUBJECT), "uncommitted edit\n");
      const tracked = await run(fixture, script, ["core"]);
      expect(tracked.status).toBe(2);
      expect(tracked.stderr).toMatch(/uncommitted changes/);
      const explicitHead = await run(fixture, script, ["core", `--rev=${head}`]);
      expect(explicitHead.status).toBe(2);
      expect(readFileSync(join(fixture.root, SUBJECT), "utf8")).toBe("uncommitted edit\n");
      git(fixture.root, "checkout", "--", SUBJECT);

      writeFileSync(join(fixture.root, "src", "untracked.txt"), "not added yet\n");
      const untracked = await run(fixture, script, ["core"]);
      expect(untracked.status).toBe(2);
      expect(untracked.stderr).toMatch(/uncommitted changes/);
      rmSync(join(fixture.root, "src", "untracked.txt"));

      const unknown = await run(fixture, script, ["core", "--rev=no-such-ref"]);
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toMatch(/unknown ref/);

      // `--ref` for `--rev`: ignoring it would review HEAD and say nothing.
      const typo = await run(fixture, script, ["core", "--ref=HEAD"]);
      expect(typo.status).toBe(2);
      expect(typo.stderr).toMatch(/unknown option/);

      expect(callsOf(fixture)).toEqual([]);
      expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "with --allow-dirty reviews HEAD and records that the uncommitted work was not reviewed",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      writeFileSync(join(fixture.root, SUBJECT), "uncommitted edit\n");

      const result = await run(fixture, script, ["core", "--allow-dirty"]);
      expect(callsOf(fixture).map((call) => call.subject)).toEqual(["pinned v1\n"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/not reviewed/);
      const dir = runDirectoryOf(fixture, script, result);
      expect(manifestIn(dir).workingTree).toMatchObject({ dirty: true, uncommittedWorkReviewed: false });
      expect(summaryIn(dir)?.workingTree).toMatchObject({ dirty: true, uncommittedWorkReviewed: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads only the pinned revision while the original checkout changes under it",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass", mutateOriginal: fixture.root });
      const commit = git(fixture.root, "rev-parse", "HEAD");
      const tree = git(fixture.root, "rev-parse", "HEAD^{tree}");

      const result = await run(fixture, script, ["core"]);
      const [call] = callsOf(fixture);
      expect(call?.subject).toBe("pinned v1\n");
      expect(samePath(call?.viewDir ?? "", fixture.root)).toBe(false);
      expect(result.status).toBe(0);
      // The run neither reset nor reverted what changed in the user's checkout.
      expect(readFileSync(join(fixture.root, SUBJECT), "utf8")).toBe("mutated while the review ran\n");

      const dir = runDirectoryOf(fixture, script, result);
      const manifest = manifestIn(dir);
      expect(manifest.revision).toEqual({ commit, tree });
      expect(manifest.selectedAreas).toEqual(["core"]);
      expect(manifest.reviewer).toMatchObject({ cli, path: join(fixture.bin, cli), version: `${cli} fake-reviewer 0.0.0` });
      expect(manifest.results["core"]).toMatchObject({ execution: "COMPLETED", report: "VALID" });
      expect(manifest.status).toBe("COMPLETE");
      expect(Date.parse(manifest.endedAt)).toBeGreaterThanOrEqual(Date.parse(manifest.startedAt));
      expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(expect.arrayContaining(["core.json", "core.log", "summary.json"]));
      const summary = summaryIn(dir);
      expect(summary?.revision).toEqual({ commit, tree });
      expect(resultOf(summary, "core")).toBe("PASS");
      expect(summary?.findingsVerdict).toBe("PASS");
      expect(summary?.mergeApproval).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  const ENDINGS = [
    ["fail", "FAILED", 1],
    ["pass-then-fail", "FAILED", 1],
    ["pass-then-hang", "TIMED_OUT", 1],
    ["interrupt", "INTERRUPTED", 130],
  ] as const;
  it.each(ENDINGS)(
    "a reviewer that ends with %s after an earlier PASS does not make the new run PASS",
    async (ending, execution, status) => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      const first = await run(fixture, script, ["core"]);
      expect(first.status).toBe(0);
      const firstDir = runDirectoryOf(fixture, script, first);
      const firstFiles = snapshot(firstDir);
      expect(resultOf(summaryIn(firstDir), "core")).toBe("PASS");

      setPlan(fixture, { default: ending === "interrupt" ? "pass-then-hang" : ending });
      let second: Run;
      if (ending === "interrupt") {
        const started = start(fixture, script, ["core"]);
        await waitFor(() => callsOf(fixture).length === 2, "the second reviewer starting");
        // What a terminal's Ctrl-C delivers: SIGINT to the foreground process group.
        if (started.child.pid !== undefined) process.kill(-started.child.pid, "SIGINT");
        second = await started.done;
      } else {
        second = await run(fixture, script, ["core", "--area-timeout-ms=1500"]);
      }

      const secondDir = runDirectoryOf(fixture, script, second);
      const summary = summaryIn(secondDir);
      expect(resultOf(summary, "core")).not.toBe("PASS");
      expect(second.status).toBe(status);
      expect(secondDir).not.toBe(firstDir);
      expect(entryOf(summary, "core")).toMatchObject({ result: "ERROR", execution, verdict: null });
      expect(summary?.findingsVerdict).toBe("UNDETERMINED");
      expect(summary?.mergeApproval).toBe(false);
      expect(manifestIn(secondDir).results["core"]?.execution).toBe(execution);
      // Nothing a reader of `core.json` could take for this run's report.
      expect(existsSync(join(secondDir, "core.json"))).toBe(false);
      expect(snapshot(firstDir)).toEqual(firstFiles);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not count another commit's area, an unselected area or a partial report as a current success",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      const first = await run(fixture, script, ["guard"]);
      expect(first.status).toBe(0);
      expect(resultOf(summaryIn(runDirectoryOf(fixture, script, first)), "guard")).toBe("PASS");

      writeFileSync(join(fixture.root, SUBJECT), "pinned v2\n");
      git(fixture.root, "commit", "-q", "--no-verify", "-am", "second");
      const second = git(fixture.root, "rev-parse", "HEAD");
      setPlan(fixture, { areas: { core: "partial" } });
      const result = await run(fixture, script, ["core"]);

      const summary = summaryIn(runDirectoryOf(fixture, script, result));
      expect(resultOf(summary, "guard")).not.toBe("PASS");
      expect(resultOf(summary, "core")).not.toBe("PASS");
      expect(result.status).toBe(1);
      expect(summary?.revision?.commit).toBe(second);
      expect(entryOf(summary, "guard")).toMatchObject({ result: "NOT_RUN", execution: "NOT_RUN" });
      expect(entryOf(summary, "core")).toMatchObject({ result: "ERROR", execution: "COMPLETED", report: "UNPARSABLE" });
      expect(summary?.findingsVerdict).toBe("UNDETERMINED");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not count a report replaced after it was recorded, or one planted for an unselected area",
    async () => {
      const fixture = makeFixture();
      const out = join("evidence", "local", "tampered");
      setPlan(fixture, { areas: { core: "pass", guard: "tamper" }, tamperRepo: fixture.root, tamperOut: out });
      const result = await run(fixture, script, ["core", "guard", `--out=${out}`]);

      const summary = summaryIn(join(fixture.root, out));
      expect(resultOf(summary, "review")).not.toBe("PASS");
      expect(resultOf(summary, "core")).not.toBe("PASS");
      expect(resultOf(summary, "guard")).toBe("PASS");
      expect(result.status).toBe(1);
      expect(entryOf(summary, "core")).toMatchObject({ result: "STALE", execution: "COMPLETED" });
      expect(entryOf(summary, "review")).toMatchObject({ result: "NOT_RUN" });
      expect(summary?.unattributedFiles).toContain("review.json");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives every run its own directory and leaves the user's checkout as it found it",
    async () => {
      const fixture = makeFixture();
      const older = git(fixture.root, "rev-parse", "HEAD");
      writeFileSync(join(fixture.root, SUBJECT), "pinned v2\n");
      git(fixture.root, "commit", "-q", "--no-verify", "-am", "second");
      const userState = (): Record<string, string> => ({
        head: git(fixture.root, "rev-parse", "HEAD"),
        branch: git(fixture.root, "symbolic-ref", "HEAD"),
        worktrees: git(fixture.root, "worktree", "list", "--porcelain"),
      });
      const before = userState();
      setPlan(fixture, { default: "pass" });

      const first = await run(fixture, script, ["core"]);
      expect(first.status).toBe(0);
      const firstDir = runDirectoryOf(fixture, script, first);
      const firstFiles = snapshot(firstDir);
      const second = await run(fixture, script, ["core"]);
      expect(second.status).toBe(0);
      const secondDir = runDirectoryOf(fixture, script, second);
      expect(secondDir).not.toBe(firstDir);
      expect(snapshot(firstDir)).toEqual(firstFiles);
      expect(manifestIn(secondDir).runId).not.toBe(manifestIn(firstDir).runId);

      // A directory that exists is refused, not reused.
      const reuse = await run(fixture, script, ["core", `--out=${relative(fixture.root, firstDir)}`]);
      expect(reuse.status).toBe(2);
      expect(reuse.stderr).toMatch(/already exists/);
      expect(snapshot(firstDir)).toEqual(firstFiles);
      expect(callsOf(fixture)).toHaveLength(2);

      // Uncommitted work stays where the user left it while an older commit is reviewed.
      writeFileSync(join(fixture.root, SUBJECT), "the user's uncommitted edit\n");
      writeFileSync(join(fixture.root, "src", "untracked.txt"), "the user's untracked file\n");
      const dirtyStatus = git(fixture.root, "status", "--porcelain", "--untracked-files=all");
      const third = await run(fixture, script, ["core", `--rev=${older}`]);
      expect(callsOf(fixture).at(-1)?.subject).toBe("pinned v1\n");
      expect(third.status).toBe(0);
      expect(readFileSync(join(fixture.root, SUBJECT), "utf8")).toBe("the user's uncommitted edit\n");
      expect(readFileSync(join(fixture.root, "src", "untracked.txt"), "utf8")).toBe("the user's untracked file\n");
      expect(git(fixture.root, "status", "--porcelain", "--untracked-files=all")).toBe(dirtyStatus);
      expect(userState()).toEqual(before);
      const thirdManifest = manifestIn(runDirectoryOf(fixture, script, third));
      expect(thirdManifest.revision.commit).toBe(older);
      expect(thirdManifest.workingTree).toMatchObject({ dirty: true, uncommittedWorkReviewed: false });
      expect(thirdManifest.checkout.removed).toBe(true);
      for (const call of callsOf(fixture)) {
        expect(samePath(call.viewDir, fixture.root)).toBe(false);
        expect(existsSync(call.viewDir)).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a disposable checkout that does not hold the pinned commit's bytes, before any reviewer starts",
    async () => {
      const fixture = makeFixture({ smudged: true });
      setPlan(fixture, { default: "pass" });
      expect(git(fixture.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
      const worktrees = git(fixture.root, "worktree", "list", "--porcelain");

      const result = await run(fixture, script, ["core"]);
      // a680e971..ea57c9b0: the reviewer read `NOT IN PINNED COMMIT` and the run said PASS.
      expect(callsOf(fixture).map((call) => call.subject)).toEqual([]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/disposable checkout of [0-9a-f]{12} does not hold/);
      expect(result.stderr).toMatch(/src\/subject\.txt: bytes differ from the commit/);
      expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
      expect(git(fixture.root, "worktree", "list", "--porcelain")).toBe(worktrees);
      expect(readFileSync(join(fixture.root, SUBJECT), "utf8")).toBe("pinned v1\n");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "vouches only for the report bytes it validated when another writer replaces them right after",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "block" });
      const preload = join(fixture.base, "swap-preload.mjs");
      const marker = join(fixture.base, "swapped");
      writeFileSync(preload, SWAP_PRELOAD);

      const result = await run(fixture, script, ["core"], { nodeArgs: ["--import", preload], env: { SWAP_MARKER: marker } });
      const dir = runDirectoryOf(fixture, script, result);
      const summary = summaryIn(dir);
      expect(resultOf(summary, "core")).not.toBe("PASS");
      expect(existsSync(marker)).toBe(true);
      expect(result.status).toBe(1);
      const core = manifestIn(dir).results["core"];
      expect(core).toMatchObject({ verdict: "BLOCK", findings: 1, report: "VALID" });
      const recorded = core?.artifacts.find((artifact) => artifact.name === "core.json")?.sha256;
      expect(recorded).not.toBe(createHash("sha256").update(readFileSync(join(dir, "core.json"))).digest("hex"));
      expect(entryOf(summary, "core")).toMatchObject({ result: "STALE", verdict: null });
      expect(summary?.findingsVerdict).toBe("UNDETERMINED");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not read a report from a FIFO that hands each reader different bytes",
    async () => {
      const fixture = makeFixture();
      const out = join("evidence", "local", "fifo");
      const feeder = join(fixture.base, "feeder.cjs");
      writeFileSync(feeder, FIFO_FEEDER);
      setPlan(fixture, { default: "fifo", fifoDir: join(fixture.root, out), feeder });

      const result = await run(fixture, script, ["core", `--out=${out}`]);
      const summary = summaryIn(join(fixture.root, out));
      expect(resultOf(summary, "core")).not.toBe("PASS");
      expect(result.status).toBe(1);
      expect(entryOf(summary, "core")).toMatchObject({ result: "ERROR", execution: "COMPLETED", report: "INVALID" });
      expect(summary?.findingsVerdict).toBe("UNDETERMINED");
      expect(existsSync(join(fixture.root, out, "core.json"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["loses", "chmod-off", "src/tool.sh: mode 100644 where the commit has 100755"],
    ["gains", "chmod-on", "src/subject.txt: mode 100755 where the commit has 100644"],
  ] as const)(
    "does not report COMPLETE when a committed file %s its executable bit during the review",
    async (_direction, mode, difference) => {
      const fixture = makeFixture({ executable: true });
      setPlan(fixture, { default: mode });

      const result = await run(fixture, script, ["core"]);
      const dir = runDirectoryOf(fixture, script, result);
      const summary = summaryIn(dir);
      // 02a3a7a6 compared bytes only: COMPLETE, PASS, exit 0, trackedChangesDuringRun false.
      expect(summary?.execution).toBe("INCOMPLETE");
      expect(result.status).toBe(1);
      expect(summary?.findingsVerdict).toBe("UNDETERMINED");
      expect(manifestIn(dir).checkout).toMatchObject({ trackedChangesDuringRun: true, changedDuringRun: [difference] });
      expect(result.stderr).toMatch(/the checkout changed while the reviewers ran/);
      expect(statSync(join(fixture.root, "src", "tool.sh")).mode & 0o100).toBe(0o100);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a checkout that git wrote with a symbolic link as a plain file, before any reviewer starts",
    async () => {
      const fixture = makeFixture({ symlinksOff: true });
      setPlan(fixture, { default: "pass" });
      expect(git(fixture.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
      const worktrees = git(fixture.root, "worktree", "list", "--porcelain");

      const result = await run(fixture, script, ["core"]);
      expect(callsOf(fixture)).toEqual([]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/src\/link: not the symbolic link the commit holds/);
      expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
      expect(git(fixture.root, "worktree", "list", "--porcelain")).toBe(worktrees);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cannot be handed a checkout without its executable bit: the umask that would strip it stops the run first",
    async () => {
      const fixture = makeFixture({ executable: true });
      setPlan(fixture, { default: "pass" });
      const worktrees = git(fixture.root, "worktree", "list", "--porcelain");

      // Git creates a 100755 file as 0777 & ~umask. A umask without the owner's execute bit also
      // takes it from every directory, so neither git nor this script can build a checkout at all.
      const result = await run(fixture, script, ["core"], { umask: "0100" });
      expect(callsOf(fixture)).toEqual([]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/could not prepare a disposable checkout/);
      expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
      expect(git(fixture.root, "worktree", "list", "--porcelain")).toBe(worktrees);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the reviewer model", () => {
  it(
    "grok-review.mjs selects its model explicitly, records it, and says UNKNOWN when the CLI reports another",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      const first = await run(fixture, "grok-review.mjs", ["core"]);
      expect(callsOf(fixture).map((call) => call.model)).toEqual(["grok-4.6"]);
      expect(first.status).toBe(0);
      const firstDir = runDirectoryOf(fixture, "grok-review.mjs", first);
      expect(manifestIn(firstDir).reviewer).toMatchObject({ model: "grok-4.6", modelIdentity: "ESTABLISHED" });
      expect(summaryIn(firstDir)).toMatchObject({ reviewerModel: "grok-4.6", reviewerModelIdentity: "ESTABLISHED" });

      const chosen = await run(fixture, "grok-review.mjs", ["core", "--model=grok-4.7"]);
      expect(callsOf(fixture).at(-1)?.model).toBe("grok-4.7");
      expect(manifestIn(runDirectoryOf(fixture, "grok-review.mjs", chosen)).reviewer.model).toBe("grok-4.7");

      setPlan(fixture, { default: "pass", reportedModel: "grok-somebody-else" });
      const other = await run(fixture, "grok-review.mjs", ["core"]);
      const otherDir = runDirectoryOf(fixture, "grok-review.mjs", other);
      const manifest = manifestIn(otherDir);
      expect(manifest.results["core"]?.reportedModel).toBe("grok-somebody-else");
      expect(manifest.reviewer).toMatchObject({ model: "grok-4.6", modelIdentity: "UNKNOWN" });
      const summary = summaryIn(otherDir);
      expect(summary?.reviewerModelIdentity).toBe("UNKNOWN");
      expect(summary?.reviewerModelNote).toMatch(/grok-somebody-else/);
      expect(other.stdout).toMatch(/reviewer model: UNKNOWN/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "production-review.mjs passes and records its pinned model and refuses another",
    async () => {
      const fixture = makeFixture();
      setPlan(fixture, { default: "pass" });
      const refused = await run(fixture, "production-review.mjs", ["core", "--model=gpt-other"]);
      expect(refused.status).toBe(2);
      expect(callsOf(fixture)).toEqual([]);
      const result = await run(fixture, "production-review.mjs", ["core"]);
      expect(callsOf(fixture).map((call) => call.model)).toEqual(["gpt-6.1-sol"]);
      const dir = runDirectoryOf(fixture, "production-review.mjs", result);
      expect(summaryIn(dir)).toMatchObject({ reviewerModel: "gpt-6.1-sol", reviewerModelIdentity: "ESTABLISHED" });
    },
    TEST_TIMEOUT_MS,
  );
});
