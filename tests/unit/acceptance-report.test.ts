import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  type AcceptanceLifecycles,
  type AcceptedAnomalies,
  buildAcceptanceReport,
  computeVerdict,
  type PreventedAttempts,
} from "../../src/export/acceptance-report.ts";
import type { Db } from "../../src/db/database.ts";
import { makeHarness } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const insertRun = (
  db: Db,
  runId: string,
  state: "COMPLETED" | "FAILED" | "CANCELLED" | "ACTIVE",
  createdAt: string,
): void => {
  db.run(
    `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at, ended_at)
     VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', ?, 'fixture', 'sha256:contract', ?, ?)`,
    [runId, state, createdAt, state === "ACTIVE" ? null : createdAt],
  );
};

const insertAudit = (db: Db, at: string, kind: string, reasonCode: string | null): void => {
  db.run(
    `INSERT INTO audit_events (at, kind, reason_code, evidence_json) VALUES (?, ?, ?, '{}')`,
    [at, kind, reasonCode],
  );
};

const noLifecycles: AcceptanceLifecycles = { completed: 0, failed: 0, cancelled: 0, total: 0 };
const oneLifecycle: AcceptanceLifecycles = { completed: 1, failed: 0, cancelled: 0, total: 1 };
const twelveLifecycles: AcceptanceLifecycles = { completed: 12, failed: 0, cancelled: 0, total: 12 };

const zeroPrevented: PreventedAttempts = {
  falseCompletions: 0,
  duplicateDispatches: 0,
  acceptedStaleGenerationResults: 0,
  forgedGates: 0,
  unauthorizedMerges: 0,
};

const allNA: AcceptedAnomalies = {
  falseCompletions: "N/A",
  duplicateDispatches: "N/A",
  acceptedStaleGenerationResults: "N/A",
  forgedGates: "N/A",
  unauthorizedMerges: "N/A",
};

const allUnknown: AcceptedAnomalies = {
  falseCompletions: "UNKNOWN",
  duplicateDispatches: "UNKNOWN",
  acceptedStaleGenerationResults: "UNKNOWN",
  forgedGates: "UNKNOWN",
  unauthorizedMerges: "UNKNOWN",
};

const allZero: AcceptedAnomalies = {
  falseCompletions: 0,
  duplicateDispatches: 0,
  acceptedStaleGenerationResults: 0,
  forgedGates: 0,
  unauthorizedMerges: 0,
};

