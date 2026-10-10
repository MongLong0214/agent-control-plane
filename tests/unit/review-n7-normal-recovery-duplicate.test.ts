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
 * 1080-N6, the mixed turn whose mention becomes ineligible during the provider call. The gate
 * holds when the provider starts, so the turn runs; inside it the ordinary requests are
 * acknowledged, then the holder's room is lost or moved, or its identity made ineligible, and only
 * then is the mention claimed. The claim is refused (MENTION_NOT_ELIGIBLE), the message stays
 * PENDING, the ordinary requests stay ACKED, and the mention's trigger is released: a wake that
 * names it again is taken, and once eligibility is restored that same event is claimed.
 *
 * Adapted from the closure review's witness. The original 1080-N5 note for this fixture follows.
 *
 * 1080-N5, the mixed turn. While a driven PRIMARY_CTO's ordinary turn is held, a verified mention
 * and an ordinary CANCEL_REQUEST coalesce; then the holder's room is lost or moved, or its identity
 * is made ineligible. The follow-up turn runs for the ordinary trigger, as it should. The mention's
 * message is not claimed (the claim is gated on the message's own verified provenance), stays
 * PENDING, and its trigger is released rather than marked handled. Real driven holder through the
 * production bootstrap, attestation, credential and socket paths; only the provider is a double.
 */

const ROOM = "room-drift";
const OTHER_ROOM = "room-drift-other";

type ClaimAnswer = { ok?: boolean; value?: { claimed?: { provenance?: { eventId?: string } } | null; mentionWithheld?: { messageId: string; reason: string }[] } };

for (const change of ["room lost", "room moved", "identity excluded"] as const) {
  it(`N7 duplicate after normal recovery releases a mention whose ${change === "identity excluded" ? "identity is excluded" : change.replace("room ", "room is ")} during the provider call, keeps the ordinary work ACKED, and claims it once eligible again`, async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const projectId = "claim-time-drift";
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, projectId);
      const bootstrap = await f.dispatchBootstrap();
      const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
      if (!bound.allowed) throw new Error(bound.message);
      const binding = bound.value;
      const session = cp.sessions.require(binding.sessionId);
      const dir = tempDir("acp-drift-");
      chmodSync(dir, 0o700);
      const cto = channelKey(dir, "cto.key");
      const owner = channelKey(dir, "owner.key");
      cp.sessions.setBuzzAddress(binding.sessionId, ROOM);
      expect(cp.sessions.bindBuzzActor(
        { sessionId: binding.sessionId, sessionSecret: f.claude.credentials.get(binding.sessionId)!.sessionSecret, buzzActorId: cto.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM, OTHER_ROOM] }]);
      const listeners = await startLocalMcpListeners(cp, dir, "claim-time-drift-token");
      const policy = { allowedActors: [owner.pubkey], secret: "claim-time-drift-secret" };
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
      const ineligible = (): void => {
        if (change === "room lost") cp.sessions.setBuzzAddress(binding.sessionId, null);
        if (change === "room moved") cp.sessions.setBuzzAddress(binding.sessionId, OTHER_ROOM);
        if (change === "identity excluded") {
          expect(cp.bindings.revoke("CEO", "fixture: a second mentionable role").allowed).toBe(true);
          expect(cp.bindings.bind({ role: Role.CEO, sessionId: binding.sessionId }).allowed).toBe(true);
        }
        subscriber.rejudge();
      };
      const eligibleAgain = (): void => {
        if (change === "identity excluded") expect(cp.bindings.revoke("CEO", "fixture: restore").allowed).toBe(true);
        else cp.sessions.setBuzzAddress(binding.sessionId, ROOM);
        subscriber.rejudge();
      };
      const audits = (kind: string): number =>
        cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND session_id = ?`, [kind, binding.sessionId])!.n;
      const external = session.incarnation.split("#")[0];
      const providerCalls = (): number =>
        f.claude.turns.filter((turn) => turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
      const ownerMessages = () => cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = 'OWNER_MESSAGE'`);
      const cancelRequests = () => cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = 'CANCEL_REQUEST'`);
      try {
        await relay.drain(subscriber);
        expect(subscriber.admission().identities[0]?.state).toBe("ADMITTED");
        f.claude.onWorkTurn = async (_request, credential) => {
          if (credential?.sessionId !== binding.sessionId) return;
          workTurns += 1;
          if (workTurns === 1) {
            await barrier;
            return;
          }
          const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
          if (workTurns === 2) {
            // The mixed turn: the ordinary work first, then the mention turns ineligible, then the claim.
            const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
            const messages = (pending.value as { messages?: { messageId: string; kind: string }[] })?.messages ?? [];
            for (const message of messages.filter((one) => one.kind === MessageKind.CANCEL_REQUEST)) {
              expect((await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId })).ok).toBe(true);
            }
            ineligible();
          }
          claims.push(await callMcpToolOverSocket(f.ctoSocket, as, "role_owner_message_claim", { roleKey: binding.roleKey }) as ClaimAnswer);
        };
        const finishedBefore = f.finishedTurns(binding.sessionId);
        expect(enqueue("drift-first-ordinary").allowed).toBe(true);
        await vi.waitFor(() => expect(workTurns).toBe(1));
        const before = providerCalls();

        f.harness.clock.advance(1_000);
        const event = signedMention({
          author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: Math.floor(Date.parse(cp.clock.nowIso()) / 1000), text: "mention that drifts mid-turn",
        });
        relay.publish(event);
        await relay.drain(subscriber);
        expect(enqueue("drift-coalesced-ordinary").allowed).toBe(true);
        const mentionTrigger: SessionWakeTrigger | undefined = wakes.mock.calls
          .flatMap(([, triggers]) => triggers)
          .find((trigger) => trigger.stillAdmissible !== undefined);
        expect(mentionTrigger?.stillAdmissible?.()).toBe(true);
        release();
        await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(finishedBefore + 2));

        // The mixed turn ran, its ordinary work is ACKED, and the mention's claim was refused.
        expect(providerCalls() - before).toBe(1);
        expect(cancelRequests()).toEqual([{ status: "ACKED" }, { status: "ACKED" }]);
        expect(claims.filter((claim) => claim.value?.claimed)).toHaveLength(0);
        expect(claims[0]?.value?.mentionWithheld?.map((row) => row.reason)).toEqual(["MENTION_NOT_ELIGIBLE"]);
        expect(ownerMessages()).toEqual([{ status: "PENDING" }]);
        expect(audits("HANDOFF_ACK")).toBe(0);

        // Restore without manufacturing another mention wake. The subscriber does not queue a
        // second delivery for this accepted event; ordinary work later invokes the normal claim.
        const callsBeforeRestore = providerCalls();
        const wakesBeforeRestore = wakes.mock.calls.length;
        eligibleAgain();
        await relay.drain(subscriber);
        expect(providerCalls()).toBe(callsBeforeRestore);
        expect(wakes.mock.calls.length).toBe(wakesBeforeRestore);
        expect(mentionTrigger!.served!()).toBe(false);
        expect(cp.db.all("SELECT status, attempts FROM outbox WHERE kind='OWNER_MESSAGE'"))
          .toEqual([{status:"PENDING",attempts:0}]);
        const settled = f.finishedTurns(binding.sessionId);
        expect(enqueue("normal-next-holder-claim").allowed).toBe(true);
        await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(settled + 1));
        expect(claims.at(-1)?.value?.claimed?.provenance?.eventId).toBe(event.id);
        expect(ownerMessages()).toEqual([{ status: "SENT" }]);
        // Served now, so handled: a further wake that names it is a duplicate.
        expect(mentionTrigger!.served!()).toBe(true);
        const duplicateClaim = await callMcpToolOverSocket(f.ctoSocket, {
          sessionId: binding.sessionId, sessionSecret: f.claude.credentials.get(binding.sessionId)!.sessionSecret,
          token: f.claude.credentials.get(binding.sessionId)!.token ?? "",
        }, "role_owner_message_claim", {roleKey:binding.roleKey}) as ClaimAnswer;
        expect(duplicateClaim.value?.claimed).toBeNull();
        const beforeDuplicate = f.finishedTurns(binding.sessionId);
        const duplicateTrigger = cp.sessionRuntime.wake(binding.roleKey,[mentionTrigger!]);
        if(duplicateTrigger.allowed) await vi.waitFor(()=>expect(f.finishedTurns(binding.sessionId)).toBe(beforeDuplicate+1));
        expect(duplicateTrigger.allowed,"a mention really claimed by the normal recovery turn must not rerun").toBe(false);
        expect(duplicateTrigger.reasonCode).toBe(ReasonCode.SESSION_TURN_DUPLICATE);
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
