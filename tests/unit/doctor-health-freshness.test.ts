import { describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { resolveDoctorHealth, type DoctorReport } from "../../src/doctor/doctor.ts";

/**
 * #734 — a doctor verdict was written only at startup, so an eight-day-old snapshot read as
 * current health. `resolveDoctorHealth` is the pure comparison that closes the gap: given the
 * last evaluation that actually finished and the outcome of the most recent attempt to produce a
 * fresh one, it says what a reader should be told *right now*, rather than handing back whatever
 * was last written regardless of age.
 */
const reportAt = (ranAt: string, status: DoctorReport["status"] = "HEALTHY"): DoctorReport => ({
  scope: "system",
  target: null,
  status,
  findings: [],
  ranAt,
});

describe("#734 resolveDoctorHealth", () => {
  it("carries the checked_at of the evaluation that actually ran, and reports it as current inside the freshness window", () => {
    const report = reportAt("2026-08-23T00:00:00.000Z", "DEGRADED");

    const health = resolveDoctorHealth(
      { report, generation: 7 },
      { startedAt: "2026-08-22T23:59:59.000Z", completedAt: "2026-08-23T00:00:00.000Z", generation: 7, ok: true },
      "2026-08-23T00:01:00.000Z",
      10 * 60_000,
    );

    expect(health).toMatchObject({
      status: "DEGRADED",
      reasonCode: ReasonCode.DOCTOR_DEGRADED,
      checkedAt: "2026-08-23T00:00:00.000Z",
      ageMs: 60_000,
      freshnessMs: 10 * 60_000,
    });
  });

  it("#734 criterion 1/3: a report older than the bounded freshness window is not served as its old value — the reader gets STALE", () => {
    const report = reportAt("2026-08-15T00:00:00.000Z", "HEALTHY");

    const health = resolveDoctorHealth(
      { report, generation: 3 },
      { startedAt: "2026-08-14T23:59:59.000Z", completedAt: "2026-08-15T00:00:00.000Z", generation: 3, ok: true },
      "2026-08-23T00:00:00.000Z",
      10 * 60_000,
    );

    expect(health.status).toBe("STALE");
    expect(health.status).not.toBe("HEALTHY");
    expect(health.reasonCode).toBe(ReasonCode.DOCTOR_HEALTH_STALE);
    expect(health.checkedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("#734 criterion 3: a re-evaluation that fails yields STALE immediately, even while the last success is still inside its window", () => {
    const report = reportAt("2026-08-23T00:00:00.000Z", "HEALTHY");

    const health = resolveDoctorHealth(
      { report, generation: 4 },
      {
        startedAt: "2026-08-23T00:00:30.000Z",
        completedAt: "2026-08-23T00:01:00.000Z",
        generation: 5,
        ok: false,
        error: "capacity probe threw",
      },
      // Only a minute past the last success and the last attempt — far inside a 10-minute
      // window. A naive age-only check would still call this HEALTHY; the failed attempt is
      // evidence, right now, that the cached value must not be reused.
      "2026-08-23T00:01:30.000Z",
      10 * 60_000,
    );

    expect(health.status).toBe("STALE");
    expect(health.status).not.toBe("HEALTHY");
    expect(health.reasonCode).toBe(ReasonCode.DOCTOR_HEALTH_STALE);
    expect(health.reason).toContain("capacity probe threw");
  });

  it("#734: a failure that STARTED before the retained success finished, but COMPLETED after it, is still the newest fact — STALE", () => {
    // The comparison this function used to make was `lastAttempt.at >= report.ranAt`, and those
    // two stamps are taken at different lifecycle points: `at` before the probes, `ranAt` after
    // them. A slow failure overlapping a fast success has a start stamp earlier than the
    // success's completion stamp, so the old form ruled the failure *older* and served the
    // healthy verdict it was evidence against. Nothing about the stamps below is ambiguous —
    // generation 9 finished after generation 8 — and only a rule that compares like with like
    // can see it.
    const report = reportAt("2026-08-23T00:00:20.000Z", "HEALTHY");

    const health = resolveDoctorHealth(
      { report, generation: 8 },
      {
        startedAt: "2026-08-23T00:00:10.000Z",
        completedAt: "2026-08-23T00:00:30.000Z",
        generation: 9,
        ok: false,
        error: "the slow probe exploded",
      },
      "2026-08-23T00:00:35.000Z",
      10 * 60_000,
    );

    expect(health.status).toBe("STALE");
    expect(health.status).not.toBe("HEALTHY");
    expect(health.reasonCode).toBe(ReasonCode.DOCTOR_HEALTH_STALE);
    expect(health.reason).toContain("the slow probe exploded");
  });

  it("a failed attempt older than the current success does not retroactively mark it stale", () => {
    const report = reportAt("2026-08-23T00:05:00.000Z", "HEALTHY");

    const health = resolveDoctorHealth(
      { report, generation: 5 },
      {
        // Started *and* finished before the retained success did, and it says so in the only
        // field an ordering may read: a lower generation.
        startedAt: "2026-08-23T00:00:00.000Z",
        completedAt: "2026-08-23T00:00:10.000Z",
        generation: 4,
        ok: false,
        error: "transient failure before the success",
      },
      "2026-08-23T00:05:30.000Z",
      10 * 60_000,
    );

    expect(health.status).toBe("HEALTHY");
  });

  it("no evaluation has ever succeeded: UNKNOWN, not a stale value pretending to be one", () => {
    const health = resolveDoctorHealth(null, null, "2026-08-23T00:00:00.000Z", 10 * 60_000);

    expect(health).toMatchObject({
      status: "UNKNOWN",
      reasonCode: ReasonCode.DOCTOR_HEALTH_UNKNOWN,
      checkedAt: null,
      ageMs: null,
    });
  });
});
