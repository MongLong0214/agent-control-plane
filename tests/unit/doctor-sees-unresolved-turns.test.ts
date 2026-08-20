import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";

afterAll(cleanupTempDirs);

/**
 * An unresolved turn is the one state the design says a timer must not resolve: the reply
 * command may already have written into the owner's transcript, and only a receipt or a person
 * can say which. The CEO made surfacing it a required condition on #632 — *"audit/doctor 에서
 * 명시적으로 보여야 한다"* — and #635 shipped only the audit half.
 *
 * That gap mattered because every runbook here opens with `agentctl doctor system`. A wedged
 * conversation was visible only to someone tailing `audit_events`, and the tool the operator
 * actually reaches for reported a healthy CEO route.
 */
const claim = (harness: ReturnType<typeof makeHarness>, nonce: string, receivedAt: string): void => {
  harness.cp.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, result_json)
     VALUES ('telegram', ?, 'owner', ?, ?)`,
    [nonce, receivedAt, JSON.stringify({ deliveryStatus: "TURN_CLAIMED", turnRequestId: nonce })],
  );
};

const turnFinding = (report: DoctorReport) =>
  report.findings.find((finding) => finding.code === "TURN_OUTCOME_UNKNOWN");

describe("what doctor says about a wedged conversation", () => {
  it("says nothing when nothing is outstanding", async () => {
    // The other half of the requirement. A finding that is always present is not a signal, and
    // an operator who learns to ignore it has lost the one they needed.
    const harness = makeHarness();

    expect(turnFinding(await harness.cp.doctor.run("system"))).toBeUndefined();
  });

  it("reports an outstanding turn rather than a healthy route", async () => {
    const harness = makeHarness();
    claim(harness, "update:1", harness.cp.clock.nowIso());

    const finding = turnFinding(await harness.cp.doctor.run("system"));

    expect(finding).toBeDefined();
    expect(finding?.observedEvidence).toMatchObject({ outstanding: 1 });
  });

  it("names the message, because the operator has to go and look at one", async () => {
    // A count says how many and nothing else. Settling requires finding the turn, and the
    // channel and nonce are what a person can search on.
    const harness = makeHarness();
    claim(harness, "update:7", harness.cp.clock.nowIso());

    const finding = turnFinding(await harness.cp.doctor.run("system"));

    expect(finding?.observedEvidence).toMatchObject({
      oldest: { channel: "telegram", nonce: "update:7" },
    });
  });

  it("escalates on age rather than clearing, because a turn does not become safe by getting old", async () => {
    // The CEO's rule: age is an escalation criterion, never a clear criterion. The same reason
    // `IngressGuard.prune` exempts these rows — an old unresolved turn is more likely to have
    // written than a new one, not less.
    const harness = makeHarness();
    claim(harness, "update:2", "2000-01-01T00:00:00.000Z");

    const finding = turnFinding(await harness.cp.doctor.run("system"));

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("ERROR");
  });

  it("reports the oldest, and counts all of them", async () => {
    const harness = makeHarness();
    claim(harness, "update:new", harness.cp.clock.nowIso());
    claim(harness, "update:old", "2000-01-01T00:00:00.000Z");

    const finding = turnFinding(await harness.cp.doctor.run("system"));

    expect(finding?.observedEvidence).toMatchObject({
      outstanding: 2,
      oldest: { nonce: "update:old" },
    });
  });

  it("ignores a message that was admitted but never claimed", async () => {
    // Admitted-and-running is not outstanding. Counting it would make every message in flight
    // look wedged, and the finding would stop meaning anything.
    const harness = makeHarness();
    harness.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('telegram', 'plain', 'owner', ?)`,
      [harness.cp.clock.nowIso()],
    );

    expect(turnFinding(await harness.cp.doctor.run("system"))).toBeUndefined();
  });
});
