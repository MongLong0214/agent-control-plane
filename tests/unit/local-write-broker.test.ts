import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { isoPlus } from "../../src/core/clock.ts";
import { newAssignmentId, newTaskId } from "../../src/core/ids.ts";
import { ManagedWriteGuard, WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { realWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import {
  GuardedInvocationWriteBroker,
  type ManagedInvocationWrite,
  type ManagedInvocationWriteBroker,
} from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, makeRepo, seedRun, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

/** A provider stand-in which writes both inside and outside the authorised directory. */
const writeScopeProbe = (repository: string): string => {
  const binary = join(repository, "write-scope-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const allowed = join(process.cwd(), "allowed");
const outside = join(process.cwd(), "outside", "escaped.txt");
writeFileSync(join(allowed, "provider-started"), "started");
writeFileSync(join(allowed, "allowed.txt"), "authorised");
let outsideDenied = false;
try {
  writeFileSync(outside, "escaped");
} catch (error) {
  outsideDenied = error && (error.code === "EPERM" || error.code === "EACCES");
}
process.stdout.write(JSON.stringify({ outsideDenied }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("CP-HI-01 local runtime write broker", () => {
  it("#355 refuses an ungranted CLI write and actively denies a provider write outside its guarded target", async () => {
    const core = makeCore();
    const repository = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repository });
    const runtimeRoot = tempDir("acp-runtime-workdir-");
    const assignedWorktree = join(runtimeRoot, "assigned");
    const otherAssignedWorktree = join(runtimeRoot, "assigned-b");
    gitSync(repository, ["worktree", "add", "--detach", assignedWorktree, "HEAD"]);
    gitSync(repository, ["worktree", "add", "--detach", otherAssignedWorktree, "HEAD"]);
    const allowed = join(assignedWorktree, "allowed");
    const outside = join(assignedWorktree, "outside");
    const otherAllowed = join(otherAssignedWorktree, "allowed");
    const otherOutside = join(otherAssignedWorktree, "outside");
    const outsideTarget = join(runtimeRoot, "outside-target");
    mkdirSync(allowed);
    mkdirSync(outside);
    mkdirSync(otherAllowed);
    mkdirSync(otherOutside);
    mkdirSync(outsideTarget);
    const taskId = newTaskId();
    const taskReceiptId = "exec_runtime-bound";
    const now = core.clock.nowIso();
    core.db.run(
      `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
       VALUES (?, ?, 'runtime write', 'implementation', 'READY', '{}', ?, ?)`,
      [taskId, seeded.runId, now, now],
    );
    core.db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, run_id, task_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'WORKER', ?, ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
      [newAssignmentId(), `WORKER:${taskId}`, seeded.runId, taskId, seeded.sessionId, now],
    );
    core.db.run(
      `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                    worker_session_id, provider, model, repository_id, worktree_id,
                                    started_at, status)
       VALUES (?, ?, ?, 1, ?, ?, 'claude', 'opus', ?, ?, ?, 'RUNNING')`,
      [taskReceiptId, seeded.runId, taskId, seeded.generation, seeded.sessionId, seeded.repositoryId, assignedWorktree, now],
    );
    // The adapter receives a directory target, but the guard also observes the actual
    // checkout branch. A live claim for both resources makes this a valid managed write,
    // so a refusal below can only be the runtime target scope rather than test setup.
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('branch_claim', ?, 'dev', ?, ?, ?, ?, ?, 'HELD')`,
      [
        seeded.identity,
        seeded.runId,
        seeded.sessionId,
        seeded.generation,
        core.clock.nowIso(),
        isoPlus(core.clock.nowIso(), 3_600_000),
      ],
    );
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    const guardedBroker = new GuardedInvocationWriteBroker(guard);
    let providerLaunches = 0;
    const monitoredBroker: ManagedInvocationWriteBroker = {
      authorize: <T>(write: ManagedInvocationWrite, effect: () => T | Promise<T>) =>
        guardedBroker.authorize(write, async () => {
          // This is immediately around the adapter's provider-launch callback. It keeps
          // the receipt/worktree regression observable even where a platform sandbox
          // rejects the child process before the probe can write its marker.
          providerLaunches += 1;
          return effect();
        }),
    };
    const adapter = new ClaudeCliAdapter({
      clock: core.clock,
      capacityFile: join(repository, "capacity.json"),
      binary: writeScopeProbe(repository),
      managedWriteBroker: monitoredBroker,
    });

    const withoutGrant = await adapter.invoke({
      prompt: "attempt a write without control-plane authority",
      workdir: runtimeRoot,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-without-grant",
    });
    expect(withoutGrant.ok).toBe(false);
    expect(withoutGrant.error).toBe(
      "WRITE_REQUIRES_MANAGED_RUN: writable runtime invocation lacks per-effect authorisation",
    );
    // The provider process is not even launched until the broker has admitted a live
    // guard request; a prompt cannot turn `readOnly: false` into checkout authority.
    expect(existsSync(join(allowed, "provider-started"))).toBe(false);

    const rejectedByGuard = await adapter.invoke({
      prompt: "attempt a write with a stale binding",
      workdir: runtimeRoot,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-stale-binding",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: allowed,
        taskId,
        taskReceiptId,
        assignedWorktreeId: assignedWorktree,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation + 1,
      },
    });
    expect(rejectedByGuard.ok).toBe(false);
    // A syntactically complete grant is not enough: deleting the broker's authorize call
    // launches this probe and creates provider-started before the valid grant below.
    expect(existsSync(join(allowed, "provider-started"))).toBe(false);

    const guardDecisionsBeforeReceiptWorktreeCheck = core.audit.byKind("MANAGED_WRITE_GUARD").length;
    const launchesBeforeReceiptWorktreeCheck = providerLaunches;
    const receiptBoundToARequestedAtB = await adapter.invoke({
      prompt: "attempt a write using a receipt from another assigned worktree",
      workdir: runtimeRoot,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-receipt-worktree-mismatch",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: otherAllowed,
        taskId,
        taskReceiptId,
        // The receipt above is durably bound to `assignedWorktree`; this request reaches
        // the Guard with a real, separate Git worktree B so only the receipt equality
        // check can reject it.
        assignedWorktreeId: otherAssignedWorktree,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });
    expect(receiptBoundToARequestedAtB.ok).toBe(false);
    expect(receiptBoundToARequestedAtB.error).toBe(
      "WRITE_TARGET_RESOURCE_MISMATCH: request worktree differs from the task receipt binding",
    );
    // Unlike the adapter-only boundary test below, this request is well-formed for the
    // adapter and must reach the Guard's receipt-to-worktree equality check.
    expect(core.audit.byKind("MANAGED_WRITE_GUARD").length).toBe(
      guardDecisionsBeforeReceiptWorktreeCheck + 1,
    );
    expect(providerLaunches).toBe(launchesBeforeReceiptWorktreeCheck);
    expect(existsSync(join(otherAllowed, "provider-started"))).toBe(false);

    const guardDecisionsBeforeBoundaryCheck = core.audit.byKind("MANAGED_WRITE_GUARD").length;
    const outsideAssignedWorktree = await adapter.invoke({
      prompt: "attempt a write outside the assigned worktree",
      workdir: runtimeRoot,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-outside-assigned-worktree",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: outsideTarget,
        taskId,
        taskReceiptId,
        assignedWorktreeId: assignedWorktree,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });
    expect(outsideAssignedWorktree.ok).toBe(false);
    expect(outsideAssignedWorktree.error).toContain("WRITE_TARGET_OUTSIDE_RUN_SCOPE");
    expect(existsSync(join(outsideTarget, "provider-started"))).toBe(false);
    // The adapter must reject this before it reaches the broker. If the adapter's
    // assigned-worktree check is removed, the guard audit below appears even though the
    // provider is ultimately refused by the later task-receipt check.
    expect(core.audit.byKind("MANAGED_WRITE_GUARD").length).toBe(guardDecisionsBeforeBoundaryCheck);

    const withGrant = await adapter.invoke({
      prompt: "write only inside the declared target",
      workdir: runtimeRoot,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-guarded-target",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: allowed,
        taskId,
        taskReceiptId,
        assignedWorktreeId: assignedWorktree,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });

    if (!seatbeltCanApply()) {
      // No unconfined fallback is allowed. The assertion above still proves an ungranted
      // request cannot launch; the platform-specific denial is exercised where seatbelt runs.
      expect(withGrant.ok).toBe(false);
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
      return;
    }

    expect(withGrant.ok, JSON.stringify(withGrant)).toBe(true);
    expect(readFileSync(join(allowed, "allowed.txt"), "utf8")).toBe("authorised");
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    expect(JSON.parse(withGrant.text)).toEqual({ outsideDenied: true });
    // Deleting the missing-grant branch changes its exact error above; deleting the broker
    // launches the stale-binding probe; restoring a workdir-wide profile allow creates
    // `escaped.txt`. Each change makes this test fail rather than merely weakening an audit.
  });
});
