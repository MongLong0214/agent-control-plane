import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commandsForMode } from "../../src/contracts/manifest.ts";
import type * as Ids from "../../src/core/ids.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { integrationOrder, pathConflicts, type TaskResult } from "../../src/run/candidate-integration.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { candidateSnapshotDigest, verifySnapshotFreshness } from "../../src/snapshot/candidate-snapshot.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

/**
 * S6-C — a STANDARD_WORK run whose tasks each worked on their own branch at the run's pinned base
 * (S-TB) freezes every SUCCEEDED task's result, not only the branch its checkout was left on.
 *
 * Over the real CTO MCP socket, the real claim registry, guard, worker runner, pipeline and
 * verification engine, in scratch repositories only. Stood in: the WORKER provider and its capacity
 * admission, and (for the dependency case only) which task ids the task graph mints, so the stable
 * key and the dependency order disagree by construction.
 */

const seeded = vi.hoisted(() => ({ taskIds: [] as string[] }));
vi.mock("../../src/core/ids.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Ids>();
  return {
    ...actual,
    newTaskId: () => (seeded.taskIds.shift() ?? actual.newTaskId()) as ReturnType<typeof actual.newTaskId>,
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  seeded.taskIds.length = 0;
});

const PURPOSE = "candidate-integration";

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  declaredParent: string;
  baseSha: string;
}

interface TaskInput {
  key: string;
  title: string;
  category: "docs" | "implementation";
  dependsOn?: string[];
  spec: Record<string, unknown>;
}

const README = { key: "readme", title: "update readme", category: "docs" as const, spec: { writeTarget: { paths: ["README.md"] } } };
const APP = { key: "app", title: "update app", category: "implementation" as const, spec: { writeTarget: { paths: ["src/app.js"] } } };

/** A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, its tasks submitted, the real worker path. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string, tasks: TaskInput[], taskIds: string[] = []) => {
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
  seeded.taskIds.push(...taskIds);
  const submitted = cp.tasks.submit(runId, tasks);
  if (!submitted.allowed) throw new Error(submitted.message);
  expect(seeded.taskIds, "every seeded task id was minted by this submission").toEqual([]);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  const ids = Object.fromEntries(tasks.map((task, index) => [task.key, submitted.value[index]!.taskId]));
  return { runId, sessionId, ids, repo: f.harness.repoPath, checkoutPath: repository.checkout_path, projectId };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

/** The WORKER provider stood in by a fake that writes what its script says, through the real guard broker. */
const workerDoing = (f: BootstrapRuntimeFixture): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

/** Provisions, claims, runs one task to its end with `script`, and releases the run's claims. */
const runToSuccess = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, script: FakeTurnScript) => {
  worker.script = script;
  const provisioned = await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });
  expect(provisioned).toMatchObject({ ok: true });
  const target = (provisioned["value"] as { writeTarget: WriteTarget }).writeTarget;
  const claimed = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });
  expect(claimed).toMatchObject({ ok: true });
  const claimId = (claimed["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims.find((claim) => claim.worktreeId !== null)!.claimId;
  const ran = await f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });
  expect(ran).toMatchObject({ ok: true });
  const executionId = (ran["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  expect(f.harness.cp.tasks.execution(executionId)?.status).toBe("SUCCEEDED");
  expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
  return { target, commit: gitSync(s.repo, ["rev-parse", `refs/heads/${target.branch}`]) };
};

const refsOf = (repo: string): string => gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
const worktreesOf = (repo: string): string => gitSync(repo, ["worktree", "list", "--porcelain"]);
const objectsOf = (repo: string): string => gitSync(repo, ["count-objects", "-v"]);
const fileAt = (repo: string, commit: string, path: string): string => gitSync(repo, ["show", `${commit}:${path}`]);
const isAncestor = (repo: string, ancestor: string, of: string): boolean => {
  try {
    gitSync(repo, ["merge-base", "--is-ancestor", ancestor, of]);
    return true;
  } catch {
    return false;
  }
};
const integrationWorktrees = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.db.all<{ state: string; worktree_path: string }>(
    `SELECT state, worktree_path FROM verification_worktrees WHERE run_id = ? AND command_id = ?`,
    [runId, PURPOSE],
  );
const managedTrees = (f: BootstrapRuntimeFixture): string[] => {
  const root = join(f.harness.root, "worktrees");
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith(PURPOSE)) : [];
};

