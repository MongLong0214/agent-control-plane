import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { GatewayIncumbentProof } from "../../src/bootstrap/hermes-incumbent-adoption.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { respond } from "../../src/mcp/shared.ts";
import { readHermesTargetHead, TARGET_HEAD_ADVANCED } from "../../src/session/hermes-target-head.ts";
import { adoptedFixture as makeAdoptedFixture, DIGEST, LIVE, snapshot, type AdoptedCeoFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * PR #1053 review counterexamples for the head the adopted CEO's tool admission follows, against
 * the production registries: the Gateway's readback and the process tree are stated by the test.
 *
 *   ACP1053-02  a delayed readback of an older head, and a connection anchored on it, after a newer
 *               head was recorded;
 *   ACP1053-03  heads the audit writer would not store exactly, and an unchanged head admitted again.
 */

const fixtures: AdoptedCeoFixture[] = [];
const clients: Client[] = [];
const adoptedFixture = (bound?: Parameters<typeof makeAdoptedFixture>[0]): AdoptedCeoFixture => {
  const fixture = makeAdoptedFixture(bound);
  fixtures.push(fixture);
  return fixture;
};
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
});
afterAll(cleanupTempDirs);

/** A = LIVE, the head the fixture's target is born with; B is the head a compression rotates it to. */
const A = LIVE;
const B = "20261002_090000_rotated";

const reporting = (fixture: AdoptedCeoFixture, head: string) =>
  ({ gatewayOrigin: async (): Promise<GatewayIncumbentProof> => ({ ...fixture.proof, session_id: head }) });

const advances = (fixture: AdoptedCeoFixture) =>
  fixture.h.cp.audit.byKind(TARGET_HEAD_ADVANCED).map((row) => [row.evidence["previousHead"], row.evidence["head"]]);

describe("ACP1053-02: tool admission fences the recorded head across the Gateway readback", () => {
  it("a delayed readback of A after B was recorded does not move the head back", async () => {
    const fixture = adoptedFixture();
    let answer!: (proof: GatewayIncumbentProof) => void;
    const delayed = fixture.admit(undefined, {
      gatewayOrigin: () => new Promise<GatewayIncumbentProof>((resolve) => { answer = resolve; }),
    });
    // Another admission sees the rotation first and records A → B.
    expect((await fixture.admit(undefined, reporting(fixture, B))).allowed).toBe(true);
    expect(advances(fixture)).toEqual([[A, B]]);
    const before = snapshot(fixture.h);
    // The first readback was answered before the rotation and arrives only now.
    answer({ ...fixture.proof, session_id: A });
    const late = await delayed;
    expect(late.allowed).toBe(false);
    expect(snapshot(fixture.h)).toEqual(before);
    // A fresh readback naming A again is a head this conversation has left: refused, nothing written.
    expect((await fixture.admit(undefined, reporting(fixture, A))).allowed).toBe(false);
    expect(snapshot(fixture.h)).toEqual(before);
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(B);
  });

  it("an open connection admitted on A follows the recorded move to B: B's provenance is admitted, A's refused", async () => {
    const fixture = adoptedFixture();
    const admission = fixture.admission();
    const admitted = await fixture.admit();
    if (!admitted.allowed) throw new Error(admitted.message);
    expect(admitted.value.provenance.liveHermesSessionId).toBe(A);
    // What `startAdoptedCeoToolSocket` builds for the admitted connection.
    const server = createHermesServer(createHermesMcpPort(fixture.h.cp), () => admission.authenticate(admitted.value),
      { provenance: admitted.value.provenance });
    server.registerTool("fixture_mutation", { description: "fixture" },
      async () => respond(allow(ReasonCode.OK, { reached: true })));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "hermes-gateway-fixture", version: "1" });
    await client.connect(clientTransport);
    clients.push(client);
    const call = async (session: string) => (await client.callTool({ name: "fixture_mutation", arguments: {},
      _meta: { [HERMES_PROVENANCE_META_KEY]: { session_id: session, lineage_root_digest: DIGEST,
        principal: "owner", cron: false, delegation_depth: 0 } } })).structuredContent;
    expect(await call(A)).toMatchObject({ ok: true });
    // Another connection's admission records the rotation A → B; this one stays open.
    expect((await fixture.admit(undefined, reporting(fixture, B))).allowed).toBe(true);
    expect(await call(B)).toMatchObject({ ok: true, value: { reached: true } });
    expect(await call(A)).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_TOOL_PROVENANCE_REFUSED });
  });
});

describe("ACP1053-03: a head is stored exactly or refused", () => {
  it("refuses an sk-shaped head the audit writer would redact, however often it is admitted", async () => {
    const fixture = adoptedFixture();
    const secretShaped = `sk-${"Z".repeat(25)}`;
    for (let pass = 0; pass < 3; pass++) {
      const decision = await fixture.admit(undefined, reporting(fixture, secretShaped));
      expect(decision.allowed).toBe(false);
    }
    expect(fixture.h.cp.audit.byKind(TARGET_HEAD_ADVANCED).length).toBeLessThanOrEqual(1);
    expect(advances(fixture)).toEqual([]);
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(A);
  });

  it("never stores a head the audit writer would truncate as a later previous head, so the next move is recorded", async () => {
    const fixture = adoptedFixture();
    const long = `20261002_080000_${"a".repeat(185)}`;
    expect(long.length).toBe(201);
    expect((await fixture.admit(undefined, reporting(fixture, long))).allowed).toBe(false);
    expect((await fixture.admit(undefined, reporting(fixture, B))).allowed).toBe(true);
    expect(advances(fixture)).toEqual([[A, B]]);
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(B);
  });
});
