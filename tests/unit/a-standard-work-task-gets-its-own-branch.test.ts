import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { BranchProfile } from "../../src/contracts/manifest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle } from "../../src/domain/types.ts";
import { classifyBranch, validateBranchContract } from "../../src/github/branch-contract.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #512 S-TB (CEO 0a16329c, f5879479) — a STANDARD_WORK task gets its own work branch, made by the
 * control plane:
 *
 * - one canonical write target per task (repository, branch, declared parent, paths, the run's pinned
 *   base commit) is recorded when its first worker is provisioned, into the task's spec that
 *   contract_get answers, and the claim and the runner name that same value;
 * - a task planned before the field existed (the live task_e959ee8b: a docs task, no writeTarget, a
 *   main-only repository) gets it the same way, derived from its contract's one declared file;
 * - the work branch's class is one policy point: `task/<id>-<slug>` from dev in a dev-bearing
 *   profile, `hotfix/<id>-<slug>` from main in a main-only one, anything else refused by name; the
 *   pair passes the branch contract the PR is checked against;
 * - before the first execution the branch is created at the pinned base, never at the base branch's
 *   moving name, as a guard-approved GIT_BRANCH write on a clean, owned checkout, and checked out; an
 *   existing branch of the same run and task is re-entered, a foreign or diverged one is refused and
 *   left as it is; a dirty checkout is refused with its change intact; the base branch is never
 *   written, nothing is pushed or forced.
 *
 * Over the real CTO MCP socket, the real claim registry, guard and worker runner, in scratch
 * repositories only. Stood in: the WORKER provider (the Claude double, which launches no process, so
 * a started execution ends FAILED) and its capacity admission. Literals stand for the new exports so
 * a tree without them fails on behaviour, not on a missing name.
 */

const RECORDED = "TASK_WRITE_TARGET_RECORDED";
const PREPARED = "TASK_BRANCH_PREPARED";
const CREATING = "TASK_BRANCH_CREATING";
const CREATED = "TASK_BRANCH_CREATED";
const UNDONE = "TASK_BRANCH_CREATION_UNDONE";
const POLICY = "WORK_BRANCH_POLICY";
const IDENTITY = "github:acme/fixture";

const DEV_BEARING: BranchProfile = fixtureManifest("profile").branchProfile;
const MAIN_ONLY: BranchProfile = { ...DEV_BEARING, longLived: ["main"], defaultBranch: "main" };

/** The task id in the branch classifier's id format: its letters and digits. */
const idOf = (taskId: string): string => taskId.replace(/[^A-Za-z0-9]/g, "");

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  declaredParent: string;
  baseSha: string;
}

const contractFor = (scope: string[]) => ({
  goal: "update the README",
  why: "one documentation change",
  scope,
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
});

interface TaskInput {
  key: string;
  title: string;
  category: "docs" | "implementation";
  spec?: Record<string, unknown>;
}

/**
 * A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, its tasks as its PLAN left them, and the real
 * worker path with only the provider and its capacity admission stood in.
 */
const standardRun = async (
  f: BootstrapRuntimeFixture,
  projectId: string,
  options: { tasks: TaskInput[]; profile?: BranchProfile; base?: string; scope?: string[] },
) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId, options.profile ? { branchProfile: options.profile } : {});
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
    contract: contractFor(options.scope ?? ["README.md"]),
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: options.base ?? "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, options.tasks.map((task) => ({ ...task, spec: task.spec ?? {} })));
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return {
    runId,
    sessionId,
    bootstrapRunId: bootstrap.runId,
    taskIds: submitted.value.map((task) => task.taskId),
    repo: f.harness.repoPath,
    checkoutPath: repository.checkout_path,
  };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const provision = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) =>
  f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });

const targetOf = (answer: Record<string, unknown>): WriteTarget =>
  (answer["value"] as { writeTarget: WriteTarget }).writeTarget;

const claimTarget = async (f: BootstrapRuntimeFixture, s: StandardRun, target: Pick<WriteTarget, "repositoryIdentity" | "branch" | "paths">) => {
  const answer = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });
  expect(answer).toMatchObject({ ok: true });
  return (answer["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims
    .find((claim) => claim.worktreeId !== null)!.claimId;
};

const runTask = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string, claimId: string, as: string = s.sessionId) =>
  f.cto(as, "task_worker_run", { runId: s.runId, taskId, claimId });

const settle = async (f: BootstrapRuntimeFixture, answer: Record<string, unknown>): Promise<string> => {
  const executionId = (answer["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  return executionId;
};

const refOf = (repo: string, ref: string): string | null => {
  try {
    return gitSync(repo, ["rev-parse", "--verify", "-q", ref]);
  } catch {
    return null;
  }
};
const branchOf = (repo: string): string => gitSync(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
const refsOf = (repo: string): string => gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const events = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
  f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId).map((row) => row.evidence);

const contractTasks = async (f: BootstrapRuntimeFixture, s: StandardRun) =>
  ((await f.cto(s.sessionId, "contract_get", { runId: s.runId }))["value"] as { tasks: Array<{ taskId: string; spec: Record<string, unknown> }> }).tasks;

/** The WORKER provider stood in by a fake that writes what its script says, through the real guard broker. */
const workerDoing = (f: BootstrapRuntimeFixture, script: FakeTurnScript): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  fake.script = script;
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

/** A WORKER bound the way staffing binds one, with no write target recorded: a task staffed before S-TB. */
const bindWorker = (f: BootstrapRuntimeFixture, runId: string, taskId: string): void => {
  const cp = f.harness.cp;
  const session = cp.sessions.create({ provider: "claude", model: "opus" });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test worker").allowed).toBe(true);
  const bound = cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, runId, taskId, projectId: cp.runs.require(runId).projectId });
  if (!bound.allowed) throw new Error(bound.message);
};

/** Provisions the task's worker and claims the write target the control plane recorded for it. */
const staffAndClaim = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) => {
  const provisioned = await provision(f, s, taskId);
  expect(provisioned).toMatchObject({ ok: true });
  const target = targetOf(provisioned);
  const claimId = await claimTarget(f, s, target);
  return { target, claimId };
};

