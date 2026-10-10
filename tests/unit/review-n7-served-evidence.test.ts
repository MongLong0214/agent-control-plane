import { chmodSync } from "node:fs";

import { afterAll, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
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

for (const variant of ["claimed-reset", "claimed-pointer-moved", "wrong-event-row", "terminal-rejection", "claimed-normally"] as const) {
  it(`N7 served evidence: ${variant}`, async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const projectId = "claim-time-drift";
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, projectId);
      const bootstrap = await f.dispatchBootstrap();
      const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
      if (!bound.allowed) throw new Error(bound.message);
      const binding = bound.value;
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
      let eventId = "";
      let messageId = "";
      let priorMessageId = "";
      let priorNonce = "";
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
            const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
            const messages = (pending.value as { messages?: { messageId: string; kind: string }[] })?.messages ?? [];
            for (const message of messages.filter((one) => one.kind === MessageKind.CANCEL_REQUEST)) {
              expect((await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId })).ok).toBe(true);
            }
            if (variant === "wrong-event-row") {
              cp.sessions.setBuzzAddress(binding.sessionId, OTHER_ROOM); subscriber.rejudge();
              claims.push(await callMcpToolOverSocket(f.ctoSocket, as, "role_owner_message_claim", { roleKey: binding.roleKey }) as ClaimAnswer);
              // The previous event was really claimed. Only its writable pointer is changed:
              // neither the current event's row nor its immutable departure evidence is touched.
              cp.db.run("UPDATE outbox SET payload_json = json_set(payload_json, '$.sourceNonce', ?) WHERE message_id = ?", [`buzz-message:${eventId}`, priorMessageId]);
            } else if (variant === "terminal-rejection") {
              const rejected=await callMcpToolOverSocket(f.ctoSocket,as,"role_owner_message_reject",{roleKey:binding.roleKey,messageId});
              expect(rejected.ok).toBe(true);
              expect(cp.outbox.get(messageId)?.status).toBe("REJECTED");
            } else {
              const answer = await callMcpToolOverSocket(f.ctoSocket, as, "role_owner_message_claim", { roleKey: binding.roleKey }) as ClaimAnswer;
              claims.push(answer);
              expect(answer.value?.claimed?.provenance?.eventId).toBe(eventId);
              if (variant === "claimed-reset") cp.db.run("UPDATE outbox SET status='PENDING', attempts=0, sent_at=NULL WHERE message_id=?", [messageId]);
              if (variant === "claimed-pointer-moved") cp.db.run("UPDATE outbox SET payload_json=json_set(payload_json,'$.sourceNonce','buzz-message:unrelated') WHERE message_id=?", [messageId]);
            }
          } else {
            claims.push(await callMcpToolOverSocket(f.ctoSocket, as, "role_owner_message_claim", { roleKey: binding.roleKey }) as ClaimAnswer);
          }
        };
        if (variant === "wrong-event-row") {
          const source = {type:"BUZZ_MESSAGE",conversation:ROOM,text:"prior event"};
          priorNonce = "buzz-message:prior-event";
          cp.db.run("INSERT INTO inbound_messages(channel,nonce,actor,received_at,payload_json) VALUES('buzz',?,?,?,?)", [priorNonce,owner.pubkey,cp.clock.nowIso(),JSON.stringify(source)]);
          const row = cp.outbox.enqueue({idempotencyKey:"prior-event",roleKey:binding.roleKey,bindingGeneration:binding.bindingGeneration,targetSessionId:binding.sessionId,runId:null,kind:MessageKind.OWNER_MESSAGE,payload:{sourceChannel:"buzz",sourceNonce:priorNonce,sourcePayloadDigest:digestOf(source)}});
          if(!row.allowed) throw new Error(row.message); priorMessageId=row.value.messageId;
          const credential = f.claude.credentials.get(binding.sessionId)!;
          const answer = await callMcpToolOverSocket(f.ctoSocket,{sessionId:binding.sessionId,sessionSecret:credential.sessionSecret,token:credential.token??""},"role_owner_message_claim",{roleKey:binding.roleKey}) as ClaimAnswer;
          expect(answer.value?.claimed?.provenance?.eventId).toBe("prior-event");
        }
        const finishedBefore = f.finishedTurns(binding.sessionId);
        expect(enqueue("drift-first-ordinary").allowed).toBe(true);
        await vi.waitFor(() => expect(workTurns).toBe(1));

        f.harness.clock.advance(1_000);
        const event = signedMention({
          author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: Math.floor(Date.parse(cp.clock.nowIso()) / 1000), text: "mention that drifts mid-turn",
        });
        eventId=event.id;
        relay.publish(event);
        await relay.drain(subscriber);
        messageId=cp.db.get<{message_id:string}>("SELECT message_id FROM outbox WHERE json_extract(payload_json,'$.sourceNonce')=?",[`buzz-message:${event.id}`])!.message_id;
        expect(enqueue("drift-coalesced-ordinary").allowed).toBe(true);
        const mentionTrigger: SessionWakeTrigger | undefined = wakes.mock.calls
          .flatMap(([, triggers]) => triggers)
          .find((trigger) => trigger.stillAdmissible !== undefined);
        expect(mentionTrigger?.stillAdmissible?.()).toBe(true);
        release();
        await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(finishedBefore + 2));

        const served=mentionTrigger!.served!();
        const departures=cp.db.all<{ reason: string }>("SELECT * FROM holder_message_source_departures WHERE source_nonce=?",[`buzz-message:${event.id}`]);
        const retry=cp.sessionRuntime.wake(binding.roleKey,[mentionTrigger!]);
        if(retry.allowed && variant !== "wrong-event-row") {
          const settled=f.finishedTurns(binding.sessionId);
          await vi.waitFor(()=>expect(f.finishedTurns(binding.sessionId)).toBe(settled+1));
          expect(claims.at(-1)?.value?.claimed).toBeNull();
        }
        if(variant === "wrong-event-row") {
          expect(departures).toEqual([]);
          expect(claims[0]?.value?.claimed).toBeNull();
          expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
          expect(served,"a different event's remapped SENT row is not claim evidence for this event").toBe(false);
          expect(retry.allowed,"the withheld mention must be released").toBe(true);
        } else {
          expect(departures.some((row)=>row.reason === "MESSAGE_DEPARTED")).toBe(true);
          expect(retry.allowed,"an event already claimed or settled must not re-run its provider trigger").toBe(false);
          expect(retry.reasonCode).toBe(ReasonCode.SESSION_TURN_DUPLICATE);
          expect(retry.allowed).toBe(false);
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
