import { chmodSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
  startDaemonMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * How a mention reaches a holder that runs on the daemon's own runtime (#246 C4).
 *
 * An interactive holder is never written to, so only a driven holder has a wake: it goes through the
 * session runtime, and a holder whose driven-spawn record contradicts its binding is refused before
 * any turn starts.
 */

const PROJECT = "repo-factory";
const ROOM = "room-repo-factory";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** A canonical CTO bound on its conversation, its subscriber identity, and the daemon-built CTO port. */
const start = async () => {
  const dir = tempDir("acp-wks-");
  chmodSync(dir, 0o700);
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  const ceo = channelKey(dir, "ceo.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  expect(h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: cto.pubkey },
    { isAllowedActor: () => true },
  ).allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  expect(h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: session.sessionId,
    projectId: PROJECT,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "wake-scope", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  }).allowed).toBe(true);
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey, ceo.pubkey], secret: "buzz-wake-scope-secret" };
  // The daemon's own composition: its MCP listeners (the in-band wake callback included) build the port.
  const listeners = await startDaemonMcpListeners(h.cp, dir, "wake-scope-mcp-token", { finalizeApprovedRun: () => undefined });
  const conversation = listeners.ctoConversation;
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
    roleConversation: conversation,
  });
  const relay = storingRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: steppedClock().scheduler,
    reportAdmission: () => undefined,
  });
  rejudgeBuzzMentionSubscriberOnBindingSwitch(h.cp, () => subscriber);
  await relay.drain(subscriber);

  /** The holder's room is moved to one its identity does not subscribe in: the identity is EXCLUDED. */
  const excludeIdentity = (): void => {
    h.cp.sessions.setBuzzAddress(h.cp.bindings.active(roleKey)!.sessionId, "room-unsubscribed");
    subscriber.rejudge();
    expect(subscriber.admission().identities[0]).toMatchObject({ state: "EXCLUDED", reason: "ROOM_NOT_SUBSCRIBED" });
  };
  return {
    h,
    dir,
    cto,
    ceo,
    owner,
    policy,
    ingress,
    roleKey,
    relay,
    subscriber,
    excludeIdentity,
    close: async () => {
      subscriber.close();
      await ingress.close();
      await listeners.close();
      h.cp.close();
    },
  };
};

describe("a mention's wake of a driven holder goes through its runtime (#246 C4)", () => {
  const publishMention = async (f: Awaited<ReturnType<typeof start>>): Promise<void> => {
    f.h.clock.advance(1_000);
    f.relay.publish(signedMention({
      author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM, createdAt: secondsOf(f.h.cp.clock.nowIso()), text: "mention",
    }));
    await f.relay.drain(f.subscriber);
  };

  it("wakes a driven holder through its runtime", async () => {
    const f = await start();
    try {
      vi.spyOn(f.h.cp.sessionRuntime, "drivesSession").mockReturnValue(true);
      const driven = vi.spyOn(f.h.cp.sessionRuntime, "wake").mockReturnValue(allow(ReasonCode.OK, "STARTED"));
      await publishMention(f);
      expect(driven).toHaveBeenCalledTimes(1);
      expect(driven.mock.calls[0]?.[0]).toBe(f.roleKey);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  it("refuses a holder whose driven-spawn record contradicts its binding, before any turn starts", async () => {
    const f = await start();
    try {
      vi.spyOn(f.h.cp.sessionRuntime, "drivenModeOf").mockReturnValue("CONTRADICTED");
      const driven = vi.spyOn(f.h.cp.sessionRuntime, "wake");
      await publishMention(f);
      expect(driven).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });
});
