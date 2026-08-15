import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BuzzAdapter, BuzzCliTransport, InMemoryBuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { ClaimRegistry } from "../../src/claims/claim-registry.ts";
import { newRunId } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seededCore = () => {
  const core = makeCore();
  const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
  return { core, seeded };
};

const enqueue = (
  core: ReturnType<typeof makeCore>,
  seeded: ReturnType<typeof seedRun>,
  key = `outbox:${crypto.randomUUID()}`,
  ttlMs?: number,
) =>
  core.outbox.enqueue({
    idempotencyKey: key,
    roleKey: seeded.roleKey,
    bindingGeneration: seeded.generation,
    targetSessionId: seeded.sessionId,
    runId: seeded.runId,
    kind: MessageKind.RUN_DISPATCH,
    payload: { runId: seeded.runId },
    ttlMs,
  });

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected operation to throw");
};

describe("round-2 outbox fencing", () => {
  it("#378 delivers only the exact pending HANDOFF_PACKAGE to its unbound incoming session", () => {
    const { core, seeded } = seededCore();
    const incoming = core.sessions.create({ provider: "claude", model: "incoming-cto" });
    expect(core.sessions.transition(incoming.sessionId, SessionLifecycle.READY, "incoming handoff recipient").allowed)
      .toBe(true);
    const handoffId = "hof_delivery_path";
    core.db.run(
      `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                             to_session_id, package_json, digest, status, created_at)
       VALUES (?, ?, 'HANDOFF', ?, ?, ?, '{}', 'sha256:handoff', 'PENDING', ?)`,
      [
        handoffId,
        seeded.projectId,
        seeded.sessionId,
        seeded.generation,
        incoming.sessionId,
        core.clock.nowIso(),
      ],
    );

    const handoff = core.outbox.enqueue({
      idempotencyKey: `handoff:${handoffId}`,
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: incoming.sessionId,
      kind: MessageKind.HANDOFF_PACKAGE,
      payload: { handoffId },
    });
    expect(handoff.allowed).toBe(true);
    if (!handoff.allowed) return;

    // A pending handoff does not turn the incoming session into a general recipient.
    const forged = core.outbox.enqueue({
      idempotencyKey: "handoff:forged",
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: incoming.sessionId,
      kind: MessageKind.HANDOFF_PACKAGE,
      payload: { handoffId: "forged" },
    });
    expect(forged.allowed).toBe(false);
    expect(forged.reasonCode).toBe(ReasonCode.OUTBOX_TARGET_NOT_CURRENT);

    const claimed = core.outbox.claimDeliverable();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.messageId).toBe(handoff.value.messageId);
    expect(core.outbox.markSent(handoff.value.messageId, claimed[0]!.claimToken).allowed).toBe(true);
    expect(core.outbox.get(handoff.value.messageId)?.status).toBe("SENT");
  });

  it("#379 keeps an active DRAINING recipient deliverable so it can finish in-flight work", () => {
    const { core, seeded } = seededCore();
    const message = enqueue(core, seeded, "outbox:draining-recipient");
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;

    expect(core.sessions.transition(seeded.sessionId, SessionLifecycle.DRAINING, "replacement requested").allowed)
      .toBe(true);
    const claimed = core.outbox.claimDeliverable();
    expect(claimed).toHaveLength(1);
    expect(core.outbox.markSent(message.value.messageId, claimed[0]!.claimToken).allowed).toBe(true);
  });

  it("#48 fences an in-flight old-generation claim during failover", () => {
    const { core, seeded } = seededCore();
    const message = enqueue(core, seeded, "outbox:failover");
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;
    const claimed = core.outbox.claimDeliverable()[0]!;

    const successor = core.sessions.create({ provider: "claude", model: "successor" });
    core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "test successor");
    const switched = core.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId: seeded.projectId,
      sessionId: successor.sessionId,
      reason: "test failover",
      conversation: "REPLACED",
      takeover: true,
    });

    expect(switched.allowed).toBe(true);
    expect(core.outbox.get(claimed.messageId)?.status).toBe("REJECTED");
    expect(core.outbox.markSent(claimed.messageId, claimed.claimToken).reasonCode).toBe(
      ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
    );
    expect(
      core.outbox.markAttemptFailed(claimed.messageId, claimed.claimToken, {
        failureClass: "transient",
        retryable: true,
        error: "relay disconnected",
      }).reasonCode,
    ).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(claimed.messageId)?.status).toBe("REJECTED");
    expect(core.outbox.claimDeliverable()).toHaveLength(0);
  });

  it("#49 rejects an enqueue addressed to a session that does not hold the role", () => {
    const { core, seeded } = seededCore();
    const unrelated = core.sessions.create({ provider: "claude", model: "unrelated" });
    core.sessions.transition(unrelated.sessionId, SessionLifecycle.READY, "test unrelated");

    const refused = core.outbox.enqueue({
      idempotencyKey: "outbox:wrong-target",
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: unrelated.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.OUTBOX_TARGET_NOT_CURRENT);
  });

  it("#175 atomically rejects pending and in-flight messages when their target enters ERROR or STOPPED", () => {
    const { core, seeded } = seededCore();
    const inFlight = enqueue(core, seeded, "outbox:terminal-in-flight");
    expect(inFlight.allowed).toBe(true);
    if (!inFlight.allowed) return;
    const claimed = core.outbox.claimDeliverable()[0]!;
    const pending = enqueue(core, seeded, "outbox:terminal-pending");
    expect(pending.allowed).toBe(true);
    if (!pending.allowed) return;

    const errored = core.sessions.transition(seeded.sessionId, SessionLifecycle.ERROR, "runtime failed");
    expect(errored.reasonCode).toBe(ReasonCode.OK);

    for (const messageId of [claimed.messageId, pending.value.messageId]) {
      expect(
        core.db.get<{ status: string; reason_code: string }>(
          "SELECT status, reason_code FROM outbox WHERE message_id = ?",
          [messageId],
        ),
      ).toEqual({
        status: "REJECTED",
        reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
      });
    }
    expect(core.outbox.markSent(claimed.messageId, claimed.claimToken).reasonCode).toBe(
      ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
    );
    expect(core.outbox.claimDeliverable()).toHaveLength(0);

    const stopped = seededCore();
    const stoppedMessage = enqueue(stopped.core, stopped.seeded, "outbox:stopped-target");
    expect(stoppedMessage.allowed).toBe(true);
    if (!stoppedMessage.allowed) return;
    const stoppedTransition = stopped.core.sessions.transition(
      stopped.seeded.sessionId,
      SessionLifecycle.STOPPED,
      "operator stopped runtime",
    );
    expect(stoppedTransition.reasonCode).toBe(ReasonCode.OK);
    expect(
      stopped.core.db.get<{ status: string; reason_code: string }>(
        "SELECT status, reason_code FROM outbox WHERE message_id = ?",
        [stoppedMessage.value.messageId],
      ),
    ).toEqual({
      status: "REJECTED",
      reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
    });

    const missing = stopped.core.outbox.enqueue({
      idempotencyKey: "outbox:missing-target",
      roleKey: stopped.seeded.roleKey,
      bindingGeneration: stopped.seeded.generation,
      targetSessionId: "ses_does_not_exist",
      runId: stopped.seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: stopped.seeded.runId },
    });
    expect(missing.allowed).toBe(false);
    expect(missing.reasonCode).toBe(ReasonCode.OUTBOX_TARGET_NOT_CURRENT);
  });

  it("#173 denies a different request that reuses an idempotency key", () => {
    const { core, seeded } = seededCore();
    const first = enqueue(core, seeded, "outbox:collision");
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(
      core.db.get<{ request_fingerprint: string }>(
        "SELECT request_fingerprint FROM outbox WHERE message_id = ?",
        [first.value.messageId],
      )?.request_fingerprint,
    ).toMatch(/^sha256:/);
    expect(
      thrown(() =>
        core.db.run(
          "UPDATE outbox SET request_fingerprint = 'sha256:forged' WHERE message_id = ?",
          [first.value.messageId],
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH });

    const collision = core.outbox.enqueue({
      idempotencyKey: "outbox:collision",
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId, attackerReplacement: true },
    });

    expect(collision.allowed).toBe(false);
    expect(collision.reasonCode).toBe(ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH);
    core.outbox.retargetOrReject(seeded.roleKey, seeded.generation, 2, "ses_successor");
    const replay = enqueue(core, seeded, "outbox:collision");
    expect(replay.allowed).toBe(true);
    expect(replay.reasonCode).toBe(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED);
    expect(core.outbox.listByRun(seeded.runId)).toHaveLength(1);
  });

  it("#248 retains retarget provenance without admitting RETARGETED as a delivery state", () => {
    const { core, seeded } = seededCore();
    const message = enqueue(core, seeded, "outbox:retargeted");
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;

    const successor = core.sessions.create({ provider: "claude", model: "successor" });
    core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "test successor");
    const switched = core.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId: seeded.projectId,
      sessionId: successor.sessionId,
      reason: "test retarget",
      conversation: "REPLACED",
      takeover: true,
    });
    expect(switched.reasonCode).toBe(ReasonCode.OK);
    expect(
      core.db.get<{ status: string; reason_code: string }>(
        "SELECT status, reason_code FROM outbox WHERE message_id = ?",
        [message.value.messageId],
      ),
    ).toEqual({ status: "PENDING", reason_code: ReasonCode.OUTBOX_RETARGETED });
    expect(
      core.db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'",
      )?.sql,
    ).not.toMatch(/CHECK\s*\(status\s+IN\s*\([^)]*'RETARGETED'/);
    expect(core.outbox.claimDeliverable()[0]?.targetSessionId).toBe(successor.sessionId);
  });

  it("#51 terminally rejects a non-retryable delivery with its durable classification", () => {
    const { core, seeded } = seededCore();
    const message = enqueue(core, seeded, "outbox:permanent-failure");
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;
    const claimed = core.outbox.claimDeliverable()[0]!;
    const failed = core.outbox.markAttemptFailed(claimed.messageId, claimed.claimToken, {
      failureClass: "contract",
      retryable: false,
      error: "target address is invalid",
    });

    expect(failed.allowed).toBe(false);
    expect(failed.reasonCode).toBe(ReasonCode.OUTBOX_DELIVERY_REJECTED);
    expect(
      core.db.get<{
        status: string;
        failure_class: string;
        retry_eligible: number;
        next_attempt_at: string | null;
        reason_code: string;
      }>(
        `SELECT status, failure_class, retry_eligible, next_attempt_at, reason_code
           FROM outbox WHERE message_id = ?`,
        [claimed.messageId],
      ),
    ).toEqual({
      status: "REJECTED",
      failure_class: "contract",
      retry_eligible: 0,
      next_attempt_at: null,
      reason_code: ReasonCode.OUTBOX_DELIVERY_REJECTED,
    });
    expect(core.outbox.claimDeliverable()).toHaveLength(0);
  });

  it("#174 defers only retryable failures, then terminates at the bounded attempt policy", () => {
    const { core, seeded } = seededCore();
    const retryMessage = enqueue(core, seeded, "outbox:bounded-retry", 3 * 60 * 60 * 1000);
    expect(retryMessage.allowed).toBe(true);
    if (!retryMessage.allowed) return;
    core.db.run(
      `UPDATE outbox SET retry_max_attempts = 2, retry_backoff_ms = 2_500 WHERE message_id = ?`,
      [retryMessage.value.messageId],
    );
    expect(core.outbox.get(retryMessage.value.messageId)?.status).toBe("PENDING");
    const initialClaims = core.outbox.claimDeliverable();
    expect(initialClaims).toHaveLength(1);
    const firstClaim = initialClaims[0]!;
    const deferred = core.outbox.markAttemptFailed(firstClaim.messageId, firstClaim.claimToken, {
      failureClass: "transient",
      retryable: true,
      error: "relay temporarily unavailable",
    });
    expect(deferred.reasonCode).toBe(ReasonCode.OK);
    const deferredRow = core.db.get<{
      attempts: number;
      status: string;
      failure_class: string;
      retry_eligible: number;
      next_attempt_at: string | null;
    }>(
      `SELECT attempts, status, failure_class, retry_eligible, next_attempt_at
         FROM outbox WHERE message_id = ?`,
      [firstClaim.messageId],
    )!;
    expect(deferredRow).toMatchObject({
      attempts: 1,
      status: "PENDING",
      failure_class: "transient",
      retry_eligible: 1,
    });
    expect(deferredRow.next_attempt_at).not.toBeNull();
    expect(core.outbox.claimDeliverable()).toHaveLength(0);
    core.clock.advance(2_499);
    expect(core.outbox.claimDeliverable()).toHaveLength(0);
    core.clock.advance(1);
    const retryClaim = core.outbox.claimDeliverable()[0]!;
    const exhausted = core.outbox.markAttemptFailed(retryClaim.messageId, retryClaim.claimToken, {
      failureClass: "transient",
      retryable: true,
      error: "relay temporarily unavailable",
    });
    expect(exhausted.reasonCode).toBe(ReasonCode.OUTBOX_DELIVERY_REJECTED);
    expect(
      core.db.get<{
        attempts: number;
        status: string;
        failure_class: string;
        retry_eligible: number;
        next_attempt_at: string | null;
        reason_code: string;
      }>(
        `SELECT attempts, status, failure_class, retry_eligible, next_attempt_at, reason_code
           FROM outbox WHERE message_id = ?`,
        [retryClaim.messageId],
      ),
    ).toEqual({
      attempts: 2,
      status: "REJECTED",
      failure_class: "transient",
      retry_eligible: 0,
      next_attempt_at: null,
      reason_code: ReasonCode.OUTBOX_DELIVERY_REJECTED,
    });

    const zeroBackoff = enqueue(core, seeded, "outbox:zero-backoff");
    expect(zeroBackoff.allowed).toBe(true);
    if (!zeroBackoff.allowed) return;
    core.db.run(`UPDATE outbox SET retry_backoff_ms = 0 WHERE message_id = ?`, [
      zeroBackoff.value.messageId,
    ]);
    const zeroBackoffClaim = core.outbox.claimDeliverable()[0]!;
    const refusedZeroBackoff = core.outbox.markAttemptFailed(
      zeroBackoffClaim.messageId,
      zeroBackoffClaim.claimToken,
      {
        failureClass: "transient",
        retryable: true,
        error: "relay temporarily unavailable",
      },
    );
    expect(refusedZeroBackoff.reasonCode).toBe(ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE);
    expect(core.outbox.get(zeroBackoffClaim.messageId)?.status).toBe("REJECTED");
  });
});

