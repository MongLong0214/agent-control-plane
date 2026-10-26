import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ClaudeCliAdapter, CodexCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { requireSeatbelt, seatbeltStatus } from "../helpers/seatbelt.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type FakeTurnScript, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1246 — a worker's read-only git leaves the git dir alone.
 *
 * A live gpt worker's first command was `git status --short`, which its prompt allows, and the turn was
 * refused GIT_DIR_CHANGED although the worker wrote nothing in the git dir. A plain `git status` takes
 * the index's optional lock (creating and removing `index.lock` beside the index) and, on an index left
 * racily clean, rewrites it; in a linked worktree both change the git dir the turn is held to.
 *
 * - (a) on a freshly prepared, racily clean branch in a linked worktree, the worker's `git status --short`
 *   rewrites nothing and takes no lock, and the turn succeeds;
 * - (b) a worker that really writes the git dir is still refused GIT_DIR_CHANGED, and the refusal names
 *   the entries that differ (root, relative path, kind; at most 50, then the count);
 * - (c) the provider child of a WORKER turn, Codex's and Claude's, runs with `GIT_OPTIONAL_LOCKS=0`, so
 *   the status it runs takes no lock even on an index whose stat cache went stale after the baseline;
 * - (d) in a main checkout a plain `git status` that does rewrite a racily clean index changes nothing the
 *   git-dir comparison reads, before this change and after: the live main-checkout refusal is not this;
 * - (e) the repository's own configuration cannot make that read-only git write the git dir either: a
 *   caching textconv driver's notes, or the builtin fsmonitor daemon's cookies. A worker that asks for
 *   the cache itself is still refused;
 * - (f) nor can the provider user's global configuration: a worker's git reads no global or system
 *   configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), nor a file the repository's
 *   configuration includes from the provider's HOME (`include.path`, `includeIf`): discovery reads with
 *   that same HOME;
 * - (g) a repository whose index uses a shared index, or whose `core.splitIndex` is true, is refused
 *   before anything is prepared or launched (WORKER_REPOSITORY_SPLIT_INDEX_UNSUPPORTED), naming
 *   `core.splitIndex`; one recovered as that refusal says, its unused `sharedindex.*` file left behind,
 *   runs.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const CHANGE = "module.exports = () => 2;\n";

const gitDirOf = (tree: string): string => gitSync(tree, ["rev-parse", "--absolute-git-dir"]);

/**
 * Racily clean, as a checkout and its index written in one second leave them: every tracked file and
 * the index carry the same mtime second, so the stat cache cannot show an entry is clean, and a plain
 * `git status` re-reads the files and rewrites the index to settle it.
 */
const makeRacilyClean = (tree: string): void => {
  const second = Math.floor(Date.now() / 1000);
  for (const path of gitSync(tree, ["ls-files", "-z"]).split("\0").filter(Boolean)) utimesSync(join(tree, path), second, second);
  gitSync(tree, ["update-index", "--really-refresh"]);
  utimesSync(join(gitDirOf(tree), "index"), second, second);
};

/**
 * A checkout standing on the run's base branch with no task branch yet, so the runner creates and checks
 * out the task's branch; then made racily clean. Linked (its git dir outside the work tree) or main.
 */
const freshRacyWorld = (layout: "linked" | "main" = "linked"): WorkerWorld => {
  const world = seedWorkerWorld(makeCore(), { linkedWorktree: layout === "linked" });
  if (layout === "linked") gitSync(world.mainRepoPath, ["checkout", "-q", "--detach"]);
  gitSync(world.repoPath, ["checkout", "-q", "dev"]);
  gitSync(world.repoPath, ["branch", "-q", "-D", world.branch]);
  makeRacilyClean(world.repoPath);
  return world;
};

const startTurn = (runner: WorkerTurnRunner, world: WorkerWorld) =>
  runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
    timeoutMs: 20_000,
  });

const diagnosticsOf = (runner: WorkerTurnRunner, world: WorkerWorld, executionId: string): Record<string, unknown> => {
  const view = runner.describe(executionId, world.runId);
  return view.allowed ? (view.value.diagnostics?.evidence ?? {}) : {};
};

const outcomeOf = (runner: WorkerTurnRunner, world: WorkerWorld, executionId: string) => ({
  status: world.tasks.execution(executionId)!.status,
  reason: diagnosticsOf(runner, world, executionId)["reason"] ?? null,
});