describe("the one branch policy point (CEO f5879479)", () => {
  it("a dev-bearing profile gives task/<id>-<slug> from dev, a main-only one hotfix/<id>-<slug> to main, both passing the branch contract; any other profile or base is refused by name", async () => {
    const { deriveWorkBranch } = await import("../../src/run/task-write-target.ts");
    const taskId = "task_0123abcd4567";

    const dev = deriveWorkBranch({ taskId, title: "Update README.md", base: "dev", profile: DEV_BEARING });
    expect(dev).toMatchObject({ allowed: true, value: { branch: "task/task0123abcd4567-update-readme-md", declaredParent: "dev", branchClass: "task" } });
    if (!dev.allowed) throw new Error(dev.message);
    expect(classifyBranch(dev.value.branch, DEV_BEARING)).toEqual({ name: dev.value.branch, class: "task", identifier: idOf(taskId) });
    expect(validateBranchContract({ head: dev.value.branch, base: "dev", profile: DEV_BEARING, declaredParent: "dev" }).allowed).toBe(true);

    const main = deriveWorkBranch({ taskId, title: "Update README.md", base: "main", profile: MAIN_ONLY });
    expect(main).toMatchObject({ allowed: true, value: { branch: "hotfix/task0123abcd4567-update-readme-md", declaredParent: "main", branchClass: "hotfix" } });
    if (!main.allowed) throw new Error(main.message);
    expect(classifyBranch(main.value.branch, MAIN_ONLY)).toEqual({ name: main.value.branch, class: "hotfix", identifier: idOf(taskId) });
    expect(validateBranchContract({ head: main.value.branch, base: "main", profile: MAIN_ONLY, declaredParent: "main", sourceBranch: "main" }).allowed).toBe(true);
    // Why main-only is not task/*: the contract refuses main as a task branch's parent.
    expect(validateBranchContract({ head: "task/task0123abcd4567-update-readme-md", base: "main", profile: MAIN_ONLY, declaredParent: "main" }))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.PR_BRANCH_CONTRACT_VIOLATION });

    // Any other profile or base: refused, naming the policy point.
    // c98ea8a3 (S-TB-05): in a dev-bearing profile the parent is dev only; a feature or release base is
    // refused here, although the branch contract would accept either as a task branch's parent.
    expect(validateBranchContract({ head: "task/x-y", base: "release/1.2.3", profile: DEV_BEARING, declaredParent: "release/1.2.3" }).allowed).toBe(true);
    for (const [profile, base] of [
      [{ ...DEV_BEARING, defaultBranch: "main" }, "main"],
      [DEV_BEARING, "main"],
      [DEV_BEARING, "feature/123-parent"],
      [DEV_BEARING, "release/1.2.3"],
      [MAIN_ONLY, "dev"],
      [{ ...MAIN_ONLY, longLived: ["main", "trunk"] }, "main"],
    ] as Array<[BranchProfile, string]>) {
      const refused = deriveWorkBranch({ taskId, title: "x", base, profile });
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, evidence: { policy: POLICY } });
    }
    // A PLAN-declared branch is kept only inside the policy's class and the contract; never a long-lived one.
    expect(deriveWorkBranch({ taskId, title: "x", base: "dev", profile: DEV_BEARING, declared: "task/readme" }))
      .toMatchObject({ allowed: true, value: { branch: "task/readme", declaredParent: "dev" } });
    for (const declared of ["hotfix/readme-x", "dev", "main", "task/../dev", "feature/x-y"]) {
      expect(deriveWorkBranch({ taskId, title: "x", base: "dev", profile: DEV_BEARING, declared })).toMatchObject({ allowed: false });
    }
  });
});

describe("a STANDARD_WORK task with no prior branch", () => {
  it("the control plane records one canonical target, creates its branch at the pinned base on a clean, owned checkout through a guard-approved GIT_BRANCH, and a real claim and task_worker_run start an execution on it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-new", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { repositoryIdentity: IDENTITY, paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const dev = refOf(s.repo, "refs/heads/dev")!;
      const branch = `task/${idOf(taskId)}-update-readme-md`;
      expect(refOf(s.repo, `refs/heads/${branch}`)).toBeNull();

      const provisioned = await provision(f, s, taskId);
      const expected: WriteTarget = { repositoryIdentity: IDENTITY, branch, paths: ["README.md"], declaredParent: "dev", baseSha: dev };
      expect(provisioned).toMatchObject({ ok: true, value: { generation: 1, writeTarget: expected } });
      // One value: the provision answer, the task's spec that contract_get answers, and the audit record.
      expect((await contractTasks(f, s))[0]!.spec).toEqual({ writeTarget: expected });
      expect(events(f, RECORDED, s.runId)).toEqual([expect.objectContaining({
        taskId,
        writeTarget: expected,
        declared: { repositoryIdentity: IDENTITY, paths: ["README.md"] },
        policy: POLICY,
        branchClass: "task",
        baseBranch: "dev",
      })]);
      // Provisioning only records: no branch yet, the checkout untouched.
      expect(refOf(s.repo, `refs/heads/${branch}`)).toBeNull();
      expect(branchOf(s.repo)).toBe("dev");

      const claimId = await claimTarget(f, s, expected);
      const refsBefore = refsOf(s.repo);
      const ran = await runTask(f, s, taskId, claimId);
      expect(ran).toMatchObject({ ok: true });
      const executionId = await settle(f, ran);
      expect(cp.tasks.executions(s.runId)).toEqual([expect.objectContaining({ executionId, runtimeManaged: true })]);
      // Created at the pinned base and checked out; the base branch never written.
      expect(refOf(s.repo, `refs/heads/${branch}`)).toBe(dev);
      expect(branchOf(s.repo)).toBe(branch);
      expect(refOf(s.repo, "refs/heads/dev")).toBe(dev);
      expect(refsOf(s.repo).split("\n").filter((line) => !line.startsWith(`refs/heads/${branch} `)).join("\n")).toBe(refsBefore);
      expect(gitSync(s.repo, ["reflog", "-1", "--format=%gs", `refs/heads/${branch}`])).toBe("agent-control-plane: task branch");
      expect(gitSync(s.repo, ["remote"])).toBe("");
      expect(events(f, PREPARED, s.runId)).toEqual([expect.objectContaining({
        taskId, claimId, branch, baseSha: dev, head: dev, from: dev, fromBranch: "dev", created: true, checkedOut: false,
      })]);
      // The branch write went through the Managed Write Guard and was allowed there.
      expect(cp.audit.byKind("MANAGED_WRITE_GUARD").map((row) => row.evidence).filter((evidence) => evidence["operation"] === "GIT_BRANCH"))
        .toEqual([expect.objectContaining({ allowed: true, targetBranch: branch, taskId, repositoryIdentity: IDENTITY })]);
      // The claim the runner started under names exactly the recorded target.
      expect(cp.db.all(`SELECT branch, declared_path FROM resource_claims WHERE run_id = ? AND (branch IS NOT NULL OR declared_path IS NOT NULL) ORDER BY claim_id`, [s.runId]))
        .toEqual(expect.arrayContaining([{ branch, declared_path: null }, { branch: null, declared_path: "README.md" }]));
      expect(validateBranchContract({ head: branch, base: "dev", profile: DEV_BEARING, declaredParent: expected.declaredParent }).allowed).toBe(true);
    });
  });

  it("a claim that is not the recorded target is refused before anything is written: another branch, or other paths", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-claim", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { repositoryIdentity: IDENTITY, paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const target = targetOf(await provision(f, s, taskId));
      const refsBefore = refsOf(s.repo);
      const otherBranch = await claimTarget(f, s, { ...target, branch: `task/${idOf(taskId)}-elsewhere` });
      expect(await runTask(f, s, taskId, otherBranch)).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
      const otherPaths = await claimTarget(f, s, { ...target, paths: ["README.md", "src/app.js"] });
      expect(await runTask(f, s, taskId, otherPaths)).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(branchOf(s.repo)).toBe("dev");
      expect(f.harness.cp.tasks.executions(s.runId)).toEqual([]);
      expect(events(f, PREPARED, s.runId)).toEqual([]);
    });
  });
});

