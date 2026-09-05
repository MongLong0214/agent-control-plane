import { afterAll, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ownerMessageLedger, startBuzzMessageIngressListener } from "../../src/daemon/agentcpd.ts";
import {
  buzzMessageNonce,
  buzzMessagePayload,
  buzzMessageSigningRequest,
} from "../../src/ingress/buzz-message.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { MessageKind, RETARGETABLE_KINDS } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { createConnection } from "node:net";

afterAll(cleanupTempDirs);

/**
 * `#760` Q2 §1/§2 — `inbound_messages.payload_json` is the *only* durable copy of an owner's
 * envelope, and the three facts admission produces are produced together or not at all.
 *
 * The rows here are written against the ways a plausible implementation still looks green: an
 * outbox payload that carries the text "for convenience" beside the pointer; an enqueue that
 * happens after the inbound row has already been committed, so a failure leaves a spent nonce with
 * nothing addressed to anybody; and a turn claim minted from a fresh UUID rather than from the
 * outbox message id, which reads identically on a passing run and leaves the ingress claim with no
 * way to name the outbox row it is holding open.
 */

const SECRET = "owner-message-durable-copy-secret";
const OWNER = "npub-owner";
const RELAY_ACTORS = [OWNER];
const CTO_MENTION = "npub-cto-of-record";

const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

const envelope = (input: {
  eventId: string;
  text: string;
  addressedTo?: string;
  mention?: unknown;
}) => {
  const message = {
    actor: OWNER,
    conversation: "buzz-ceo-room",
    eventId: input.eventId,
    addressedTo: input.addressedTo ?? "CTO",
    mention: input.mention ?? CTO_MENTION,
    text: input.text,
  };
  return { ...message, signature: ingressSignature(SECRET, buzzMessageSigningRequest(message)) };
};

const exchangeSocketLine = (socketPath: string, line: unknown): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    let settled = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        rejectExchange(new Error("local socket response timed out"));
      }
    }, 10_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectExchange(error);
      else resolveExchange(received);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(line)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes('"reasonCode"')) socket.end();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });

/** A live session that holds the project's CTO role and answers to `CTO_MENTION`. */
const readyBoundSession = (
  harness: ReturnType<typeof makeHarness>,
  model: string,
  projectIds: readonly string[],
): { sessionId: string; incarnation: string; sessionSecret: string } => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode,
  ).toBe(ReasonCode.OK);
  for (const projectId of projectIds) {
    const bound = harness.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: session.sessionId,
      projectId,
    });
    if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
  }
  const actor = harness.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: CTO_MENTION },
    anyBuzzActorIsAuthenticated,
  );
  if (!actor.allowed) throw new Error(`buzz actor binding failed: ${actor.message}`);
  return {
    sessionId: session.sessionId,
    incarnation: harness.cp.sessions.require(session.sessionId).incarnation,
    sessionSecret: session.sessionSecret!,
  };
};

const roleConversationFor = (harness: ReturnType<typeof makeHarness>): RoleConversationPort =>
  new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (roleKey) => harness.cp.bindings.active(roleKey),
    currentCandidates: () =>
      harness.cp.projects
        .list()
        .map((project) => harness.cp.bindings.activePrimaryCto(project.projectId))
        .filter((binding): binding is NonNullable<typeof binding> => binding !== null),
  });

const stillHeldBy = (session: { sessionId: string; incarnation: string }): McpPeerAuthenticator =>
  () =>
    allow(ReasonCode.OK, {
      actor: "role-peer",
      sessionId: session.sessionId,
      sessionIncarnation: session.incarnation,
    });

const fakeRolePeer = () =>
  ({
    server: {
      getClientCapabilities: () => ({ sampling: {} }),
      getClientVersion: () => ({ name: "claude-code", version: "2.1.259" }),
      createMessage: async () => ({
        model: "fake",
        role: "assistant",
        content: { type: "text", text: "받았다" },
      }),
    },
  }) as never;

const outboxRows = (harness: ReturnType<typeof makeHarness>) =>
  harness.cp.db.all<{
    message_id: string;
    kind: string;
    status: string;
    payload_json: string;
    role_key: string;
    binding_generation: number;
    target_session_id: string;
  }>(
    `SELECT message_id, kind, status, payload_json, role_key, binding_generation, target_session_id
       FROM outbox ORDER BY created_at`,
    [],
  );

