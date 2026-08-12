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

describe("round-2 outbox fencing", () => {
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
      takeover: true,
    });

    expect(switched.allowed).toBe(true);
    expect(core.outbox.get(claimed.messageId)?.status).toBe("REJECTED");
    expect(core.outbox.markSent(claimed.messageId, claimed.claimToken).reasonCode).toBe(
      ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
    );
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

  it("#175 fences a retained message when its target enters ERROR", () => {
    const { core, seeded } = seededCore();
    const message = enqueue(core, seeded, "outbox:terminal-target");
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;
    core.sessions.transition(seeded.sessionId, SessionLifecycle.ERROR, "runtime failed");

    expect(core.outbox.claimDeliverable()).toHaveLength(0);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("REJECTED");
  });

  it("#173 denies a different request that reuses an idempotency key", () => {
    const { core, seeded } = seededCore();
    core.db.exec(`ALTER TABLE outbox ADD COLUMN request_fingerprint TEXT;`);
    const first = enqueue(core, seeded, "outbox:collision");
    expect(first.allowed).toBe(true);
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

  it("#51/#174 records classified bounded retries and fails closed before the retry migration", () => {
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
    expect(failed.reasonCode).toBe(ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE);
    expect(core.outbox.get(claimed.messageId)?.status).toBe("REJECTED");
    expect(core.outbox.claimDeliverable()).toHaveLength(0);

    core.db.exec(`ALTER TABLE outbox ADD COLUMN failure_class TEXT;
                  ALTER TABLE outbox ADD COLUMN retry_eligible INTEGER;
                  ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;`);
    const retryMessage = enqueue(core, seeded, "outbox:bounded-retry", 3 * 60 * 60 * 1000);
    expect(retryMessage.allowed).toBe(true);
    if (!retryMessage.allowed) return;
    expect(core.outbox.get(retryMessage.value.messageId)?.status).toBe("PENDING");
    const initialClaims = core.outbox.claimDeliverable();
    expect(initialClaims).toHaveLength(1);
    let retryClaim = initialClaims[0]!;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = core.outbox.markAttemptFailed(retryClaim.messageId, retryClaim.claimToken, {
        failureClass: "transient",
        retryable: true,
        error: "relay temporarily unavailable",
      });
      expect(result.allowed).toBe(true);
      const row = core.db.get<{
        attempts: number;
        status: string;
        failure_class: string;
        retry_eligible: number;
        next_attempt_at: string | null;
      }>(
        `SELECT attempts, status, failure_class, retry_eligible, next_attempt_at
           FROM outbox WHERE message_id = ?`,
        [retryClaim.messageId],
      )!;
      expect(row.attempts).toBe(attempt);
      expect(row.failure_class).toBe("transient");
      if (attempt === 5) {
        expect(row.status).toBe("REJECTED");
        expect(row.retry_eligible).toBe(0);
        expect(row.next_attempt_at).toBeNull();
        break;
      }
      expect(row.status).toBe("PENDING");
      expect(row.retry_eligible).toBe(1);
      expect(core.outbox.claimDeliverable()).toHaveLength(0);
      core.clock.advance(30 * 60 * 1000);
      retryClaim = core.outbox.claimDeliverable()[0]!;
    }
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

  it("#124/#214 never authorizes an actor by a delivery channel address", async () => {
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
