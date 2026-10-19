import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { BranchProfile } from "../../src/contracts/manifest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { validateBranchContract } from "../../src/github/branch-contract.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";
import { TaskWriteTargets } from "../../src/run/task-write-target.ts";
import { FakeWorkerAdapter } from "../helpers/worker-turn-fixture.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * PR #1159 review r1 (BLOCK at fc52cb92), the reviewer's nine probes ported as written: R1–R8 are the
 * eight requirement witnesses (S-TB-01..08) that failed at fc52cb92, R9 the rollback witness that
 * passed. Changed from the reviewer's file only where noted: its imports moved to the top, `any`
 * typed, and R4's two assertions that recorded fc52cb92's divergent bases replaced by the one base the
 * requirement asks for. The reviewer's description of S-TB follows.
 *
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
const IDENTITY = "github:acme/fixture";

const DEV_BEARING: BranchProfile = fixtureManifest("profile").branchProfile;

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


describe("PR1159 independent requirement probes", () => {
  it("R1 refuses execution after canonical target derivation was refused", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "review-absent", {
        tasks: [{ key: "impl", title: "implement", category: "implementation" }],
      });
      const taskId = s.taskIds[0]!;
      expect(await provision(f, s, taskId)).toMatchObject({ ok: true, value: { writeTarget: null, writeTargetRefused: { reasonCode: ReasonCode.INVALID_ARGUMENT } } });
      expect(events(f, RECORDED, s.runId)).toEqual([]);
      const arbitrary = "task/unrecorded-target";
      gitSync(s.repo, ["checkout", "-q", "-b", arbitrary]);
      const claimId = await claimTarget(f, s, { repositoryIdentity: IDENTITY, branch: arbitrary, paths: ["README.md"] });
      const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
      fake.script = { writes: { "README.md": "# wrote despite refused target\n" } };
      vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
      try {
        const ran = await runTask(f, s, taskId, claimId);
        if (ran["ok"]) {
          const executionId = await settle(f, ran);
          expect(f.harness.cp.tasks.execution(executionId)?.status).toBe("SUCCEEDED");
        }
        console.error("R1 outcome", JSON.stringify(ran), "executions", f.harness.cp.tasks.executions(s.runId).length);
        expect(ran).toMatchObject({ ok: false });
      } finally { fake.killAll(); }
    });
  });

  it("R2 starts the next task after a successful task leaves its own clean branch", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "review-next", { tasks: [
        { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
        { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
      ] });
      const [one, two] = s.taskIds as [string, string];
      const first = await staffAndClaim(f, s, one);
      const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(cp.guard));
      fake.script = { writes: { "README.md": "# changed by task one\n" } };
      const invoke = vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
      try {
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        const executionId = await settle(f, ran);
        expect(cp.tasks.execution(executionId)?.status).toBe("SUCCEEDED");
        expect(gitSync(s.repo, ["status", "--porcelain"])).toBe("");
        expect(branchOf(s.repo)).toBe(first.target.branch);
        invoke.mockRestore();
        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const second = await staffAndClaim(f, s, two);
        const next = await runTask(f, s, two, second.claimId);
        if (next["ok"]) await settle(f, next);
        console.error("R2 outcome", JSON.stringify(next), "current branch", branchOf(s.repo));
        expect(next).toMatchObject({ ok: true });
      } finally { fake.killAll(); }
    });
  });

  it("R3 refuses a preexisting branch without creation provenance for this run and task", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "review-foreign-base", { tasks: [
        { key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
      ] });
      gitSync(s.repo, ["branch", `task/${idOf(s.taskIds[0]!)}-update-readme-md`]);
      const { target, claimId } = await staffAndClaim(f, s, s.taskIds[0]!);
      expect(events(f, PREPARED, s.runId)).toEqual([]);
      const ran = await runTask(f, s, s.taskIds[0]!, claimId);
      if (ran["ok"]) await settle(f, ran);
      console.error("R3 outcome", JSON.stringify(ran), "target", JSON.stringify(target));
      expect(ran).toMatchObject({ ok: false });
      expect(branchOf(s.repo)).toBe("dev");
    });
  });

  it("R4 pins one base across concurrent recordings of different tasks", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "review-pin-race", { tasks: [
        { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
        { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
      ] });
      const old = refOf(s.repo, "refs/heads/dev")!;
      let release!: () => void;
      let captured!: () => void;
      const paused = new Promise<void>((resolve) => { captured = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      const prototype = TaskWriteTargets.prototype as unknown as { pinnedBase: (...args: unknown[]) => Promise<unknown> };
      const original = prototype.pinnedBase;
      let n = 0;
      vi.spyOn(prototype, "pinnedBase").mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const answer = await original.apply(this, args);
        if (++n === 1) { captured(); await resume; }
        return answer;
      });
      const first = provision(f, s, s.taskIds[0]!);
      await paused;
      expect(events(f, RECORDED, s.runId)).toEqual([]);
      writeFiles(s.repo, { "README.md": "# base moved while first provision is pending\n" });
      const advanced = commitAll(s.repo, "advance dev");
      const second = await provision(f, s, s.taskIds[1]!);
      release();
      const firstAnswer = await first;
      const a = targetOf(firstAnswer);
      const b = targetOf(second);
      // Ported change: at fc52cb92 these were old and advanced. The second recording committed first,
      // so its pin is the run's; the first, resumed, takes it inside its own transaction.
      expect(old).not.toBe(advanced);
      expect(b.baseSha).toBe(advanced);
      expect(events(f, RECORDED, s.runId)).toHaveLength(2);
      console.error("R4 recorded bases", a.baseSha, b.baseSha);
      expect(a.baseSha).toBe(b.baseSha);
    });
  });

  it("R5 refuses feature and release bases under the dev-bearing task policy", async () => {
    const { deriveWorkBranch } = await import("../../src/run/task-write-target.ts");
    for (const base of ["feature/123-parent", "release/1.2.3"]) {
      const answer = deriveWorkBranch({ taskId: "task_0123", title: "update", base, profile: DEV_BEARING });
      console.error("R5 policy", base, JSON.stringify(answer));
      expect.soft(answer).toMatchObject({ allowed: false });
    }
  });
});

