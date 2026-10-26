import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commandsForMode } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { verifySnapshotFreshness } from "../../src/snapshot/candidate-snapshot.ts";
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
 * linked worktree of the clone the daemon adds beside it and registers in its place, moving an
 * existing project's HELD claims and the task branch its clone stood on with it.
 *
 * Over the real CTO MCP socket, the real daemon pass, claim registry, guard, worker runner, pipeline and
 * verification engine, in scratch repositories only. Stood in: the WORKER provider and its capacity
 * admission, and the #1240 GitHub work-scope tracking a resident project's runs also pass through.
 * Literals stand for the new names, so a tree without them fails on behaviour, not on a missing export.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const IDENTITY = "github:acme/fixture";
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

/** One worker turn to its end; answers the execution, or the refusal of its start. */
const turn = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, claimId: string, script: FakeTurnScript) => {
  worker.script = script;
  const ran = await f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });
  if (ran["ok"] !== true) return { ran, execution: null };
  const executionId = (ran["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  return { ran, execution: f.harness.cp.tasks.execution(executionId)! };
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
const moves = (f: BootstrapRuntimeFixture) => f.harness.cp.audit.byKind(MOVED).map((row) => row.evidence);

describe("#1227 a resident's working directory never reaches a worker turn", () => {
  it("W1: the resident writes the cron lock and other files in its cwd; the worker turn runs in the dedicated checkout, succeeds, and none of them reach it or its commit", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "resident-w1", [APP]);
      becomeResident(f, s);
      residentWrites(s.clone);
      const statusBefore = gitSync(s.clone, ["status", "--porcelain", "--untracked-files=all"]);
      const base = gitSync(s.clone, ["rev-parse", "refs/heads/dev"]);
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        // The registered checkout, read back, is not the resident's cwd.
        expect(checkout).not.toBe(s.clone);
        expect(cp.repositories.byIdentity(IDENTITY)!.checkoutPath).toBe(checkout);
        expect(lstatSync(join(checkout, ".git")).isFile()).toBe(true);

        const target = await provision(f, s, s.ids["app"]!);
        const claimId = await claim(f, s, target, checkout);
        const { ran, execution } = await turn(f, s, worker, s.ids["app"]!, claimId, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(ran, JSON.stringify(ran).slice(0, 800)).toMatchObject({ ok: true });
        expect(execution!.status).toBe("SUCCEEDED");
        // Where the worker actually ran: the registered checkout, never the resident's cwd.
        expect(execution!.worktreeId).toBe(checkout);

        const commit = gitSync(s.clone, ["rev-parse", `refs/heads/${target.branch}`]);
        expect(gitSync(s.clone, ["rev-parse", `${commit}^`])).toBe(base);
        expect(gitSync(s.clone, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, commit])).toBe("src/app.js");
        expect(gitSync(s.clone, ["show", `${commit}:README.md`])).toBe("# fixture project");
        expect(gitSync(s.clone, ["ls-tree", "-r", "--name-only", commit])).not.toMatch(/\.claude|notes/);
        // The resident's tree is exactly as it left it, on its own branch; the worker's stands clean on the task's.
        expectResidentFilesUntouched(s.clone);
        expect(gitSync(s.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
        expect(headRef(s.clone)).toBe("refs/heads/dev");
        expect(gitSync(s.clone, ["rev-parse", "refs/heads/dev"])).toBe(base);
        expect(headRef(checkout)).toBe(`refs/heads/${target.branch}`);
        expect(gitSync(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
      } finally {
        worker.killAll();
      }
    }, { repoPath: residentClone() });
  });

  it("W2: an existing project worked on in the resident's clone is moved with its HELD claim and the task branch its clone stood on, and that branch is re-entered in the new checkout", async () => {
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

        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        expect(checkout).not.toBe(s.clone);
        expect(moves(f)).toEqual([expect.objectContaining({ identity: IDENTITY, branch: readme.branch, head: readmeTip, claimsMoved: 1 })]);
        // No ref moved; the clone's HEAD is detached where it stood, its files as the resident left them;
        // the worker checkout holds README's branch at the same commit, clean.
        expect(refsOf(s.clone)).toBe(refsBefore);
        expect(headRef(s.clone)).toBeNull();
        expect(gitSync(s.clone, ["rev-parse", "HEAD"])).toBe(readmeTip);
        expectResidentFilesUntouched(s.clone);
        expect(headRef(checkout)).toBe(`refs/heads/${readme.branch}`);
        expect(gitSync(checkout, ["rev-parse", "HEAD"])).toBe(readmeTip);
        expect(gitSync(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
        // The HELD claim followed the checkout.
        expect(cp.db.get<{ worktree_id: string }>(`SELECT worktree_id FROM resource_claims WHERE claim_id = ?`, [readmeClaim])!.worktree_id).toBe(checkout);

        // The earlier task's branch is re-entered by the same claim, and its turn commits on it.
        const again = await turn(f, s, worker, s.ids["readme"]!, readmeClaim, { writes: { "README.md": "# by the readme task\n" } });
        expect(again.ran, JSON.stringify(again.ran).slice(0, 800)).toMatchObject({ ok: true });
        expect(again.execution!.status).toBe("SUCCEEDED");
        expect(again.execution!.worktreeId).toBe(checkout);
        const readmeCommit = gitSync(s.clone, ["rev-parse", `refs/heads/${readme.branch}`]);
        expect(gitSync(s.clone, ["rev-parse", `${readmeCommit}^`])).toBe(readmeTip);
        expect(gitSync(s.clone, ["rev-parse", `refs/heads/${app.branch}`])).toBe(appCommit);
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

  it("W3: freeze still integrates every task commit made in the dedicated checkout; the candidate is fresh against it and verification passes on it", async () => {
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
        const results: Record<string, string> = {};
        for (const [key, script] of [
          ["app", { writes: { "src/app.js": "module.exports = () => 2;\n" } }],
          ["readme", { writes: { "README.md": "# task one\n" } }],
        ] as const) {
          const target = await provision(f, s, s.ids[key]!);
          const { ran, execution } = await turn(f, s, worker, s.ids[key]!, await claim(f, s, target, checkout), script);
          expect(ran, JSON.stringify(ran).slice(0, 800)).toMatchObject({ ok: true });
          expect(execution!.status).toBe("SUCCEEDED");
          results[key] = gitSync(s.clone, ["rev-parse", `refs/heads/${target.branch}`]);
          await release(f, s);
        }

        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence).slice(0, 600)}`);
        const repo = frozen.value.repositories[0]!;
        expect(isAncestor(s.clone, results["app"]!, repo.candidateHead)).toBe(true);
        expect(isAncestor(s.clone, results["readme"]!, repo.candidateHead)).toBe(true);
        expect(gitSync(s.clone, ["show", `${repo.candidateHead}:src/app.js`])).toBe("module.exports = () => 2;");
        expect(gitSync(s.clone, ["show", `${repo.candidateHead}:README.md`])).toBe("# task one");
        expect(repo.touchedPaths).toEqual(["README.md", "src/app.js"]);
        expect((await verifySnapshotFreshness(frozen.value, [{ identity: IDENTITY, checkoutPath: checkout }])).allowed).toBe(true);
        // Candidate verification runs on the integrated commit, read from the worker checkout.
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

describe("#1227 the move refuses, and a refused move keeps worker turns out of the resident's cwd", () => {
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

  it("a task branch the resident checked out in its clone is not checked out in the worker checkout as well; neither tree moves", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "resident-held-branch", [APP, README]);
      becomeResident(f, s);
      const worker = workerDoing(f);
      try {
        await daemonPass(f);
        const checkout = await registeredCheckout(f, s);
        // APP's first turn fails on its new branch; README's succeeds, taking the checkout off APP's.
        const app = await provision(f, s, s.ids["app"]!);
        const appClaim = await claim(f, s, app, checkout);
        expect((await turn(f, s, worker, s.ids["app"]!, appClaim, { exitCode: 1 })).execution!.status).not.toBe("SUCCEEDED");
        await release(f, s);
        const readme = await provision(f, s, s.ids["readme"]!);
        expect((await turn(f, s, worker, s.ids["readme"]!, await claim(f, s, readme, checkout), { writes: { "README.md": "# done\n" } })).execution!.status).toBe("SUCCEEDED");
        await release(f, s);
        // The resident checks APP's branch out in its own clone.
        gitSync(s.clone, ["switch", "-q", app.branch]);
        const before = { clone: gitSync(s.clone, ["rev-parse", "HEAD"]), checkout: gitSync(checkout, ["rev-parse", "HEAD"]), refs: refsOf(s.clone) };

        const refused = await turn(f, s, worker, s.ids["app"]!, await claim(f, s, app, checkout), { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        expect(refused.ran).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(JSON.stringify(refused.ran)).toContain("checked out in another worktree");
        expect(headRef(s.clone)).toBe(`refs/heads/${app.branch}`);
        expect(headRef(checkout)).toBe(`refs/heads/${readme.branch}`);
        expect({ clone: gitSync(s.clone, ["rev-parse", "HEAD"]), checkout: gitSync(checkout, ["rev-parse", "HEAD"]), refs: refsOf(s.clone) }).toEqual(before);
      } finally {
        worker.killAll();
      }
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
