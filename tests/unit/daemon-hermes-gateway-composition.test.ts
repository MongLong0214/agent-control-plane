import { createServer } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createConfiguredHermesGatewayConversation } from "../../src/daemon/agentcpd.ts";
import { createHermesGatewayConversationSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { createHermesGatewayIdentityReader, type HermesGatewayIdentity } from "../../src/runtime/hermes-gateway-identity.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { readHermesTargetHead, TARGET_HEAD_ADVANCED } from "../../src/session/hermes-target-head.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  adoptedFixture as makeAdoptedFixture,
  DIGEST,
  GATEWAY,
  LIVE,
  LSTART,
  OTHER_DIGEST,
  snapshot,
  TOKEN,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";

afterAll(cleanupTempDirs);
const fixtures: AdoptedCeoFixture[] = [];
const adoptedFixture = (bound?: Parameters<typeof makeAdoptedFixture>[0]): AdoptedCeoFixture => {
  const fixture = makeAdoptedFixture(bound);
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
});

/** No head is configured: neither Keychain head value is set (2026-10-03). */
const config = () => ({
  ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST,
  ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
  ACP_HERMES_PROFILE: "test-profile",
  ACP_HERMES_HOME: "/opt/test/home",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test",
  ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key",
});
const source = { eventId: "signed-7", actor: "owner", conversation: "room" };
const OLDER_HEAD = "20260923_000000_older_head";
const identity = (overrides: Partial<HermesGatewayIdentity> = {}): HermesGatewayIdentity => ({
  session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN, ...overrides,
});
/** An identity reader port that counts its reads. */
const reader = (answer: () => HermesGatewayIdentity) => {
  const port = { reads: 0, factory: (() => async () => { port.reads++; return answer(); }) as typeof createHermesGatewayIdentityReader };
  return port;
};
const processPorts = (token = TOKEN) => ({ processStartToken: () => token, processStartedAt: () => LSTART });
const answering = () => {
  const port = { dispatched: 0, factory: (() => {
    port.dispatched++;
    return async () => ({ contact: "REACHED" as const, answered: allow(ReasonCode.OK, "answered") });
  }) as typeof createHermesGatewayConversationSender };
  return port;
};

