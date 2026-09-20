import { afterAll, describe, expect, it } from "vitest";

import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  IngressGuard,
  type OwnerBatchCanonicalClaim,
  type TurnIdentity,
} from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { TelegramHermesRouter } from "../../src/ingress/telegram-router.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #858, the router's half of the missing writer.
 *
 * `canonical_turns` has exactly one writer — `ConversationTurnCoordinator.claim()` — and no
 * production caller, so the canonical ledger stayed empty while `inbound_messages.turn_claim_json`
 * held the real turn. Four adjudication surfaces and a 60s reconcile sweep therefore passed over
 * an empty row set: not two ledgers with different counts, two ledgers holding different turns.
 *
 * The bridge is a narrow port rather than the coordinator itself, because the router is sealed
 * away from the ControlPlane by design. This measures the router end: after it claims a DIRECT
 * message, it hands that exact nonce and prompt over. The coordinator end is a closure assembled
 * in `telegram-polling`, where `cp` is in scope.
 *
 * Why the port and not `canonical_turns` directly: the coordinator refuses a turn whose actor has
 * no verified target, and this fixture binds no Hermes CEO. Asserting on the row would measure the
 * fixture's binding rather than the router's behaviour — and would have passed for a router that
 * never called anything, since the row is absent either way.
 */
const SECRET = "telegram-secret";
const NOW = "2026-09-20T00:00:00.000Z";

const canonicalTarget = (harness: ReturnType<typeof makeHarness>, name: string) => {
  const targetActorId = `actor:${name}`;
  const targetBindingId = `bind:${name}`;
  const targetAttestationId = `att:${name}`;
  const executorSessionId = `runtime:${name}`;
  const assignmentId = `asg:${name}`;
  harness.cp.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc', 'claude', 'opus', 'READY', ?, ?)`,
    [executorSessionId, NOW, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc', ?)`,
    [targetActorId, executorSessionId, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [targetBindingId, targetActorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [assignmentId, `CEO:${name}`, targetActorId, executorSessionId, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc', 1, ?, ?)`,
    [targetAttestationId, targetBindingId, `attd:${name}`, executorSessionId, assignmentId, NOW],
  );
  return (identity: TurnIdentity) => ({
    turnRequestId: identity.turnRequestId,
    targetActorId,
    promptDigest: identity.promptDigest,
    bindingGeneration: 1,
    targetBindingId,
    targetAttestationId,
    executorSessionId,
    executorSessionIncarnation: "inc",
  });
};

afterAll(() => {
  cleanupTempDirs();
});

const buildRouter = (
  harness: ReturnType<typeof makeHarness>,
  materializeTurn?: (input: OwnerBatchCanonicalClaim & { prompt: string }) => Decision<void>,
  directHandler?: (input: { text: string }) => string,
  canonicalTargetForClaim?: (identity: TurnIdentity) => ReturnType<ReturnType<typeof canonicalTarget>>,
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["424242"], allowedConversations: ["999"], recoverInFlight: true },
  }, canonicalTargetForClaim ? { canonicalTargetForClaim } : {});
  const ingress = new TelegramIngress(guard, { webhookSecret: SECRET });
  const router = new TelegramHermesRouter({
    ingress,
    hermes: createHermesMcpPort(harness.cp),
    currentCandidateSnapshotDigest: () => null,
    bindingGeneration: () => null,
    ...(materializeTurn ? { materializeTurn } : {}),
    ...(directHandler ? { directHandler } : {}),
  });
  return { guard, ingress, router };
};

const update = (updateId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_700_000_000,
    text,
    from: { id: 424242, username: "owner" },
    chat: { id: 999 },
  },
});

