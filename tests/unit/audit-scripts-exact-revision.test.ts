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
fs.appendFileSync(process.env.FAKE_REVIEWER_LOG, JSON.stringify({ cli, area, mode, viewDir, subject }) + "\n");
const reportOf = (verdict, tag) => ({
  verdict,
  filesExamined: ["src/subject.txt", tag],
  omittedItems: [],
  findings: verdict === "PASS" ? [] : [{ severity: "MAJOR", category: "correctness", file: "src/subject.txt", line: 1, summary: "s", detail: "d", suggestedFix: "f" }],
});
const textOf = (report) => cli === "codex" ? JSON.stringify(report) : JSON.stringify({ text: "narration", structuredOutput: report, stopReason: "end_turn" });
const emit = (text) => { if (cli === "codex") fs.writeFileSync(outPath, text); else process.stdout.write(text); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = textOf(reportOf(mode === "revise" ? "REVISE" : "PASS", "nonce " + nonce));
(async () => {
  switch (mode) {
    case "pass":
    case "revise":
      emit(report);
      process.exit(0);
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

interface Fixture {
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
}

interface Plan {
  readonly default?: string;
  readonly areas?: Record<string, string>;
  readonly mutateOriginal?: string;
  readonly tamperRepo?: string;
  readonly tamperOut?: string;
}

const makeFixture = (): Fixture => {
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
    "docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md": "# fixture PRD\n",
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  for (const name of [...SCRIPTS, join("lib", "audit-run.mjs")]) {
    if (!existsSync(join(ACP_SCRIPTS, name))) continue; // a680e971 had no shared helper
    mkdirSync(dirname(join(root, "scripts", name)), { recursive: true });
    copyFileSync(join(ACP_SCRIPTS, name), join(root, "scripts", name));
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "base");
  for (const cli of Object.values(CLI)) {
    writeFileSync(join(bin, cli), `#!${process.execPath}\n${FAKE_REVIEWER}`);
    chmodSync(join(bin, cli), 0o755);
  }
  const plan = join(base, "plan.json");
  const log = join(base, "reviewer.log");
  writeFileSync(log, "");
  const path = [...new Set([bin, gitDirectory(), "/usr/bin", "/bin"])].join(delimiter);
  return { root, bin, plan, log, env: { ...baseEnv(), PATH: path, FAKE_REVIEWER_PLAN: plan, FAKE_REVIEWER_LOG: log } };
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
const start = (fixture: Fixture, script: Script, argv: readonly string[]): { child: ChildProcess; done: Promise<Run> } => {
  const child = spawn(process.execPath, [join(fixture.root, "scripts", script), ...argv], {
    cwd: fixture.root,
    env: fixture.env,
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

const run = (fixture: Fixture, script: Script, argv: readonly string[]): Promise<Run> => start(fixture, script, argv).done;

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
  reviewer: { cli: string; path: string; version: string | null };
  results: Record<string, { execution: string; report: string }>;
  status: string;
  runId: string;
  startedAt: string;
  endedAt: string;
  artifacts: { name: string; sha256: string }[];
  workingTree: { dirty: boolean; uncommittedWorkReviewed: boolean };
  checkout: { removed: boolean };
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
});