/** A Gateway on an ephemeral port: identity GET answers `identity()`, every POST body is kept. */
const gatewayServer = async (current: () => HermesGatewayIdentity, onGet?: () => Promise<void>) => {
  const posts: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      void (onGet?.() ?? Promise.resolve()).then(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(current()));
      });
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      posts.push(JSON.parse(body) as Record<string, unknown>);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ event_id: source.eventId, text: "Gateway answered" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return {
    posts,
    ports: {
      identityReader: ((options) => createHermesGatewayIdentityReader({ ...options, port: address.port })) as
        typeof createHermesGatewayIdentityReader,
      senderFactory: ((options) => createHermesGatewayConversationSender({ ...options, port: address.port })) as
        typeof createHermesGatewayConversationSender,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("daemon Gateway CEO composition", () => {
  it("delivers only to the process whose native start is pinned for the CEO runtime (#1037)", async () => {
    // A successor Gateway inside the recorded lstart second renders the same lstart; only the
    // pinned native start tells it from the process the binding was adopted onto.
    const deliver = async (liveToken: string): Promise<{ contact: string; dispatched: number }> => {
      const fixture = adoptedFixture();
      const sender = answering();
      const outcome = await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
        ...processPorts(liveToken),
        identityReader: reader(() => identity({ process_started_at: liveToken })).factory,
        senderFactory: sender.factory,
      })!("status", source);
      return { contact: outcome.contact, dispatched: sender.dispatched };
    };
    expect(await deliver(TOKEN)).toEqual({ contact: "REACHED", dispatched: 1 });
    expect(await deliver("darwin-tv:1790000000.000999")).toEqual({ contact: "NEVER_REACHED", dispatched: 0 });
  });

  /**
   * An unpinned row (adopted before #1037) is never delivered to. The lstart rule that once
   * delivered to one written after its start second is deleted, and the absent pin does not fall
   * back to the live token, which proves nothing (review PR1046-R1, round 2).
   */
  it.each(["ps-start", "Thu Oct  1 00:25:43 2026"])("refuses an unpinned row recording %j", async (lstart) => {
    const fixture = adoptedFixture({ unpinned: { lstart } });
    const sender = answering();
    const gateway = reader(() => identity());
    const outcome = await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
      processStartToken: () => "live-native-start", processStartedAt: () => lstart,
      identityReader: gateway.factory, senderFactory: sender.factory,
    })!("status", source);
    expect({ contact: outcome.contact, dispatched: sender.dispatched, reads: gateway.reads,
      pinned: fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId) })
      .toEqual({ contact: "NEVER_REACHED", dispatched: 0, reads: 0, pinned: null });
  });

  it("refuses without POST when the CEO binding is revoked during identity GET", async () => {
    const fixture = adoptedFixture();
    let identityRequested!: () => void;
    const requested = new Promise<void>((resolve) => { identityRequested = resolve; });
    let releaseIdentity!: () => void;
    const released = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    const gateway = await gatewayServer(() => identity(), () => { identityRequested(); return released; });
    try {
      const send = createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
        authorityHeld: () => true, ...processPorts(), ...gateway.ports,
      });
      expect(send).toBeDefined();
      const outcome = send!("status", source);
      await requested;
      expect(fixture.h.cp.bindings.revoke("CEO", "revoked while Gateway identity pending").allowed).toBe(true);
      releaseIdentity();
      expect(await outcome).toMatchObject({ contact: "NEVER_REACHED",
        answered: { allowed: false, reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
      expect(gateway.posts).toHaveLength(0);
    } finally {
      releaseIdentity();
      await gateway.close();
    }
  });

  it("pins the adopted active CEO and server-owned binding when delivering a turn", async () => {
    const fixture = adoptedFixture();
    const calls: unknown[] = [];
    let lockHeld = true;
    let loseLockDuringProcessCheck = false;
    const sender = createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
      authorityHeld: () => lockHeld,
      identityReader: reader(() => identity()).factory,
      processStartToken: () => {
        if (loseLockDuringProcessCheck) lockHeld = false;
        return TOKEN;
      },
      processStartedAt: () => LSTART,
      senderFactory: (options) => {
        calls.push(options);
        return async (text, event) => {
          calls.push({ text, event });
          return { contact: "REACHED", answered: allow(ReasonCode.OK, "Gateway answered") };
        };
      },
    });
    expect(sender).toBeDefined();
    expect(await sender!("status", source)).toMatchObject({ contact: "REACHED", answered: { value: "Gateway answered" } });
    expect(calls).toEqual([
      { apiKey: "fixture-gateway-key", binding: "acp-canonical-ceo",
        expected: { session_id: LIVE, lineage_root_digest: DIGEST,
          process_pid: GATEWAY, process_started_at: TOKEN },
        preDispatch: expect.any(Function) },
      { text: "status", event: source },
    ]);
    lockHeld = false;
    expect(await sender!("after-lock-loss", source)).toMatchObject({ contact: "NEVER_REACHED",
      answered: { reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
    expect(calls).toHaveLength(2);
    lockHeld = true;
    loseLockDuringProcessCheck = true;
    expect(await sender!("during-lock-loss", source)).toMatchObject({ contact: "NEVER_REACHED",
      answered: { reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
    expect(calls).toHaveLength(2);
  });

  it("refuses wrong target, wrong process and partial config without invoking Gateway or MCP", async () => {
    const otherLineage = adoptedFixture({ digest: OTHER_DIGEST });
    const fixture = adoptedFixture();
    const sender = answering();
    const gateway = reader(() => identity());
    const ports = { ...processPorts(), identityReader: gateway.factory, senderFactory: sender.factory };
    expect((await createConfiguredHermesGatewayConversation(otherLineage.h.cp, config(), ports)!("status", source)).contact)
      .toBe("NEVER_REACHED");
    expect((await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
      ...ports, processStartedAt: () => "different-process",
    })!("status", source)).contact).toBe("NEVER_REACHED");
    expect((await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
      ...ports, processStartToken: () => null,
    })!("status", source)).contact).toBe("NEVER_REACHED");
    const partial = { ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST };
    expect((await createConfiguredHermesGatewayConversation(fixture.h.cp, partial, ports)!("status", source)).contact)
      .toBe("NEVER_REACHED");
    expect(createConfiguredHermesGatewayConversation(fixture.h.cp, {}, ports)).toBeUndefined();
    expect((await createConfiguredHermesGatewayConversation(fixture.h.cp,
      { ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key" }, ports)!("status", source)).contact)
      .toBe("NEVER_REACHED");
    expect(sender.dispatched).toBe(0);
    expect(gateway.reads).toBe(0);
  });
});

describe("daemon Gateway CEO composition — the head moves inside the lineage (2026-10-03)", () => {
  it("delivers to the Gateway's new head over the stored older one, recording the move once", async () => {
    // CEO gen3 as it stood live: bound to the 09-23 head, the Gateway serving the 10-01 head.
    const fixture = adoptedFixture({ locator: OLDER_HEAD });
    const { h } = fixture;
    const gateway = await gatewayServer(() => identity());
    try {
      const send = createConfiguredHermesGatewayConversation(h.cp, config(), {
        authorityHeld: () => true, ...processPorts(), ...gateway.ports,
      })!;
      const before = snapshot(h);
      expect(await send("status", source)).toMatchObject({ contact: "REACHED",
        answered: { allowed: true, value: "Gateway answered" } });
      expect(gateway.posts).toHaveLength(1);
      expect(gateway.posts[0]).toMatchObject({ session_id: LIVE, lineage_root_digest: DIGEST,
        process_pid: GATEWAY, process_started_at: TOKEN });
      expect(readHermesTargetHead(h.cp.db, fixture.actorId)).toMatchObject({ head: LIVE, bornLocator: OLDER_HEAD });
      const after = snapshot(h);
      for (const table of Object.keys(before)) {
        if (table !== "audit_events") expect(after[table]).toEqual(before[table]);
      }
      const added = after.audit_events!.filter((row) => !before.audit_events!.includes(row));
      expect(added.map((row) => JSON.parse(row) as { kind: string })).toEqual([
        expect.objectContaining({ kind: TARGET_HEAD_ADVANCED }),
      ]);
      expect(JSON.parse((JSON.parse(added[0]!) as { evidence_json: string }).evidence_json)).toMatchObject({
        previousHead: OLDER_HEAD, head: LIVE, path: "gateway_delivery", bindingGeneration: 1 });
      // Once moved, the next turn finds the head it reports and records nothing.
      const settled = snapshot(h);
      expect((await send("again", source)).contact).toBe("REACHED");
      expect(gateway.posts).toHaveLength(2);
      expect(snapshot(h)).toEqual(settled);
    } finally {
      await gateway.close();
    }
  });

  it("refuses a Gateway head in another lineage, writing nothing and never dispatching", async () => {
    const fixture = adoptedFixture({ locator: OLDER_HEAD });
    const sender = answering();
    const before = snapshot(fixture.h);
    const outcome = await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
      ...processPorts(),
      identityReader: reader(() => identity({ session_id: "20261002_080000_other_chat",
        lineage_root_digest: OTHER_DIGEST })).factory,
      senderFactory: sender.factory,
    })!("status", source);
    expect(outcome.contact).toBe("NEVER_REACHED");
    expect(sender.dispatched).toBe(0);
    expect(snapshot(fixture.h)).toEqual(before);
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(OLDER_HEAD);
  });

  it("does not move the head on a readback from another process, writing nothing", async () => {
    for (const other of [{ process_pid: GATEWAY + 1 }, { process_started_at: "darwin-tv:1.000000" }]) {
      const fixture = adoptedFixture({ locator: OLDER_HEAD });
      const sender = answering();
      const before = snapshot(fixture.h);
      const outcome = await createConfiguredHermesGatewayConversation(fixture.h.cp, config(), {
        ...processPorts(), identityReader: reader(() => identity(other)).factory, senderFactory: sender.factory,
      })!("status", source);
      expect(outcome.contact).toBe("NEVER_REACHED");
      expect(sender.dispatched).toBe(0);
      expect(snapshot(fixture.h)).toEqual(before);
    }
  });
});
