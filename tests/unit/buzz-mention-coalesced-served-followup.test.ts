import { chmodSync } from "node:fs";

import { afterAll, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startBuzzMessageIngressListener, startDaemonBuzzMentionSubscriber, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { SessionWakeTrigger } from "../../src/runtime/provisioned-session-runtime.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);

/**
 * A verified mention arrives while a driven PRIMARY_CTO's ordinary turn is running, so its trigger
 * is coalesced into the follow-up turn. The running turn then claims the mention's message itself:
 * the event is spent before the follow-up starts. The follow-up must make no provider call for it.
 *
 * - `mention only`: the mention is the only coalesced trigger. The follow-up is refused at its final
 *   check (`SESSION_TURN_DUPLICATE`), the trigger is marked handled, and no provider call is made.
 * - `mention and ordinary work`: an ordinary request coalesced beside it still runs its follow-up,
 *   exactly as before; only the served mention is dropped from it.
 *
 * Real driven holder through the production bootstrap, attestation, credential and socket paths;
 * only the provider is a double.
 */

const ROOM = "room-coalesced";
const WAIT = { timeout: 30_000, interval: 50 };

type ClaimAnswer = { ok?: boolean; value?: { claimed?: { provenance?: { eventId?: string } } | null } };

for (const variant of ["mention only", "mention and ordinary work"] as const) {
  it(`a coalesced mention the running turn already claimed makes no follow-up provider call: ${variant}`, async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, "coalesced-served");
      const bootstrap = await f.dispatchBootstrap();
      const bound = await cp.cto.ensureDrivenPrimaryCto("coalesced-served", bootstrap.runId);
      if (!bound.allowed) throw new Error(bound.message);
      const binding = bound.value;
      const session = cp.sessions.require(binding.sessionId);
      const dir = tempDir("acp-coalesced-");
      chmodSync(dir, 0o700);
      const cto = channelKey(dir, "cto.key");
      const owner = channelKey(dir, "owner.key");
      cp.sessions.setBuzzAddress(binding.sessionId, ROOM);
      expect(cp.sessions.bindBuzzActor(
        { sessionId: binding.sessionId, sessionSecret: f.claude.credentials.get(binding.sessionId)!.sessionSecret, buzzActorId: cto.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
      const listeners = await startLocalMcpListeners(cp, dir, "coalesced-served-token");
      const policy = { allowedActors: [owner.pubkey], secret: "coalesced-served-secret" };
      const ingress = await startBuzzMessageIngressListener(cp, dir, policy, {
        ceoConversation: new CeoConversationPort(),
        ownerActors: [owner.pubkey],
        roleConversation: listeners.ctoConversation,
      });
      const relay = storingRelay();
      const subscriber = startDaemonBuzzMentionSubscriber(cp, dir, policy, ingress, {
        openSocket: relay.factory,
        scheduler: steppedClock().scheduler,
        reportAdmission: () => undefined,
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let workTurns = 0;
      const claims: ClaimAnswer[] = [];
      const wakes = vi.spyOn(cp.sessionRuntime, "wake");
      const enqueue = (key: string) =>
        cp.outbox.enqueue({
          idempotencyKey: key,
          roleKey: binding.roleKey,
          bindingGeneration: binding.bindingGeneration,
          targetSessionId: binding.sessionId,
          runId: null,
          kind: MessageKind.CANCEL_REQUEST,
          payload: { reason: key },
        });
      const external = session.incarnation.split("#")[0];
      const providerCalls = (): number =>
        f.claude.turns.filter((turn) => turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
      const duplicateRefusals = (): number =>
        cp.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN_REFUSED' AND session_id = ? AND reason_code = ?`,
          [binding.sessionId, ReasonCode.SESSION_TURN_DUPLICATE],
        )!.n;
      try {
        await relay.drain(subscriber);
        expect(subscriber.admission().identities[0]?.state).toBe("ADMITTED");
        f.claude.onWorkTurn = async (_request, credential) => {
          if (credential?.sessionId !== binding.sessionId) return;
          workTurns += 1;
          const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
          // The running turn: held until the mention has been coalesced, then it claims the
          // mention's message itself, spending the event before its follow-up starts.
          if (workTurns === 1) await barrier;
          claims.push(await callMcpToolOverSocket(f.ctoSocket, as, "role_owner_message_claim", { roleKey: binding.roleKey }) as ClaimAnswer);
        };
        const finishedBefore = f.finishedTurns(binding.sessionId);
        expect(enqueue("coalesced-first-ordinary").allowed).toBe(true);
        await vi.waitFor(() => expect(workTurns).toBe(1), WAIT);
        const before = providerCalls();

        f.harness.clock.advance(1_000);
        const event = signedMention({
          author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: Math.floor(Date.parse(cp.clock.nowIso()) / 1000), text: "mention coalesced behind a running turn",
        });
        relay.publish(event);
        await relay.drain(subscriber);
        const messageId = cp.db.get<{ message_id: string }>(
          "SELECT message_id FROM outbox WHERE json_extract(payload_json, '$.sourceNonce') = ?",
          [`buzz-message:${event.id}`],
        )!.message_id;
        if (variant === "mention and ordinary work") expect(enqueue("coalesced-second-ordinary").allowed).toBe(true);
        const mentionTrigger: SessionWakeTrigger | undefined = wakes.mock.calls
          .flatMap(([, triggers]) => triggers)
          .find((trigger) => trigger.stillAdmissible !== undefined);
        expect(mentionTrigger?.served?.()).toBe(false);
        // Coalesced, not started: the turn it waits behind is still running.
        expect(wakes.mock.results.at(-1)?.value).toMatchObject({ allowed: true, value: "COALESCED" });

        release();
        // The follow-up either runs (a finished turn) or is refused before the provider (a
        // duplicate refusal); wait for whichever it does, then count provider calls.
        await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId) - finishedBefore + duplicateRefusals()).toBe(2), WAIT);

        expect(claims[0]?.value?.claimed?.provenance?.eventId).toBe(event.id);
        expect(cp.outbox.get(messageId)?.status).toBe("SENT");
        expect(mentionTrigger!.served!()).toBe(true);
        if (variant === "mention only") {
          expect(providerCalls() - before, "the follow-up made a provider call for a mention already served").toBe(0);
          expect(workTurns).toBe(1);
          expect(duplicateRefusals()).toBe(1);
        } else {
          // The ordinary request still has its follow-up turn, which finds nothing more to claim.
          expect(providerCalls() - before).toBe(1);
          expect(workTurns).toBe(2);
          expect(claims[1]?.value?.claimed).toBeNull();
          expect(duplicateRefusals()).toBe(0);
        }
        // Either way the mention's trigger is handled: a wake that names it again is a duplicate.
        const again = cp.sessionRuntime.wake(binding.roleKey, [mentionTrigger!]);
        expect(again.allowed).toBe(false);
        expect(again.reasonCode).toBe(ReasonCode.SESSION_TURN_DUPLICATE);
      } finally {
        release();
        wakes.mockRestore();
        subscriber.close();
        await ingress.close();
        await listeners.close();
      }
    });
  });
}
