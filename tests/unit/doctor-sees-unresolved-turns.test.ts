import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
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
const guardFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], recoverInFlight: true },
  });

const identity = (turnRequestId: string): TurnIdentity => ({
  turnRequestId,
  sessionDigest: "session-digest",
  promptDigest: "prompt-digest",
  bindingDigest: "binding-digest",
});

/**
 * Claims a turn the way production does — `IngressGuard.admit` then `claimTurn` — rather than
 * hand-inserting a row. The claim's `deliveryStatus` lives in `turn_claim_json`; `result_json`
 * is the reply-delivery lifecycle and never holds it (#671). A fixture that wrote it into
 * `result_json` would pass against a query that reads the wrong column and never catch the bug.
 *
 * `receivedAt` is stamped by `admit` from the harness clock, so the clock is moved there and
 * back rather than threaded through as a parameter `admit` does not take.
 */
const claim = (harness: ReturnType<typeof makeHarness>, nonce: string, receivedAt: string): void => {
  const guard = guardFor(harness);
  const restoreAt = harness.clock.now();
  harness.clock.set(receivedAt);
  const admitted = guard.admit({
    channel: "telegram",
    actor: "owner",
    conversation: "chat",
    nonce,
    payload: { text: "…" },
  });
  if (!admitted.allowed) {
    throw new Error(`fixture setup failed: admit refused (${JSON.stringify(admitted)})`);
  }
  const claimed = guard.claimTurn("telegram", nonce, identity(nonce));
  if (!claimed.allowed) {
    throw new Error(`fixture setup failed: claimTurn refused (${JSON.stringify(claimed)})`);
  }
  harness.clock.set(restoreAt);
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
    const admitted = guardFor(harness).admit({
      channel: "telegram",
      actor: "owner",
      conversation: "chat",
      nonce: "plain",
      payload: { text: "…" },
    });
    expect(admitted.allowed).toBe(true);

    expect(turnFinding(await harness.cp.doctor.run("system"))).toBeUndefined();
  });
});