describe("a multi-task candidate is every SUCCEEDED task's result on the pinned base (S6-C)", () => {
  it("two independent tasks: the candidate holds both changes, verification passes on it rather than on the checkout, nothing is moved or left, and a second freeze is the same candidate", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s6c-two", [README, APP]);
      const worker = workerDoing(f);
      try {
        // The app task first, so the checkout is left on the README task's branch, where app() is 1.
        const app = await runToSuccess(f, s, worker, s.ids["app"]!, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        const readme = await runToSuccess(f, s, worker, s.ids["readme"]!, { writes: { "README.md": "# task one\n" } });
        expect(readme.target.baseSha).toBe(app.target.baseSha);
        const head = gitSync(s.repo, ["rev-parse", "HEAD"]);
        expect(head).toBe(readme.commit);
        const branch = gitSync(s.repo, ["symbolic-ref", "--short", "HEAD"]);
        const refsBefore = refsOf(s.repo);
        const worktreesBefore = worktreesOf(s.repo);

        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        const repo = frozen.value.repositories[0]!;
        const order = [s.ids["app"]!, s.ids["readme"]!].sort();
        const commitOf = (taskId: string) => (taskId === s.ids["app"] ? app.commit : readme.commit);
        // Both changes, each task commit an ancestor, joined by one merge in task-id order.
        expect(fileAt(s.repo, repo.candidateHead, "README.md")).toBe("# task one");
        expect(fileAt(s.repo, repo.candidateHead, "src/app.js")).toBe("module.exports = () => 2;");
        expect(repo.integration).toEqual({ checkoutHead: head, tasks: order.map((taskId) => ({ taskId, commit: commitOf(taskId) })) });
        expect(repo.candidateHead).not.toBe(head);
        expect(isAncestor(s.repo, app.commit, repo.candidateHead)).toBe(true);
        expect(isAncestor(s.repo, readme.commit, repo.candidateHead)).toBe(true);
        expect(gitSync(s.repo, ["rev-list", "--parents", "-n", "1", repo.candidateHead]).split(" ").slice(1)).toEqual(order.map(commitOf));
        expect(repo.touchedPaths).toEqual(["README.md", "src/app.js"]);
        // The origin is the tasks' recorded one (S-TB-06).
        expect({ sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead }).toEqual({ sourceBranch: app.target.declaredParent, sourceHead: app.target.baseSha });
        // Task refs, the checkout, its branch and its worktrees are exactly as they were (S-TB-02).
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(gitSync(s.repo, ["rev-parse", "HEAD"])).toBe(head);
        expect(gitSync(s.repo, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
        expect(gitSync(s.repo, ["status", "--porcelain"])).toBe("");
        expect(worktreesOf(s.repo)).toBe(worktreesBefore);
        expect(integrationWorktrees(f, s.runId).map((row) => row.state)).toEqual(["DESTROYED"]);
        expect(managedTrees(f)).toEqual([]);
        expect(cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId).at(-1)?.evidence["repositories"]).toEqual([
          { identity: repo.identity, candidateHead: repo.candidateHead, sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead, files: 2, integratedTasks: 2 },
        ]);

        // The same inputs freeze to the same commit and the same digest.
        const again = await cp.pipeline.freeze(s.runId);
        if (!again.allowed) throw new Error(`${again.reasonCode}: ${again.message}`);
        expect(again.value.repositories[0]!.candidateHead).toBe(repo.candidateHead);
        expect(candidateSnapshotDigest(again.value)).toBe(candidateSnapshotDigest(frozen.value));

        // Fresh against the checkout as it stands, and verification judges the integrated commit: the
        // checkout's HEAD has app() === 1 and would fail the fixture's verify.js.
        expect((await verifySnapshotFreshness(again.value, [{ identity: repo.identity, checkoutPath: s.checkoutPath }])).allowed).toBe(true);
        expect(fileAt(s.repo, head, "src/app.js")).toBe("module.exports = () => 1;");
        const run = cp.runs.require(s.runId);
        const manifest = cp.projects.manifest(run.pinnedManifestDigest!)!;
        const verified = await cp.verification.verify({ runId: s.runId, snapshot: again.value, commands: commandsForMode(manifest, run.executionMode), contractDigest: run.contractDigest });
        if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
        expect(verified.value.results.map((result) => [result.status, result.exactHead])).toEqual([["PASS", repo.candidateHead]]);

        // A later commit on the checkout stales it.
        gitSync(s.repo, ["commit", "-q", "--allow-empty", "-m", "user commit"]);
        expect(await verifySnapshotFreshness(again.value, [{ identity: repo.identity, checkoutPath: s.checkoutPath }])).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
      } finally {
        worker.killAll();
      }
    });
  });

  it("a task is integrated after every task it depends on, even when its task id sorts first", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const dependent = "task_000000000000000000000000";
      const dependency = "task_ffffffffffffffffffffffff";
      const s = await standardRun(f, "s6c-order", [README, { ...APP, dependsOn: ["readme"] }], [dependency, dependent]);
      expect(s.ids).toEqual({ app: dependent, readme: dependency });
      const worker = workerDoing(f);
      try {
        const readme = await runToSuccess(f, s, worker, dependency, { writes: { "README.md": "# task one\n" } });
        const app = await runToSuccess(f, s, worker, dependent, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        const repo = frozen.value.repositories[0]!;
        // The dependency's commit is the first parent, the dependent's joins it.
        expect(gitSync(s.repo, ["rev-list", "--parents", "-n", "1", repo.candidateHead]).split(" ").slice(1)).toEqual([readme.commit, app.commit]);
        expect(repo.integration?.tasks).toEqual([{ taskId: dependency, commit: readme.commit }, { taskId: dependent, commit: app.commit }]);
      } finally {
        worker.killAll();
      }
    });
  });

  it("two tasks that change one path refuse the freeze by name, with nothing written, frozen or left behind", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s6c-conflict", [README, { ...README, key: "readme-again", title: "update readme again" }]);
      const worker = workerDoing(f);
      try {
        await runToSuccess(f, s, worker, s.ids["readme"]!, { writes: { "README.md": "# one\n" } });
        await runToSuccess(f, s, worker, s.ids["readme-again"]!, { writes: { "README.md": "# two\n" } });
        const refsBefore = refsOf(s.repo);
        const worktreesBefore = worktreesOf(s.repo);
        const objectsBefore = objectsOf(s.repo);
        const frozen = await cp.pipeline.freeze(s.runId);
        expect(frozen.allowed).toBe(false);
        if (frozen.allowed) return;
        const pair = [s.ids["readme"]!, s.ids["readme-again"]!].sort();
        expect(frozen.reasonCode).toBe(ReasonCode.CONFLICT);
        expect(frozen.message).toContain(`${pair[0]} and ${pair[1]} both change README.md`);
        expect(frozen.evidence["conflicts"]).toEqual([{ tasks: pair, paths: ["README.md"] }]);
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(worktreesOf(s.repo)).toBe(worktreesBefore);
        expect(objectsOf(s.repo)).toBe(objectsBefore);
        expect(integrationWorktrees(f, s.runId)).toEqual([]);
        expect(managedTrees(f)).toEqual([]);
        expect(cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId)).toEqual([]);
        expect(cp.artifacts.latest(s.runId, ArtifactKind.CANDIDATE_SNAPSHOT)).toBeNull();
        expect(cp.runs.currentCandidate(s.runId)).toBeNull();
      } finally {
        worker.killAll();
      }
    });
  });

  it("a single-task run freezes its checkout's HEAD exactly as before, with no integration", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s6c-single", [APP]);
      const worker = workerDoing(f);
      try {
        const app = await runToSuccess(f, s, worker, s.ids["app"]!, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        const repo = frozen.value.repositories[0]!;
        expect(repo.candidateHead).toBe(app.commit);
        expect(repo.candidateHead).toBe(gitSync(s.repo, ["rev-parse", "HEAD"]));
        expect("integration" in repo).toBe(false);
        expect(integrationWorktrees(f, s.runId)).toEqual([]);
        expect(cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId).at(-1)?.evidence["repositories"]).toEqual([
          { identity: repo.identity, candidateHead: app.commit, sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead, files: 1 },
        ]);
      } finally {
        worker.killAll();
      }
    });
  });
});

