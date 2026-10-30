import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commandsForMode } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { type CandidateSnapshot, candidateSnapshotDigest, verifySnapshotFreshness } from "../../src/snapshot/candidate-snapshot.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1227 — a resident CTO runs in its project's clone, and its tooling writes there: Claude Code's
 * session cron lock (`.claude/scheduled_tasks.lock`), its own local settings, notes, an edit in
 * progress. Worker turns ran in that same checkout, so every one of those was in front of the worker
 * scan and could reach a candidate. A resident project's worker turns now get their own checkout: a
 * separate local clone of the resident's clone, with its own git dir and hardlinked objects, which the
 * daemon makes beside it and registers in its place, moving an existing project's HELD claims with it
 * and standing on the task branch the resident's clone stood on. Nothing of the resident's clone is
 * written, and nothing the resident's git writes (a commit, a fetch) is in a worker turn's baseline.
 *
 * Over the real CTO MCP socket, the real daemon pass, claim registry, guard, worker runner, pipeline and
 * verification engine, in scratch repositories only. Stood in: the WORKER provider and its capacity
 * admission, and the #1240 GitHub work-scope tracking a resident project's runs also pass through.
 * Literals stand for the new names, so a tree without them fails on behaviour, not on a missing export.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const IDENTITY = "github:acme/fixture";
const ORIGIN = "https://github.com/acme/fixture.git";
const MOVED = "REPOSITORY_CHECKOUT_MOVED";
const LOCK = ".claude/scheduled_tasks.lock";
const LOCK_BYTES = '{"sessionId":"resident-cto","pid":4242,"acquiredAt":1761460000000}\n';
const SETTINGS = '{"permissions":{"allow":["Bash"]}}\n';
const NOTES = "# what the resident is thinking about\n";
const RESIDENT_README = "# the resident's edit in progress\n";

const APP = { key: "app", title: "update app", category: "implementation" as const, spec: { writeTarget: { paths: ["src/app.js"] } } };
const README = { key: "readme", title: "update readme", category: "docs" as const, spec: { writeTarget: { paths: ["README.md"] } } };

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  declaredParent: string;
  baseSha: string;
}

/** The project's clone where a resident's would be, `<home>/projects/<name>`, with the harness's files. */
const residentClone = (): string => {
  const home = realpathSync(tempDir("acp-resident-home-"));
  mkdirSync(join(home, "projects"));
  gitSync(join(home, "projects"), ["init", "-q", "-b", "dev", "fixture"]);
  const clone = join(home, "projects", "fixture");
  gitSync(clone, ["config", "--local", "maintenance.auto", "false"]);
  gitSync(clone, ["config", "--local", "core.excludesFile", "/dev/null"]);
  gitSync(clone, ["remote", "add", "origin", ORIGIN]);
  writeFiles(clone, {
    "README.md": "# fixture project\n",
    "src/app.js": "module.exports = () => 1;\n",
    "verify.js": `const app = require('./src/app.js');
if (app() !== 2) { console.error('expected app() === 2'); process.exit(1); }
console.log('verification ok');`,
  });
  commitAll(clone, "base");
  return clone;
};

/** A driven PRIMARY_CTO's STANDARD_WORK run on the clone, dispatched, its tasks submitted, the real worker path. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string, tasks: Array<typeof APP | typeof README>) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  const sessionId = bound.value.sessionId;
  const repository = cp.db.get<{ repository_id: string; checkout_path: string }>(
    `SELECT repository_id, checkout_path FROM repositories WHERE project_id = ?`,
    [projectId],
  )!;
  const created = cp.runs.create({
    projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract: {
      goal: "update the project",
      why: "changes in one run",
      scope: ["README.md", "src/app.js"],
      nonGoals: [],
      acceptance: ["the files change"],
      priority: "NORMAL" as const,
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, tasks);
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  const ids = Object.fromEntries(tasks.map((task, index) => [task.key, submitted.value[index]!.taskId]));
  return { runId, sessionId, ids, projectId, bootstrapRunId: bootstrap.runId, repositoryId: repository.repository_id, clone: repository.checkout_path };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

/**
 * The project becomes a resident's, as Repo Factory provisioning leaves one: a live provisioning row
 * whose allocation's clone is the registered checkout, where the resident CTO runs. Its runs are #1240
 * work-scope governed from then on; that tracking is stood in.
 */
const becomeResident = (f: BootstrapRuntimeFixture, s: StandardRun): void => {
  const cp = f.harness.cp;
  const allocation = { projectId: s.projectId, runId: s.bootstrapRunId, repositoryIdentity: IDENTITY, clonePath: s.clone };
  cp.db.run(
    `INSERT INTO resident_project_provisioning (run_id, project_id, binding_json, allocation_json, confirmation_json, status, updated_at)
     VALUES (?, ?, '{}', ?, '{}', 'COMPLETE', ?)`,
    [s.bootstrapRunId, s.projectId, JSON.stringify(allocation), f.harness.clock.nowIso()],
  );
  const scope = cp.tasks.workScope!;
  vi.spyOn(scope, "assertTracked").mockReturnValue(allow(ReasonCode.OK, null) as never);
  vi.spyOn(scope, "ensure").mockResolvedValue(allow(ReasonCode.OK, null) as never);
};

