import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import {
  adoptedFixture as makeAdoptedFixture,
  CEO,
  count,
  DIGEST,
  expectRefusedWithoutWrites,
  GATEWAY,
  IMPOSTOR_GATEWAY,
  LIVE,
  OTHER_DIGEST,
  RELAY,
  SHELL,
  snapshot,
  STRANGER,
  TOKEN,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { readHermesTargetHead, TARGET_HEAD_ADVANCED } from "../../src/session/hermes-target-head.ts";

/**
 * The adopted CEO tool channel's one admission decision (#1037), against the real registries, with
 * the process tree and the Gateway's readback stated by the test. Every refusal is asserted by its
 * code and by every table it could write being identical before and after — and so is every
 * admission, because admitting writes nothing either.
 */

const fixtures: AdoptedCeoFixture[] = [];
const adoptedFixture = (bound?: Parameters<typeof makeAdoptedFixture>[0]): AdoptedCeoFixture => {
  const fixture = makeAdoptedFixture(bound);
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
});
afterAll(cleanupTempDirs);

describe("adopted CEO tool admission — admitted", () => {
  it("admits the Gateway's descendant as the bound CEO, writing nothing", async () => {
    const fixture = adoptedFixture();
    const before = snapshot(fixture.h);
    const admitted = await fixture.admit();
    expect(admitted.allowed).toBe(true);
    if (!admitted.allowed) return;
    expect(admitted.value).toMatchObject({
      bindingGeneration: 1,
      sessionId: fixture.gatewaySessionId,
      actorId: fixture.actorId,
      provenance: { liveHermesSessionId: LIVE, lineageRootDigest: DIGEST },
    });
    expect(snapshot(fixture.h)).toEqual(before);
    expect(fixture.admission().authenticate(admitted.value)).toMatchObject({
      allowed: true,
      value: { actor: fixture.gatewaySessionId, sessionId: fixture.gatewaySessionId },
    });
  });

  it("admits a reconnect from the same Gateway with the same answer: no new session, generation or secret", async () => {
    const fixture = adoptedFixture();
    const { h } = fixture;
    const before = snapshot(h);
    const first = await fixture.admit();
    // A respawned relay is another child of the same Gateway, through a different path.
    fixture.parents.set(STRANGER, GATEWAY);
    const respawned = await fixture.admit(STRANGER);
    const concurrent = await Promise.all([fixture.admit(), fixture.admit(RELAY)]);
    for (const decision of [first, respawned, ...concurrent]) {
      expect(decision).toEqual(first);
    }
    expect(snapshot(h)).toEqual(before);
    expect(count(h, "SELECT COUNT(*) AS n FROM assignments WHERE role_key = ?", [CEO])).toBe(1);
    expect(h.cp.db.get("SELECT MAX(binding_generation) AS g FROM assignments WHERE role_key = ?", [CEO])).toEqual({ g: 1 });
    expect(count(h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    expect(count(h, "SELECT COUNT(*) AS n FROM conversational_actors")).toBe(1);
  });
});

describe("adopted CEO tool admission — the head moves inside the lineage (2026-10-03)", () => {
  const OLDER_HEAD = "20260923_000000_older_head";

  it("admits the Gateway's new head over the stored older one and records only that move, once", async () => {
    // CEO gen3 as it stood live: bound to the 09-23 head, Gateway serving the 10-01 head.
    const fixture = adoptedFixture({ locator: OLDER_HEAD });
    const { h } = fixture;
    expect(readHermesTargetHead(h.cp.db, fixture.actorId)?.head).toBe(OLDER_HEAD);
    const before = snapshot(h);
    const admitted = await fixture.admit();
    expect(admitted.allowed).toBe(true);
    if (!admitted.allowed) return;
    // Provenance is anchored on the one head the Gateway serves, not on the lineage.
    expect(admitted.value.provenance).toEqual({ liveHermesSessionId: LIVE, lineageRootDigest: DIGEST });
    expect(readHermesTargetHead(h.cp.db, fixture.actorId)).toMatchObject({ head: LIVE, bornLocator: OLDER_HEAD });
    const after = snapshot(h);
    // No generation, session, secret, actor or target row: one audit row, the head move.
    for (const table of Object.keys(before)) {
      if (table !== "audit_events") expect(after[table]).toEqual(before[table]);
    }
    const added = after.audit_events!.filter((row) => !before.audit_events!.includes(row));
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0]!)).toMatchObject({ kind: TARGET_HEAD_ADVANCED, role_key: CEO,
      session_id: fixture.gatewaySessionId });
    expect(JSON.parse(JSON.parse(added[0]!).evidence_json)).toMatchObject({ previousHead: OLDER_HEAD, head: LIVE,
      lineageRootDigest: DIGEST, actorId: fixture.actorId, path: "tool_admission", bindingGeneration: 1 });
    // The move is made once: the next admission finds the head it reports and writes nothing.
    const settled = snapshot(h);
    expect(await fixture.admit()).toEqual(admitted);
    expect(snapshot(h)).toEqual(settled);
  });

  it("refuses a head in another lineage over the stored older one, writing nothing", async () => {
    const fixture = adoptedFixture({ locator: OLDER_HEAD });
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        lineageRootDigest: OTHER_DIGEST,
        gatewayOrigin: async () => ({ ...fixture.proof, session_id: "20261002_080000_other_chat",
          lineage_root_digest: OTHER_DIGEST }),
      }),
      ReasonCode.CONFLICT,
    );
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(OLDER_HEAD);
  });

  it("does not move the head for a Gateway that is not the bound process", async () => {
    const fixture = adoptedFixture({ locator: OLDER_HEAD });
    // The readback names another start for the bound pid: refused before anything is recorded.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, { gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1.000000" }) }),
      ReasonCode.CONFLICT,
    );
    expect(readHermesTargetHead(fixture.h.cp.db, fixture.actorId)?.head).toBe(OLDER_HEAD);
  });
});

