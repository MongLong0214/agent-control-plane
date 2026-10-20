import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RunState } from "../../src/domain/types.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import {
  type BootstrapRuntimeFixture,
  acknowledgeInBandOnWorkTurns,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { DIGEST, LIVE } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * A peer turn of the CEO binding carrying a Hermes peer grant (CEO ad57675b) dispatches a bootstrap
 * run and resolves the escalation its CTO opens, end to end: the run reaches ACTIVE through the
 * escalation's own gates, and the DISPATCHED and CEO_DECISION audit rows name the peer turn and the
 * grant it acted under. The channel carries a provenance anchor exactly as the adopted CEO's does.
 */

const PEER_GRANT = `sha256:${"d".repeat(64)}`;

const PEER_TURN = {
  session_id: LIVE,
  session_key: "agent:main:buzz:peer:cto",
  platform: "buzz",
  chat_id: "cto-room",
  cron: false,
  parent_chat_id: null,
  principal: "peer",
  lineage_root_digest: DIGEST,
  delegation_depth: 0,
  peer_grant: PEER_GRANT,
} as const;

const peerChannel = async (f: BootstrapRuntimeFixture) => {
  const server = createHermesServer(
    createHermesMcpPort(f.harness.cp),
    () => allow(ReasonCode.OK, { actor: f.ceoSessionId, sessionId: f.ceoSessionId }),
    { provenance: { liveHermesSessionId: LIVE, lineageRootDigest: DIGEST } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "hermes-peer-fixture", version: "1" });
  await client.connect(clientTransport);
  let keys = 0;
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: { idempotencyKey: `peer-${++keys}`, ...args },
        _meta: { [HERMES_PROVENANCE_META_KEY]: PEER_TURN },
      });
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    },
    close: () => client.close(),
  };
};

const auditEvidence = (f: BootstrapRuntimeFixture, kind: string, runId: string): Array<Record<string, unknown>> =>
  f.harness.cp.db
    .all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`,
      [kind, runId],
    )
    .map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

describe("a peer turn of the CEO binding, under a Hermes peer grant", () => {
  it("dispatches a run and resolves its escalation, and both audit rows name the peer turn and its grant", async () => {
    await withBootstrapRuntime(async (f) => {
      const peer = await peerChannel(f);
      try {
        acknowledgeInBandOnWorkTurns(f);
        const runId = await f.createBootstrap();
        const dispatched = await peer.call("run_dispatch", { runId });
        expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ ok: true });
        const ownerSessionId = f.harness.cp.runs.require(runId).ownerSessionId!;
        await f.awaitFinishedTurns(ownerSessionId, 1);
        expect(auditEvidence(f, "DISPATCHED", runId)).toEqual([
          expect.objectContaining({ hermesPrincipal: "peer", hermesPeerGrant: PEER_GRANT }),
        ]);

        const opened = await f.cto(ownerSessionId, "escalation_open", {
          idempotencyKey: "peer-delegated-escalation",
          runId,
          question: "which repository name?",
          options: ["acp-new", "acp-next"],
          ctoRecommendation: "acp-new",
          whyItMatters: "it is the repository's permanent identity",
          blocksCriticalPath: true,
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });
        const escalationId = f.harness.cp.db.get<{ id: number }>(
          `SELECT MAX(event_id) AS id FROM audit_events WHERE kind = 'CTO_ESCALATION' AND run_id = ?`,
          [runId],
        )!.id;

        const resolved = await peer.call("escalation_resolve", { runId, escalationId, resolution: "use acp-new" });
        expect(resolved, JSON.stringify(resolved)).toMatchObject({ ok: true, value: { runId, escalationId, state: RunState.ACTIVE } });
        expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
        expect(auditEvidence(f, "CEO_DECISION", runId)).toEqual([
          expect.objectContaining({ escalation: true, escalationId, hermesPrincipal: "peer", hermesPeerGrant: PEER_GRANT }),
        ]);
      } finally {
        await peer.close();
      }
    });
  });
});
