import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "ops hardening",
  why: "scenario",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const activeRun = async (harness: Harness, projectId = "fixture-project") => {
  const registered = await registerFixtureProject(harness, projectId);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId: registered.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [
      { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { ...registered, runId: created.value.runId, run: dispatched.value };
};

describe("a destructive repair needs a real owner (§25.7)", () => {
  it("refuses an OWNER-authorised repair with no owner identity behind it", async () => {
    const harness = makeHarness();
    const refused = await harness.cp.repair.execute({
      operationId: "prune_orphan_worktrees",
      parameters: {},
      authorizedBy: "OWNER",
      dryRun: false,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REPAIR_REQUIRES_OWNER);
  });

  it("refuses an OWNER-authorised repair from an actor that is not the owner", async () => {
    const harness = makeHarness();
    const refused = await harness.cp.repair.execute({
      operationId: "prune_orphan_worktrees",
      parameters: {},
      authorizedBy: "OWNER",
      owner: { channel: "cli", actor: "not-the-owner" },
      dryRun: false,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REPAIR_REQUIRES_OWNER);
  });

  it("still allows a Hermes-authorised low-risk repair without an owner", async () => {
    const harness = makeHarness();
    const { runId, run, identity } = await activeRun(harness);
    const claim = harness.cp.claims.acquire({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      ownerRoleKey: run.ownerRoleKey!,
      repositoryIdentity: identity,
      branch: "repair/stale-claim",
      ttlMs: 1,
    });
    if (!claim.allowed) throw new Error(claim.message);
    harness.clock.advance(1);
    const allowed = await harness.cp.repair.execute({
      operationId: "expire_stale_claims",
      parameters: {},
      authorizedBy: "HERMES",
      dryRun: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it("accepts the destructive repair once the owner identity checks out", async () => {
    const harness = makeHarness();
    await registerFixtureProject(harness);
    await harness.cp.worktrees.create(harness.repoPath, "HEAD", "owner-approved-orphan");
    const allowed = await harness.cp.repair.execute({
      operationId: "prune_orphan_worktrees",
      parameters: {},
      authorizedBy: "OWNER",
      owner: TEST_OWNER,
      dryRun: true,
    });
    expect(allowed.allowed).toBe(true);
    if (!allowed.allowed) return;
    expect(allowed.value.authorizedBy).toBe("OWNER");
  });
});

describe("coordination state belongs to the run that holds it (§23.2)", () => {
  it("refuses to release another run's claim", async () => {
    const harness = makeHarness();
    const first = await activeRun(harness);
    const claimed = harness.cp.claims.acquire({
      runId: first.runId,
      ownerSessionId: first.run.ownerSessionId!,
      ownerBindingGeneration: first.run.ownerBindingGeneration!,
      ownerRoleKey: first.run.ownerRoleKey!,
      repositoryIdentity: first.identity,
      branch: "feature/F1-thing",
    });
    if (!claimed.allowed) throw new Error(claimed.message);
    const claimId = claimed.value[0]!.claimId;

    const refused = harness.cp.claims.release(claimId, "run_someone_else");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(harness.cp.claims.heldByRun(first.runId)).toHaveLength(1);

    expect(harness.cp.claims.release(claimId, first.runId).allowed).toBe(true);
  });

  it("refuses an activity lease recorded for another run's execution", async () => {
    const harness = makeHarness();
    const { runId, run } = await activeRun(harness);
    const submitted = harness.cp.tasks.submit(runId, [
      { key: "impl", title: "work", category: "implementation" },
    ]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const task = harness.cp.tasks.ready(runId)[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId,
      taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: run.ownerSessionId,
      provider: "scripted",
      model: "scripted-worker",
    });
    if (!execution.allowed) throw new Error(execution.message);

    const refused = harness.cp.tasks.recordActivity(execution.value.executionId, "run_other");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(harness.cp.tasks.recordActivity(execution.value.executionId, runId).allowed).toBe(true);
  });
});

describe("exactly one holder of the daemon lock (§33.1)", () => {
  it("refuses a second lock in the same process and does not steal the first", () => {
    const dir = tempDir("acp-lock-");
    const path = join(dir, "agentcpd.lock");
    const first = new SingleInstanceLock(path);
    const second = new SingleInstanceLock(path);

    expect(first.acquire("2026-08-12T00:00:00.000Z").allowed).toBe(true);
    const refused = second.acquire("2026-08-12T00:00:01.000Z");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.DAEMON_ALREADY_RUNNING);
    // The first holder is intact, and releasing it removes only its own lock.
    expect(first.read()?.startedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(second.held()).toBe(false);

    first.release();
    expect(first.read()).toBeNull();
  });

  it("refuses to acquire twice through the same lock object", () => {
    const dir = tempDir("acp-lock2-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    expect(lock.acquire("2026-08-12T00:00:00.000Z").allowed).toBe(true);
    expect(lock.acquire("2026-08-12T00:00:02.000Z").allowed).toBe(false);
    lock.release();
  });

  it("does not delete a lock another holder took after this one released", () => {
    const dir = tempDir("acp-lock3-");
    const path = join(dir, "agentcpd.lock");
    const first = new SingleInstanceLock(path);
    expect(first.acquire("2026-08-12T00:00:00.000Z").allowed).toBe(true);
    first.release();

    const successor = new SingleInstanceLock(path);
    expect(successor.acquire("2026-08-12T00:00:05.000Z").allowed).toBe(true);
    // A late second release from the first holder must leave the successor's lock alone.
    first.release();
    expect(successor.read()?.startedAt).toBe("2026-08-12T00:00:05.000Z");
    successor.release();
  });
});