describe("a legacy task planned with no writeTarget (the task_e959ee8b shape)", () => {
  it("in a main-only repository: the derived target is recorded through task_worker_provision, the claim matches, and hotfix/<id>-<slug> is made from main", async () => {
    await withBootstrapRuntime(async (f) => {
      gitSync(f.harness.repoPath, ["checkout", "-q", "-b", "main"]);
      const s = await standardRun(f, "stb-legacy", {
        profile: MAIN_ONLY,
        base: "main",
        tasks: [{ key: "readme", title: "update README.md", category: "docs" }],
      });
      const taskId = s.taskIds[0]!;
      expect((await contractTasks(f, s))[0]!.spec).toEqual({});
      const main = refOf(s.repo, "refs/heads/main")!;
      const branch = `hotfix/${idOf(taskId)}-update-readme-md`;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      const expected: WriteTarget = { repositoryIdentity: IDENTITY, branch, paths: ["README.md"], declaredParent: "main", baseSha: main };
      expect(target).toEqual(expected);
      expect((await contractTasks(f, s))[0]!.spec).toEqual({ writeTarget: expected });
      expect(events(f, RECORDED, s.runId)).toEqual([expect.objectContaining({
        taskId,
        writeTarget: expected,
        declared: null,
        derived: ["baseSha", "branch", "declaredParent", "paths", "repositoryIdentity"],
        branchClass: "hotfix",
      })]);
      const ran = await runTask(f, s, taskId, claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(branchOf(s.repo)).toBe(branch);
      expect(refOf(s.repo, `refs/heads/${branch}`)).toBe(main);
      expect(refOf(s.repo, "refs/heads/main")).toBe(main);
      expect(f.harness.cp.tasks.executions(s.runId)).toHaveLength(1);
      expect(validateBranchContract({ head: branch, base: "main", profile: MAIN_ONLY, declaredParent: "main", sourceBranch: "main" }).allowed).toBe(true);
    });
  });

  it("a target that cannot be derived is refused by name and nothing is recorded: no paths and not docs, or a contract that declares more than one file", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-refuse", {
        scope: ["README.md", "docs/"],
        tasks: [
          { key: "impl", title: "implement", category: "implementation" },
          { key: "docs", title: "document", category: "docs" },
        ],
      });
      for (const taskId of s.taskIds) {
        const answer = await provision(f, s, taskId);
        expect(answer).toMatchObject({
          ok: true,
          value: { writeTarget: null, writeTargetRefused: { reasonCode: ReasonCode.INVALID_ARGUMENT } },
        });
      }
      expect((await contractTasks(f, s)).map((task) => task.spec)).toEqual([{}, {}]);
      expect(events(f, RECORDED, s.runId)).toEqual([]);
    });
  });
});

describe("the pinned base, not the base branch's name", () => {
  it("the base branch advanced after the pin: the branch is still made at the pinned commit, the checkout moved to it, the base branch left where it is; a later task of the run gets the same pin", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-moving", {
        tasks: [
          { key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
          { key: "app", title: "change app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
        ],
      });
      const [first, second] = s.taskIds as [string, string];
      const pinned = refOf(s.repo, "refs/heads/dev")!;
      const { target, claimId } = await staffAndClaim(f, s, first);
      expect(target.baseSha).toBe(pinned);
      // The base branch moves on: a commit on dev in the registered checkout, which stays clean.
      writeFiles(s.repo, { "README.md": "# moved on\n" });
      const advanced = commitAll(s.repo, "dev moves on");
      expect(advanced).not.toBe(pinned);
      expect(targetOf(await provision(f, s, second)).baseSha).toBe(pinned);

      const ran = await runTask(f, s, first, claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBe(pinned);
      expect(branchOf(s.repo)).toBe(target.branch);
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# fixture project\n");
      expect(refOf(s.repo, "refs/heads/dev")).toBe(advanced);
      expect(events(f, PREPARED, s.runId)).toEqual([expect.objectContaining({
        branch: target.branch, baseSha: pinned, head: pinned, from: advanced, fromBranch: "dev", created: true, checkedOut: true,
      })]);
    });
  });
});

describe("re-entry: the same run and task, or nothing", () => {
  it("a branch the control plane created for this run and task is re-entered, from the base branch or already checked out, with a commit this task's turn made on it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-reentry", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      // The first admission creates the branch, with its creation record, and starts an execution.
      const first = await runTask(f, s, taskId, claimId);
      expect(first).toMatchObject({ ok: true });
      await settle(f, first);
      // The intent before the create-only update, and its completion once the checkout stood clean on it.
      const creation = { taskId, repositoryIdentity: IDENTITY, branch: target.branch, baseSha: target.baseSha, worktreeId: expect.any(String), attemptId: expect.any(String) };
      expect(events(f, CREATING, s.runId)).toEqual([creation]);
      expect(events(f, CREATED, s.runId)).toEqual([creation]);
      // One attempt: the intent and its completion carry the same attempt id.
      expect(events(f, CREATED, s.runId)[0]!["attemptId"]).toBe(events(f, CREATING, s.runId)[0]!["attemptId"]);
      // A commit on it that this task's turn made, as its record names it; the checkout went back to dev.
      writeFiles(s.repo, { "README.md": "# by this task\n" });
      const ours = commitAll(s.repo, "this task's turn");
      gitSync(s.repo, ["checkout", "-q", "dev"]);
      cp.audit.record({ kind: "TASK_WORKER_TURN_SUCCEEDED", runId: s.runId, evidence: { taskId, executionId: "exec_earlier", commitHead: ours } });

      const ran = await runTask(f, s, taskId, claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(branchOf(s.repo)).toBe(target.branch);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBe(ours);
      expect(events(f, PREPARED, s.runId).slice(1)).toEqual([expect.objectContaining({ created: false, checkedOut: true, head: ours })]);

      // Already on it: re-entered with no branch write at all.
      const again = await runTask(f, s, taskId, claimId);
      expect(again).toMatchObject({ ok: true });
      await settle(f, again);
      expect(events(f, PREPARED, s.runId)).toHaveLength(2);
      expect(events(f, CREATING, s.runId)).toHaveLength(1);
      expect(events(f, CREATED, s.runId)).toHaveLength(1);
      expect(cp.tasks.executions(s.runId)).toHaveLength(3);
    });
  });

  it("a branch with the task's name made by anyone else at the pinned base, or the control plane's own carrying a foreign commit or another history, is refused and left exactly as it is", async () => {
    for (const shape of ["unrecorded", "foreign", "diverged"] as const) {
      await withBootstrapRuntime(async (f) => {
        const s = await standardRun(f, `stb-${shape}`, {
          tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        });
        const taskId = s.taskIds[0]!;
        const { target, claimId } = await staffAndClaim(f, s, taskId);
        if (shape === "unrecorded") {
          // c98ea8a3 (S-TB-03): its name and its SHA are right, and that is not ownership.
          gitSync(s.repo, ["branch", target.branch, target.baseSha]);
        } else {
          // The control plane's own branch first, through a real admission; then someone moves it.
          const first = await runTask(f, s, taskId, claimId);
          expect(first).toMatchObject({ ok: true });
          await settle(f, first);
          if (shape === "foreign") {
            writeFiles(s.repo, { "README.md": "# someone else\n" });
            commitAll(s.repo, "someone else's work");
            gitSync(s.repo, ["checkout", "-q", "dev"]);
          } else {
            gitSync(s.repo, ["checkout", "-q", "dev"]);
            const orphan = gitSync(s.repo, ["commit-tree", `${target.baseSha}^{tree}`, "-m", "unrelated history"]);
            gitSync(s.repo, ["update-ref", `refs/heads/${target.branch}`, orphan]);
          }
        }
        const executions = f.harness.cp.tasks.executions(s.runId).length;
        const prepared = events(f, PREPARED, s.runId).length;
        const refsBefore = refsOf(s.repo);
        const refused = await runTask(f, s, taskId, claimId);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(branchOf(s.repo)).toBe("dev");
        expect(f.harness.cp.tasks.executions(s.runId)).toHaveLength(executions);
        expect(events(f, PREPARED, s.runId)).toHaveLength(prepared);
      });
    }
  });
});