describe("claim-registry expiry sweeps", () => {
  it("P1-03 heldByRun expires a stale row before returning claims", () => {
    const { core, seeded } = seededCore();
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
    core.db.run(`UPDATE resource_claims SET expires_at = ? WHERE run_id = ?`, [core.clock.nowIso(), seeded.runId]);

    expect(claims.heldByRun(seeded.runId)).toEqual([]);
    expect(core.db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE run_id = ?`, [seeded.runId]))
      .toEqual({ status: "EXPIRED" });
  });

  it("P1-03 held expires stale rows before listing the registry", () => {
    const { core, seeded } = seededCore();
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
    core.db.run(`UPDATE resource_claims SET expires_at = ? WHERE run_id = ?`, [core.clock.nowIso(), seeded.runId]);

    expect(claims.held()).toEqual([]);
    expect(core.db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE run_id = ?`, [seeded.runId]))
      .toEqual({ status: "EXPIRED" });
  });

  it("P1-03 advisoryOverlaps expires a stale advisory row before evaluating overlap", () => {
    const { core, seeded } = seededCore();
    const otherRunId = "run_advisory_expired";
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'expired advisory', 'sha256:c', ?)`,
      [otherRunId, seeded.projectId, core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, declared_path, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('expired_advisory', ?, 'src/other/file.ts', ?, ?, ?, ?, ?, 'HELD')`,
      [
        seeded.identity,
        otherRunId,
        seeded.sessionId,
        seeded.generation,
        core.clock.nowIso(),
        core.clock.nowIso(),
      ],
    );
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);

    expect(claims.advisoryOverlaps(seeded.identity, seeded.runId, ["src/other/request.ts"])).toEqual([]);
    expect(core.db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE claim_id = 'expired_advisory'`))
      .toEqual({ status: "EXPIRED" });
  });

  it("P1-03 release expires a stale row before checking whether it is held", () => {
    const { core, seeded } = seededCore();
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
    const claimId = core.db.get<{ claim_id: string }>(
      `SELECT claim_id FROM resource_claims WHERE run_id = ?`,
      [seeded.runId],
    )!.claim_id;
    core.db.run(`UPDATE resource_claims SET expires_at = ? WHERE claim_id = ?`, [core.clock.nowIso(), claimId]);

    const released = claims.release(claimId, seeded.runId);
    expect(released.allowed).toBe(false);
    expect(released.reasonCode).toBe(ReasonCode.CLAIM_NOT_HELD);
    expect(core.db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE claim_id = ?`, [claimId]))
      .toEqual({ status: "EXPIRED" });
  });
});

