import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  type AcceptanceLifecycles,
  type AcceptedAnomalies,
  buildAcceptanceReport,
  computeVerdict,
  PREVENTED_ATTEMPT_WRITERS,
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

const insertAudit = (
  db: Db,
  at: string,
  kind: string,
  reasonCode: string | null,
  evidence: Record<string, unknown> = {},
): void => {
  db.run(
    `INSERT INTO audit_events (at, kind, reason_code, evidence_json) VALUES (?, ?, ?, ?)`,
    [at, kind, reasonCode, JSON.stringify(evidence)],
  );
};

const noLifecycles: AcceptanceLifecycles = { completed: 0, failed: 0, cancelled: 0, total: 0 };
const oneLifecycle: AcceptanceLifecycles = { completed: 1, failed: 0, cancelled: 0, total: 1 };
const twelveLifecycles: AcceptanceLifecycles = { completed: 12, failed: 0, cancelled: 0, total: 12 };

// `duplicateDispatches` has no real writer (see PREVENTED_ATTEMPT_WRITERS) and is permanently
// "UNKNOWN" — never a bare 0 a reader could mistake for "measured and clean".
const cleanPrevented: PreventedAttempts = {
  falseCompletions: 0,
  duplicateDispatches: "UNKNOWN",
  acceptedStaleGenerationResults: 0,
  forgedGates: 0,
  unauthorizedMerges: 0,
};

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

  it("reports real zeros where a writer exists and UNKNOWN where none does, for completed lifecycles with no guard denials", () => {
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_clean_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_2", "FAILED", "2026-08-11T00:00:00.000Z");
    insertRun(harness.cp.db, "run_clean_3", "CANCELLED", "2026-08-12T00:00:00.000Z");

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.lifecycles).toEqual({ completed: 1, failed: 1, cancelled: 1, total: 3 });
    // Four categories have a named writer and no denial fired, so they read real zeros;
    // duplicateDispatches has no writer at all and reads UNKNOWN — distinguishable from a 0.
    expect(report.preventedAttempts).toEqual(cleanPrevented);
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

  it("a prevented attempt from the write guard refusing an unauthorised merge counts as unauthorizedMerges", () => {
    // The real writer is ManagedWriteGuard.evaluate(), which audits every guard decision under
    // kind "MANAGED_WRITE_GUARD" — this is the guard actually blocking a post-approval write
    // made without daemon finalizer authority.
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_merge_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(harness.cp.db, "2026-08-10T00:05:00.000Z", "MANAGED_WRITE_GUARD", ReasonCode.MERGE_AUTHORITY_DENIED);

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.unauthorizedMerges).toBe(1);
    expect(report.acceptedAnomalies.unauthorizedMerges).toBe("UNKNOWN");
    expect(report.verdict).not.toBe("ANOMALIES_PRESENT");
  });

  it("a MERGE_AUTHORITY_DENIED row written under FINALIZATION_ATTEMPT_FAILED not an unauthorized-merge event does not increment unauthorizedMerges", () => {
    // This is the critical regression this correction exists to pin. finalizer.ts's own
    // handleFailure writes (kind: FINALIZATION_ATTEMPT_FAILED, reasonCode: MERGE_AUTHORITY_DENIED)
    // whenever the daemon's *own* finalizer lacked authority mid-finalization
    // (assertFreshDaemonFinalization in github-kernel.ts) — a misconfiguration, not a blocked
    // external unauthorised-merge attempt. Counting it here would repeat the exact inversion the
    // prevented-vs-accepted split already fixed, one field deeper.
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_finalizer_failure_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(
      harness.cp.db,
      "2026-08-10T00:05:00.000Z",
      "FINALIZATION_ATTEMPT_FAILED",
      ReasonCode.MERGE_AUTHORITY_DENIED,
    );

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.unauthorizedMerges).toBe(0);
  });

  it("a COMPLETION_AUTHORITY_DENIED row from a genuine completion-authority denial increments falseCompletions", () => {
    // The genuine writer: finalizer.ts's handleFailure records (kind: FINALIZATION_ATTEMPT_FAILED,
    // reasonCode: failure.reasonCode) when the RunState.COMPLETED transition itself was denied for
    // lacking completion authority (run-engine.ts transition()). Its evidence never carries a
    // "sqlite" key — that key belongs only to the trigger-translated version of this same code.
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_false_completion_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(
      harness.cp.db,
      "2026-08-10T00:05:00.000Z",
      "FINALIZATION_ATTEMPT_FAILED",
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      { runId: "run_false_completion_1", to: "COMPLETED", supplied: "undefined" },
    );

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.falseCompletions).toBe(1);
  });

  it("a COMPLETION_AUTHORITY_DENIED row stamped with a non-completion SQLite sentinel does not increment falseCompletions", () => {
    // The ambiguity this correction exists to remove: seven unrelated trigger sentinels
    // (EVIDENCE_WRITE_AUTHORITY_DENIED among them — src/db/database.ts TRIGGER_CODES) all
    // translate to the same COMPLETION_AUTHORITY_DENIED reason code. If one of those fires inside
    // a finalization attempt and is caught into `failure`, the row is indistinguishable from a
    // genuine false-completion denial by (kind, reason_code) alone — translate() always stamps
    // the tripped sentinel onto evidence.sqlite, and that is the discriminator.
    const harness = makeHarness();
    insertRun(harness.cp.db, "run_evidence_write_denied_1", "COMPLETED", "2026-08-10T00:00:00.000Z");
    insertAudit(
      harness.cp.db,
      "2026-08-10T00:05:00.000Z",
      "FINALIZATION_ATTEMPT_FAILED",
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      { sqlite: "EVIDENCE_WRITE_AUTHORITY_DENIED" },
    );

    const report = buildAcceptanceReport(harness.cp.db, harness.cp.clock);
    expect(report.preventedAttempts.falseCompletions).toBe(0);
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

  it("treats a category with no writer as contributing nothing to the prevented-attempt total", () => {
    const withUnknown: PreventedAttempts = { ...zeroPrevented, duplicateDispatches: "UNKNOWN" };
    const { verdictDetail } = computeVerdict(oneLifecycle, withUnknown, allUnknown);
    // "UNKNOWN" must never be summed as if it were a number — the total must read as if that
    // category contributed 0, not NaN and not a silently-coerced string.
    expect(verdictDetail).toContain("0 prevented attempt(s)");
  });
});