describe("a creation intent is never ownership (review r2, S-TB-03)", () => {
  it("an interrupted creation (its intent recorded, its ref there, no completion) is refused on re-entry by name and never adopted, from the base branch or checked out", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-interrupted", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      // What a crash between the create-only ref update and its completion leaves: the intent and the ref.
      cp.audit.record({ kind: CREATING, runId: s.runId, evidence: { taskId, repositoryIdentity: IDENTITY, branch: target.branch, baseSha: target.baseSha, worktreeId: s.checkoutPath } });
      gitSync(s.repo, ["branch", target.branch, target.baseSha]);
      for (const on of ["dev", target.branch]) {
        gitSync(s.repo, ["checkout", "-q", on]);
        const refsBefore = refsOf(s.repo);
        const refused = await runTask(f, s, taskId, claimId);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { creationAttempted: true } });
        expect(String(refused["message"])).toContain("never completed; it is not adopted");
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(branchOf(s.repo)).toBe(on);
      }
      expect(events(f, CREATED, s.runId)).toEqual([]);
      expect(cp.tasks.executions(s.runId)).toEqual([]);
    });
  });

  it("the hand-off reader trusts completions only: a branch with an intent and no completion is not left for the next task", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-intent-handoff", {
        tasks: [
          { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
          { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
        ],
      });
      const [one, two] = s.taskIds as [string, string];
      const first = targetOf(await provision(f, s, one));
      cp.audit.record({ kind: CREATING, runId: s.runId, evidence: { taskId: one, repositoryIdentity: IDENTITY, branch: first.branch, baseSha: first.baseSha, worktreeId: s.checkoutPath } });
      gitSync(s.repo, ["checkout", "-q", "-b", first.branch]);
      const second = await staffAndClaim(f, s, two);
      const refsBefore = refsOf(s.repo);
      expect(await runTask(f, s, two, second.claimId)).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(branchOf(s.repo)).toBe(first.branch);
      expect(refOf(s.repo, `refs/heads/${second.target.branch}`)).toBeNull();
    });
  });
});

describe("the hand-off between task branches (c98ea8a3, S-TB-02)", () => {
  it("two successive successful tasks in one checkout: the second leaves the first's finished branch for its own, at the pinned base, and the first's ref and commit stay exactly where they are", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-handoff", {
        tasks: [
          { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
          { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
        ],
      });
      const [one, two] = s.taskIds as [string, string];
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, ran))?.status).toBe("SUCCEEDED");
        const oneTip = refOf(s.repo, `refs/heads/${first.target.branch}`)!;
        expect(oneTip).not.toBe(first.target.baseSha);

        // S2 — no resource_release: the live CTO is never told to make one, and the first claim passes
        // to the second once the first execution has ended.
        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const second = await staffAndClaim(f, s, two);
        expect(second.target.baseSha).toBe(first.target.baseSha);
        const next = await runTask(f, s, two, second.claimId);
        expect(next).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, next))?.status).toBe("SUCCEEDED");
        expect(branchOf(s.repo)).toBe(second.target.branch);
        // The second task's commit sits on the pinned base, not on the first task's work.
        expect(refOf(s.repo, `refs/heads/${second.target.branch}^`)).toBe(second.target.baseSha);
        expect(refOf(s.repo, `refs/heads/${first.target.branch}`)).toBe(oneTip);
        expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# fixture project\n");
        expect(events(f, PREPARED, s.runId).at(-1)).toMatchObject({
          taskId: two,
          created: true,
          checkedOut: true,
          from: oneTip,
          fromBranch: first.target.branch,
          handoffFrom: { runId: s.runId, taskId: one, branch: first.target.branch },
        });
      } finally {
        worker.killAll();
      }
    });
  });

  it("a branch the control plane made for a task whose execution has not ended is not left; nothing is created or moved", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-handoff-running", {
        tasks: [
          { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
          { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
        ],
      });
      const [one, two] = s.taskIds as [string, string];
      const first = await staffAndClaim(f, s, one);
      const ran = await runTask(f, s, one, first.claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      // The first task runs again, by a receipt the CTO opened for it: its execution has not ended.
      const workerSession = cp.bindings.active(`WORKER:${one}`)!.sessionId;
      const open = cp.tasks.startExecution({ runId: s.runId, taskId: one, ownerBindingGeneration: 1, workerSessionId: workerSession, provider: "claude", model: "opus" });
      expect(open.allowed).toBe(true);
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
      const second = await staffAndClaim(f, s, two);
      const refsBefore = refsOf(s.repo);
      const refused = await runTask(f, s, two, second.claimId);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(branchOf(s.repo)).toBe(first.target.branch);
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(refOf(s.repo, `refs/heads/${second.target.branch}`)).toBeNull();
    });
  });
});

describe("an already-staffed task with no recorded target (c98ea8a3, S-TB-01)", () => {
  it("the daemon records a legacy task's derivable target before its continuation, and the claim and run go by it; a staffed task whose target cannot be derived is refused at the runner, whatever it claims", async () => {
    await withBootstrapRuntime(async (f) => {
      gitSync(f.harness.repoPath, ["checkout", "-q", "-b", "main"]);
      const s = await standardRun(f, "stb-staffed", {
        profile: MAIN_ONLY,
        base: "main",
        tasks: [
          { key: "readme", title: "update README.md", category: "docs" },
          { key: "impl", title: "implement", category: "implementation" },
        ],
      });
      const [legacy, underivable] = s.taskIds as [string, string];
      // Staffed before targets were recorded: bound the way staffing binds, with no recording.
      for (const taskId of s.taskIds) bindWorker(f, s.runId, taskId);
      expect(events(f, RECORDED, s.runId)).toEqual([]);
      const outcomes = await f.daemon.recordStandardWorkTargets();
      expect(outcomes).toHaveLength(2);
      expect(outcomes).toEqual(expect.arrayContaining([
        { runId: s.runId, taskId: legacy, recorded: true, reasonCode: ReasonCode.OK },
        { runId: s.runId, taskId: underivable, recorded: false, reasonCode: ReasonCode.INVALID_ARGUMENT },
      ]));
      // Recorded once; a refusal on the same inputs is not derived again.
      expect(await f.daemon.recordStandardWorkTargets()).toEqual([]);
      const main = refOf(s.repo, "refs/heads/main")!;
      const target = (await contractTasks(f, s)).find((task) => task.taskId === legacy)!.spec["writeTarget"] as WriteTarget;
      expect(target).toEqual({ repositoryIdentity: IDENTITY, branch: `hotfix/${idOf(legacy)}-update-readme-md`, paths: ["README.md"], declaredParent: "main", baseSha: main });
      const claimId = await claimTarget(f, s, target);
      const ran = await runTask(f, s, legacy, claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(branchOf(s.repo)).toBe(target.branch);
      gitSync(s.repo, ["checkout", "-q", "main"]);
      // The underivable one claims something arbitrary and is refused before anything is read or written.
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
      const arbitrary = await claimTarget(f, s, { repositoryIdentity: IDENTITY, branch: "task/arbitrary", paths: ["README.md"] });
      const refsBefore = refsOf(s.repo);
      expect(await runTask(f, s, underivable, arbitrary)).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(f.harness.cp.tasks.executions(s.runId).filter((execution) => execution.taskId === underivable)).toEqual([]);
    });
  });

  it("the runner records a staffed task's target from its PLAN before its first execution, and refuses a claim that is not that target", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-staffed-runner", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { repositoryIdentity: IDENTITY, paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      bindWorker(f, s.runId, taskId);
      const branch = `task/${idOf(taskId)}-update-readme-md`;
      const wrong = await claimTarget(f, s, { repositoryIdentity: IDENTITY, branch, paths: ["README.md", "src/app.js"] });
      expect(await runTask(f, s, taskId, wrong)).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      // The refusal still recorded the target, through the same derivation provisioning uses.
      expect(events(f, RECORDED, s.runId)).toEqual([expect.objectContaining({ taskId, writeTarget: expect.objectContaining({ branch, paths: ["README.md"] }) })]);
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
      const right = await claimTarget(f, s, { repositoryIdentity: IDENTITY, branch, paths: ["README.md"] });
      const ran = await runTask(f, s, taskId, right);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(branchOf(s.repo)).toBe(branch);
    });
  });
});

