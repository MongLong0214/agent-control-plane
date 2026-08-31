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
      { report },
      { at: "2026-08-23T00:00:00.000Z", ok: true },
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
      { report },
      { at: "2026-08-15T00:00:00.000Z", ok: true },
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
      { report },
      { at: "2026-08-23T00:01:00.000Z", ok: false, error: "capacity probe threw" },
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

  it("a failed attempt older than the current success does not retroactively mark it stale", () => {
    const report = reportAt("2026-08-23T00:05:00.000Z", "HEALTHY");

    const health = resolveDoctorHealth(
      { report },
      { at: "2026-08-23T00:00:00.000Z", ok: false, error: "transient failure before the success" },
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