describe("round-2 Buzz transport and authority", () => {
  it("#123/#216 writes and closes the real CLI child's stdin", async () => {
    const root = tempDir("acp-buzz-cli-");
    const binary = join(root, "buzz");
    const received = join(root, "received.txt");
    writeFileSync(binary, "#!/bin/sh\ncat > \"$ACP_TEST_BUZZ_STDIN\"\n", "utf8");
    chmodSync(binary, 0o755);

    process.env["ACP_TEST_BUZZ_STDIN"] = received;
    try {
      await new BuzzCliTransport(binary).send("channel-test", "fenced body\n");
    } finally {
      delete process.env["ACP_TEST_BUZZ_STDIN"];
    }

    expect(readFileSync(received, "utf8")).toBe("fenced body\n");
  });

  it("#321/#124/#214 maps only an authenticated actor identity to an active binding", async () => {
    const { core, seeded } = seededCore();
    const adapter = new BuzzAdapter(
      core.db,
      core.clock,
      core.audit,
      core.sessions,
      core.bindings,
      core.outbox,
      new InMemoryBuzzTransport(),
    );
    const connected = await adapter.connect(seeded.sessionId, "shared-channel");
    expect(connected.allowed).toBe(true);
    expect(adapter.resolveActor("channel:shared-channel")).toBeNull();

    const actorSession = core.sessions.create({ provider: "claude", model: "actor-runtime" });
    if (!actorSession.sessionSecret) throw new Error("session secret was not issued");
    expect(
      core.sessions.transition(actorSession.sessionId, SessionLifecycle.READY, "actor runtime ready").reasonCode,
    ).toBe(ReasonCode.OK);
    expect(
      core.bindings.bind({ role: Role.CEO, sessionId: actorSession.sessionId }).reasonCode,
    ).toBe(ReasonCode.OK);

    const unauthenticated = core.sessions.bindBuzzActor(
      {
        sessionId: actorSession.sessionId,
        sessionSecret: actorSession.sessionSecret,
        buzzActorId: "actor:untrusted",
      },
      { isAllowedActor: () => false },
    );
    expect(unauthenticated.allowed).toBe(false);
    expect(unauthenticated.reasonCode).toBe(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED);
    expect(adapter.resolveActor("actor:untrusted")).toBeNull();

    const authenticated = core.sessions.bindBuzzActor(
      {
        sessionId: actorSession.sessionId,
        sessionSecret: actorSession.sessionSecret,
        buzzActorId: "actor:trusted",
      },
      { isAllowedActor: (channel, actor) => channel === "buzz" && actor === "actor:trusted" },
    );
    expect(authenticated.reasonCode).toBe(ReasonCode.OK);
    expect(adapter.resolveActor("actor:trusted")).toMatchObject({
      role: Role.CEO,
      sessionId: actorSession.sessionId,
      status: "ACTIVE",
    });
  });
});