describe("the recorded lineage reaches the PR checks (c98ea8a3, S-TB-06)", () => {
  it.each([
    { profile: "dev-bearing", base: "dev", parent: "dev" },
    { profile: "main-only", base: "main", parent: "main" },
  ])("$profile: the base branch advances after the pin, the task commits atop the pin, and freeze, the finalizer's contract and the kernel's lineage check all carry the recorded parent and pinned commit", async ({ profile, base, parent }) => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      if (base === "main") gitSync(f.harness.repoPath, ["checkout", "-q", "-b", "main"]);
      const branchProfile = profile === "main-only" ? MAIN_ONLY : DEV_BEARING;
      const s = await standardRun(f, `stb-lineage-${base}`, {
        profile: branchProfile,
        base,
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      expect(target.declaredParent).toBe(parent);
      writeFiles(s.repo, { "README.md": `# ${base} moves on\n` });
      const advanced = commitAll(s.repo, `${base} moves on`);
      const worker = workerDoing(f, { writes: { "README.md": "# the task's change, on the pin\n" } });
      try {
        const ran = await runTask(f, s, taskId, claimId);
        expect(ran).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, ran))?.status).toBe("SUCCEEDED");
      } finally {
        worker.killAll();
      }
      expect(refOf(s.repo, `refs/heads/${target.branch}^`)).toBe(target.baseSha);
      expect(refOf(s.repo, `refs/heads/${base}`)).toBe(advanced);
      const frozen = await cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
      const repo = frozen.value.repositories[0]!;
      // Never the moving tip: the recorded parent and the pinned commit.
      expect({ sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead }).toEqual({ sourceBranch: parent, sourceHead: target.baseSha });
      // The finalizer passes the frozen origin as the declared parent (finalizer.ts).
      expect(validateBranchContract({ head: target.branch, base: repo.baseBranch, profile: branchProfile, declaredParent: repo.sourceBranch ?? null, sourceBranch: repo.sourceBranch ?? null }).allowed).toBe(true);
      // The GitHub kernel's frozen-lineage check, as PR preparation calls it.
      const kernel = cp.github as unknown as {
        assertFrozenSourceLineage(identity: string, head: string, profile: BranchProfile, declaredParent: string | null, candidate: CandidateSnapshot["repositories"][number]): Promise<unknown>;
      };
      expect(await kernel.assertFrozenSourceLineage(IDENTITY, target.branch, branchProfile, parent, repo))
        .toMatchObject({ allowed: true, value: { sourceBranch: parent, sourceHead: target.baseSha } });
    });
  });
});

describe("single-file evidence (c98ea8a3, S-TB-08)", () => {
  it("a docs task with no paths takes its contract's one scope entry only when the pinned base holds a regular file there: a directory or a missing path is refused, nothing recorded", async () => {
    for (const scope of [["src"], ["NOTES.md"]]) {
      await withBootstrapRuntime(async (f) => {
        const s = await standardRun(f, `stb-scope-${scope[0]!.replace(/\W/g, "")}`, { scope, tasks: [{ key: "docs", title: "document", category: "docs" }] });
        expect(await provision(f, s, s.taskIds[0]!)).toMatchObject({
          ok: true,
          value: { writeTarget: null, writeTargetRefused: { reasonCode: ReasonCode.INVALID_ARGUMENT } },
        });
        expect(events(f, RECORDED, s.runId)).toEqual([]);
      });
    }
  });

  // #512 (CEO 9a1f70bf) — the live legacy task: a prose contract scope, and the task's own spec.files.
  const prose = ["Improve one usage item in README.md so it matches the repository."];
  it("a legacy docs task with no writeTarget takes its own spec.files when it names exactly one regular file at the pinned base", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-legacy-files", { scope: prose, tasks: [{ key: "docs", title: "document", category: "docs", spec: { files: ["README.md"] } }] });
      expect(await provision(f, s, s.taskIds[0]!)).toMatchObject({ ok: true, value: { writeTarget: { paths: ["README.md"] } } });
      expect(events(f, RECORDED, s.runId)).toHaveLength(1);
    });
  });

  it("the spec.files fallback refuses several files, an escape, a directory, a declared writeTarget and a non-docs task, recording nothing", async () => {
    const cases: Array<{ name: string; category: "docs" | "implementation"; spec: Record<string, unknown> }> = [
      { name: "two-files", category: "docs", spec: { files: ["README.md", "NOTES.md"] } },
      { name: "escape", category: "docs", spec: { files: ["../README.md"] } },
      { name: "directory", category: "docs", spec: { files: ["src"] } },
      { name: "declared-target", category: "docs", spec: { files: ["README.md"], writeTarget: { branch: "task/x" } } },
      { name: "not-docs", category: "implementation", spec: { files: ["README.md"] } },
    ];
    for (const c of cases) {
      await withBootstrapRuntime(async (f) => {
        const s = await standardRun(f, `stb-legacy-${c.name}`, { scope: prose, tasks: [{ key: "t", title: "document", category: c.category, spec: c.spec }] });
        const result = await provision(f, s, s.taskIds[0]!);
        expect({ name: c.name, result }).toMatchObject({ name: c.name, result: { ok: true, value: { writeTarget: null } } });
        expect(events(f, RECORDED, s.runId)).toEqual([]);
      });
    }
  });
});

/** The git the tests' PATH resolves, found without running anything. */
const realGit = (): string => {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "git"))) return join(dir, "git");
  }
  throw new Error("no git on PATH");
};

/**
 * A git first on PATH that, the first time its arguments contain `match`, runs `before` (a shell line)
 * and then either runs the real git or exits 1 without it; every other call is the real git's.
 */
