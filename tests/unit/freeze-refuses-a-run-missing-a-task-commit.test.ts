import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import type * as Integration from "../../src/run/candidate-integration.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { WorkerTurnEvent, workerSuccessDigest, type WorkerSuccessDigestInputs } from "../../src/run/worker-turn.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { bindWorkerForTask, registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

/**
 * A fault injected into the S6-C integration only: the commit of the task named here is withheld from
 * what the integration is given, while the freeze's guard still reads every commit. Off unless a test
 * sets it.
 */
const fault = vi.hoisted(() => ({ dropTaskId: null as string | null }));
vi.mock("../../src/run/candidate-integration.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Integration>();
  return {
    ...actual,
    integrateTaskResults: (input: Parameters<typeof actual.integrateTaskResults>[0]) =>
      actual.integrateTaskResults(
        fault.dropTaskId === null ? input : { ...input, commits: input.commits.filter((commit) => commit.taskId !== fault.dropTaskId) },
      ),
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  fault.dropTaskId = null;
});

/**
 * S6-B — a freeze must refuse a candidate that is missing a SUCCEEDED task's own commit.
 *
 * Each STANDARD_WORK task's work branch is created at the run's pinned base, never stacked on
 * another task's branch (#512 S-TB, c98ea8a3 S-TB-02): a task that releases its claim leaves its
 * finished branch for the next task's own, cut fresh from the same pin. So in a run of two tasks
 * that both SUCCEEDED, the checkout's HEAD after the second task's turn is the second task's
 * branch, a sibling of the first task's branch rather than its descendant. Freezing that HEAD
 * alone (`candidate-snapshot.ts` reading `candidateRef ?? "HEAD"`) produced a candidate that held
 * only the second task's commit, with nothing checking that the first task's commit was in it —
 * the live defect S6-B guards and S6-C fixes: the freeze now integrates every SUCCEEDED task's commit
 * onto the pinned base, and this guard is the post-condition on that final head.
 *
 * Over the real CTO MCP socket, the real claim registry, guard and worker runner, in scratch
 * repositories only. Stood in: the WORKER provider (a fake that writes what its script says
 * through the real guard broker) and its capacity admission.
 */

const contractFor = (scope: string[]) => ({
  goal: "update the project",
  why: "one run, more than one task",
  scope,
  nonGoals: [],
  acceptance: ["every scoped file changes"],
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

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
}

/** A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, with the real worker path. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string, tasks: TaskInput[], scope: string[]) => {
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
    contract: contractFor(scope),
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, tasks.map((task) => ({ ...task, spec: task.spec ?? {} })));
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return {
    runId,
    sessionId,
    taskIds: submitted.value.map((task) => task.taskId),
    checkoutPath: repository.checkout_path,
    repositoryId: repository.repository_id,
  };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const provision = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) =>
  f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });

const targetOf = (answer: Record<string, unknown>): WriteTarget =>
  (answer["value"] as { writeTarget: WriteTarget }).writeTarget;

const claimTarget = async (f: BootstrapRuntimeFixture, s: StandardRun, target: WriteTarget): Promise<string> => {
  const answer = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });
  expect(answer, "the task's claim of its recorded write target").toMatchObject({ ok: true });
  return (answer["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims
    .find((row) => row.worktreeId !== null)!.claimId;
};

const staffAndClaim = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) => {
  const provisioned = await provision(f, s, taskId);
  expect(provisioned).toMatchObject({ ok: true });
  const target = targetOf(provisioned);
  const claimId = await claimTarget(f, s, target);
  return { target, claimId };
};

const runTask = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string, claimId: string) =>
  f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });

const settle = async (f: BootstrapRuntimeFixture, answer: Record<string, unknown>): Promise<string> => {
  const executionId = (answer["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  return executionId;
};

/** The WORKER provider stood in by a fake that writes what its script says, through the real guard broker. */
const workerDoing = (f: BootstrapRuntimeFixture, script: FakeTurnScript): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  fake.script = script;
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

/** The commit a task's own SUCCEEDED turn made, read back exactly as the pipeline guard reads it. */
const succeededCommitOf = (f: BootstrapRuntimeFixture, runId: string, taskId: string): string => {
  const row = f.harness.cp.audit
    .byKind("TASK_WORKER_TURN_SUCCEEDED")
    .filter((r) => r.runId === runId && r.evidence["taskId"] === taskId)
    .at(-1);
  if (!row) throw new Error(`no TASK_WORKER_TURN_SUCCEEDED row for task ${taskId}`);
  return String(row.evidence["commitHead"]);
};

describe("a freeze guards every SUCCEEDED task's commit (S6-B)", () => {
  /** Two successive tasks, the second cut fresh from the pinned base after the first released its claim. */
  const twoSiblingTasks = async (f: BootstrapRuntimeFixture, projectId: string) => {
    const cp = f.harness.cp;
    const s = await standardRun(
      f,
      projectId,
      [
        { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } },
        { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { paths: ["src/app.js"] } } },
      ],
      ["README.md", "src/app.js"],
    );
    const [one, two] = s.taskIds as [string, string];
    const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
    let repositoryIdentity: string;
    try {
      const first = await staffAndClaim(f, s, one);
      repositoryIdentity = first.target.repositoryIdentity;
      const ranOne = await runTask(f, s, one, first.claimId);
      expect(ranOne).toMatchObject({ ok: true });
      expect(cp.tasks.execution(await settle(f, ranOne))?.status).toBe("SUCCEEDED");
      // The hand-off: the first task's claim is released, so the second task gets its own
      // branch at the same pinned base rather than continuing on the first task's.
      expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });

      worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
      const second = await staffAndClaim(f, s, two);
      expect(second.target.branch).not.toBe(first.target.branch);
      const ranTwo = await runTask(f, s, two, second.claimId);
      expect(ranTwo).toMatchObject({ ok: true });
      expect(cp.tasks.execution(await settle(f, ranTwo))?.status).toBe("SUCCEEDED");
    } finally {
      worker.killAll();
    }
    const oneCommit = succeededCommitOf(f, s.runId, one);
    const twoCommit = succeededCommitOf(f, s.runId, two);
    // The scenario: the checkout's current HEAD (task two's branch) does not descend from task
    // one's commit; they are siblings cut from the same pinned base.
    expect(gitSync(s.checkoutPath, ["rev-parse", "HEAD"])).toBe(twoCommit);
    expect(() => gitSync(s.checkoutPath, ["merge-base", "--is-ancestor", oneCommit, "HEAD"])).toThrow();
    return { s, one, two, oneCommit, twoCommit, repositoryIdentity };
  };

  const currentCandidateOf = (f: BootstrapRuntimeFixture, runId: string): string | null =>
    f.harness.cp.db.get<{ digest: string | null }>(`SELECT current_candidate_digest AS digest FROM runs WHERE run_id = ?`, [runId])?.digest ?? null;

  it("two successive tasks, the second cut fresh from the pinned base: the freeze integrates both, the candidate holds each task's commit, and the guard passes", async () => {
    await withBootstrapRuntime(async (f) => {
      const { s, oneCommit, twoCommit } = await twoSiblingTasks(f, "s6b-missing");
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
      const repo = frozen.value.repositories[0]!;
      expect(repo.candidateHead).not.toBe(twoCommit);
      // Asked from the checkout, where the guard asks: the integrated commit's objects are there.
      expect(gitSync(s.checkoutPath, ["merge-base", "--is-ancestor", oneCommit, repo.candidateHead])).toBe("");
      expect(gitSync(s.checkoutPath, ["merge-base", "--is-ancestor", twoCommit, repo.candidateHead])).toBe("");
      expect(repo.integration?.tasks.map((task) => task.commit).sort()).toEqual([oneCommit, twoCommit].sort());
      expect(currentCandidateOf(f, s.runId)).not.toBeNull();
    });
  });

  it("the guard still bites after integration: an integration that drops a task's commit is refused by name, and nothing is promoted", async () => {
    await withBootstrapRuntime(async (f) => {
      const { s, two, twoCommit, repositoryIdentity } = await twoSiblingTasks(f, "s6b-dropped");
      // The integration is not given task two's commit, the one HEAD holds, so it really runs, on task
      // one alone: its candidate is task one's commit, and only task two is missing from it.
      fault.dropTaskId = two;
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      expect(frozen).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CANDIDATE_MISSING_TASK_COMMIT,
        evidence: { runId: s.runId, missing: [{ taskId: two, commitHead: twoCommit, repositoryIdentity }] },
      });
      expect(frozen.allowed ? [] : (frozen.evidence["missing"] as unknown[])).toHaveLength(1);
      // The integration ran: its worktree was made and torn down.
      expect(f.harness.cp.db.all<{ state: string }>(
        `SELECT state FROM verification_worktrees WHERE run_id = ? AND command_id = 'candidate-integration'`,
        [s.runId],
      ).map((row) => row.state)).toEqual(["DESTROYED"]);
      expect(currentCandidateOf(f, s.runId)).toBeNull();
      expect(f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId)).toEqual([]);
    });
  });

  it("GREEN — a single task: the candidate is the task's own commit, and the freeze is unaffected", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "s6b-single",
        [{ key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        ["README.md"],
      );
      const [one] = s.taskIds as [string];
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, ran))?.status).toBe("SUCCEEDED");

        const oneCommit = succeededCommitOf(f, s.runId, one);
        const frozen = await cp.pipeline.freeze(s.runId);
        expect(frozen).toMatchObject({ allowed: true, value: { repositories: [{ candidateHead: oneCommit }] } });
      } finally {
        worker.killAll();
      }
    });
  });

  it("GREEN — a single task whose checkout moved past its commit, then off it: the guard agrees with each candidate", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "s6b-single-moved",
        [{ key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        ["README.md"],
      );
      const [one] = s.taskIds as [string];
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      let base: string;
      try {
        const first = await staffAndClaim(f, s, one);
        base = first.target.branch;
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, ran))?.status).toBe("SUCCEEDED");
      } finally {
        worker.killAll();
      }
      const oneCommit = succeededCommitOf(f, s.runId, one);

      // Past it: a commit on top of the task's. HEAD holds the task's commit, so there is no
      // integration and the candidate is HEAD, as before.
      gitSync(s.checkoutPath, ["commit", "-q", "--allow-empty", "-m", "on top of the task"]);
      const onTop = gitSync(s.checkoutPath, ["rev-parse", "HEAD"]);
      const past = await cp.pipeline.freeze(s.runId);
      if (!past.allowed) throw new Error(`${past.reasonCode}: ${past.message}`);
      expect(past.value.repositories[0]!.candidateHead).toBe(onTop);
      expect("integration" in past.value.repositories[0]!).toBe(false);

      // Off it: the checkout on the base branch, which does not hold the task's commit. The candidate
      // is the task's commit, integrated alone, and the guard finds it there.
      gitSync(s.checkoutPath, ["checkout", "-q", "dev"]);
      expect(base).not.toBe("dev");
      expect(() => gitSync(s.checkoutPath, ["merge-base", "--is-ancestor", oneCommit, "HEAD"])).toThrow();
      const off = await cp.pipeline.freeze(s.runId);
      if (!off.allowed) throw new Error(`${off.reasonCode}: ${off.message}`);
      expect(off.value.repositories[0]!.candidateHead).toBe(oneCommit);
      expect(off.value.repositories[0]!.integration).toEqual({ checkoutHead: gitSync(s.checkoutPath, ["rev-parse", "HEAD"]), tasks: [{ taskId: one, commit: oneCommit }] });
    });
  });

  it("a declared branch a sibling task already owns is refused — not this freeze guard's case, but the reason a 'shared branch' GREEN cannot be built through the real provisioning path", async () => {
    await withBootstrapRuntime(async (f) => {
      const sharedBranch = "task/shared-work";
      const s = await standardRun(
        f,
        "s6b-shared-branch-refused",
        [
          { key: "one", title: "update readme", category: "docs", spec: { writeTarget: { branch: sharedBranch, paths: ["README.md"] } } },
          { key: "two", title: "update app", category: "implementation", spec: { writeTarget: { branch: sharedBranch, paths: ["src/app.js"] } } },
        ],
        ["README.md", "src/app.js"],
      );
      const [one, two] = s.taskIds as [string, string];
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        expect(first.target.branch).toBe(sharedBranch);
        const ranOne = await runTask(f, s, one, first.claimId);
        expect(ranOne).toMatchObject({ ok: true });
        expect(f.harness.cp.tasks.execution(await settle(f, ranOne))?.status).toBe("SUCCEEDED");
        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });

        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const second = await staffAndClaim(f, s, two);
        expect(second.target.branch).toBe(sharedBranch);
        // S-TB-03 (review r2): a branch's ownership is its recorded creation for this run *and task*,
        // never a name or a tip alone. A second task declaring the first's branch is refused by it,
        // which is exactly why "a second task stacked on the first" is proven below by seeding its
        // receipt directly rather than by declaring a shared branch through this path.
        expect(await runTask(f, s, two, second.claimId)).toMatchObject({
          ok: false,
          reasonCode: ReasonCode.CONFLICT,
          message: expect.stringContaining("did not create for this run and task"),
        });
      } finally {
        worker.killAll();
      }
    });
  });

  it("GREEN — a second task's commit stacked on the first's: both SUCCEEDED, both contained, and the freeze passes", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "s6b-stacked",
        [{ key: "one", title: "update readme", category: "docs", spec: { writeTarget: { paths: ["README.md"] } } }],
        ["README.md", "src/app.js"],
      );
      const [one] = s.taskIds as [string];
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ranOne = await runTask(f, s, one, first.claimId);
        expect(ranOne).toMatchObject({ ok: true });
        expect(cp.tasks.execution(await settle(f, ranOne))?.status).toBe("SUCCEEDED");
        const oneCommit = succeededCommitOf(f, s.runId, one);

        // A second task of the same run, admitted and finished the same way the existing
        // `driven-standard-work-continuation` tests already drive `startExecution`/`finishExecution`
        // directly. Its commit is made straight onto the checkout the first task's turn left clean,
        // on top of the first task's own commit — no branch-ownership machinery is exercised here;
        // that path is covered (and refused, correctly) by the test just above. What this asks is
        // only whether the freeze still passes when every SUCCEEDED task's commit really is in the
        // candidate's history.
        const submittedTwo = cp.tasks.submit(s.runId, [{ key: "two", title: "update app", category: "implementation", spec: {} }]);
        if (!submittedTwo.allowed) throw new Error(submittedTwo.message);
        const twoTaskId = submittedTwo.value[0]!.taskId;
        const workerSessionId = bindWorkerForTask(cp, twoTaskId, { provider: "claude", model: "opus" });
        const opened = cp.tasks.startExecution({
          runId: s.runId,
          taskId: twoTaskId,
          ownerBindingGeneration: 1,
          workerSessionId,
          provider: "claude",
          model: "opus",
          repositoryId: s.repositoryId,
        });
        if (!opened.allowed) throw new Error(opened.message);
        writeFiles(s.checkoutPath, { "src/app.js": "module.exports = () => 2;\n" });
        const twoCommit = commitAll(s.checkoutPath, "task two: update app");
        const inputs: WorkerSuccessDigestInputs = {
          executionId: opened.value.executionId,
          workerSessionId,
          sessionIncarnation: cp.sessions.get(workerSessionId)!.incarnation,
          providerSessionId: "scripted-session",
          exitCode: 0,
          stdoutSha256: sha256(""),
          commitHead: twoCommit,
          diffDigest: "sha256:stand-in-diff",
        };
        const resultDigest = workerSuccessDigest(inputs);
        const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest }, s.runId);
        if (!closed.allowed) throw new Error(closed.message);
        cp.audit.record({
          kind: WorkerTurnEvent.SUCCEEDED,
          runId: s.runId,
          sessionId: workerSessionId,
          evidence: { ...inputs, resultDigest, taskId: twoTaskId, head: oneCommit, paths: ["src/app.js"] },
        });

        // Both commits are on the one branch: task two's commit descends from task one's.
        expect(gitSync(s.checkoutPath, ["merge-base", "--is-ancestor", oneCommit, "HEAD"])).toBe("");

        const frozen = await cp.pipeline.freeze(s.runId);
        expect(frozen).toMatchObject({ allowed: true, value: { repositories: [{ candidateHead: twoCommit }] } });
      } finally {
        worker.killAll();
      }
    });
  });
});