describe("#858 the router hands a claimed turn to the canonical ledger", () => {
  it("hands over the nonce and prompt it just claimed", async () => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "handoff");
    const handed: Array<{ channel: string; nonce: string; prompt: string }> = [];
    const { ingress, router } = buildRouter(harness, ({ sources, prompt }) => {
      const source = sources[0]!;
      handed.push({ channel: source.channel, nonce: source.nonce, prompt });
      return allow(ReasonCode.OK, undefined);
    }, undefined, targetForClaim);

    const inbound = update(8581, "이 문장은 canonical 원장의 증인이다.");
    await router.route(inbound, SECRET);

    expect(handed, "the router claimed a DIRECT turn and told the canonical ledger nothing").toHaveLength(1);
    expect(handed[0]?.channel).toBe("telegram");
    expect(handed[0]?.prompt).toBe("이 문장은 canonical 원장의 증인이다.");
    // The nonce has to be the one the ingress claimed, not a fresh one: a bridge that invents an
    // identifier writes a canonical turn nobody can match back to the message it answered.
    expect(handed[0]?.nonce, "the handed nonce is not the one the ingress claimed").toBe(
      ingress.nonceFor(inbound),
    );
  });

  it("keeps the ingress claim and owner outcome when additive canonical materialization refuses", async () => {
    const baselineHarness = makeHarness();
    let baselineExecutions = 0;
    const baseline = buildRouter(
      baselineHarness,
      undefined,
      () => {
        baselineExecutions += 1;
        return "owner handled";
      },
    );
    const baselineParked = update(8582, "first");
    expect(baseline.ingress.admit(baselineParked, SECRET).allowed).toBe(true);
    baseline.guard.parkForBatch(
      baseline.ingress.nonceFor(baselineParked),
      baseline.ingress.turnIdentityFor(baselineParked, "first", null, null).sessionDigest,
    );

    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "refusing");
    let executions = 0;
    const handedSources: OwnerBatchCanonicalClaim["sources"][] = [];
    const refusing = buildRouter(
      harness,
      ({ sources }) => {
        handedSources.push(sources);
        return deny(ReasonCode.CONVERSATION_TARGET_UNVERIFIED, "no verified target", {});
      },
      () => {
        executions += 1;
        return "owner handled";
      },
      targetForClaim,
    );
    const refusingParked = update(8582, "first");
    expect(refusing.ingress.admit(refusingParked, SECRET).allowed).toBe(true);
    refusing.guard.parkForBatch(
      refusing.ingress.nonceFor(refusingParked),
      refusing.ingress.turnIdentityFor(refusingParked, "first", null, null).sessionDigest,
    );

    const baselineOutcome = await baseline.router.route(update(8583, "second"), SECRET);
    const refusedOutcome = await refusing.router.route(update(8583, "second"), SECRET);

    expect(handedSources).toHaveLength(1);
    expect(handedSources[0]?.map(({ nonce, payload }) => ({ nonce, payload }))).toEqual([
      { nonce: "update:8582", payload: expect.objectContaining({ text: "first", messageId: 8582 }) },
      { nonce: "update:8583", payload: expect.objectContaining({ text: "second", messageId: 8583 }) },
    ]);
    expect(executions).toBe(1);
    expect(baselineExecutions).toBe(1);
    expect(refusedOutcome).toEqual(baselineOutcome);
    expect(harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inbound_messages WHERE turn_claim_json IS NOT NULL`,
    )?.count).toBe(2);
    expect(harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM canonical_turns`,
    )?.count).toBe(0);
  });

  it("publishes every consumed nonce to the canonical ledger in arrival order", async () => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "owner-batch");
    const { guard, ingress, router } = buildRouter(
      harness,
      ({ target, prompt, sources }) => {
        const claimed = harness.cp.conversation.claim({
          targetActorId: target.targetActorId,
          prompt,
          sources,
        });
        return claimed.allowed
          ? allow(ReasonCode.OK, undefined)
          : deny(claimed.reasonCode, claimed.message, claimed.evidence);
      },
      undefined,
      targetForClaim,
    );
    const parked = update(8583, "first");
    expect(ingress.admit(parked, SECRET).allowed).toBe(true);
    const scope = ingress.turnIdentityFor(parked, "first", null, null).sessionDigest;
    guard.parkForBatch(ingress.nonceFor(parked), scope);

    await router.route(update(8584, "second"), SECRET);

    const ingressClaim = JSON.parse(harness.cp.db.get<{ turn_claim_json: string }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8584'`,
    )!.turn_claim_json) as { batchConsumedNonces: string[] };
    const canonicalSources = harness.cp.db.all<{ source_nonce: string; batch_ordinal: number }>(
      `SELECT source_nonce, batch_ordinal FROM canonical_turn_sources ORDER BY batch_ordinal`,
    );
    expect(canonicalSources.map((source) => source.source_nonce)).toEqual(ingressClaim.batchConsumedNonces);
    expect(canonicalSources.map((source) => source.batch_ordinal)).toEqual([0, 1]);
  });
});