describe("agentctl acceptance report — reading the database", () => {
  it("reports NA for the verdict and every accepted anomaly when the database has no lifecycles", () => {
    const harness = makeHarness();
    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);

    expect(report.lifecycles.total).toBe(0);
    expect(report.verdict).toBe("N/A");
    expect(report.acceptedAnomalies.falseCompletions).toBe("N/A");
    expect(report.acceptedAnomalies.duplicateDispatches).toBe("N/A");
    expect(report.acceptedAnomalies.acceptedStaleGenerationResults).toBe("N/A");
    expect(report.acceptedAnomalies.forgedGates).toBe("N/A");
    expect(report.acceptedAnomalies.unauthorizedMerges).toBe("N/A");

    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain("PASS");
  });

  it("reports NA even when telemetry and audit rows exist but no lifecycle ever completed", () => {
    // The exact trap the CEO named: the daemon measuring itself produces telemetry/audit rows
    // while runs, tasks and projects stay at zero. The window may be real; the verdict must not be.
    const harness = makeHarness();
    insertAudit(harness.cp.db, "2026-08-01T00:00:00.000Z", "CAPACITY_PROBE", null);
    insertAudit(harness.cp.db, "2026-08-14T00:00:00.000Z", "CONTINUITY_RECONCILED", null);
    harness.cp.db.run(
      `INSERT INTO telemetry_metrics (at, scope, name, value_num) VALUES (?, 'capacity', 'probe', 1)`,
      ["2026-08-10T00:00:00.000Z"],
    );

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.lifecycles.total).toBe(0);
    expect(report.window.firstActivityAt).toBe("2026-08-01T00:00:00.000Z");
    expect(report.window.lastActivityAt).toBe("2026-08-14T00:00:00.000Z");
    expect(report.verdict).toBe("N/A");
    expect(report.acceptedAnomalies.forgedGates).toBe("N/A");
  });

  it("reports the cancelled field under its own name, not abandoned", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_cancelled_1", "CANCELLED", "2026-08-10T00:00:00.000Z");

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.lifecycles).toEqual({ completed: 0, failed: 0, cancelled: 1, total: 1 });
    expect(Object.keys(report.lifecycles)).not.toContain("abandoned");
  });

  it("reports real zero prevented attempts and UNKNOWN accepted anomalies for completed lifecycles with no guard denials", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_clean_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_2", "FAILED", "2026-08-11T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_3", "CANCELLED", "2026-08-12T00:00:00.000Z");

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.lifecycles).toEqual({ completed: 1, failed: 1, cancelled: 1, total: 3 });
    // Prevented attempts are a real, always-measurable count — no guard fired, so all real zeros.
    expect(report.preventedAttempts).toEqual(zeroPrevented);
    // No accepted-anomaly source exists in this codebase today (see ACCEPTED_ANOMALY_SOURCES in
    // src/export/acceptance-report.ts) — every category must read UNKNOWN, never a bare 0.
    expect(report.acceptedAnomalies).toEqual(allUnknown);
    expect(report.verdict).toBe("UNVERIFIED");
    expect(report.verdictDetail).toContain("3");
    expect(report.verdictDetail.toLowerCase()).toContain("not a clean bill of health");
  });

  it("a prevented attempt from a guard refusing a forged gate does not produce ANOMALIES_PRESENT", () => {
    // This is the correction that matters: GATE_CREATOR_UNTRUSTED is the record of the guard
    // *working* — an attempt was refused, not an anomaly that was accepted. Seeding it must move
    // preventedAttempts, never acceptedAnomalies, and the verdict must not read as a clean pass
    // either — it stays UNVERIFIED because no accepted-anomaly source can rule the anomaly out.
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_forged_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(harness.cp.db, "2026-08-10T00:05:00.000Z", "GATE_REJECTED", ReasonCode.GATE_CREATOR_UNTRUSTED);

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.forgedGates).toBe(1);
    expect(report.acceptedAnomalies.forgedGates).toBe("UNKNOWN");
    expect(report.verdict).not.toBe("ANOMALIES_PRESENT");
    expect(report.verdict).not.toBe("OBSERVED_NO_ANOMALIES");
    expect(report.verdict).toBe("UNVERIFIED");
  });

  it("a prevented attempt from a guard refusing an unauthorised merge does not produce ANOMALIES_PRESENT", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_merge_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(harness.cp.db, "2026-08-10T00:05:00.000Z", "MERGE_REJECTED", ReasonCode.MERGE_AUTHORITY_DENIED);

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.unauthorizedMerges).toBe(1);
    expect(report.acceptedAnomalies.unauthorizedMerges).toBe("UNKNOWN");
    expect(report.verdict).not.toBe("ANOMALIES_PRESENT");
  });

  it("derives the window from the data's own first and last activity rather than a constant", () => {
    const harnessA = makeHarness();
    insertAudit(harnessA.cp.db, "2026-01-05T00:00:00.000Z", "CAPACITY_PROBE", null);
    insertAudit(harnessA.cp.db, "2026-01-06T00:00:00.000Z", "CAPACITY_PROBE", null);
    const reportA = buildAcceptanceReport(harnessA.cp.db, harnessA.cp.clock);

    const harnessB = makeHarness();
    insertAudit(harnessB.cp.db, "2026-05-01T00:00:00.000Z", "CAPACITY_PROBE", null);
    insertAudit(harnessB.cp.db, "2026-06-20T00:00:00.000Z", "CAPACITY_PROBE", null);
    const reportB = buildAcceptanceReport(harnessB.cp.db, harnessB.cp.clock);

    expect(reportA.window.firstActivityAt).toBe("2026-01-05T00:00:00.000Z");
    expect(reportA.window.lastActivityAt).toBe("2026-01-06T00:00:00.000Z");
    expect(reportB.window.firstActivityAt).toBe("2026-05-01T00:00:00.000Z");
    expect(reportB.window.lastActivityAt).toBe("2026-06-20T00:00:00.000Z");
    expect(reportA.window.durationMs).not.toBe(reportB.window.durationMs);
  });

  it("carries its own lifecycle count so a small clean sample reads differently from a large one", () => {
    const small = makeHarness();
    insertRun(small.cp.db, "run_small_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    const smallReport = buildAcceptanceReport(small.cp.db, small.cp.clock);

    const large = makeHarness();
    for (let index = 0; index < 12; index += 1) {
      insertRun(large.cp.db, `run_large_${index}`, "COMPLETED", "2026-08-10T00:00:00.000Z");
    }
    const largeReport = buildAcceptanceReport(large.cp.db, large.cp.clock);

    expect(smallReport.verdict).toBe("UNVERIFIED");
    expect(largeReport.verdict).toBe("UNVERIFIED");
    expect(smallReport.lifecycles.total).toBe(1);
    expect(largeReport.lifecycles.total).toBe(12);
    // Same verdict token, but the detail and the count it carries must differ — a reader
    // comparing the two must not be able to mistake one sample size for the other.
    expect(smallReport.verdictDetail).not.toBe(largeReport.verdictDetail);
    expect(smallReport.verdictDetail).toContain("1");
    expect(largeReport.verdictDetail).toContain("12");
  });
});

