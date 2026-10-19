import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { BranchProfile } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { classifyBranch, validateBranchContract } from "../../src/github/branch-contract.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

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
    for (const [profile, base] of [
      [{ ...DEV_BEARING, defaultBranch: "main" }, "main"],
      [DEV_BEARING, "main"],
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
  it("an existing branch at the pinned base is re-entered, from the base branch or already checked out; one carrying a commit this task's turn made is re-entered too", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "stb-reentry", {
        tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
      });
      const taskId = s.taskIds[0]!;
      const { target, claimId } = await staffAndClaim(f, s, taskId);
      // An earlier admission made the branch and stopped before an execution; the checkout went back to dev.
      gitSync(s.repo, ["branch", target.branch, target.baseSha]);
      // A commit on it that this task's turn made, as its record names it.
      gitSync(s.repo, ["checkout", "-q", target.branch]);
      writeFiles(s.repo, { "README.md": "# by this task\n" });
      const ours = commitAll(s.repo, "this task's turn");
      gitSync(s.repo, ["checkout", "-q", "dev"]);
      cp.audit.record({ kind: "TASK_WORKER_TURN_SUCCEEDED", runId: s.runId, evidence: { taskId, executionId: "exec_earlier", commitHead: ours } });

      const ran = await runTask(f, s, taskId, claimId);
      expect(ran).toMatchObject({ ok: true });
      await settle(f, ran);
      expect(branchOf(s.repo)).toBe(target.branch);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBe(ours);
      expect(events(f, PREPARED, s.runId)).toEqual([expect.objectContaining({ created: false, checkedOut: true, head: ours })]);

      // Already on it: re-entered with no branch write at all.
      const again = await runTask(f, s, taskId, claimId);
      expect(again).toMatchObject({ ok: true });
      await settle(f, again);
      expect(events(f, PREPARED, s.runId)).toHaveLength(1);
      expect(cp.tasks.executions(s.runId)).toHaveLength(2);
    });
  });

  it("a branch with the task's name that carries a foreign commit, or does not descend from the pinned base, is refused and left exactly as it is", async () => {
    for (const shape of ["foreign", "diverged"] as const) {
      await withBootstrapRuntime(async (f) => {
        const s = await standardRun(f, `stb-${shape}`, {
          tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        });
        const taskId = s.taskIds[0]!;
        const { target, claimId } = await staffAndClaim(f, s, taskId);
        if (shape === "foreign") {
          gitSync(s.repo, ["checkout", "-q", "-b", target.branch]);
          writeFiles(s.repo, { "README.md": "# someone else\n" });
          commitAll(s.repo, "someone else's work");
          gitSync(s.repo, ["checkout", "-q", "dev"]);
        } else {
          const orphan = gitSync(s.repo, ["commit-tree", `${target.baseSha}^{tree}`, "-m", "unrelated history"]);
          gitSync(s.repo, ["branch", target.branch, orphan]);
        }
        const refsBefore = refsOf(s.repo);
        const refused = await runTask(f, s, taskId, claimId);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(refsOf(s.repo)).toBe(refsBefore);
        expect(branchOf(s.repo)).toBe("dev");
        expect(f.harness.cp.tasks.executions(s.runId)).toEqual([]);
        expect(events(f, PREPARED, s.runId)).toEqual([]);
      });
    }
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
