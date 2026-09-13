import { describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  PROBE_FORBIDDEN_TOOLS,
  assertProbeToolsMeasuredOff,
  classifyHermesContention,
  hermesContentionReport,
  type HermesSharedStateObservation,
  type ProbeToolCensus,
} from "../../src/acceptance/disposable-realm.ts";

/**
 * #655's safety list has eight conditions. Six had witnesses; these are the other two, and they
 * are the two the list itself phrases as gates on *starting* rather than as properties of a run:
 *
 *   3  "if mutating and external tools are not **measured** as off, the run does not start"
 *   6  "if contention on the shared Hermes state.db appears, that observation is itself the
 *       result and the run stops"
 *
 * Both are the same shape underneath: **not having looked is not the same as having looked and
 * found nothing**, and a check that reads a boolean cannot tell them apart. That is why each
 * takes an observation object with a nullable "when" rather than a flag.
 */
const censusOf = (tools: Record<string, boolean>, measuredAt: string | null = "2026-09-13T08:00:00.000Z"): ProbeToolCensus => ({
  measuredAt,
  targetRoot: "/tmp/probe-root",
  tools,
});

const allOff = Object.fromEntries(PROBE_FORBIDDEN_TOOLS.map((tool) => [tool, false]));

describe("condition 3 — the probe child's tools are measured off, not assumed off", () => {
  it("refuses a census that was never taken, rather than reading its empty tool map as clean", () => {
    // The defect this exists for: `{}` has no enabled tool in it, so every "are any enabled?"
    // check passes on a census nobody took. The absence has to be its own refusal.
    const refused = assertProbeToolsMeasuredOff(censusOf({}, null));

    expect(refused.allowed).toBe(false);
    // Narrowed before the message is read: `Decision<T>`'s allowed branch carries no `message`,
    // and reading it through the union is a type error rather than a runtime one.
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE);
    expect(refused.message).toContain("never measured");
  });

  it("refuses a census that names only some of the forbidden tools", () => {
    // A census taken against a shorter list is not a census against this one. Reported separately
    // from an enabled tool because the operator's next action differs: complete the census rather
    // than change the child.
    const partial = { ...allOff };
    delete (partial as Record<string, boolean>)["web_fetch"];
    const refused = assertProbeToolsMeasuredOff(censusOf(partial));

    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ unmeasured: ["web_fetch"] });
  });

  it("refuses a child that may still call a tool whose side effects leave the realm", () => {
    const refused = assertProbeToolsMeasuredOff(censusOf({ ...allOff, bash: true }));

    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ enabled: ["bash"] });
  });

  it("allows a complete census with every forbidden tool measured off — the control", () => {
    // Without this the three refusals above would pass against a function that always denies.
    const allowed = assertProbeToolsMeasuredOff(censusOf(allOff));

    expect(allowed.allowed).toBe(true);
  });

  it("does not treat a tool it does not forbid as a reason to refuse", () => {
    // The list is about reach, not about every capability. A read-only tool the child happens to
    // have is not this condition's business, and refusing on it would make the gate unusable and
    // therefore switched off.
    const allowed = assertProbeToolsMeasuredOff(censusOf({ ...allOff, read: true }));

    expect(allowed.allowed).toBe(true);
  });
});

describe("condition 6 — contention on the shared Hermes database is the result, not a retry", () => {
  const observation = (
    contended: boolean | null,
    observedAt: string | null = "2026-09-13T08:00:00.000Z",
  ): HermesSharedStateObservation => ({
    observedAt,
    databasePath: "/Users/fixture/.hermes/state.db",
    contended,
    detail: "a second writer holds the -wal",
  });

  it("stops and reports when contention was observed", () => {
    expect(classifyHermesContention(observation(true))).toBe("STOP_AND_REPORT");
  });

  it("proceeds only when the inspection ran and found none", () => {
    expect(classifyHermesContention(observation(false))).toBe("PROCEED");
  });

  it("is inconclusive when the inspection never ran", () => {
    // Not PROCEED. This is the same absence-as-success shape as the tool census: an unexamined
    // database and an examined quiet one are different facts.
    expect(classifyHermesContention(observation(false, null))).toBe("INCONCLUSIVE");
  });

  it("is inconclusive when the inspection ran and could not decide", () => {
    // `contended: null` is the honest answer of a probe that could not read the file. Collapsing
    // it to false is how a run proceeds through the contention it was told to stop for.
    expect(classifyHermesContention(observation(null))).toBe("INCONCLUSIVE");
  });

  it("reports the observation it rests on, and claims nothing about the probe's subject", () => {
    // The condition says the observation *is* the result. A report that only says "stopped"
    // discards the finding the stop was made of.
    const report = hermesContentionReport(observation(true));

    expect(report).toContain("/Users/fixture/.hermes/state.db");
    expect(report).toContain("a second writer holds the -wal");
    expect(report).toContain("No process this run did not start was signalled");
    expect(report).toContain("nothing about the probe's subject was exercised");
  });
});
