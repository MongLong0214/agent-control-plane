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
  LSTART,
  OTHER_DIGEST,
  RELAY,
  SHELL,
  snapshot,
  STRANGER,
  TOKEN,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

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
    // The process at the pid started at neither recorded moment.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000999.000002");
    fixture.starts.set(GATEWAY, "Fri Oct  2 08:00:00 2026");
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    // The row's recorded start still matches by lstart, but the native token is not the one the
    // Gateway reported for itself: the one-second grain is not trusted on its own.
    fixture.starts.set(GATEWAY, LSTART);
    await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    // A Gateway restarted at the same pid: its readback and the live process agree with each
    // other, and only the CEO row still records the process that is gone.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000999.000002");
    fixture.starts.set(GATEWAY, "Fri Oct  2 08:00:00 2026");
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000999.000002" }),
      }),
      ReasonCode.CONFLICT,
    );
    fixture.starts.set(GATEWAY, LSTART);
    fixture.tokens.set(GATEWAY, TOKEN);
    // The readback reports another start token for the same pid.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, { gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1.000000" }) }),
      ReasonCode.CONFLICT,
    );
  });

  it("refuses a Gateway restarted inside the recorded lstart second, whose readback follows it (PR1046-R1)", async () => {
    const fixture = adoptedFixture();
    // Only the native token moves: the new process renders the same lstart second, and the
    // Gateway's own readback reports the new process consistently.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000000.000999");
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000000.000999" }),
      }),
      ReasonCode.CONFLICT,
    );
  });

  it("decides a legacy lstart-only row only when it was written after that second, then pins the token", async () => {
    // Written 2026-08-12T00:00:00Z, recording a process that started the day before.
    const fixture = adoptedFixture({ legacy: { lstart: "Tue Aug 11 09:00:00 2026" } });
    const { h } = fixture;
    expect(h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBeNull();
    expect((await fixture.admit()).allowed).toBe(true);
    expect(h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBe(TOKEN);
    // Pinned once: the next admission writes nothing, and a new token behind the same lstart and
    // a readback that follows it is now refused exactly.
    const pinned = snapshot(h);
    expect((await fixture.admit()).allowed).toBe(true);
    expect(snapshot(h)).toEqual(pinned);
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000000.000999");
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000000.000999" }),
      }),
      ReasonCode.CONFLICT,
    );
  });

  it("refuses a legacy row written inside its process's own start second, or before it", async () => {
    // The harness clock's own second, rendered the way `ps -o lstart=` renders it locally.
    const written = new Date("2026-08-12T00:00:00.000Z");
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][written.getDay()];
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][written.getMonth()];
    const two = (n: number) => String(n).padStart(2, "0");
    const sameSecond =
      `${day} ${month} ${String(written.getDate()).padStart(2, " ")} ` +
      `${two(written.getHours())}:${two(written.getMinutes())}:${two(written.getSeconds())} ${written.getFullYear()}`;
    const ambiguous = adoptedFixture({ legacy: { lstart: sameSecond } });
    await expectRefusedWithoutWrites(ambiguous, () => ambiguous.admit(), ReasonCode.CONFLICT);
    const later = adoptedFixture({ legacy: { lstart: LSTART } });
    await expectRefusedWithoutWrites(later, () => later.admit(), ReasonCode.CONFLICT);
  });

  it("pins nothing for a legacy row whose admission is refused after the lineage decided it (PR1046-R4)", async () => {
    const fixture = adoptedFixture({ legacy: { lstart: "Tue Aug 11 09:00:00 2026" } });
    // The lineage would decide this row and hand back a token to pin; the Gateway's readback then
    // names another start, so the admission is refused — and must leave nothing behind.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1790000000.000777" }),
      }),
      ReasonCode.CONFLICT,
    );
    expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBeNull();
  });

  it("refuses a legacy lstart that names two instants where clocks fall back (PR1046-R1, round 2)", async () => {
    const zone = process.env["TZ"];
    process.env["TZ"] = "America/New_York";
    try {
      // The original started at 01:30 EDT (05:30Z) and was recorded at 01:31 EDT; its successor at
      // the same pid started at 01:30 EST (06:30Z). Both render `Sun Nov  1 01:30:00 2026`.
      const fixture = adoptedFixture({
        legacy: { lstart: "Sun Nov  1 01:30:00 2026", writtenAt: "2026-11-01T05:31:00.000Z" },
      });
      fixture.tokens.set(GATEWAY, "darwin-tv:1793511000.000001");
      await expectRefusedWithoutWrites(
        fixture,
        () => fixture.admit(RELAY, {
          gatewayOrigin: async () => ({ ...fixture.proof, process_started_at: "darwin-tv:1793511000.000001" }),
        }),
        ReasonCode.CONFLICT,
      );
      expect(fixture.h.cp.sessions.pinnedNativeStart(fixture.gatewaySessionId)).toBeNull();
      // The original itself cannot be told from it either, so it is refused too: fail-closed.
      fixture.tokens.set(GATEWAY, TOKEN);
      await expectRefusedWithoutWrites(fixture, () => fixture.admit(), ReasonCode.CONFLICT);
    } finally {
      if (zone === undefined) delete process.env["TZ"];
      else process.env["TZ"] = zone;
    }
  });

  it("refuses another chat's session, another lineage, and a binding to another head", async () => {
    const fixture = adoptedFixture();
    for (const proof of [
      { ...fixture.proof, session_id: "20261002_080000_other_chat" },
      { ...fixture.proof, lineage_root_digest: OTHER_DIGEST },
    ]) {
      await expectRefusedWithoutWrites(fixture, () => fixture.admit(RELAY, { gatewayOrigin: async () => proof }), ReasonCode.CONFLICT);
    }
    // The readback and the configuration agree with each other, not with what the CEO is bound to.
    await expectRefusedWithoutWrites(
      fixture,
      () => fixture.admit(RELAY, {
        expectedLiveSessionId: "20261002_080000_other_chat",
        gatewayOrigin: async () => ({ ...fixture.proof, session_id: "20261002_080000_other_chat" }),
      }),
      ReasonCode.CONFLICT,
    );
    const otherLineage = adoptedFixture({ digest: OTHER_DIGEST });
    await expectRefusedWithoutWrites(otherLineage, () => otherLineage.admit(), ReasonCode.CONFLICT);
    const olderHead = adoptedFixture({ locator: "20261001_000000_older_head" });
    await expectRefusedWithoutWrites(olderHead, () => olderHead.admit(), ReasonCode.CONFLICT);
  });

  it("refuses a DEAD Gateway, an unreadable one, a different Gateway, and a binding the operator has not adopted", async () => {
    const dead = adoptedFixture();
    dead.tokens.delete(GATEWAY);
    dead.starts.delete(GATEWAY);
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
    other.starts.set(IMPOSTOR_GATEWAY, LSTART);
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