describe("the integration order and its conflicts (S6-C)", () => {
  const result = (taskId: string): TaskResult => ({ taskId, title: taskId, commit: "0".repeat(40), declaredParent: "dev", baseSha: "1".repeat(40) });

  it("dependencies first through the whole graph, ties by task id; a cycle has no order", () => {
    const tasks = [
      { taskId: "task_a", dependsOn: ["task_x"] },
      { taskId: "task_m", dependsOn: [] },
      { taskId: "task_x", dependsOn: ["task_z"] },
      { taskId: "task_z", dependsOn: [] },
    ];
    // task_x is not a result here (another repository), but task_a still follows task_z through it.
    expect(integrationOrder(tasks, [result("task_a"), result("task_m"), result("task_z")])?.map((r) => r.taskId)).toEqual(["task_m", "task_z", "task_a"]);
    expect(integrationOrder([{ taskId: "task_b", dependsOn: [] }, { taskId: "task_a", dependsOn: [] }], [result("task_b"), result("task_a")])?.map((r) => r.taskId)).toEqual(["task_a", "task_b"]);
    expect(integrationOrder([{ taskId: "task_a", dependsOn: ["task_b"] }, { taskId: "task_b", dependsOn: ["task_a"] }], [result("task_a")])).toBeNull();
  });

  it("one path, or a path and one beneath it, collide; a shared prefix that is not a directory does not", () => {
    expect(pathConflicts([
      { taskId: "task_a", paths: ["README.md", "docs/guide", "lib"] },
      { taskId: "task_b", paths: ["README.md", "docs/guide/intro.md", "library.js"] },
      { taskId: "task_c", paths: ["src/app.js"] },
    ])).toEqual([{ tasks: ["task_a", "task_b"], paths: ["README.md", "docs/guide", "docs/guide/intro.md"] }]);
  });
});