describe("agentctl acceptance report — writer mapping is verifiable, not a hand-list that can rot", () => {
  // For each declared (kind, reasonCode) pair with a literal reason code, confirm the exact text
  // is still present together in the named source file. This cannot check the two indirect pairs
  // (falseCompletions, unauthorizedMerges) the same way — their `.record(` call sites pass the
  // reason code through a variable — so those two are checked by name below instead.
  const sourceRoot = new URL("../../src/", import.meta.url);
  const readSource = (relativePath: string): string => readFileSync(new URL(relativePath, sourceRoot), "utf8");

  it("acceptedStaleGenerationResults' writer literally pairs its kind and reason code in candidate-pipeline.ts", () => {
    const writers = PREVENTED_ATTEMPT_WRITERS.acceptedStaleGenerationResults;
    expect(writers).not.toBeNull();
    const source = readSource("run/candidate-pipeline.ts");
    for (const writer of writers ?? []) {
      expect(source).toContain(`kind: "${writer.kind}"`);
      expect(source).toContain(`reasonCode: ReasonCode.${writer.reasonCode}`);
    }
  });

  it("forgedGates' writers literally pair their kind and reason codes in github-kernel.ts", () => {
    const writers = PREVENTED_ATTEMPT_WRITERS.forgedGates;
    expect(writers).not.toBeNull();
    const source = readSource("github/github-kernel.ts");
    expect(source).toContain(`kind: "GATE_REJECTED"`);
    for (const writer of writers ?? []) {
      expect(source).toContain(`reasonCode: ReasonCode.${writer.reasonCode}`);
    }
  });

  it("unauthorizedMerges' writer kind is literally written in managed-write-guard.ts, and the non-writer kind is a distinct file", () => {
    const writers = PREVENTED_ATTEMPT_WRITERS.unauthorizedMerges;
    expect(writers).not.toBeNull();
    const guardSource = readSource("guard/managed-write-guard.ts");
    for (const writer of writers ?? []) {
      expect(guardSource).toContain(`kind: "${writer.kind}"`);
      expect(guardSource).toContain(`ReasonCode.${writer.reasonCode}`);
    }
    // The excluded pairing lives in a different writer entirely (finalizer.ts's
    // FINALIZATION_ATTEMPT_FAILED, via github-kernel.ts's assertFreshDaemonFinalization) — not
    // inside managed-write-guard.ts's own decide(), which is the only source of this reason code
    // that evaluate() can record.
    const finalizerSource = readSource("daemon/finalizer.ts");
    expect(finalizerSource).toContain(`kind: "FINALIZATION_ATTEMPT_FAILED"`);
    const githubKernelSource = readSource("github/github-kernel.ts");
    expect(githubKernelSource).toContain("ReasonCode.MERGE_AUTHORITY_DENIED");
  });

  it("falseCompletions' writer kind is literally written in finalizer.ts, and the genuine denial lives in run-engine.ts", () => {
    const writers = PREVENTED_ATTEMPT_WRITERS.falseCompletions;
    expect(writers).not.toBeNull();
    const finalizerSource = readSource("daemon/finalizer.ts");
    for (const writer of writers ?? []) {
      expect(finalizerSource).toContain(`kind: "${writer.kind}"`);
    }
    const runEngineSource = readSource("run/run-engine.ts");
    expect(runEngineSource).toContain("ReasonCode.COMPLETION_AUTHORITY_DENIED");
    // The seven non-completion sentinels this same reason code also carries — confirming the
    // ambiguity the isGenuine discriminator exists to resolve is real, not hypothetical.
    const databaseSource = readSource("db/database.ts");
    expect(databaseSource).toContain("EVIDENCE_WRITE_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED");
  });

  it("duplicateDispatches is declared with no writer", () => {
    expect(PREVENTED_ATTEMPT_WRITERS.duplicateDispatches).toBeNull();
  });
});