/** One turn on the fake provider, which writes the owned file and then runs `whileLatched`. */
const fakeTurn = async (world: WorkerWorld, whileLatched: () => void) => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = { writes: { "src/app.js": CHANGE }, whileLatched } satisfies FakeTurnScript;
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter as ProviderAdapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
  );
  const started = await startTurn(runner, world);
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  await runner.settled(started.value.executionId);
  return { ...outcomeOf(runner, world, started.value.executionId), diagnostics: diagnosticsOf(runner, world, started.value.executionId) };
};

/** git as the worker's shell runs it: with `env` over the test's own environment, minus any `GIT_OPTIONAL_LOCKS`. */
const shellGit = (cwd: string, args: readonly string[], env: Record<string, string> = {}): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GIT_OPTIONAL_LOCKS")), ...env },
  });

/** The real adapter, observed: every answer it returns is kept. */
const observed = (adapter: ProviderAdapter, answers: InvocationResult[]): ProviderAdapter => ({
  provider: adapter.provider,
  isProduction: adapter.isProduction,
  defaultModels: adapter.defaultModels,
  invoke: async (request: InvocationRequest) => {
    const answer = await adapter.invoke(request);
    answers.push(answer);
    return answer;
  },
}) as unknown as ProviderAdapter;

interface CodexReport {
  optionalLocks: string | null;
  /** Whether any index entry was racily clean (its mtime second not older than the index's) at the turn. */
  racilyClean: boolean;
  status: string;
  indexRewritten: boolean;
  /** `GIT_CONFIG_KEY_<n>` to `GIT_CONFIG_VALUE_<n>`, as the child's environment carries them. */
  gitConfig: Record<string, string>;
  /** `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM`, as the child's environment carries them. */
  configFiles: { global: string | null; nosystem: string | null };
}

/**
 * A codex stand-in. Its turn edits the owned file; with `stale`, it also leaves README.md's bytes as they
 * were with its mtime moved (a stale stat cache, after the baseline). It reads, without writing, whether
 * the index it found was racily clean, runs each of `commands` and then `git status --short` with the
 * environment it was given, and reports that environment and whether the index was rewritten.
 */
interface CodexScript {
  stale?: boolean;
  /** git argument lists run after the edit, before the status. */
  commands?: string[][];
}

const stubCodex = (root: string, options: CodexScript): string => {
  const binary = join(root, "codex");
  writeFileSync(binary, `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "login") process.exit(0);
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => {
  const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" });
  const index = join(git("rev-parse", "--absolute-git-dir").trim(), "index");
  const indexSecond = Math.floor(statSync(index).mtimeMs / 1000);
  const racilyClean = [...git("ls-files", "--debug").matchAll(/^  mtime: (\\d+):/gm)].some((match) => Number(match[1]) >= indexSecond);
  writeFileSync(join(process.cwd(), "src", "app.js"), ${JSON.stringify(CHANGE)});
  if (${JSON.stringify(options.stale ?? false)}) {
    const past = Math.floor(Date.now() / 1000) - 120;
    utimesSync(join(process.cwd(), "README.md"), past, past);
  }
  for (const command of ${JSON.stringify(options.commands ?? [])}) git(...command);
  const before = statSync(index).mtimeMs;
  const status = git("status", "--short");
  const indexRewritten = statSync(index).mtimeMs !== before;
  const gitConfig = Object.fromEntries(Array.from({ length: Number(process.env.GIT_CONFIG_COUNT ?? 0) },
    (_, n) => [process.env["GIT_CONFIG_KEY_" + n], process.env["GIT_CONFIG_VALUE_" + n]]));
  const configFiles = { global: process.env.GIT_CONFIG_GLOBAL ?? null, nosystem: process.env.GIT_CONFIG_NOSYSTEM ?? null };
  const report = { optionalLocks: process.env.GIT_OPTIONAL_LOCKS ?? null, racilyClean, status, indexRewritten, gitConfig, configFiles };
  writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(report));
  process.exit(0);
});
`);
  chmodSync(binary, 0o700);
  return binary;
};

