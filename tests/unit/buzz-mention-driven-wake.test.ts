import { chmodSync } from "node:fs";

import { afterAll, expect, it, vi } from "vitest";

import { startBuzzMessageIngressListener, startDaemonBuzzMentionSubscriber, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);

/**
 * 1080-N4-01. A verified mention to a DRIVEN PRIMARY_CTO is woken through its session runtime, and
 * the mention's gate rides with the runtime's trigger to the turn's final check, immediately before
 * the provider call and after every await. The holder is a real driven PRIMARY_CTO, provisioned
 * through the production bootstrap, attestation, credential and socket paths; only the model
 * provider is a double. While the runtime prepares the turn's credential, the holder's room is
 * lost, moved to another configured room, or a second mentionable role makes the identity
 * ineligible. None of those turns reaches the provider or claims the message; the control does.
 */

const ROOM = "room-driven-mention";
const OTHER_ROOM = "room-driven-other";

for (const change of ["none", "room lost", "room changed", "identity excluded"] as const) {
  it(`gives a driven holder's mention turn ${change === "none" ? "one provider call and one claim" : "no provider call and no claim"} when ${change === "none" ? "nothing changes" : `its ${change}`} before the provider call`, async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const projectId = "driven-mention";
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, projectId);
      const bootstrap = await f.dispatchBootstrap();
      const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
      if (!bound.allowed) throw new Error(bound.message);
      const binding = bound.value;
      const dir = tempDir("acp-dmw-");
      chmodSync(dir, 0o700);
      const cto = channelKey(dir, "cto.key");
      const owner = channelKey(dir, "owner.key");
      cp.sessions.setBuzzAddress(binding.sessionId, ROOM);
      const session = cp.sessions.require(binding.sessionId);
      expect(cp.sessions.bindBuzzActor(
        { sessionId: binding.sessionId, sessionSecret: f.claude.credentials.get(binding.sessionId)!.sessionSecret, buzzActorId: cto.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM, OTHER_ROOM] }]);
      const listeners = await startLocalMcpListeners(cp, dir, "driven-mention-token");
      const policy = { allowedActors: [owner.pubkey], secret: "driven-mention-secret" };
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
      try {
        await relay.drain(subscriber);
        expect(subscriber.admission().identities[0]?.state).toBe("ADMITTED");
        expect(cp.sessionRuntime.drivenModeOf(binding.sessionId)).toBe("DRIVEN");

        const claims: { ok?: boolean; value?: { claimed?: unknown } }[] = [];
        f.claude.onWorkTurn = async (_request, credential) => {
          if (credential?.sessionId !== binding.sessionId) return;
          claims.push(await callMcpToolOverSocket(
            f.ctoSocket,
            { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" },
            "role_owner_message_claim",
            { roleKey: binding.roleKey },
          ) as { ok?: boolean; value?: { claimed?: unknown } });
        };
        // The change lands during the turn's credential preparation: after the wake was admitted,
        // before the final check.
        let changed = false;
        cp.sessionRuntime.attach({
          delivery: {
            prepare: async () => {
              const prepared = await f.launch.prepare();
              if (!changed) {
                changed = true;
                if (change === "room lost") cp.sessions.setBuzzAddress(binding.sessionId, null);
                if (change === "room changed") cp.sessions.setBuzzAddress(binding.sessionId, OTHER_ROOM);
                if (change === "identity excluded") {
                  expect(cp.bindings.revoke("CEO", "fixture: a second mentionable role").allowed).toBe(true);
                  expect(cp.bindings.bind({ role: Role.CEO, sessionId: binding.sessionId }).allowed).toBe(true);
                }
                subscriber.rejudge();
              }
              return prepared;
            },
            provision: (credential) => f.launch.provision(credential),
            withdraw: (externalSessionId) => f.launch.withdraw(externalSessionId),
          },
        });
        const external = session.incarnation.split("#")[0];
        const providerCalls = (): number =>
          f.claude.turns.filter((turn) => turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
        const settledTurns = (): number =>
          cp.db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM audit_events WHERE kind IN ('SESSION_TURN', 'SESSION_TURN_REFUSED') AND session_id = ?`,
            [binding.sessionId],
          )!.n;
        const refusals = (): number =>
          cp.db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN_REFUSED' AND reason_code = 'ROLE_PEER_STALE' AND session_id = ?`,
            [binding.sessionId],
          )!.n;
        const callsBefore = providerCalls();
        const settledBefore = settledTurns();

        f.harness.clock.advance(1_000);
        relay.publish(signedMention({
          author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: Math.floor(Date.parse(cp.clock.nowIso()) / 1000), text: "verified driven mention",
        }));
        await relay.drain(subscriber);
        await vi.waitFor(() => expect(settledTurns()).toBe(settledBefore + 1));

        expect(changed).toBe(true);
        if (change === "none") {
          expect(providerCalls() - callsBefore).toBe(1);
          expect(claims).toHaveLength(1);
          expect(claims[0]?.value?.claimed).toBeTruthy();
          expect(refusals()).toBe(0);
        } else {
          expect(providerCalls() - callsBefore, "a provider call for a mention whose gate no longer holds").toBe(0);
          expect(claims).toEqual([]);
          expect(refusals()).toBe(1);
          // Refused, never executed: the message itself is untouched.
          expect(cp.db.all(`SELECT status FROM outbox WHERE kind = 'OWNER_MESSAGE'`)).toEqual([{ status: "PENDING" }]);
        }
      } finally {
        subscriber.close();
        await ingress.close();
        await listeners.close();
      }
    });
  });
}