/** What the resident's tooling leaves in its own working directory. */
const residentWrites = (clone: string): void => {
  mkdirSync(join(clone, ".claude"), { recursive: true });
  writeFileSync(join(clone, LOCK), LOCK_BYTES);
  writeFileSync(join(clone, ".claude", "settings.local.json"), SETTINGS);
  mkdirSync(join(clone, "notes"), { recursive: true });
  writeFileSync(join(clone, "notes", "resident.md"), NOTES);
  writeFileSync(join(clone, "README.md"), RESIDENT_README);
};

const expectResidentFilesUntouched = (clone: string): void => {
  expect(readFileSync(join(clone, LOCK), "utf8")).toBe(LOCK_BYTES);
  expect(readFileSync(join(clone, ".claude", "settings.local.json"), "utf8")).toBe(SETTINGS);
  expect(readFileSync(join(clone, "notes", "resident.md"), "utf8")).toBe(NOTES);
  expect(readFileSync(join(clone, "README.md"), "utf8")).toBe(RESIDENT_README);
};

const daemonPass = async (f: BootstrapRuntimeFixture): Promise<void> => {
  await new Daemon(f.harness.cp, { stateDir: join(f.harness.root, "daemon") }).resumeResidentProjects();
};

/** The checkout `contract_get` answers for the run's repository: what the CTO claims. */
const registeredCheckout = async (f: BootstrapRuntimeFixture, s: StandardRun): Promise<string> => {
  const contract = await f.cto(s.sessionId, "contract_get", { runId: s.runId });
  return (contract["value"] as { repositories: Array<{ checkoutPath: string }> }).repositories[0]!.checkoutPath;
};

const workerDoing = (f: BootstrapRuntimeFixture): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

const provision = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string): Promise<WriteTarget> => {
  const provisioned = await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });
  expect(provisioned, JSON.stringify(provisioned).slice(0, 600)).toMatchObject({ ok: true });
  return (provisioned["value"] as { writeTarget: WriteTarget }).writeTarget;
};

const claim = async (f: BootstrapRuntimeFixture, s: StandardRun, target: WriteTarget, worktreeId: string): Promise<string> => {
  const claimed = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId,
    declaredPaths: target.paths,
  });
  expect(claimed, JSON.stringify(claimed).slice(0, 600)).toMatchObject({ ok: true });
  return (claimed["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims.find((row) => row.worktreeId !== null)!.claimId;
};

/** One worker turn to its end; answers the execution and its diagnostics, or the refusal of its start. */
const turn = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, claimId: string, script: FakeTurnScript) => {
  worker.script = script;
  const ran = await f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });
  if (ran["ok"] !== true) return { ran, execution: null, diagnostics: {} as Record<string, unknown> };
  const executionId = (ran["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  const view = f.harness.cp.workerTurns.describe(executionId, s.runId);
  const diagnostics = view.allowed ? (view.value.diagnostics?.evidence ?? {}) : {};
  return { ran, execution: f.harness.cp.tasks.execution(executionId)!, diagnostics };
};

/** git as the resident's own session runs it, in its clone. */
const residentGit = (clone: string, args: readonly string[]): string => gitSync(clone, args);

/** A migrated resident project with one task staffed and claimed in its worker clone, ready for a turn. */
const migratedWithClaim = async (f: BootstrapRuntimeFixture, projectId: string) => {
  const s = await standardRun(f, projectId, [APP]);
  becomeResident(f, s);
  await daemonPass(f);
  const checkout = await registeredCheckout(f, s);
  expect(checkout).not.toBe(s.clone);
  const target = await provision(f, s, s.ids["app"]!);
  return { s, checkout, target, claimId: await claim(f, s, target, checkout) };
};

const release = async (f: BootstrapRuntimeFixture, s: StandardRun): Promise<void> => {
  expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
};

const refsOf = (repo: string): string => gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
const headRef = (repo: string): string | null => {
  try {
    return gitSync(repo, ["symbolic-ref", "-q", "HEAD"]);
  } catch {
    return null;
  }
};
const isAncestor = (repo: string, ancestor: string, of: string): boolean => {
  try {
    gitSync(repo, ["merge-base", "--is-ancestor", ancestor, of]);
    return true;
  } catch {
    return false;
  }
};

/** A git first on PATH that mutates the checkout before the first matching real git invocation. */
const gitOnce = (match: string, before: string): { restore: () => void; fired: () => boolean } => {
  const bin = tempDir("acp-resident-git-");
  const fired = join(bin, "fired");
  const real = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "git"))
    .find((path) => existsSync(path));
  if (!real) throw new Error("no git on PATH");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `case "$*" in *"${match}"*) if [ ! -e '${fired}' ]; then : > '${fired}'; ${before}; fi;; esac`,
    `exec '${real}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  return { restore: () => { process.env["PATH"] = path; }, fired: () => existsSync(fired) };
};
const moves = (f: BootstrapRuntimeFixture) => f.harness.cp.audit.byKind(MOVED).map((row) => row.evidence);
/** Every file under a git dir, with its inode and times: what changed in it, if anything did. */
const gitDirState = (repo: string): string => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      out.push(`${path} ${stat.ino} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(join(repo, ".git"));
  return out.join("\n");
};