describe("agentctl acceptance report — verdict logic in isolation", () => {
  it("is NA whenever there are no lifecycles, regardless of prevented attempts", () => {
    const { verdict } = computeVerdict(noLifecycles, zeroPrevented, allNA);
    expect(verdict).toBe("N/A");
  });

  it("is OBSERVED_NO_ANOMALIES only when every accepted-anomaly category is a verified zero", () => {
    const { verdict, verdictDetail } = computeVerdict(oneLifecycle, zeroPrevented, allZero);
    expect(verdict).toBe("OBSERVED_NO_ANOMALIES");
    expect(verdictDetail).not.toContain("PASS");
  });

  it("is UNVERIFIED when lifecycles exist and at least one accepted-anomaly category is UNKNOWN, with no positives", () => {
    const mixed: AcceptedAnomalies = { ...allZero, forgedGates: "UNKNOWN" };
    const { verdict, verdictDetail } = computeVerdict(oneLifecycle, zeroPrevented, mixed);
    expect(verdict).toBe("UNVERIFIED");
    expect(verdictDetail).toContain("forgedGates");
  });

  it("is ANOMALIES_PRESENT only when an accepted anomaly is an actual positive count, never from prevented attempts alone", () => {
    const busyGuards: PreventedAttempts = { ...zeroPrevented, unauthorizedMerges: 40 };
    const stillUnverified = computeVerdict(oneLifecycle, busyGuards, allUnknown);
    expect(stillUnverified.verdict).toBe("UNVERIFIED");

    const oneAcceptedAnomaly: AcceptedAnomalies = { ...allZero, unauthorizedMerges: 1 };
    const { verdict, verdictDetail } = computeVerdict(oneLifecycle, busyGuards, oneAcceptedAnomaly);
    expect(verdict).toBe("ANOMALIES_PRESENT");
    expect(verdictDetail).toContain("unauthorizedMerges");
  });

  it("names the exact lifecycle count in the UNVERIFIED detail so a small and a large sample read differently", () => {
    const smallDetail = computeVerdict(oneLifecycle, zeroPrevented, allUnknown).verdictDetail;
    const largeDetail = computeVerdict(twelveLifecycles, zeroPrevented, allUnknown).verdictDetail;
    expect(smallDetail).not.toBe(largeDetail);
    expect(smallDetail).toContain("1");
    expect(largeDetail).toContain("12");
  });
});
