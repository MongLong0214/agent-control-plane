import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1162 r3 (ROUND1-ESCAPE-01) — a task branch made by the S-TB writer while continuity holds the run is
 * movement no database row shows: the ref and the checkout move, the tasks do not. So the release keeps
 * the hold for every S-TB branch record after the pause (TASK_BRANCH_CREATING, TASK_BRANCH_CREATED,
 * TASK_BRANCH_CREATION_UNDONE), and refuses outright while a creation's intent has neither its
 * completion nor a verified undo, whenever that intent was written.
 *
 * Over the real CTO socket, claim registry, guard and worker runner, in scratch repositories only; the
 * pause is injected at the real writer's own records, as the reviewer's probe injects it.
 */

const CREATING = "TASK_BRANCH_CREATING";
const CREATED = "TASK_BRANCH_CREATED";
const CEO = roleKeyFor(Role.CEO);

interface WriteTarget { repositoryIdentity: string; branch: string; paths: string[]; baseSha: string }

const contract = {
  goal: "update the README",
  why: "one documentation change",
  scope: ["README.md"],
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

/** A driven PRIMARY_CTO's STANDARD_WORK run with one READY docs task and the real worker path. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string) => {
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
    contract,
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, [{ key: "readme", title: "README", category: "docs", spec: {} }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return { runId, sessionId, taskId: submitted.value[0]!.taskId, repo: f.harness.repoPath, checkoutPath: repository.checkout_path };
};

/** Provisions the task's worker and claims the write target the control plane recorded for it. */
const staffAndClaim = async (f: BootstrapRuntimeFixture, s: Awaited<ReturnType<typeof standardRun>>) => {
  const provisioned = await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId: s.taskId, provider: "claude" });
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
  const claimId = (claimed["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims
    .find((claim) => claim.worktreeId !== null)!.claimId;
  return { target, claimId };
};

const refOf = (repo: string, ref: string): string | null => {
  try {
    return gitSync(repo, ["rev-parse", "--verify", "-q", ref]);
  } catch {
    return null;
  }
};

type Release = ReturnType<BootstrapRuntimeFixture["harness"]["cp"]["runs"]["releaseContinuityHold"]>;

/** Runs the task's first execution with continuity's pause injected right after the creation's intent. */
const runWithPauseAtIntent = async (
  f: BootstrapRuntimeFixture,
  s: Awaited<ReturnType<typeof standardRun>>,
  claimId: string,
  hooks: { atIntent?: (release: () => Release) => void; atCompletion?: (release: () => Release) => void },
) => {
  const cp = f.harness.cp;
  const record = cp.audit.record.bind(cp.audit);
  const release = (): Release => cp.runs.releaseContinuityHold(s.runId, cp.bindings.active(CEO)!);
  vi.spyOn(cp.audit, "record").mockImplementation((entry) => {
    const result = record(entry);
    if (entry.runId === s.runId && entry.kind === CREATING) {
      f.harness.clock.advance(1_000);
      const paused = cp.runs.pauseForContinuity(s.runId, CEO, "failover refused: SESSION_NOT_READY", { continuityAction: "PAUSE_NEW_WORK" });
      expect(paused.allowed).toBe(true);
      hooks.atIntent?.(release);
    }
    if (entry.runId === s.runId && entry.kind === CREATED) hooks.atCompletion?.(release);
    return result;
  });
  const answer = await f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId: s.taskId, claimId });
  if (answer["ok"] === true) await cp.workerTurns.settled((answer["value"] as { executionId: string }).executionId);
  vi.mocked(cp.audit.record).mockRestore();
  return answer;
};

describe("#1162 r3 — a task branch made or being made under the hold keeps it", () => {
  it("ROUND1-ESCAPE-01 port: a real branch completion after the continuity pause keeps the hold", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "hold-branch-created");
      const { target, claimId } = await staffAndClaim(f, s);
      expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBeNull();
      let release: Release | null = null;
      await runWithPauseAtIntent(f, s, claimId, {
        atCompletion: (attempt) => {
          expect(refOf(s.repo, `refs/heads/${target.branch}`)).toBe(target.baseSha);
          queueMicrotask(() => { release = attempt(); });
        },
      });
      expect(release).toMatchObject({ allowed: true, value: { released: false, kept: `${CREATED} was recorded for the run after continuity's pause` } });
      expect(cp.runs.require(s.runId).state).toBe("BLOCKED");
    });
  });

  it("a release attempted while the creation's intent has no completion or undo is refused as in flight", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "hold-branch-in-flight");
      const { claimId } = await staffAndClaim(f, s);
      let release: Release | null = null;
      let completedBeforeRelease: boolean | null = null;
      await runWithPauseAtIntent(f, s, claimId, {
        atIntent: (attempt) => queueMicrotask(() => {
          completedBeforeRelease = cp.audit.forRun(s.runId).some((entry) => entry.kind === CREATED);
          release = attempt();
        }),
      });
      // The release ran inside the creation: after its intent and the pause, before its completion.
      expect(completedBeforeRelease).toBe(false);
      expect(release).toMatchObject({ allowed: true, value: { released: false, kept: "a task branch creation of the run is in flight or unresolved" } });
      expect(cp.runs.require(s.runId).state).toBe("BLOCKED");
    });
  });
});