const gitOnce = (match: string, before: string, then: "run" | "fail"): { restore: () => void; fired: () => boolean } => {
  const bin = tempDir("acp-stb-git-");
  const fired = join(bin, "fired");
  const real = realGit();
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `case "$*" in *"${match}"*)`,
    `  if [ ! -e '${fired}' ]; then : > '${fired}'; ${before}; ${then === "fail" ? "exit 1" : ":"}; fi;;`,
    "esac",
    `exec '${real}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  return { restore: () => { process.env["PATH"] = path; }, fired: () => existsSync(fired) };
};

describe("every later failure of branch preparation leaves refs, HEAD and user bytes as they were (review r2, S-TB-07)", () => {
  type Case = {
    name: string;
    moved: boolean;
    match?: string;
    before?: (repo: string) => string;
    then?: "run" | "fail";
    record?: boolean;
    userFile: string;
    userBytes?: string;
    /** The refusal's own words, so each case is known to fail where it says, and whether a ref it made was removed. */
    says: string;
    created: boolean;
  };
  const edit = (repo: string): string => `printf '# a user edit, landed late\\n' > '${join(repo, "README.md")}'`;
  const notes = (repo: string): string => `printf 'user notes\\n' > '${join(repo, "notes.txt")}'`;
  const cases: Case[] = [
    { name: "the stat-cache refresh finds a file changed", moved: true, match: "update-index --refresh", before: edit, then: "run", userFile: "README.md", userBytes: "# a user edit, landed late\n", says: "the checkout's files changed before its task branch was made", created: false },
    { name: "read-tree refuses a file changed after the refresh", moved: true, match: "read-tree -m -u", before: edit, then: "run", userFile: "README.md", userBytes: "# a user edit, landed late\n", says: "could not be moved to the task's branch", created: true },
    { name: "HEAD cannot be put on the branch, after the files moved", moved: true, match: "task branch HEAD", before: () => ":", then: "fail", userFile: "README.md", says: "could not be put on the task's branch", created: true },
    { name: "HEAD cannot be put on the branch, with no file to move", moved: false, match: "task branch HEAD", before: () => ":", then: "fail", userFile: "README.md", says: "could not be put on the task's branch", created: true },
    { name: "a user file appears while the checkout is moved", moved: true, match: "task branch HEAD", before: notes, then: "run", userFile: "notes.txt", userBytes: "user notes\n", says: "changed while it was moved to the task's branch", created: true },
    { name: "a user file appears with no file to move", moved: false, match: "task branch HEAD", before: notes, then: "run", userFile: "notes.txt", userBytes: "user notes\n", says: "changed while it was moved to the task's branch", created: true },
    { name: "the completion cannot be recorded", moved: true, record: true, userFile: "README.md", says: "could not be recorded complete", created: true },
  ];
  it.each(cases)("$name", async (c) => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, `stb-late-${cases.indexOf(c)}`, {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      // Files must move when the base has advanced past the pin; none when it has not.
      if (c.moved) {
        writeFiles(s.repo, { "README.md": "# the base moved on\n" });
        commitAll(s.repo, "the base moves on");
      }
      const head = refOf(s.repo, "HEAD");
      const refsBefore = refsOf(s.repo);
      const readmeBefore = readFileSync(join(s.repo, "README.md"), "utf8");
      const wrapper = c.match ? gitOnce(c.match, c.before!(s.repo), c.then!) : null;
      if (c.record) {
        const record = cp.audit.record.bind(cp.audit);
        vi.spyOn(cp.audit, "record").mockImplementation((entry) =>
          entry.kind === CREATED ? deny(ReasonCode.AUDIT_WRITE_FAILED, "injected: the completion is not recorded", {}) : record(entry));
      }
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, taskId, claimId);
      } finally {
        wrapper?.restore();
      }
      if (wrapper) expect(wrapper.fired()).toBe(true);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(String(refused["message"])).toContain(c.says);
      if (c.created) expect(refused["evidence"]).toMatchObject({ created: true, refRemoved: true, leftOnBranch: false, headMoved: false, filesMoved: false });
      // Refs, HEAD and the user's bytes exactly as they were; the task's branch never left behind.
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
      expect(branchOf(s.repo)).toBe("dev");
      expect(refOf(s.repo, "HEAD")).toBe(head);
      if (c.userBytes) expect(readFileSync(join(s.repo, c.userFile), "utf8")).toBe(c.userBytes);
      else expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe(readmeBefore);
      expect(events(f, CREATED, s.runId)).toEqual([]);
      expect(events(f, PREPARED, s.runId)).toEqual([]);
      expect(cp.tasks.executions(s.runId)).toEqual([]);
    });
  });
});

/**
 * A git first on PATH whose behaviour per call is a shell `case` body: `script(real)` receives the real
 * git's path and returns the case arms; anything unmatched runs the real git.
 */
const gitScripted = (arms: (real: string) => string): { restore: () => void } => {
  const bin = tempDir("acp-stb-git-script-");
  const real = realGit();
  writeFileSync(join(bin, "git"), ["#!/bin/sh", 'case "$*" in', arms(real), "esac", `exec '${real}' "$@"`, ""].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  return { restore: () => { process.env["PATH"] = path; } };
};

describe("the undo verifies each step before it takes it, and names every step it could not take (review r3, S-TB-07)", () => {
  const oneTask = async (f: BootstrapRuntimeFixture, label: string, advance: boolean) => {
    const s = await standardRun(f, label, {
      tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
    });
    const taskId = s.taskIds[0]!;
    const claimed = await staffAndClaim(f, s, taskId);
    if (advance) {
      writeFiles(s.repo, { "README.md": "# the base moved on\n", "src/app.js": "module.exports = () => 9;\n" });
      commitAll(s.repo, "the base moves on");
    }
    return { ...s, taskId, ...claimed };
  };
  const blockersOf = (answer: Record<string, unknown>) => ((answer["evidence"] as { blockers?: Array<{ step: string; error: string; state: string; paths?: string[] }> }).blockers ?? []);

  it("(a) HEAD another writer selected during the switch is never moved, with the files moved too; the ref and files it stands beside are kept, and the step is named", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-head-elsewhere", true);
      gitSync(s.repo, ["branch", "user-selected", s.target.baseSha]);
      const git = gitScripted((real) => `  *"task branch HEAD"*) '${real}' "$@"; code=$?; '${real}' symbolic-ref HEAD refs/heads/user-selected; exit "$code";;`);
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
      }
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: false, headMoved: true, filesMoved: true, refRemoved: false } });
      expect(blockersOf(refused)).toEqual([expect.objectContaining({ step: "head-back", error: expect.stringContaining("refs/heads/user-selected") })]);
      expect(branchOf(s.repo)).toBe("user-selected");
      expect(refOf(s.repo, `refs/heads/${s.target.branch}`)).toBe(s.target.baseSha);
      expect(events(f, CREATED, s.runId)).toEqual([]);
    });
  });

  /** The blob a commit holds at a path. */
  const blobAt = (repo: string, commit: string, path: string): string => gitSync(repo, ["rev-parse", `${commit}:${path}`]);
  const recoveryOf = (answer: Record<string, unknown>) => (answer["evidence"] as { recovery?: Record<string, unknown> }).recovery;

  it("(b) a refused forward read-tree that moved a file is measured and never put back: files, index, HEAD and ref stay exactly as they stand, and recovery is incomplete, path by path (CEO 363fae88)", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-partial", true);
      const head = refOf(s.repo, "HEAD")!;
      const marks = tempDir("acp-stb-marks-");
      const git = gitScripted(() => [
        `  *"read-tree -m -u"*) chmod 555 '${join(s.repo, "src")}';;`,
        `  *"checkout-index"*) : > '${join(marks, "checkout-index")}';;`,
      ].join("\n"));
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
        chmodSync(join(s.repo, "src"), 0o755);
      }
      // Nothing was written to put anything back.
      expect(existsSync(join(marks, "checkout-index"))).toBe(false);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: false, undoRecorded: false, refRemoved: false, filesMoved: true, headMoved: false, created: true } });
      expect(String(refused["message"])).toContain("recovery is incomplete");
      expect(blockersOf(refused)).toEqual([expect.objectContaining({ step: "recovery incomplete", paths: ["README.md"] })]);
      // The recovery evidence: per path, the original blob, what is there now, and the attempt.
      expect(recoveryOf(refused)).toEqual({
        attemptId: events(f, CREATING, s.runId)[0]!["attemptId"],
        from: head,
        to: s.target.baseSha,
        paths: [{
          path: "README.md",
          expected: { mode: "100644", oid: blobAt(s.repo, head, "README.md") },
          current: { mode: "100644", blob: blobAt(s.repo, s.target.baseSha, "README.md") },
          destination: { mode: "100644", oid: blobAt(s.repo, s.target.baseSha, "README.md") },
        }],
        indexChanged: [],
        notOurs: [],
      });
      // Exactly as git left it: README at the pin's bytes, src/app.js untouched, the index still at HEAD's tree.
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# fixture project\n");
      expect(readFileSync(join(s.repo, "src/app.js"), "utf8")).toBe("module.exports = () => 9;\n");
      expect(gitSync(s.repo, ["ls-files", "-s", "README.md"])).toContain(blobAt(s.repo, head, "README.md"));
      expect(branchOf(s.repo)).toBe("dev");
      expect(refOf(s.repo, "HEAD")).toBe(head);
      expect(refOf(s.repo, `refs/heads/${s.target.branch}`)).toBe(s.target.baseSha);
      expect(events(f, CREATED, s.runId)).toEqual([]);
      expect(events(f, UNDONE, s.runId)).toEqual([]);
      // Unresolved, fail-closed: the next attempt is refused by name, not recovered automatically.
      expect(await runTask(f, s, s.taskId, s.claimId)).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { creationAttempted: true } });
    });
  });

  it("(b) counterexample: a user write landing after the measure, where the put-back used to write, is preserved, and the refusal claims no rollback (CEO 363fae88)", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-user-after-measure", true);
      const head = refOf(s.repo, "HEAD")!;
      const marks = tempDir("acp-stb-marks-");
      const userBytes = "# a user write, after the measure\n";
      // The seam: the measure reads the original tree for the paths it found moved, after deciding they
      // are ours and before the old put-back wrote them. The user writes README.md exactly there.
      const git = gitScripted((real) => [
        `  *"read-tree -m -u"*) chmod 555 '${join(s.repo, "src")}';;`,
        `  *"ls-tree -z --full-tree ${head}"*) if [ ! -e '${join(marks, "wrote")}' ]; then : > '${join(marks, "wrote")}'; printf '${userBytes.replace("\n", "\\n")}' > '${join(s.repo, "README.md")}'; fi; exec '${real}' "$@";;`,
      ].join("\n"));
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
        chmodSync(join(s.repo, "src"), 0o755);
      }
      expect(existsSync(join(marks, "wrote"))).toBe(true);
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe(userBytes);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: false, undoRecorded: false } });
      expect(blockersOf(refused).map((blocker) => blocker.step)).toContain("recovery incomplete");
      expect(events(f, UNDONE, s.runId)).toEqual([]);
      expect(branchOf(s.repo)).toBe("dev");
      expect(refOf(s.repo, `refs/heads/${s.target.branch}`)).toBe(s.target.baseSha);
    });
  });

  it("(b) the reverse read-tree, when it moves some files back and stops, is measured and never put back either: HEAD stays where the undo left it, nothing follows (CEO 363fae88)", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-reverse-partial", true);
      const head = refOf(s.repo, "HEAD")!;
      const pin = s.target.baseSha;
      const git = gitScripted((real) => [
        `  *"read-tree -m -u ${pin} ${head}"*) chmod 555 '${join(s.repo, "src")}';;`,
        `  *"task branch HEAD"*) '${real}' "$@"; code=$?; printf 'user notes\\n' > '${join(s.repo, "notes.txt")}'; exit "$code";;`,
      ].join("\n"));
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
        chmodSync(join(s.repo, "src"), 0o755);
      }
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: false, undoRecorded: false, refRemoved: false, filesMoved: true, headMoved: false } });
      expect(blockersOf(refused)).toEqual([expect.objectContaining({ step: "recovery incomplete", paths: ["README.md"] })]);
      expect(recoveryOf(refused)).toMatchObject({
        attemptId: events(f, CREATING, s.runId)[0]!["attemptId"],
        from: pin,
        to: head,
        paths: [{ path: "README.md", expected: { oid: blobAt(s.repo, pin, "README.md") }, current: { blob: blobAt(s.repo, head, "README.md") } }],
      });
      // Left exactly as the reverse read-tree left them: README back at HEAD's bytes, src/app.js still at the pin's.
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# the base moved on\n");
      expect(readFileSync(join(s.repo, "src/app.js"), "utf8")).toBe("module.exports = () => 1;\n");
      expect(readFileSync(join(s.repo, "notes.txt"), "utf8")).toBe("user notes\n");
      expect(branchOf(s.repo)).toBe("dev");
      expect(refOf(s.repo, `refs/heads/${s.target.branch}`)).toBe(pin);
      expect(events(f, UNDONE, s.runId)).toEqual([]);
      expect(events(f, CREATED, s.runId)).toEqual([]);
    });
  });

  it("(c) a throw from the intent record leaves nothing, and a throw from the completion record goes through the undo; neither escapes as INTERNAL_ERROR", async () => {
    for (const kind of [CREATING, CREATED]) {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const s = await oneTask(f, `stb-r3-throw-${kind === CREATED ? "completion" : "intent"}`, true);
        const refsBefore = refsOf(s.repo);
        const head = refOf(s.repo, "HEAD");
        const record = cp.audit.record.bind(cp.audit);
        const spy = vi.spyOn(cp.audit, "record").mockImplementation((entry) => {
          if (entry.kind === kind) throw new Error(`injected: the store refused ${kind}`);
          return record(entry);
        });
        const refused = await runTask(f, s, s.taskId, s.claimId);
        spy.mockRestore();
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(JSON.stringify(refused)).toContain(`injected: the store refused ${kind}`);
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(refOf(s.repo, "HEAD")).toBe(head);
        expect(branchOf(s.repo)).toBe("dev");
        expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# the base moved on\n");
        expect(gitSync(s.repo, ["status", "--porcelain"])).toBe("");
        // No intent was written: a retry starts afresh. A completion that failed leaves its attempt unresolved:
        // a retry is refused by name, never re-attempted on its own.
        const retry = await runTask(f, s, s.taskId, s.claimId);
        if (kind === CREATING) {
          expect(retry).toMatchObject({ ok: true });
          await settle(f, retry);
        } else {
          expect(retry).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { creationAttempted: true } });
        }
      });
    }
  });

  it("(c) a throw from a git read after the switch (not a record) goes through the same undo: nothing is left", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-throw-git", true);
      const refsBefore = refsOf(s.repo);
      const head = refOf(s.repo, "HEAD");
      // The post-switch clean scan reads the task tree first; that read fails once, so the scan throws.
      const git = gitScripted(() => `  *"ls-tree -r -z --full-tree ${s.target.baseSha}"*) echo 'injected: ls-tree' >&2; exit 1;;`);
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
      }
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: true, refRemoved: true, headMoved: false, filesMoved: false, blockers: [] } });
      expect(String(refused["message"])).toContain("an unexpected failure while the task's branch was made");
      expect(JSON.stringify(refused)).toContain("injected: ls-tree");
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(refOf(s.repo, "HEAD")).toBe(head);
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# the base moved on\n");
      expect(gitSync(s.repo, ["status", "--porcelain"])).toBe("");
      // A throw is not a verified, git-only failure: the attempt stays unresolved and is not tried again on its own.
      expect(events(f, UNDONE, s.runId)).toEqual([]);
    });
  });

  it("(d) every undo step that fails is a named blocker with git's words and the state it leaves; the refusal never claims a rollback", async () => {
    const cases = [
      {
        name: "files-back refused: HEAD follows the files onto the task branch",
        arms: (repo: string) => (real: string) => `  *"task branch HEAD"*) '${real}' "$@"; code=$?; printf '# user edit\\n' > '${join(repo, "README.md")}'; exit "$code";;`,
        steps: ["files-back"],
        evidence: { leftOnBranch: true, headMoved: true, filesMoved: true },
        on: "task",
      },
      {
        name: "head-back fails",
        arms: (repo: string) => (real: string) => [
          `  *"task branch undone HEAD"*) echo 'injected: head-back' >&2; exit 1;;`,
          `  *"task branch HEAD"*) '${real}' "$@"; code=$?; printf 'notes\\n' > '${join(repo, "notes.txt")}'; exit "$code";;`,
        ].join("\n"),
        steps: ["head-back"],
        evidence: { headMoved: true },
        on: "task",
      },
      {
        name: "ref-delete fails",
        arms: (repo: string) => (real: string) => [
          `  *"task branch undone -d"*) echo 'injected: ref-delete' >&2; exit 1;;`,
          `  *"task branch HEAD"*) '${real}' "$@"; code=$?; printf 'notes\\n' > '${join(repo, "notes.txt")}'; exit "$code";;`,
        ].join("\n"),
        steps: ["ref-delete"],
        evidence: { headMoved: false, filesMoved: false, refRemoved: false },
        on: "dev",
      },
    ];
    for (const c of cases) {
      await withBootstrapRuntime(async (f) => {
        const s = await oneTask(f, `stb-r3-d-${cases.indexOf(c)}`, true);
        const git = gitScripted(c.arms(s.repo));
        let refused: Record<string, unknown>;
        try {
          refused = await runTask(f, s, s.taskId, s.claimId);
        } finally {
          git.restore();
        }
        expect(refused, c.name).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { rolledBack: false, undoRecorded: false, ...c.evidence } });
        const blockers = blockersOf(refused);
        expect(blockers.map((blocker) => blocker.step), c.name).toEqual(c.steps);
        for (const blocker of blockers) {
          expect(blocker.error.length, c.name).toBeGreaterThan(0);
          expect(blocker.state.length, c.name).toBeGreaterThan(0);
        }
        if (c.name === "head-back fails") expect(blockers[0]!.error).toContain("injected: head-back");
        if (c.name === "ref-delete fails") expect(blockers[0]!.error).toContain("injected: ref-delete");
        expect(branchOf(s.repo), c.name).toBe(c.on === "task" ? s.target.branch : "dev");
        // The ref this attempt made is kept: something stands on it, or its removal failed.
        expect(refOf(s.repo, `refs/heads/${s.target.branch}`), c.name).toBe(s.target.baseSha);
        expect(events(f, UNDONE, s.runId), c.name).toEqual([]);
      });
    }
  });

  it("an attempt undone and verified is recorded resolved, so the task's next attempt creates its branch afresh", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await oneTask(f, "stb-r3-resolved", true);
      const git = gitScripted(() => `  *"task branch HEAD"*) exit 1;;`);
      let refused: Record<string, unknown>;
      try {
        refused = await runTask(f, s, s.taskId, s.claimId);
      } finally {
        git.restore();
      }
      expect(refused).toMatchObject({ ok: false, evidence: { rolledBack: true, undoRecorded: true, refRemoved: true, blockers: [] } });
      expect(events(f, UNDONE, s.runId)).toEqual([expect.objectContaining({ attemptId: events(f, CREATING, s.runId)[0]!["attemptId"] })]);
      const retry = await runTask(f, s, s.taskId, s.claimId);
      expect(retry).toMatchObject({ ok: true });
      await settle(f, retry);
      expect(branchOf(s.repo)).toBe(s.target.branch);
      expect(events(f, CREATED, s.runId)).toHaveLength(1);
    });
  });
});

describe("a checkout that is not clean or not the writer's", () => {
  it("a dirty checkout is refused and the user's change is left intact; nothing is created", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-dirty", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      writeFileSync(join(s.repo, "README.md"), "# the user's unsaved work\n");
      writeFileSync(join(s.repo, "notes.txt"), "the user's untracked notes\n");
      const refsBefore = refsOf(s.repo);
      const refused = await runTask(f, s, taskId, claimId);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect((refused["evidence"] as { paths: string[] }).paths).toEqual(expect.arrayContaining(["README.md", "notes.txt"]));
      expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# the user's unsaved work\n");
      expect(readFileSync(join(s.repo, "notes.txt"), "utf8")).toBe("the user's untracked notes\n");
      expect(refsOf(s.repo)).toBe(refsBefore);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
      expect(branchOf(s.repo)).toBe("dev");
      expect(f.harness.cp.tasks.executions(s.runId)).toEqual([]);
    });
  });

  it("cleanliness and the index are asserted again at the branch effect: a user edit or an index-only change landing just before the guard's authorization refuses with nothing created or moved", async () => {
    for (const change of ["edit", "index"] as const) {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const s = await standardRun(f, `stb-fence-${change}`, {
          tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        });
        const taskId = s.taskIds[0]!;
        const { target, claimId } = await staffAndClaim(f, s, taskId);
        const authorize = cp.guard.authorize.bind(cp.guard);
        let landed = false;
        vi.spyOn(cp.guard, "authorize").mockImplementation(async (request, effect) => {
          if (request.operation === "GIT_BRANCH") {
            landed = true;
            if (change === "edit") writeFileSync(join(s.repo, "README.md"), "# a user's edit, just in time\n");
            else gitSync(s.repo, ["update-index", "--assume-unchanged", "README.md"]);
          }
          return authorize(request, effect);
        });
        const refsBefore = refsOf(s.repo);
        const refused = await runTask(f, s, taskId, claimId);
        expect(landed).toBe(true);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
        expect(branchOf(s.repo)).toBe("dev");
        if (change === "edit") expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# a user's edit, just in time\n");
        expect(events(f, CREATING, s.runId)).toEqual([]);
        expect(events(f, CREATED, s.runId)).toEqual([]);
        expect(cp.tasks.executions(s.runId)).toEqual([]);
      });
    }
  });

  it("not owned: a checkout on another branch is not moved, a released claim and a caller that does not own the run are refused, and nothing is created", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "stb-owned", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      // Another caller: the project's bootstrap run's owner, which does not own this run.
      const outsider = f.harness.cp.runs.require(s.bootstrapRunId).ownerSessionId!;
      expect(await runTask(f, s, taskId, claimId, outsider)).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      // The checkout is on someone's other branch: neither the task's nor the run's base.
      gitSync(s.repo, ["checkout", "-q", "-b", "someone/else"]);
      const refsBefore = refsOf(s.repo);
      expect(await runTask(f, s, taskId, claimId)).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      expect(branchOf(s.repo)).toBe("someone/else");
      expect(refsOf(s.repo)).toBe(refsBefore);
      gitSync(s.repo, ["checkout", "-q", "dev"]);
      // The claim released: nothing the writer holds names the checkout any more.
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
      expect(await runTask(f, s, taskId, claimId)).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_NOT_HELD });
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
      expect(branchOf(s.repo)).toBe("dev");
      expect(f.harness.cp.tasks.executions(s.runId)).toEqual([]);
      expect(events(f, PREPARED, s.runId)).toEqual([]);
    });
  });
});
