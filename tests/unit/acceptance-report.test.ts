import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buildAcceptanceReport } from "../../src/export/acceptance-report.ts";
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

describe("agentctl acceptance report", () => {
  it("reports NA for the verdict and every anomaly when the database has no lifecycles", () => {
    const harness = makeHarness();
    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);

    expect(report.lifecycles.total).toBe(0);
    expect(report.verdict).toBe("N/A");
    expect(report.anomalies.falseCompletions).toBe("N/A");
    expect(report.anomalies.duplicateDispatches).toBe("N/A");
    expect(report.anomalies.acceptedStaleGenerationResults).toBe("N/A");
    expect(report.anomalies.forgedGates).toBe("N/A");
    expect(report.anomalies.unauthorizedMerges).toBe("N/A");

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
    expect(report.anomalies.forgedGates).toBe("N/A");
  });

  it("reports real distinguishable zero counts for a database with completed lifecycles and no anomalies", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_clean_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_2", "FAILED", "2026-08-11T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_3", "CANCELLED", "2026-08-12T00:00:00.000Z");

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.lifecycles).toEqual({ completed: 1, failed: 1, abandoned: 1, total: 3 });
    expect(report.anomalies.falseCompletions).toBe(0);
    expect(report.anomalies.duplicateDispatches).toBe(0);
    expect(report.anomalies.acceptedStaleGenerationResults).toBe(0);
    expect(report.anomalies.forgedGates).toBe(0);
    expect(report.anomalies.unauthorizedMerges).toBe(0);
    expect(report.verdict).toBe("OBSERVED_NO_ANOMALIES");
    expect(report.verdictDetail).toContain("3");
    expect(report.verdictDetail.toLowerCase()).toContain("not a");
  });

  it("names a seeded forged-gate anomaly as a non-zero, non-NA count", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_forged_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(harness.cp.db, "2026-08-10T00:05:00.000Z", "GATE_REJECTED", ReasonCode.GATE_CREATOR_UNTRUSTED);

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.anomalies.forgedGates).toBe(1);
    expect(report.anomalies.unauthorizedMerges).toBe(0);
    expect(report.verdict).toBe("ANOMALIES_PRESENT");
    expect(report.verdictDetail).toContain("forgedGates");
  });

  it("names a seeded unauthorized-merge anomaly as a non-zero, non-NA count", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_merge_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(harness.cp.db, "2026-08-10T00:05:00.000Z", "MERGE_REJECTED", ReasonCode.MERGE_AUTHORITY_DENIED);

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.anomalies.unauthorizedMerges).toBe(1);
    expect(report.verdict).toBe("ANOMALIES_PRESENT");
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

    expect(smallReport.verdict).toBe("OBSERVED_NO_ANOMALIES");
    expect(largeReport.verdict).toBe("OBSERVED_NO_ANOMALIES");
    expect(smallReport.lifecycles.total).toBe(1);
    expect(largeReport.lifecycles.total).toBe(12);
    // Same verdict token, but the detail and the count it carries must differ — a reader
    // comparing the two must not be able to mistake one sample size for the other.
    expect(smallReport.verdictDetail).not.toBe(largeReport.verdictDetail);
    expect(smallReport.verdictDetail).toContain("1");
    expect(largeReport.verdictDetail).toContain("12");
  });
});