const inboundRow = (harness: ReturnType<typeof makeHarness>, eventId: string) =>
  harness.cp.db.get<{ payload_json: string | null; turn_claim_json: string | null }>(
    `SELECT payload_json, turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
    [buzzMessageNonce(eventId)],
  ) ?? null;

describe("an owner's message has exactly one durable copy, and admission produces three facts or none", () => {
  it("enqueues a non-retargetable pointer whose turn request id is the outbox message id", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = readyBoundSession(harness, "cto-one-copy", [projectId]);

    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
    const listener = await startBuzzMessageIngressListener(
      harness.cp,
      tempDir("acp-owner-message-"),
      { allowedActors: RELAY_ACTORS, secret: SECRET },
      { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER], roleConversation },
    );

    const text = "CTO, 이 한 문장은 한 번만 저장된다";
    const sent = envelope({ eventId: "evt-one-copy", text });
    try {
      const answered = await exchangeSocketLine(listener.socketPath, sent);
      expect(JSON.parse(answered.trim())).toMatchObject({ ok: true });

      const rows = outboxRows(harness);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.kind).toBe(MessageKind.OWNER_MESSAGE);
      expect(row.status).toBe("PENDING");
      expect(row.role_key).toBe(roleKey);
      expect(row.binding_generation).toBe(harness.cp.bindings.active(roleKey)!.bindingGeneration);
      expect(row.target_session_id).toBe(session.sessionId);
      // Non-retargetable by the set that decides it, not by a literal that can drift.
      expect(RETARGETABLE_KINDS.has(MessageKind.OWNER_MESSAGE)).toBe(false);

      // The whole of the outbox payload: an immutable pointer, and nothing that is the message.
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload).toEqual({
        sourceChannel: "buzz",
        sourceNonce: buzzMessageNonce("evt-one-copy"),
        // The *full signed payload*, not only the text: a digest over the text alone would let a
        // captured envelope be re-pointed at another recipient and still verify at claim time.
        sourcePayloadDigest: digestOf(buzzMessagePayload(sent)),
      });
      // Said again as a property rather than as a shape, because the shape check above passes if
      // some later field carries the words in a differently named key.
      expect(row.payload_json).not.toContain(text);

      // One durable copy, and it is the ingress row.
      const inbound = inboundRow(harness, "evt-one-copy");
      expect(JSON.parse(inbound!.payload_json!)).toMatchObject({ text });

      // The outbox message id *is* the turn request identity, so the unresolved ingress claim
      // names the outbox row that is holding it open.
      const claim = JSON.parse(inbound!.turn_claim_json!) as { turnRequestId: string };
      expect(claim.turnRequestId).toBe(row.message_id);
    } finally {
      await listener.close();
    }
  }, 30_000);

  /**
   * The failure is injected where production would meet it — a colliding idempotency key already
   * in the outbox — and reached **through the ingress socket**, never by calling `enqueue`.
   *
   * Calling `enqueue` directly would measure the outbox's own refusal, which Q1 already covers,
   * and would say nothing about whether the inbound row admitted a moment earlier survives it.
   * That surviving row is the whole defect: a spent `(buzz, nonce)` slot addressed to nobody means
   * the owner's next attempt at the same event is refused as a replay of a turn that never ran.
   */
  it("leaves no admitted row and no spent nonce when the enqueue underneath it refuses", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = readyBoundSession(harness, "cto-rollback", [projectId]);

    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
    const listener = await startBuzzMessageIngressListener(
      harness.cp,
      tempDir("acp-owner-message-"),
      { allowedActors: RELAY_ACTORS, secret: SECRET },
      { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER], roleConversation },
    );

    // The collision: this event id's idempotency key is already taken by a row with a different
    // request fingerprint, so the admission's own enqueue is refused rather than suppressed.
    const blocker = harness.cp.outbox.enqueue({
      idempotencyKey: `owner-message:${buzzMessageNonce("evt-rollback")}`,
      roleKey,
      bindingGeneration: harness.cp.bindings.active(roleKey)!.bindingGeneration,
      targetSessionId: session.sessionId,
      runId: null,
      kind: MessageKind.OWNER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: "a different event", sourcePayloadDigest: "x" },
    });
    expect(blocker.allowed).toBe(true);

    try {
      const refused = await exchangeSocketLine(
        listener.socketPath,
        envelope({ eventId: "evt-rollback", text: "이 메시지는 남지 않는다" }),
      );
      expect(JSON.parse(refused.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
      });

      // Nothing half-admitted: no inbound row at all, so the nonce was never spent.
      expect(inboundRow(harness, "evt-rollback")).toBeNull();
      // And nothing half-enqueued: the blocker is still the only outbox row.
      expect(outboxRows(harness).map((row) => row.message_id)).toEqual([
        blocker.allowed ? blocker.value.messageId : "",
      ]);

      // The positive control, and the assertion that makes the two above mean "rolled back"
      // rather than "refused before it started": with the collision gone the *same event id* is
      // admitted, which it could not be if the first attempt had consumed its nonce.
      harness.cp.db.run(`DELETE FROM outbox WHERE message_id = ?`, [
        blocker.allowed ? blocker.value.messageId : "",
      ]);
      const admitted = await exchangeSocketLine(
        listener.socketPath,
        envelope({ eventId: "evt-rollback", text: "이 메시지는 남지 않는다" }),
      );
      expect(JSON.parse(admitted.trim())).toMatchObject({ ok: true });
      expect(inboundRow(harness, "evt-rollback")).not.toBeNull();
      expect(outboxRows(harness)).toHaveLength(1);
    } finally {
      await listener.close();
    }
  }, 30_000);

  /**
   * §5/§6, entered at the production ledger the connection-bound tools call.
   *
   * The tools' own half — that a caller may name only a lookup key and that the holder identity is
   * derived from the authenticated connection — is measured over a real socket in
   * `the-cto-socket-has-a-live-peer.test.ts`. What is measured here is what happens *after* an
   * identity has been derived, which is the half that touches two ledgers.
   */
  it("hands over once, replays nothing after a crash, and closes both ledgers together", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = readyBoundSession(harness, "cto-settle", [projectId]);

    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
    const listener = await startBuzzMessageIngressListener(
      harness.cp,
      tempDir("acp-owner-message-"),
      { allowedActors: RELAY_ACTORS, secret: SECRET },
      { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER], roleConversation },
    );

    const text = "이 문장은 한 번만 건네진다";
    try {
      const admitted = await exchangeSocketLine(
        listener.socketPath,
        envelope({ eventId: "evt-settle", text }),
      );
      expect(JSON.parse(admitted.trim())).toMatchObject({ ok: true });

      const binding = harness.cp.bindings.active(roleKey)!;
      const holder = {
        roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        sessionIncarnation: binding.sessionIncarnation,
      };
      const ledger = ownerMessageLedger(harness.cp);

      const first = ledger.claim(holder);
      expect(first.allowed).toBe(true);
      if (!first.allowed) return;
      const messageId = first.value.claimed!.messageId;
      expect(first.value.claimed!.text).toBe(text);
      expect(first.value.unresolved).toEqual([]);
      expect(harness.cp.outbox.get(messageId)?.status).toBe("SENT");

      // The crash: the holder took the payload and never came back. A second claim is what the
      // replacement runtime — or the same one after a restart — does, and it must learn that
      // something is unsettled without being handed the words a second time.
      const afterCrash = ledger.claim(holder);
      expect(afterCrash.allowed).toBe(true);
      if (!afterCrash.allowed) return;
      expect(afterCrash.value.claimed).toBeNull();
      expect(afterCrash.value.unresolved.map((row) => row.messageId)).toEqual([messageId]);
      // Payload-free by the shape of what came back, not by a field that happens to be undefined.
      expect(JSON.stringify(afterCrash.value.unresolved)).not.toContain(text);
      expect(Object.keys(afterCrash.value.unresolved[0]!)).not.toContain("payload");

      // Both ledgers, together. Before the settle the ingress claim is outstanding: that is what
      // keeps `prune` off the one durable copy while the outbox row is unresolved.
      const beforeSettle = JSON.parse(inboundRow(harness, "evt-settle")!.turn_claim_json!) as {
        repliedAt?: unknown;
        noReplyAt?: unknown;
      };
      expect(beforeSettle.noReplyAt).toBeUndefined();

      const completed = ledger.complete(messageId, holder);
      expect(completed.reasonCode).toBe(ReasonCode.OK);
      expect(harness.cp.outbox.get(messageId)?.status).toBe("ACKED");
      const settledClaim = JSON.parse(inboundRow(harness, "evt-settle")!.turn_claim_json!) as {
        repliedAt?: unknown;
        noReplyAt?: unknown;
      };
      expect(settledClaim.noReplyAt).toEqual(expect.any(String));
      // Never `repliedAt`. Nothing handed a reply to any transport, and writing that fact would
      // tell every later reader the owner has an answer nobody produced.
      expect(settledClaim.repliedAt).toBeUndefined();

      // An exact duplicate completion is the ordinary lost-acknowledgement retry, not an error.
      expect(ledger.complete(messageId, holder).allowed).toBe(true);

      // A different runtime holding the same binding fails closed. The tuple differs only in the
      // incarnation, which is the one field a respawn changes and the only thing separating the
      // conversation this message was addressed to from the one that replaced it.
      const stranger = { ...holder, sessionIncarnation: `${holder.sessionIncarnation}-respawned` };
      expect(ledger.complete(messageId, stranger).allowed).toBe(false);
      expect(ledger.reject(messageId, stranger).allowed).toBe(false);
    } finally {
      await listener.close();
    }
  }, 30_000);

  /**
   * A claim whose source no longer matches its pointer hands over nothing and burns the row.
   *
   * Re-serving it would be the worse failure: the row would stay `PENDING`, every claim would
   * re-take it, and the holder would be handed a payload from whatever the pointer now resolves
   * to. So the just-claimed row is terminally rejected, and that rejection has to survive the
   * denial it travels with.
   */
  it("returns no text and terminally rejects when the source does not match its pointer", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = readyBoundSession(harness, "cto-mismatch", [projectId]);

    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
    const listener = await startBuzzMessageIngressListener(
      harness.cp,
      tempDir("acp-owner-message-"),
      { allowedActors: RELAY_ACTORS, secret: SECRET },
      { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER], roleConversation },
    );

    try {
      expect(
        JSON.parse(
          (
            await exchangeSocketLine(
              listener.socketPath,
              envelope({ eventId: "evt-mismatch", text: "원본" }),
            )
          ).trim(),
        ),
      ).toMatchObject({ ok: true });

      // The pointer is re-aimed at a *different* admitted envelope — the same shape a stale or
      // rewritten pointer has, and the one thing a claim that trusted its pointer would follow.
      // (`inbound_messages.payload_json` itself is immutable at the schema level, so the only way
      // the two can disagree is from the outbox side, which is exactly the side the digest binds.)
      expect(
        JSON.parse(
          (
            await exchangeSocketLine(
              listener.socketPath,
              envelope({ eventId: "evt-other", text: "누군가 바꿔 넣은 문장" }),
            )
          ).trim(),
        ),
      ).toMatchObject({ ok: true });
      const target = outboxRows(harness).find(
        (row) => JSON.parse(row.payload_json).sourceNonce === buzzMessageNonce("evt-mismatch"),
      )!;
      harness.cp.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [
        JSON.stringify({
          ...(JSON.parse(target.payload_json) as Record<string, unknown>),
          sourceNonce: buzzMessageNonce("evt-other"),
        }),
        target.message_id,
      ]);

      const binding = harness.cp.bindings.active(roleKey)!;
      const claimed = ownerMessageLedger(harness.cp).claim({
        roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        sessionIncarnation: binding.sessionIncarnation,
      });
      expect(claimed.allowed).toBe(false);
      expect(claimed.reasonCode).toBe(ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH);
      // No text anywhere in what came back — neither the original nor the one it was re-aimed at.
      expect(JSON.stringify(claimed)).not.toContain("누군가 바꿔 넣은 문장");
      expect(JSON.stringify(claimed)).not.toContain("원본");
      // Terminal, and committed: the row is not waiting to be served again.
      expect(
        outboxRows(harness).find((row) => row.message_id === target.message_id)?.status,
      ).toBe("REJECTED");
    } finally {
      await listener.close();
    }
  }, 30_000);
});
