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
 * 1080-N5, the mixed turn. While a driven PRIMARY_CTO's ordinary turn is held, a verified mention
 * and an ordinary CANCEL_REQUEST coalesce; then the holder's room is lost or moved, or its identity
 * is made ineligible. The follow-up turn runs for the ordinary trigger, as it should. The mention's
 * message is not claimed (the claim is gated on the message's own verified provenance), stays
 * PENDING, and its trigger is released rather than marked handled. Real driven holder through the
 * production bootstrap, attestation, credential and socket paths; only the provider is a double.
 */

const ROOM = "room-mixed";
const OTHER_ROOM = "room-mixed-other";

type ClaimAnswer = { ok?: boolean; value?: { claimed?: { provenance?: { eventId?: string } } | null; mentionWithheld?: { messageId: string; reason: string }[] } };

for (const change of ["none", "room lost", "room moved", "identity excluded"] as const) {
  it(`runs the ordinary trigger of a mixed turn and ${change === "none" ? "claims" : "does not claim"} the mention's message when ${change === "none" ? "nothing changed" : `the ${change}`}`, async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const projectId = "mixed-turn";
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, projectId);
      const bootstrap = await f.dispatchBootstrap();
      const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
      if (!bound.allowed) throw new Error(bound.message);
      const binding = bound.value;
      const session = cp.sessions.require(binding.sessionId);
      const dir = tempDir("acp-mix-");
      chmodSync(dir, 0o700);
      const cto = channelKey(dir, "cto.key");
      const owner = channelKey(dir, "owner.key");
      cp.sessions.setBuzzAddress(binding.sessionId, ROOM);
      expect(cp.sessions.bindBuzzActor(
        { sessionId: binding.sessionId, sessionSecret: f.claude.credentials.get(binding.sessionId)!.sessionSecret, buzzActorId: cto.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM, OTHER_ROOM] }]);
      const listeners = await startLocalMcpListeners(cp, dir, "mixed-turn-token");
      const policy = { allowedActors: [owner.pubkey], secret: "mixed-turn-secret" };
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
      let entered = false;
      const claims: ClaimAnswer[] = [];
      const prompts: string[] = [];
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
      const audits = (kind: string): number =>
        cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND session_id = ?`, [kind, binding.sessionId])!.n;
      const external = session.incarnation.split("#")[0];
      const providerCalls = (): number =>
        f.claude.turns.filter((turn) => turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
      const ownerMessages = () => cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = 'OWNER_MESSAGE'`);
      try {
        await relay.drain(subscriber);
        expect(subscriber.admission().identities[0]?.state).toBe("ADMITTED");
        f.claude.onWorkTurn = async (request, credential) => {
          if (credential?.sessionId !== binding.sessionId) return;
          prompts.push(request.prompt);
          if (!entered) {
            entered = true;
            await barrier;
            return;
          }
          claims.push(await callMcpToolOverSocket(
            f.ctoSocket,
            { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" },
            "role_owner_message_claim",
            { roleKey: binding.roleKey },
          ) as ClaimAnswer);
        };
        const finishedBefore = f.finishedTurns(binding.sessionId);
        expect(enqueue("mixed-first-ordinary").allowed).toBe(true);
        await vi.waitFor(() => expect(entered).toBe(true));
        const before = providerCalls();

        f.harness.clock.advance(1_000);
        const event = signedMention({
          author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: Math.floor(Date.parse(cp.clock.nowIso()) / 1000), text: "verified mixed mention",
        });
        relay.publish(event);
        await relay.drain(subscriber);
        expect(enqueue("mixed-coalesced-ordinary").allowed).toBe(true);
        const mentionTrigger: SessionWakeTrigger | undefined = wakes.mock.calls
          .flatMap(([, triggers]) => triggers)
          .find((trigger) => trigger.stillAdmissible !== undefined);
        expect(mentionTrigger?.stillAdmissible?.()).toBe(true);

        if (change === "room lost") cp.sessions.setBuzzAddress(binding.sessionId, null);
        if (change === "room moved") cp.sessions.setBuzzAddress(binding.sessionId, OTHER_ROOM);
        if (change === "identity excluded") {
          expect(cp.bindings.revoke("CEO", "fixture: a second mentionable role").allowed).toBe(true);
          expect(cp.bindings.bind({ role: Role.CEO, sessionId: binding.sessionId }).allowed).toBe(true);
        }
        subscriber.rejudge();
        expect(mentionTrigger!.stillAdmissible!()).toBe(change === "none");
        release();
        await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(finishedBefore + 2));

        // The ordinary trigger runs its turn either way, and the turn was woken for both kinds.
        expect(providerCalls() - before).toBe(1);
        expect(prompts[1]).toContain("owner message");
        expect(prompts[1]).toContain("in-band dispatch");
        expect(audits("HANDOFF_ACK")).toBe(0);

        // The mention trigger: handled only when it was served. A released one is taken by a wake
        // that names it again; a handled one is refused as a duplicate.
        const again = cp.sessionRuntime.wake(binding.roleKey, [mentionTrigger!]);
        if (change === "none") {
          expect(claims[0]?.value?.claimed?.provenance?.eventId).toBe(event.id);
          expect(ownerMessages()).toEqual([{ status: "SENT" }]);
          expect(again.allowed).toBe(false);
          expect(again.reasonCode).toBe(ReasonCode.SESSION_TURN_DUPLICATE);
        } else {
          expect(claims.filter((claim) => claim.value?.claimed), "a claim of the ineligible mention").toHaveLength(0);
          expect(claims[0]?.value?.mentionWithheld?.map((row) => row.reason)).toEqual(["MENTION_NOT_ELIGIBLE"]);
          expect(ownerMessages()).toEqual([{ status: "PENDING" }]);
          expect(again.allowed, "the refused mention's trigger was marked handled").toBe(true);
          // That re-wake's turn finds the gate still closed and is refused before the provider.
          const refusedBefore = audits("SESSION_TURN_REFUSED");
          await vi.waitFor(() => expect(audits("SESSION_TURN_REFUSED")).toBe(refusedBefore + 1));
          expect(providerCalls() - before).toBe(1);
          expect(ownerMessages()).toEqual([{ status: "PENDING" }]);
        }
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