describe("#1227 a resident's working directory never reaches a worker turn", () => {
  it("W1: the resident writes the cron lock and other files in its cwd and commits on its own dev; the worker turn runs in the worker clone, from that dev, succeeds, and none of the cwd files reach it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-w1", [APP]);
      becomeResident(f, s);
      residentWrites(s.clone);
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        // The registered checkout, read back, is not the resident's cwd: a separate clone with its own git
        // dir, its objects hardlinked to the resident's, its origin the repository's own remote.
        expect(checkout).not.toBe(s.clone);
        expect(cp.repositories.byIdentity(IDENTITY)!.checkoutPath).toBe(checkout);
        expect(lstatSync(join(checkout, ".git")).isDirectory()).toBe(true);
        expect(gitSync(checkout, ["rev-parse", "--git-common-dir"])).toBe(".git");
        expect(gitSync(checkout, ["remote", "get-url", "origin"])).toBe(ORIGIN);
        expect(gitSync(checkout, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])).toBe("");
        const object = gitSync(s.clone, ["rev-parse", "HEAD:src/app.js"]);
        const objectPath = (repo: string): string => join(repo, ".git", "objects", object.slice(0, 2), object.slice(2));
        expect(statSync(objectPath(checkout)).ino).toBe(statSync(objectPath(s.clone)).ino);
        const workerDev = gitSync(checkout, ["rev-parse", "refs/heads/dev"]);

        // The resident commits on its own dev, in its own clone, after the move: the run's base is read there.
        writeFiles(s.clone, { "docs/resident.md": "# committed by the resident\n" });
        residentGit(s.clone, ["add", "docs/resident.md"]);
        residentGit(s.clone, ["commit", "-q", "-m", "the resident's own commit"]);
        const residentDev = gitSync(s.clone, ["rev-parse", "refs/heads/dev"]);
        const statusBefore = gitSync(s.clone, ["status", "--porcelain", "--untracked-files=all"]);
        const cloneGitDir = gitDirState(s.clone);

        const target = await provision(f, s, s.ids["app"]!);
        expect(target.baseSha).toBe(residentDev);
        const claimId = await claim(f, s, target, checkout);
        const { ran, execution } = await turn(f, s, worker, s.ids["app"]!, claimId, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(ran, JSON.stringify(ran).slice(0, 800)).toMatchObject({ ok: true });
        expect(execution!.status).toBe("SUCCEEDED");
        // Where the worker actually ran: the registered checkout, never the resident's cwd.
        expect(execution!.worktreeId).toBe(checkout);

        const commit = gitSync(checkout, ["rev-parse", `refs/heads/${target.branch}`]);
        expect(gitSync(checkout, ["rev-parse", `${commit}^`])).toBe(residentDev);
        expect(gitSync(checkout, ["diff-tree", "--no-commit-id", "--name-only", "-r", residentDev, commit])).toBe("src/app.js");
        expect(gitSync(checkout, ["show", `${commit}:README.md`])).toBe("# fixture project");
        expect(gitSync(checkout, ["ls-tree", "-r", "--name-only", commit])).not.toMatch(/\.claude|notes/);
        // Only the claimed task branch moves. The worker clone's base ref is not an unclaimed mirror
        // of the resident's dev; the task branch starts directly from the pinned commit instead.
        expect(gitSync(checkout, ["rev-parse", "refs/heads/dev"])).toBe(workerDev);
        expect(workerDev).not.toBe(residentDev);
        // The resident's clone is exactly as it left it: every file of its git dir (read first: this test's
        // own git status below may refresh the index), its files, its branch.
        expect(gitDirState(s.clone)).toBe(cloneGitDir);
        expectResidentFilesUntouched(s.clone);
        expect(gitSync(s.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
        expect(headRef(s.clone)).toBe("refs/heads/dev");
        expect(headRef(checkout)).toBe(`refs/heads/${target.branch}`);
        expect(gitSync(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("a refresh refusal leaves the worker clone's base ref at the exact value held before the task-branch attempt", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "resident-base-ref-refresh", [APP]);
      becomeResident(f, s);
      const worker = workerDoing(f);
      let wrapper: ReturnType<typeof gitOnce> | null = null;
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        const workerDev = gitSync(checkout, ["rev-parse", "refs/heads/dev"]);

        writeFiles(s.clone, { "docs/resident.md": "# a later resident commit\n" });
        residentGit(s.clone, ["add", "docs/resident.md"]);
        residentGit(s.clone, ["commit", "-q", "-m", "resident advances dev"]);
        const residentDev = gitSync(s.clone, ["rev-parse", "refs/heads/dev"]);
        expect(residentDev).not.toBe(workerDev);

        const target = await provision(f, s, s.ids["app"]!);
        expect(target.baseSha).toBe(residentDev);
        const claimId = await claim(f, s, target, checkout);
        const lateBytes = "# a late checkout edit\n";
        wrapper = gitOnce("update-index --refresh", `printf '${lateBytes.replace(/\n/g, "\\n")}' > '${join(checkout, "README.md")}'`);
        const refused = await turn(f, s, worker, s.ids["app"]!, claimId, { writes: { "src/app.js": "module.exports = () => 2;\n" } });

        expect(wrapper.fired()).toBe(true);
        expect(refused.ran).toMatchObject({ ok: false });
        expect(gitSync(checkout, ["rev-parse", "refs/heads/dev"])).toBe(workerDev);
        expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe(lateBytes);
      } finally {
        wrapper?.restore();
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("W2: an existing project worked on in the resident's clone is moved with its HELD claim, its worker clone stands on the task branch the resident's clone stood on, and that branch is re-entered there; the resident's clone is not written", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-w2", [APP, README]);
      const worker = workerDoing(f);
      try {
        // Before this build: worker turns ran in the clone. APP succeeded there; README's first turn
        // failed, leaving the clone on README's branch with its claim still HELD.
        const app = await provision(f, s, s.ids["app"]!);
        const appRun = await turn(f, s, worker, s.ids["app"]!, await claim(f, s, app, s.clone), { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(appRun.execution!.status).toBe("SUCCEEDED");
        const appCommit = gitSync(s.clone, ["rev-parse", `refs/heads/${app.branch}`]);
        await release(f, s);
        const readme = await provision(f, s, s.ids["readme"]!);
        const readmeClaim = await claim(f, s, readme, s.clone);
        const first = await turn(f, s, worker, s.ids["readme"]!, readmeClaim, { exitCode: 1 });
        expect(first.execution!.status).not.toBe("SUCCEEDED");
        expect(headRef(s.clone)).toBe(`refs/heads/${readme.branch}`);
        const readmeTip = gitSync(s.clone, ["rev-parse", `refs/heads/${readme.branch}`]);

        // Then the project is a resident's, and the resident writes in its cwd.
        becomeResident(f, s);
        residentWrites(s.clone);
        const refsBefore = refsOf(s.clone);
        const cloneGitDir = gitDirState(s.clone);

        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        expect(checkout).not.toBe(s.clone);
        expect(moves(f)).toEqual([expect.objectContaining({ identity: IDENTITY, branch: readme.branch, head: readmeTip, claimsMoved: 1 })]);
        // The resident's clone is untouched: its HEAD still on README's branch, its refs and git dir as they were.
        expect(headRef(s.clone)).toBe(`refs/heads/${readme.branch}`);
        expect(refsOf(s.clone)).toBe(refsBefore);
        expect(gitDirState(s.clone)).toBe(cloneGitDir);
        expectResidentFilesUntouched(s.clone);
        // The worker clone has every branch the clone had, and stands on README's at the same commit, clean.
        expect(refsOf(checkout)).toBe(refsBefore);
        expect(headRef(checkout)).toBe(`refs/heads/${readme.branch}`);
        expect(gitSync(checkout, ["rev-parse", "HEAD"])).toBe(readmeTip);
        expect(gitSync(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
        // The HELD claim followed the checkout.
        expect(cp.db.get<{ worktree_id: string }>(`SELECT worktree_id FROM resource_claims WHERE claim_id = ?`, [readmeClaim])!.worktree_id).toBe(checkout);

        // The earlier task's branch is re-entered by the same claim, and its turn commits on it there.
        const again = await turn(f, s, worker, s.ids["readme"]!, readmeClaim, { writes: { "README.md": "# by the readme task\n" } });
        expect(again.ran, JSON.stringify(again.ran).slice(0, 800)).toMatchObject({ ok: true });
        expect(again.execution!.status).toBe("SUCCEEDED");
        expect(again.execution!.worktreeId).toBe(checkout);
        const readmeCommit = gitSync(checkout, ["rev-parse", `refs/heads/${readme.branch}`]);
        expect(gitSync(checkout, ["rev-parse", `${readmeCommit}^`])).toBe(readmeTip);
        expect(gitSync(checkout, ["rev-parse", `refs/heads/${app.branch}`])).toBe(appCommit);
        // The resident's copy of that branch stays where the resident has it.
        expect(gitSync(s.clone, ["rev-parse", `refs/heads/${readme.branch}`])).toBe(readmeTip);
        expect(gitDirState(s.clone)).toBe(cloneGitDir);
        expectResidentFilesUntouched(s.clone);

        // A second pass moves nothing.
        await daemonPass(f);
        expect(moves(f)).toHaveLength(1);
        expect(await registeredCheckout(f, s)).toBe(checkout);
        // A retried activation naming the clone gets the registration as it stands.
        const retried = await cp.repositories.register({ checkoutPath: s.clone, projectId: s.projectId, repositoryRole: "primary", activeManifestDigest: cp.repositories.byIdentity(IDENTITY)!.activeManifestDigest, identity: IDENTITY });
        expect(retried).toMatchObject({ allowed: true, value: { checkoutPath: checkout } });
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("W3: freeze still integrates every task commit made in the worker clone; the candidate is fresh against it and verification passes on it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-w3", [APP, README]);
      becomeResident(f, s);
      residentWrites(s.clone);
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        expect(checkout).not.toBe(s.clone);
        const workerDev = gitSync(checkout, ["rev-parse", "refs/heads/dev"]);
        // The resident advances its own dev after the worker clone was created. Task branches must use
        // this exact recorded pin as their candidate base without moving the worker clone's stale dev ref.
        writeFiles(s.clone, { "docs/resident.md": "# resident base commit\n" });
        residentGit(s.clone, ["add", "docs/resident.md"]);
        residentGit(s.clone, ["commit", "-q", "-m", "resident advances the task base"]);
        const residentDev = residentGit(s.clone, ["rev-parse", "refs/heads/dev"]);
        expect(workerDev).not.toBe(residentDev);
        const results: Record<string, string> = {};
        for (const [key, script] of [
          ["app", { writes: { "src/app.js": "module.exports = () => 2;\n" } }],
          ["readme", { writes: { "README.md": "# task one\n" } }],
        ] as const) {
          const target = await provision(f, s, s.ids[key]!);
          const { ran, execution } = await turn(f, s, worker, s.ids[key]!, await claim(f, s, target, checkout), script);
          expect(ran, JSON.stringify(ran).slice(0, 800)).toMatchObject({ ok: true });
          expect(execution!.status).toBe("SUCCEEDED");
          results[key] = gitSync(checkout, ["rev-parse", `refs/heads/${target.branch}`]);
          await release(f, s);
        }

        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence).slice(0, 600)}`);
        const repo = frozen.value.repositories[0]!;
        expect(repo.baseHead).toBe(residentDev);
        expect(repo.baseHeadPinned).toBe(true);
        expect(isAncestor(checkout, results["app"]!, repo.candidateHead)).toBe(true);
        expect(isAncestor(checkout, results["readme"]!, repo.candidateHead)).toBe(true);
        expect(gitSync(checkout, ["show", `${repo.candidateHead}:docs/resident.md`])).toBe("# resident base commit");
        expect(gitSync(checkout, ["show", `${repo.candidateHead}:src/app.js`])).toBe("module.exports = () => 2;");
        expect(gitSync(checkout, ["show", `${repo.candidateHead}:README.md`])).toBe("# task one");
        expect(repo.touchedPaths).toEqual(["README.md", "src/app.js"]);
        expect((await verifySnapshotFreshness(frozen.value, [{ identity: IDENTITY, checkoutPath: checkout }])).allowed).toBe(true);
        // Candidate verification runs on the integrated commit, read from the worker clone.
        const run = cp.runs.require(s.runId);
        const manifest = cp.projects.manifest(run.pinnedManifestDigest!)!;
        const verified = await cp.verification.verify({ runId: s.runId, snapshot: frozen.value, commands: commandsForMode(manifest, run.executionMode), contractDigest: run.contractDigest });
        if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
        expect(verified.value.results.map((result) => [result.status, result.exactHead])).toEqual([["PASS", repo.candidateHead]]);
        // No registry row names the resident's clone any more; a candidate command is still denied it.
        const denied = (cp.verification as unknown as { denyReadPaths(own: string): string[] }).denyReadPaths(checkout);
        expect(denied).toEqual(expect.arrayContaining([checkout, s.clone]));
        // The resident's own edit to README.md is in neither commit nor the candidate.
        expectResidentFilesUntouched(s.clone);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });
});

/** Every freshness check a frozen candidate meets: verification's, the pipeline's own, and the CEO confirmation's. */
const freshnessChecks = (f: BootstrapRuntimeFixture, s: StandardRun, snapshot: CandidateSnapshot) => {
  const cp = f.harness.cp;
  const run = cp.runs.require(s.runId);
  const commands = commandsForMode(cp.projects.manifest(run.pinnedManifestDigest!)!, run.executionMode);
  type Answer = { allowed: boolean; reasonCode?: string; evidence?: Record<string, unknown> };
  return {
    verify: async (): Promise<Answer> =>
      (await cp.verification.verify({ runId: s.runId, snapshot, commands, contractDigest: run.contractDigest })) as Answer,
    pipeline: (): Promise<Answer> =>
      (cp.pipeline as unknown as { assertStillFresh(snapshot: CandidateSnapshot): Promise<Answer> }).assertStillFresh(snapshot),
    confirm: (): Answer =>
      (cp.ceo as unknown as { revalidateCandidateFreshness(runId: string, digest: string): Answer })
        .revalidateCandidateFreshness(s.runId, candidateSnapshotDigest(snapshot)),
  };
};

/** A git dir's refs and FETCH_HEAD: what a read-only check must leave exactly as it found them. */
const refsAndFetchHead = (repo: string): string => {
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  return `${gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])}\nFETCH_HEAD ${existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : "absent"}`;
};

describe("#1227 review r2 (PR #1256, D-P2): candidate freshness reads the resident's base", () => {
  it("a candidate frozen in the worker clone goes stale when the resident commits on its dev: every freshness check refuses it, and none writes a ref or FETCH_HEAD in either clone", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { s, checkout, target, claimId } = await migratedWithClaim(f, "resident-p2");
      const worker = workerDoing(f);
      try {
        const { execution } = await turn(f, s, worker, s.ids["app"]!, claimId, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(execution!.status).toBe("SUCCEEDED");
        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        const snapshot = frozen.value;
        expect(snapshot.repositories[0]).toMatchObject({ baseBranch: "dev", baseHead: target.baseSha, baseHeadPinned: true });
        const checks = freshnessChecks(f, s, snapshot);
        // Fresh while the resident's dev is the base the candidate was made from.
        expect(await checks.verify()).toMatchObject({ allowed: true });
        expect(await checks.pipeline()).toMatchObject({ allowed: true });
        expect(checks.confirm()).toMatchObject({ allowed: true });

        // The resident commits a README change on its own dev.
        writeFileSync(join(s.clone, "README.md"), "# the resident moved its base\n");
        residentGit(s.clone, ["commit", "-q", "-am", "the resident's base moves"]);
        const movedBase = residentGit(s.clone, ["rev-parse", "refs/heads/dev"]);
        expect(movedBase).not.toBe(target.baseSha);
        const before = { resident: gitDirState(s.clone), worker: refsAndFetchHead(checkout) };

        // The candidate keeps the old README, and every freshness check now refuses it as stale.
        expect(gitSync(checkout, ["show", `${snapshot.repositories[0]!.candidateHead}:README.md`])).toBe("# fixture project");
        const drift = expect.objectContaining({ identity: IDENTITY, baseBranch: "dev", expectedBaseHead: target.baseSha, observedBaseHead: movedBase });
        const verified = await checks.verify();
        expect(verified).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
        expect(verified.evidence?.["drift"]).toEqual([drift]);
        const pipeline = await checks.pipeline();
        expect(pipeline).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
        expect(pipeline.evidence?.["drift"]).toEqual([drift]);
        const confirmed = checks.confirm();
        expect(confirmed).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
        expect(confirmed.evidence?.["drift"]).toEqual([expect.objectContaining({ identity: IDENTITY, expectedBaseHead: target.baseSha, observedBaseHead: movedBase })]);
        // The worker clone alone, as a probe that names no resident clone reads it, is unchanged: its pin is still readable.
        expect((await verifySnapshotFreshness(snapshot, [{ identity: IDENTITY, checkoutPath: checkout }])).allowed).toBe(true);

        // Read only: nothing in the resident's git dir, and no ref or FETCH_HEAD in the worker clone's, was written.
        expect(gitDirState(s.clone)).toBe(before.resident);
        expect(refsAndFetchHead(checkout)).toBe(before.worker);
        expect(gitSync(checkout, ["rev-parse", "refs/heads/dev"])).toBe(target.baseSha);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("the CEO confirmation reads the base where freshness does: a resident's dev that advanced before the run is the candidate's base, not drift", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-p2-confirm", [APP]);
      becomeResident(f, s);
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        const workerDev = gitSync(checkout, ["rev-parse", "refs/heads/dev"]);
        writeFiles(s.clone, { "docs/resident.md": "# resident base commit\n" });
        residentGit(s.clone, ["add", "docs/resident.md"]);
        residentGit(s.clone, ["commit", "-q", "-m", "resident advances the task base"]);
        const residentDev = residentGit(s.clone, ["rev-parse", "refs/heads/dev"]);
        const target = await provision(f, s, s.ids["app"]!);
        const { execution } = await turn(f, s, worker, s.ids["app"]!, await claim(f, s, target, checkout), { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(execution!.status).toBe("SUCCEEDED");
        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        expect(frozen.value.repositories[0]).toMatchObject({ baseHead: residentDev, baseHeadPinned: true });
        // The worker clone's own dev stays where the clone was made; it is not the current base.
        expect(gitSync(checkout, ["rev-parse", "refs/heads/dev"])).toBe(workerDev);
        const checks = freshnessChecks(f, s, frozen.value);
        expect(await checks.pipeline()).toMatchObject({ allowed: true });
        expect(checks.confirm()).toMatchObject({ allowed: true });
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });
});

describe("#1227 review (PR #1256): the resident's git activity does not reach a worker turn", () => {
  it("R1: the resident commits in its clone during a worker turn, and the turn succeeds", async () => {
    await withBootstrapRuntime(async (f) => {
      const { s, checkout, target, claimId } = await migratedWithClaim(f, "resident-r1");
      const worker = workerDoing(f);
      try {
        const before = gitSync(s.clone, ["rev-parse", "HEAD"]);
        const { ran, execution, diagnostics } = await turn(f, s, worker, s.ids["app"]!, claimId, {
          writes: { "src/app.js": "module.exports = () => 2;\n" },
          whileLatched: () => {
            residentGit(s.clone, ["commit", "-q", "--allow-empty", "-m", "the resident commits mid-turn"]);
          },
        });
        expect(ran).toMatchObject({ ok: true });
        expect({ status: execution!.status, reason: diagnostics["reason"] ?? null }).toEqual({ status: "SUCCEEDED", reason: null });
        expect(gitSync(s.clone, ["rev-parse", "HEAD^"])).toBe(before);
        expect(gitSync(checkout, ["rev-parse", `refs/heads/${target.branch}^`])).toBe(target.baseSha);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("R2: the resident fetches origin in its clone during a worker turn, and the turn succeeds", async () => {
    await withBootstrapRuntime(async (f) => {
      const { s, checkout, target, claimId } = await migratedWithClaim(f, "resident-r2");
      // The repository's remote, stood in by a local bare repository one commit ahead of the clone.
      const remote = join(realpathSync(tempDir("acp-resident-remote-")), "fixture.git");
      gitSync(dirname(remote), ["clone", "-q", "--bare", s.clone, remote]);
      const ahead = join(dirname(remote), "ahead");
      gitSync(dirname(remote), ["clone", "-q", remote, ahead]);
      gitSync(ahead, ["commit", "-q", "--allow-empty", "-m", "upstream moved"]);
      gitSync(ahead, ["push", "-q", "origin", "HEAD:dev"]);
      const upstream = gitSync(remote, ["rev-parse", "refs/heads/dev"]);
      const worker = workerDoing(f);
      try {
        const { ran, execution, diagnostics } = await turn(f, s, worker, s.ids["app"]!, claimId, {
          writes: { "src/app.js": "module.exports = () => 2;\n" },
          whileLatched: () => {
            residentGit(s.clone, ["-c", `url.${remote}.insteadOf=${ORIGIN}`, "fetch", "-q", "origin"]);
          },
        });
        expect(ran).toMatchObject({ ok: true });
        expect({ status: execution!.status, reason: diagnostics["reason"] ?? null }).toEqual({ status: "SUCCEEDED", reason: null });
        expect(gitSync(s.clone, ["rev-parse", "refs/remotes/origin/dev"])).toBe(upstream);
        expect(gitSync(checkout, ["rev-parse", `refs/heads/${target.branch}^`])).toBe(target.baseSha);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  for (const [name, write, named] of [
    ["config", (checkout: string) => gitSync(checkout, ["config", "--local", "acp.stray", "1"]), [{ change: "changed", root: "gitDir", path: "config", kind: "file" }]],
    ["a ref", (checkout: string) => gitSync(checkout, ["update-ref", "refs/heads/stray", "HEAD"]), [{ change: "added", root: "gitDir", path: "refs/heads/stray", kind: "file" }]],
    ["objects/info/alternates", (checkout: string) => writeFileSync(join(checkout, ".git", "objects", "info", "alternates"), `${join(checkout, "..", "elsewhere", "objects")}\n`), [
      { change: "added", root: "gitDir", path: "objects/info/alternates", kind: "file" },
    ]],
  ] as const) {
    it(`R3: a write to the worker clone's own ${name} during a turn is still refused GIT_DIR_CHANGED, named in the worker clone's own git dir`, async () => {
      await withBootstrapRuntime(async (f) => {
        const { s, checkout, claimId } = await migratedWithClaim(f, `resident-r3-${name.replace(/[^a-z]/g, "")}`);
        mkdirSync(join(checkout, ".git", "objects", "info"), { recursive: true });
        const worker = workerDoing(f);
        try {
          const { execution, diagnostics } = await turn(f, s, worker, s.ids["app"]!, claimId, {
            writes: { "src/app.js": "module.exports = () => 2;\n" },
            whileLatched: () => {
              write(checkout);
            },
          });
          expect({ status: execution!.status, reason: diagnostics["reason"] }).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
          expect(diagnostics["gitDirChanges"]).toEqual(expect.arrayContaining([...named]));
          expect(diagnostics["gitDirChangeCount"]).toBe((diagnostics["gitDirChanges"] as unknown[]).length);
        } finally {
          worker.killAll();
        }
      }, { repoPath: residentClone() });
    });
  }

  it("the resident has a branch of a task's name in its own clone; the worker clone's turn on that task is not affected, and neither clone's branch moves the other's", async () => {
    await withBootstrapRuntime(async (f) => {
      const { s, checkout, target, claimId } = await migratedWithClaim(f, "resident-own-branch");
      residentGit(s.clone, ["switch", "-q", "-c", target.branch]);
      residentGit(s.clone, ["commit", "-q", "--allow-empty", "-m", "the resident's own work on that name"]);
      const residentTip = gitSync(s.clone, ["rev-parse", "HEAD"]);
      const worker = workerDoing(f);
      try {
        const { execution } = await turn(f, s, worker, s.ids["app"]!, claimId, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(execution!.status).toBe("SUCCEEDED");
        expect(gitSync(checkout, ["rev-parse", `refs/heads/${target.branch}^`])).toBe(target.baseSha);
        expect(gitSync(s.clone, ["rev-parse", `refs/heads/${target.branch}`])).toBe(residentTip);
        expect(headRef(s.clone)).toBe(`refs/heads/${target.branch}`);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });
});

describe("#1227 the move refuses, recovers, and a refused move keeps worker turns out of the resident's cwd", () => {
  it("a path the control plane did not make is left as it is, the refusal is recorded once, and a turn in the clone is refused with nothing launched", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-occupied", [APP]);
      becomeResident(f, s);
      const occupied = join(dirname(s.clone), ".acp-worker-checkouts", s.repositoryId);
      mkdirSync(occupied, { recursive: true });
      writeFileSync(join(occupied, "keep.txt"), "not the control plane's\n");
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        await daemonPass(f);
        expect(cp.repositories.byIdentity(IDENTITY)!.checkoutPath).toBe(s.clone);
        expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("not the control plane's\n");
        expect(cp.audit.byKind("REPOSITORY_CHECKOUT_MOVE_REFUSED")).toHaveLength(1);
        expect(moves(f)).toEqual([]);

        const target = await provision(f, s, s.ids["app"]!);
        const refused = await turn(f, s, worker, s.ids["app"]!, await claim(f, s, target, s.clone), {});
        expect(refused.ran).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(JSON.stringify(refused.ran)).toContain("resident CTO's working directory");
        expect(worker.launches).toBe(0);
        expect(cp.tasks.executions(s.runId)).toEqual([]);
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("a worker clone an earlier pass made, whose registration never moved, is taken as it is", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-adopt", [APP]);
      becomeResident(f, s);
      await daemonPass(f);
      const checkout = cp.repositories.byIdentity(IDENTITY)!.checkoutPath;
      // The pass stopped after the clone was renamed into place and before the registry moved.
      cp.db.run(`UPDATE repositories SET checkout_path = ? WHERE repository_id = ?`, [s.clone, s.repositoryId]);
      const inode = statSync(join(checkout, ".git")).ino;
      await daemonPass(f);
      expect(cp.repositories.byIdentity(IDENTITY)!.checkoutPath).toBe(checkout);
      expect(statSync(join(checkout, ".git")).ino).toBe(inode);
      expect(moves(f)).toHaveLength(2);
      expect(readdirSync(dirname(checkout))).toEqual([s.repositoryId]);
    }, { repoPath: residentClone() });
  });
});

describe("#1227 the cron lock is no longer passed over", () => {
  it("a Claude Code cron lock in a worker checkout itself is untracked agent configuration, and refuses the turn like any other", async () => {
    const world = seedWorkerWorld(makeCore());
    gitSync(world.repoPath, ["config", "core.excludesFile", "/dev/null"]);
    mkdirSync(join(world.repoPath, ".claude"), { recursive: true });
    writeFileSync(join(world.repoPath, LOCK), LOCK_BYTES);
    const adapter = new FakeWorkerAdapter(world.broker);
    try {
      const runner = new WorkerTurnRunner(
        { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
        { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
      );
      const started = await runner.start({
        runId: world.runId,
        taskId: world.taskId,
        claimId: world.claimId,
        ownerSessionId: world.cto.sessionId,
        ownerBindingGeneration: world.cto.generation,
      });
      expect(started).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      if (started.allowed) return;
      expect(started.evidence["paths"]).toContain(LOCK);
      expect(adapter.launches).toBe(0);
      expect(readFileSync(join(world.repoPath, LOCK), "utf8")).toBe(LOCK_BYTES);
    } finally {
      adapter.killAll();
    }
  });
});
