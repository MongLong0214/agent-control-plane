import { afterAll, describe, expect, it } from "vitest";

import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #880. #870 made a frame whose handler threw count, which ended a real misdiagnosis: the
 * subscriber used to look *silent*, and `BUZZ_MENTION_SUBSCRIBER_SILENT` sent the operator to the
 * relay while this runtime's handling was what failed. The count also suppressed the only finding
 * the state had — `framesHandled > 0` returns early — so the repair moved it from reported-wrongly
 * to reported-not-at-all, with the rejection tally the single remaining trace and no reader in
 * `src/` consulting it.
 *
 * These tests enter where the operator enters: `OPERATOR_METHOD.DOCTOR_RUN` with `scope: "system"`,
 * which is the call `supplementalSystemFindings()` hangs off. `buzzMentionSubscriberFindings` is
 * private and asserting it directly would be a test of a method rather than of the report an
 * operator reads.
 *
 * The sibling finding has no test for a stated reason — its grace window is clock-dependent and
 * `startedAtMs` is stamped by the setter, so a test cannot age it. This one has no window: a throw
 * is evidence at any age, which is what makes the behaviour reachable from here at all.
 */
const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

interface Counters {
  framesHandled: number;
  admitted: number;
  rejections: Record<string, number>;
}

const findingsFor = async (counters: Counters, label: string): Promise<Array<{ code: string; observedEvidence?: Record<string, unknown> }>> => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const stateDir = tempDir(`acp-handling-${label}-`);
  const daemon = new Daemon(harness.cp, { stateDir });
  const started = await daemon.start();
  expect(started.allowed).toBe(true);
  daemon.setBuzzMentionReceipt({ configuredIdentities: 1, counters: () => counters });
  const response = await daemon.handleOperatorRequest(
    { requestId: `doctor-${label}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
    PEER,
  );
  expect(response.allowed).toBe(true);
  await daemon.stop();
  return (response as { value: { findings: Array<{ code: string; observedEvidence?: Record<string, unknown> }> } })
    .value.findings;
};

const HANDLING_FAILING = "BUZZ_MENTION_SUBSCRIBER_HANDLING_FAILING";

describe("a subscriber whose handling fails on every frame says so (#880)", () => {
  it("reports handling as the failing side, with the relay's delivery shown beside it", async () => {
    // Two protocol frames carrying no verdict (an AUTH challenge and its `OK`) plus one `EVENT`
    // whose handler threw. `framesHandled` is 3, so the silent finding is suppressed, and under
    // the shipped behaviour before this change that left no finding at all.
    const findings = await findingsFor(
      { framesHandled: 3, admitted: 0, rejections: { "frame-handler-threw": 1 } },
      "failing",
    );

    expect(findings).toContainEqual(expect.objectContaining({
      code: HANDLING_FAILING,
      // Both numbers, because either alone reads as the other diagnosis: frames handled says the
      // relay is delivering, the throw count says this runtime is what fails.
      observedEvidence: expect.objectContaining({ framesHandled: 3, admitted: 0, frameHandlerThrew: 1 }),
    }));
    // The diagnosis it replaces must not also fire — two findings pointing at opposite sides is
    // the misdirection restated, not repaired.
    expect(findings).not.toContainEqual(expect.objectContaining({ code: "BUZZ_MENTION_SUBSCRIBER_SILENT" }));
  });

  it("stays quiet once any frame produced a different verdict — one transient throw is not this", async () => {
    // The control that makes the assertion above mean something. A delivery alongside the throw
    // breaks the equality permanently for this process, which is why no window or ratio is needed.
    const findings = await findingsFor(
      { framesHandled: 4, admitted: 1, rejections: { "frame-handler-threw": 1 } },
      "transient",
    );

    expect(findings).not.toContainEqual(expect.objectContaining({ code: HANDLING_FAILING }));
  });

  it("counts the denominator as verdicts, not as frames, so protocol traffic cannot dilute it", async () => {
    // The term an earlier reading of `BuzzMentionCounters` omitted. A real connection always
    // carries AUTH/`OK`/`EOSE`/`NOTICE`, none of which produces a verdict; comparing the throw
    // bucket against `framesHandled` would never reach equality and the finding would be dead on
    // every live daemon while passing a unit test that sent no protocol frames.
    const findings = await findingsFor(
      { framesHandled: 12, admitted: 0, rejections: { "frame-handler-threw": 2 } },
      "protocol",
    );

    expect(findings).toContainEqual(expect.objectContaining({ code: HANDLING_FAILING }));
  });

  it("stays quiet when frames were refused for authority rather than by a throw", async () => {
    // `event-not-addressed` is a relay/addressing repair and `frame-handler-threw` is a runtime
    // one. A finding that fired on any nonzero rejection total would send the operator to the
    // wrong side again, one bucket over.
    const findings = await findingsFor(
      { framesHandled: 5, admitted: 0, rejections: { "event-not-addressed": 3 } },
      "addressing",
    );

    expect(findings).not.toContainEqual(expect.objectContaining({ code: HANDLING_FAILING }));
  });
});