/** One gpt WORKER turn on the real Codex adapter, its binary the stand-in above. */
const codexTurn = async (world: WorkerWorld, options: CodexScript) => {
  world.db.run(`UPDATE sessions SET provider = 'gpt', model = 'gpt-6.1-sol' WHERE session_id = ?`, [world.worker.sessionId]);
  const root = tempDir("acp-codex-optional-locks-");
  const codex = new CodexCliAdapter({
    clock: world.clock,
    capacityFile: join(root, "capacity.json"),
    binary: stubCodex(root, options),
    managedWriteBroker: world.broker,
  });
  const answers: InvocationResult[] = [];
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => observed(codex, answers) },
    { pollMs: 20 },
  );
  const started = await startTurn(runner, world);
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  await runner.settled(started.value.executionId);
  expect(answers).toHaveLength(1);
  return {
    report: JSON.parse(answers[0]!.text) as CodexReport,
    outcome: outcomeOf(runner, world, started.value.executionId),
    diagnostics: diagnosticsOf(runner, world, started.value.executionId),
  };
};

describe("#1246 (a) a gpt worker's git status on a freshly prepared, racily clean branch", () => {
  it("rewrites nothing in the git dir and takes no lock, and the turn succeeds on the branch the runner created", async () => {
    const world = freshRacyWorld();
    const { report, outcome } = await codexTurn(world, { stale: false });
    expect({ ...report, outcome }).toEqual({
      optionalLocks: "0",
      racilyClean: true,
      status: " M src/app.js\n",
      indexRewritten: false,
      gitConfig: { "core.fsmonitor": "false" },
      configFiles: { global: "/dev/null", nosystem: "1" },
      outcome: { status: "SUCCEEDED", reason: null },
    });
    expect(world.audit.byKind("TASK_BRANCH_PREPARED").map((row) => row.evidence)).toEqual([
      expect.objectContaining({ branch: world.branch, fromBranch: "dev", created: true }),
    ]);
    expect(gitSync(world.repoPath, ["symbolic-ref", "--short", "HEAD"])).toBe(world.branch);
    expect(gitSync(world.repoPath, ["show", "HEAD:src/app.js"])).toBe(CHANGE.trimEnd());
  });
});

describe("#1246 (b) a worker that really writes the git dir", () => {
  const workerGit = (cwd: string, args: readonly string[]): string => shellGit(cwd, args, { GIT_OPTIONAL_LOCKS: "0" });
  const later = (): number => Math.floor(Date.now() / 1000) + 5;

  it("is still refused GIT_DIR_CHANGED after the same status, naming what differs by root, path and kind", async () => {
    const cases: Array<[string, "linked" | "main", (world: WorkerWorld) => void, Array<Record<string, string>>]> = [
      ["update-ref", "linked", (world) => workerGit(world.repoPath, ["update-ref", "refs/heads/stray", "HEAD"]), [
        { change: "added", root: "commonDir", path: "refs/heads/stray", kind: "file" },
      ]],
      ["the linked git dir's HEAD touched", "linked", (world) => utimesSync(join(gitDirOf(world.repoPath), "HEAD"), later(), later()), [
        { change: "changed", root: "gitDir", path: "HEAD", kind: "file" },
        { change: "changed", root: "commonDir", path: "worktrees/tree/HEAD", kind: "file" },
      ]],
      ["a main checkout's .git/HEAD touched", "main", (world) => utimesSync(join(world.repoPath, ".git", "HEAD"), later(), later()), [
        { change: "changed", root: "gitDir", path: "HEAD", kind: "file" },
      ]],
    ];
    for (const [name, layout, write, named] of cases) {
      const world = freshRacyWorld(layout);
      const outcome = await fakeTurn(world, () => {
        workerGit(world.repoPath, ["status", "--short"]);
        write(world);
      });
      expect({ status: outcome.status, reason: outcome.reason }, name).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
      const changes = outcome.diagnostics["gitDirChanges"] as Array<Record<string, string>>;
      expect(changes, name).toEqual(expect.arrayContaining(named));
      expect(outcome.diagnostics["gitDirChangeCount"], name).toBe(changes.length);
      // Root, relative path and kind only: nothing of a file's contents, inode or times.
      for (const change of changes) expect(Object.keys(change).sort(), name).toEqual(["change", "kind", "path", "root"]);
    }
  });

  it("names at most 50 differing entries and gives the count of all of them", async () => {
    const world = freshRacyWorld("main");
    const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const outcome = await fakeTurn(world, () => {
      for (let i = 0; i < 60; i += 1) writeFileSync(join(world.repoPath, ".git", "refs", "heads", `stray-${String(i).padStart(2, "0")}`), `${head}\n`);
    });
    expect({ status: outcome.status, reason: outcome.reason }).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
    expect(outcome.diagnostics["gitDirChanges"]).toHaveLength(50);
    // The 60 refs, and their directory, whose mtime they moved.
    expect(outcome.diagnostics["gitDirChangeCount"]).toBe(61);
  });
});

