import { afterAll, describe, expect, it } from "vitest";
import { symlinkSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import { isAcpError, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactStore } from "../../src/db/artifacts.ts";
import { Db } from "../../src/db/database.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION } from "../../src/doctor/repair.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import {
  createCtoMcpPort,
  createCtoServer,
  type CtoMcpPort,
} from "../../src/mcp/cto-server.ts";
import {
  createHermesMcpPort,
  createHermesServer,
  type HermesMcpPort,
} from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  bindWorker,
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

const denialCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return isAcpError(error) ? error.reasonCode : `unstructured:${String(error)}`;
  }
  return "not-denied";
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

describe("MCP evidence authority has no route through a tool handler (#352)", () => {
  it("accepts only factory-sealed operation ports, never the composition root", () => {
    const harness = makeHarness();
    const hermesPort = createHermesMcpPort(harness.cp);
    const ctoPort = createCtoMcpPort(harness.cp);
    const authenticate = () => allow(ReasonCode.OK, { actor: "port-surface-test" });

    // The root may own infrastructure, but its private evidence and completion capabilities
    // are not ordinary properties that a handler can reach.
    expect(Reflect.has(harness.cp, "evidenceWriters")).toBe(false);
    expect(Reflect.has(harness.cp, "completionAuthorities")).toBe(false);
    for (const port of [hermesPort, ctoPort]) {
      expect(Object.isFrozen(port)).toBe(true);
      for (const authority of ["db", "artifacts", "evidenceWriters", "completionAuthorities"]) {
        expect(Reflect.has(port, authority)).toBe(false);
      }
    }

    // A cast models an untyped caller. The module-private registration is the runtime
    // boundary: neither the root nor a structural copy is an MCP port.
    expect(() => createHermesServer(harness.cp as unknown as HermesMcpPort, authenticate))
      .toThrowError(/requires a sealed HermesMcpPort/);
    expect(() => createCtoServer(harness.cp as unknown as CtoMcpPort, authenticate))
      .toThrowError(/requires a sealed CtoMcpPort/);
    expect(() => createHermesServer({ ...hermesPort }, authenticate)).toThrowError(
      /requires a sealed HermesMcpPort/,
    );
    expect(() => createCtoServer({ ...ctoPort }, authenticate)).toThrowError(
      /requires a sealed CtoMcpPort/,
    );

    expect(createHermesServer(hermesPort, authenticate)).toBeDefined();
    expect(createCtoServer(ctoPort, authenticate)).toBeDefined();
  });

  it("issues evidence writers once for the underlying database file and refuses a symlink alias", () => {
    const root = tempDir("acp-evidence-file-");
    const databasePath = join(root, "state.sqlite");
    const aliasPath = join(root, "state-alias.sqlite");
    const clock = new ManualClock("2026-08-13T00:00:00.000Z");
    const first = new Db(databasePath);
    let samePath: Db | undefined;

    try {
      new ArtifactStore(first, clock).issueEvidenceWriters();

      samePath = new Db(databasePath);
      expect(samePath.file).toBe(first.file);
      expect(denialCode(() => samePath!.claimEvidenceWritePort())).toBe(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
      );
      // This deliberately names ArtifactStore's own guard. If its Set check is deleted,
      // Db's independent guard has a different message and this regression fails.
      expect(() => new ArtifactStore(samePath!, clock).issueEvidenceWriters()).toThrowError(
        /evidence writer capabilities were already issued for this database/,
      );

      symlinkSync(databasePath, aliasPath);
      // A state alias could be switched after an operator inspected the primary path, so
      // preflight rejects it before SQLite follows it. This takes precedence over the older
      // capability-domain alias behavior.
      expect(denialCode(() => new Db(aliasPath))).toBe(
        ReasonCode.STATE_PATH_INSECURE,
      );
    } finally {
      samePath?.close();
      first.close();
    }
  });

  it("rejects a raw evidence INSERT even with the genuine producer string and candidate", () => {
    const { db, clock } = (() => {
      const database = new Db(":memory:");
      const testClock = new ManualClock("2026-08-13T00:00:00.000Z");
      return { db: database, clock: testClock };
    })();
    const runId = "run_raw_evidence";
    const candidateSnapshotDigest = `sha256:${"a".repeat(64)}`;

    try {
      db.run(
        `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
         VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'raw evidence attack', 'sha256:contract', ?)`,
        [runId, clock.nowIso()],
      );
      // The raw attacker can make the prerequisite row and supply the expected metadata.
      // The database marker, not these strings, must still reject the evidence write.
      db.run(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                    content_json, produced_by, created_at)
         VALUES ('candidate_for_raw_attack', ?, 'CANDIDATE_SNAPSHOT', 'sha256:candidate', ?, '{}', 'service', ?)`,
        [runId, candidateSnapshotDigest, clock.nowIso()],
      );
      const evidence = JSON.stringify({ candidateSnapshotDigest });
      expect(
        denialCode(() =>
          db.run(
            `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                        content_json, produced_by, created_at)
             VALUES ('raw_evidence', ?, 'VERIFICATION', 'sha256:raw', ?, ?, 'verification-engine', ?)`,
            [runId, candidateSnapshotDigest, evidence, clock.nowIso()],
          ),
        ),
      ).toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
    } finally {
      db.close();
    }
  });
});

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
    const approval = {
      runId: null,
      operation: REPAIR_OWNER_APPROVAL_OPERATION,
      parameters: { operationId: "prune_orphan_worktrees", parameters: {}, dryRun: true },
      idempotencyKey: "repair-test-owner",
      approved: true,
    };
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      cli: { allowedActors: [TEST_OWNER.actor] },
    });
    const admitted = guard.admitOwnerApproval({
      channel: TEST_OWNER.channel,
      actor: TEST_OWNER.actor,
      nonce: `repair:${digestOf(approval)}`,
      payload: ownerApprovalPayload(approval),
    }, approval);
    expect(admitted.allowed).toBe(true);
    if (!admitted.allowed) return;
    const mismatched = await harness.cp.repair.execute({
      operationId: "prune_orphan_worktrees",
      parameters: { unexpected: "parameter" },
      authorizedBy: "OWNER",
      ownerApproval: admitted.value,
      dryRun: true,
    });
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    const allowed = await harness.cp.repair.execute({
      operationId: "prune_orphan_worktrees",
      parameters: {},
      authorizedBy: "OWNER",
      ownerApproval: admitted.value,
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
    const workerSessionId = bindWorker(harness, task.taskId);
    const execution = harness.cp.tasks.startExecution({
      runId,
      taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId,
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