describe("adopted CEO tool admission — refusals write nothing", () => {
  it("refuses a caller whose ancestry does not reach the Gateway", async () => {
    const fixture = adoptedFixture();
    // A stranger whose parent is launchd.
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(STRANGER), ReasonCode.CONFLICT);
    // The Gateway is not its own ancestor: the peer must be a descendant.
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(GATEWAY), ReasonCode.CONFLICT);
    // A chain that loops before reaching the Gateway.
    fixture.parents.set(SHELL, RELAY);
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    // A chain that cannot be read past the shell.
    fixture.parents.delete(SHELL);
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
  });

  it("refuses when the Gateway's pid now belongs to another process (pid reuse)", async () => {
    const fixture = adoptedFixture();
    // The process at the pid is not the one whose native start was pinned at adoption.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000999.000002");
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    // A Gateway restarted at the same pid: its readback and the live process agree with each
    // other, and only the CEO row still records the process that is gone.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000999.000002" }),
      }),
      ReasonCode.CONFLICT,
    );
    fixture.tokens.set(GATEWAY, TOKEN);
    // The readback reports another start token for the same pid.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, { gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1.000000" }) }),
      ReasonCode.CONFLICT,
    );
  });

  it("refuses a Gateway whose native start is not the pinned one, though both render one lstart second (PR1046-R1)", async () => {
    const fixture = adoptedFixture();
    // Only the native token moves: the new process renders the same lstart second, and the
    // Gateway's own readback reports the new process consistently. The pin decides.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000000.000999");
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000000.000999" }),
      }),
      ReasonCode.CONFLICT,
    );
  });

  it("refuses an unpinned lstart-only row, the shape adoption wrote before #1037, and pins nothing", async () => {
    // Written 2026-08-12T00:00:00Z, recording a process that started the day before: exactly the
    // row the deleted lstart rule admitted and pinned. Its age no longer counts for anything.
    const fixture = adoptedFixture({ unpinned: { lstart: "Tue Aug 11 09:00:00 2026" } });
    expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBeNull();
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    // Nor does the Gateway's own readback agreeing with the live process stand in for the pin.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, { gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: TOKEN }) }),
      ReasonCode.CONFLICT,
    );
    expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBeNull();
  });

  it("admits a Gateway on the native start pinned at adoption, and the admission leaves the pin as it was", async () => {
    const fixture = adoptedFixture();
    expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBe(TOKEN);
    const before = snapshot(fixture.h);
    expect((await fixture.admit()).allowed).toBe(true);
    expect(snapshot(fixture.h)).toEqual(before);
    expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBe(TOKEN);
  });

  it("refuses another lineage, reported by the Gateway or bound to the CEO", async () => {
    const fixture = adoptedFixture();
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, { gatewayOrigin: async () => ({ ...fixture.proof, lineage_root_digest: OTHER_DIGEST }) }),
      ReasonCode.CONFLICT,
    );
    // The readback and the configuration agree with each other, not with what the CEO is bound to.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        lineageRootDigest: OTHER_DIGEST,
        gatewayOrigin: async () => ({ ...fixture.proof, lineage_root_digest: OTHER_DIGEST }),
      }),
      ReasonCode.CONFLICT,
    );
    const otherLineage = adoptedFixture({ digest: OTHER_DIGEST });
    await expectRefusedWithoutWrites(otherLineage, () => otherLineage.admit(), ReasonCode.CONFLICT);
  });

  it("refuses a DEAD Gateway, an unreadable one, a different Gateway, and a binding the operator has not adopted", async () => {
    const dead = adoptedFixture();
    dead.tokens.delete(GATEWAY);
    await expectRefusedWithoutWrites(dead, () => dead.admit(), ReasonCode.CONFLICT);

    const unreadable = adoptedFixture();
    await expectRefusedWithoutWrites(unreadable, () => unreadable.admit(RELAY, { gatewayOrigin: async () => null }), ReasonCode.CONFLICT);
    await expectRefusedWithoutWrites(
      unreadable,
      () => unreadable.admit(RELAY, { gatewayOrigin: () => Promise.reject(new Error("Gateway identity unavailable")) }),
      ReasonCode.CONFLICT,
    );

    // A live process reporting itself as the Gateway that the CEO is not bound to.
    const other = adoptedFixture();
    other.parents.set(RELAY, IMPOSTOR_GATEWAY);
    other.parents.set(IMPOSTOR_GATEWAY, 1);
    other.tokens.set(IMPOSTOR_GATEWAY, TOKEN);
    await expectRefusedWithoutWrites(
      other,
      () => other.admit(RELAY, { gatewayOrigin: async () => ({ ...other.proof, process_pid: IMPOSTOR_GATEWAY }) }),
      ReasonCode.CONFLICT,
    );

    // After a Gateway restart the binding is revoked, and adoption is the operator's route.
    const revoked = adoptedFixture();
    expect(revoked.h.cp.bindings.revoke(CEO, "Gateway restarted").allowed).toBe(true);
    await expectRefusedWithoutWrites(revoked, () => revoked.admit(), ReasonCode.CONFLICT);
  });

  it("stops authenticating an admitted connection once the binding moves, without re-proving identity", async () => {
    const fixture = adoptedFixture();
    const admitted = await fixture.admit();
    if (!admitted.allowed) throw new Error(JSON.stringify(admitted));
    const admission = fixture.admission();
    expect(admission.authenticate(admitted.value).allowed).toBe(true);
    // A bootstrap or an operator re-adoption moves the CEO to another runtime.
    expect(fixture.h.cp.bindings.revoke(CEO, "operator re-adoption").allowed).toBe(true);
    const replacement = fixture.h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: 1_234_567 });
    expect(fixture.h.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(fixture.h.cp.bindings.bind({ role: Role.CEO, sessionId: replacement.sessionId }).allowed).toBe(true);
    expect(admission.authenticate(admitted.value)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
    });
  });
});