it("R6 carries the recorded parent and base through candidate freeze after the base advances", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const s = await standardRun(f, "review-freeze-moving-base", { tasks: [
      { key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
    ] });
    const { target, claimId } = await staffAndClaim(f, s, s.taskIds[0]!);
    writeFiles(s.repo, { "README.md": "# later dev commit\n" });
    const advanced = commitAll(s.repo, "dev moves");
    const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(cp.guard));
    fake.script = { writes: { "README.md": "# task change based on the pin\n" } };
    vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
    try {
      const ran = await runTask(f, s, s.taskIds[0]!, claimId);
      expect(ran).toMatchObject({ ok: true });
      const executionId = await settle(f, ran);
      expect(cp.tasks.execution(executionId)?.status).toBe("SUCCEEDED");
      expect(refOf(s.repo, `refs/heads/${target.branch}^`)).toBe(target.baseSha);
      const frozen = await cp.pipeline.freeze(s.runId);
      expect(frozen.allowed).toBe(true);
      if (!frozen.allowed) throw new Error(frozen.message);
      const repo = frozen.value.repositories[0]!;
      console.error("R6 frozen lineage", JSON.stringify({ canonical: target, frozen: { sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead, baseHead: repo.baseHead }, advanced }));
      const finalizerContract = validateBranchContract({ head: target.branch, base: repo.baseBranch, profile: DEV_BEARING, declaredParent: repo.sourceBranch ?? null, sourceBranch: repo.sourceBranch ?? null });
      console.error("R6 finalizer contract", JSON.stringify(finalizerContract));
      expect(finalizerContract.allowed).toBe(true);
    } finally { fake.killAll(); }
  });
});

it("R7 refuses a checkout dirtied before the guard effect without creating or moving a branch", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const s = await standardRun(f, "review-dirty-race", { tasks: [
      { key: "readme", title: "update README.md", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
    ] });
    const { target, claimId } = await staffAndClaim(f, s, s.taskIds[0]!);
    const original = cp.guard.authorize.bind(cp.guard);
    let changed = false;
    vi.spyOn(cp.guard, "authorize").mockImplementation(async (request, effect) => {
      if (request.operation === "GIT_BRANCH") {
        changed = true;
        writeFileSync(join(s.repo, "README.md"), "# concurrent user edit\n");
      }
      return original(request, effect);
    });
    const ran = await runTask(f, s, s.taskIds[0]!, claimId);
    expect(changed).toBe(true);
    expect(ran).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(readFileSync(join(s.repo, "README.md"), "utf8")).toBe("# concurrent user edit\n");
    console.error("R7 refused but changed branch", JSON.stringify(ran), branchOf(s.repo), refOf(s.repo, `refs/heads/${target.branch}`));
    expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
    expect(branchOf(s.repo)).toBe("dev");
  });
});

it("R8 refuses deriving a whole directory as a docs task's single file", async () => {
  await withBootstrapRuntime(async (f) => {
    const s = await standardRun(f, "review-single-directory", { scope: ["src"], tasks: [
      { key: "docs", title: "document src", category: "docs" },
    ] });
    expect(readFileSync(join(s.repo, "src/app.js"), "utf8").length).toBeGreaterThan(0);
    const answer = await provision(f, s, s.taskIds[0]!);
    console.error("R8 directory derived as file", JSON.stringify(answer));
    expect(answer).toMatchObject({ ok: true, value: { writeTarget: null, writeTargetRefused: { reasonCode: ReasonCode.INVALID_ARGUMENT } } });
  });
});

it("R9 rolls back both spec and target audit if the audit operation refuses", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const s = await standardRun(f, "review-target-audit-rollback", { tasks: [
      { key: "readme", title: "update README.md", category: "docs" },
    ] });
    const record = cp.audit.record.bind(cp.audit);
    vi.spyOn(cp.audit, "record").mockImplementation((entry) => {
      const result = record(entry);
      if (entry.kind === RECORDED) return deny(ReasonCode.AUDIT_WRITE_FAILED, "injected audit refusal after insert", {});
      return result;
    });
    const answer = await provision(f, s, s.taskIds[0]!);
    expect(answer).toMatchObject({ ok: true, value: { writeTarget: null, writeTargetRefused: { reasonCode: ReasonCode.INTERNAL_ERROR } } });
    expect((await contractTasks(f, s))[0]!.spec).toEqual({});
    expect(events(f, RECORDED, s.runId)).toEqual([]);
  });
});