describe("#1246 (d) a main checkout, racily clean, where the worker runs a plain git status", () => {
  it("has its index rewritten by that status, and the turn still succeeds: the main checkout's git-dir comparison never reads it", async () => {
    const world = freshRacyWorld("main");
    const index = join(world.repoPath, ".git", "index");
    let indexRewritten: boolean | null = null;
    const outcome = await fakeTurn(world, () => {
      const before = statSync(index).mtimeMs;
      shellGit(world.repoPath, ["status", "--short"]);
      indexRewritten = statSync(index).mtimeMs !== before;
    });
    expect({ indexRewritten, status: outcome.status, reason: outcome.reason }).toEqual({ indexRewritten: true, status: "SUCCEEDED", reason: null });
  });
});

describe("#1246 (c) a WORKER turn's provider child runs with GIT_OPTIONAL_LOCKS=0, core.fsmonitor=false and no global or system git config", () => {
  it("codex (gpt): the status it runs on an index gone stale after the baseline takes no lock, and the turn succeeds", async () => {
    const world = seedWorkerWorld(makeCore(), { linkedWorktree: true });
    const { report, outcome } = await codexTurn(world, { stale: true });
    expect({ optionalLocks: report.optionalLocks, status: report.status, indexRewritten: report.indexRewritten, outcome }).toEqual({
      optionalLocks: "0",
      status: " M src/app.js\n",
      indexRewritten: false,
      outcome: { status: "SUCCEEDED", reason: null },
    });
  });

  it("claude: the child under the seatbelt has it in its environment", async (ctx) => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const probeDir = tempDir("acp-claude-optional-locks-");
    const binary = join(probeDir, "claude-probe.mjs");
    writeFileSync(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf("--session-id") + 1];
writeFileSync(join(process.cwd(), "src", "app.js"), ${JSON.stringify(CHANGE)});
const gitConfig = Object.fromEntries(Array.from({ length: Number(process.env.GIT_CONFIG_COUNT ?? 0) },
  (_, n) => [process.env["GIT_CONFIG_KEY_" + n], process.env["GIT_CONFIG_VALUE_" + n]]));
const configFiles = { global: process.env.GIT_CONFIG_GLOBAL ?? null, nosystem: process.env.GIT_CONFIG_NOSYSTEM ?? null };
const report = { optionalLocks: process.env.GIT_OPTIONAL_LOCKS ?? null, gitConfig, configFiles };
process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: JSON.stringify(report) }));
`);
    chmodSync(binary, 0o700);
    const claude = new ClaudeCliAdapter({
      clock: core.clock,
      capacityFile: join(probeDir, "capacity.json"),
      binary,
      managedWriteBroker: world.broker,
    });
    const answers: InvocationResult[] = [];
    const runner = new WorkerTurnRunner(
      { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => observed(claude, answers) },
      { pollMs: 20 },
    );
    const started = await startTurn(runner, world);
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    await runner.settled(started.value.executionId);
    // No unconfined fallback exists: without seatbelt the turn cannot run, so this is skipped loudly.
    if (!seatbeltStatus().applies) requireSeatbelt(ctx);
    expect(answers).toHaveLength(1);
    expect({ ...(JSON.parse(answers[0]!.text) as Record<string, unknown>), outcome: outcomeOf(runner, world, started.value.executionId) })
      .toEqual({
        optionalLocks: "0",
        gitConfig: { "core.fsmonitor": "false" },
        configFiles: { global: "/dev/null", nosystem: "1" },
        outcome: { status: "SUCCEEDED", reason: null },
      });
  });
});

/** A main checkout whose owner configured a textconv driver for the owned file before the turn, caching unless `cache: false`. */
const textconvWorld = (options: { cache: boolean } = { cache: true }): WorkerWorld => {
  const world = seedWorkerWorld(makeCore());
  gitSync(world.repoPath, ["config", "diff.demo.textconv", "cat"]);
  if (options.cache) gitSync(world.repoPath, ["config", "diff.demo.cachetextconv", "true"]);
  mkdirSync(join(world.repoPath, ".git", "info"), { recursive: true });
  writeFileSync(join(world.repoPath, ".git", "info", "attributes"), "src/app.js diff=demo\n");
  return world;
};
const cachingTextconvWorld = (): WorkerWorld => textconvWorld();

const notesRef = (world: WorkerWorld): string | null => {
  try {
    return gitSync(world.repoPath, ["rev-parse", "--verify", "-q", "refs/notes/textconv/demo"]);
  } catch {
    return null;
  }
};

describe("#1246 (e) the repository's own configuration cannot make the worker's read-only git write the git dir", () => {

  it("a caching textconv driver: the worker's git diff after its edit stores no notes, and the turn succeeds", async () => {
    const world = cachingTextconvWorld();
    const { report, outcome } = await codexTurn(world, { commands: [["diff"]] });
    expect({ gitConfig: report.gitConfig, outcome, notes: notesRef(world) }).toEqual({
      gitConfig: { "core.fsmonitor": "false", "diff.demo.cachetextconv": "false" },
      outcome: { status: "SUCCEEDED", reason: null },
      notes: null,
    });
  });

  it("a worker that turns the cache on for itself is still refused GIT_DIR_CHANGED, naming the notes ref", async () => {
    const world = cachingTextconvWorld();
    const { outcome, diagnostics } = await codexTurn(world, { commands: [["-c", "diff.demo.cachetextconv=true", "diff"]] });
    expect(outcome).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
    expect(diagnostics["gitDirChanges"]).toEqual(expect.arrayContaining([
      { change: "added", root: "gitDir", path: "refs/notes/textconv/demo", kind: "file" },
    ]));
  });

  it("core.fsmonitor=true: the worker's git status starts no fsmonitor daemon in the git dir, and the turn succeeds", async () => {
    const world = seedWorkerWorld(makeCore());
    gitSync(world.repoPath, ["config", "core.fsmonitor", "true"]);
    try {
      const { report, outcome } = await codexTurn(world, {});
      expect({ status: report.status, outcome, daemonDir: existsSync(join(world.repoPath, ".git", "fsmonitor--daemon")) }).toEqual({
        status: " M src/app.js\n",
        outcome: { status: "SUCCEEDED", reason: null },
        daemonDir: false,
      });
    } finally {
      // Where a daemon did start (the tree before this change), it is stopped, never left running.
      try {
        shellGit(world.repoPath, ["fsmonitor--daemon", "stop"]);
      } catch {
        /* none was running */
      }
    }
  });
});

describe("#1246 (f) the provider user's global git configuration", () => {
  it("caching configured only in the provider HOME's .gitconfig: the worker's git diff stores no notes, and the turn succeeds", async () => {
    // The provider child keeps HOME (its own login lives there); this file's HOME is a private temporary one.
    const home = process.env["HOME"]!;
    const globalConfig = join(home, ".gitconfig");
    expect(existsSync(globalConfig)).toBe(false);
    const world = textconvWorld({ cache: false });
    writeFileSync(globalConfig, "[diff \"demo\"]\n\tcachetextconv = true\n");
    try {
      const { report, outcome } = await codexTurn(world, { commands: [["diff"]] });
      expect({ gitConfig: report.gitConfig, configFiles: report.configFiles, outcome, notes: notesRef(world) }).toEqual({
        gitConfig: { "core.fsmonitor": "false" },
        configFiles: { global: "/dev/null", nosystem: "1" },
        outcome: { status: "SUCCEEDED", reason: null },
        notes: null,
      });
    } finally {
      rmSync(globalConfig, { force: true });
    }
  });
});

describe("#1246 (f) a file the repository's configuration includes from the provider's HOME", () => {
  const CACHE = "[diff \"demo\"]\n\tcachetextconv = true\n";
  const includes: Array<[string, (world: WorkerWorld) => [string, string]]> = [
    ["include.path", () => ["include.path", "~/acp-1246-textconv-cache.inc"]],
    ["includeIf gitdir", (world) => [`includeIf.gitdir:${realpathSync(join(world.repoPath, ".git"))}.path`, "~/acp-1246-textconv-cache.inc"]],
  ];
  for (const [name, include] of includes) {
    it(`${name} = ~/…: discovery reads it with the worker's HOME, the worker's git diff stores no notes, and the turn succeeds`, async () => {
      const included = join(process.env["HOME"]!, "acp-1246-textconv-cache.inc");
      const world = textconvWorld({ cache: false });
      const [key, value] = include(world);
      gitSync(world.repoPath, ["config", key, value]);
      writeFileSync(included, CACHE);
      try {
        const { report, outcome } = await codexTurn(world, { commands: [["diff"]] });
        expect({ gitConfig: report.gitConfig, outcome, notes: notesRef(world) }).toEqual({
          gitConfig: { "core.fsmonitor": "false", "diff.demo.cachetextconv": "false" },
          outcome: { status: "SUCCEEDED", reason: null },
          notes: null,
        });
      } finally {
        rmSync(included, { force: true });
      }
    });
  }
});

describe("#1246 (g) a repository that keeps a split index", () => {
  /** Each variant, and what the refusal says of it: whether the setting is true, and whether the index uses a shared index. */
  const variants: Array<[string, (repo: string) => void, { configured: boolean; active: boolean }]> = [
    ["core.splitIndex true, the index split", (repo) => {
      gitSync(repo, ["config", "core.splitIndex", "true"]);
      gitSync(repo, ["update-index", "--split-index"]);
    }, { configured: true, active: true }],
    ["the index split with core.splitIndex unset", (repo) => gitSync(repo, ["update-index", "--split-index"]), { configured: false, active: true }],
    ["core.splitIndex true before the index is split", (repo) => gitSync(repo, ["config", "core.splitIndex", "true"]), { configured: true, active: false }],
    // Only the first half of the recovery: every read of this index still touches its shared index.
    ["core.splitIndex false with the index still split", (repo) => {
      gitSync(repo, ["update-index", "--split-index"]);
      gitSync(repo, ["config", "core.splitIndex", "false"]);
    }, { configured: false, active: true }],
  ];

  it("is refused before anything is prepared or launched, naming core.splitIndex, and nothing is left behind", async () => {
    for (const [name, split, said] of variants) {
      const world = freshRacyWorld("main");
      split(world.repoPath);
      const refs = gitSync(world.repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      const branchRecords = world.audit.byKind("TASK_BRANCH_CREATED").length;
      const adapter = new FakeWorkerAdapter(world.broker);
      adapters.push(adapter);
      const runner = new WorkerTurnRunner(
        { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter as ProviderAdapter },
        { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
      );
      const started = await startTurn(runner, world);
      expect(started, name).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.WORKER_REPOSITORY_SPLIT_INDEX_UNSUPPORTED,
        message: expect.stringContaining("core.splitIndex"),
        evidence: { setting: "core.splitIndex", ...said },
      });
      expect({
        launches: adapter.launches,
        executions: world.tasks.executions(world.runId).length,
        head: gitSync(world.repoPath, ["symbolic-ref", "--short", "HEAD"]),
        refs: gitSync(world.repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        branchRecords: world.audit.byKind("TASK_BRANCH_CREATED").length,
        attempts: world.audit.byKind("TASK_BRANCH_CREATING").length,
      }, name).toEqual({ launches: 0, executions: 0, head: "dev", refs, branchRecords, attempts: 0 });
    }
  });

  it("recovered as the refusal says, an unused sharedindex.* file left behind: the turn runs and succeeds", async () => {
    const world = freshRacyWorld("main");
    gitSync(world.repoPath, ["config", "core.splitIndex", "true"]);
    gitSync(world.repoPath, ["update-index", "--split-index"]);
    gitSync(world.repoPath, ["config", "core.splitIndex", "false"]);
    gitSync(world.repoPath, ["update-index", "--no-split-index"]);
    const leftover = readdirSync(join(world.repoPath, ".git")).filter((name) => name.startsWith("sharedindex."));
    expect({ leftover: leftover.length, sharedIndexPath: gitSync(world.repoPath, ["rev-parse", "--shared-index-path"]) }).toEqual({ leftover: 1, sharedIndexPath: "" });
    const outcome = await fakeTurn(world, () => shellGit(world.repoPath, ["status", "--short"], { GIT_OPTIONAL_LOCKS: "0" }));
    expect({ status: outcome.status, reason: outcome.reason }).toEqual({ status: "SUCCEEDED", reason: null });
    expect(gitSync(world.repoPath, ["show", "HEAD:src/app.js"])).toBe(CHANGE.trimEnd());
  });
});