describe("round-2 claim admission", () => {
  it("#157 refuses a current role generation used for another session's run", () => {
    const { core, seeded } = seededCore();
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
    const unrelated = core.sessions.create({ provider: "claude", model: "unrelated" });
    core.sessions.transition(unrelated.sessionId, SessionLifecycle.READY, "test unrelated");

    const refused = claims.acquire({
      runId: seeded.runId,
      ownerSessionId: unrelated.sessionId,
      ownerBindingGeneration: seeded.generation,
      ownerRoleKey: seeded.roleKey,
      repositoryIdentity: seeded.identity,
      declaredPaths: ["src/other.ts"],
    });

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CLAIM_OWNER_NOT_RUN_OWNER);
    expect(claims.heldByRun(seeded.runId).some((claim) => claim.declaredPath === "src/other.ts")).toBe(false);
  });

  it("#158/#229 canonicalizes equivalent write paths before rejecting conflicts", () => {
    const { core, seeded } = seededCore();
    const secondRunId = newRunId();
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, owner_session_id, owner_binding_generation,
                         owner_session_incarnation, owner_role_key, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'second run',
               'sha256:contract', ?, ?, 'inc-1', ?, ?)`,
      [
        secondRunId,
        seeded.projectId,
        seeded.sessionId,
        seeded.generation,
        seeded.roleKey,
        core.clock.nowIso(),
      ],
    );
    core.db.run(
      `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch)
       VALUES (?, ?, 'primary', 'dev')`,
      [secondRunId, seeded.repositoryId],
    );
    const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
    const first = claims.acquire({
      runId: seeded.runId,
      ownerSessionId: seeded.sessionId,
      ownerBindingGeneration: seeded.generation,
      ownerRoleKey: seeded.roleKey,
      repositoryIdentity: seeded.identity,
      declaredPaths: ["src/../README.md"],
    });
    expect(first.allowed).toBe(true);

    const conflict = claims.acquire({
      runId: secondRunId,
      ownerSessionId: seeded.sessionId,
      ownerBindingGeneration: seeded.generation,
      ownerRoleKey: seeded.roleKey,
      repositoryIdentity: seeded.identity,
      declaredPaths: ["README.md"],
    });

    expect(conflict.allowed).toBe(false);
    expect(conflict.reasonCode).toBe(ReasonCode.CLAIM_PATH_CONFLICT);
  });
});
