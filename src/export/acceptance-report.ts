import type { Clock } from "../core/clock.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";

/**
 * #241 — replaces the hand-maintained `docs/ACCEPTANCE.md` ceremony (30 lifecycles across 3
 * projects, transcribed by a human) with a command whose output *is* the evidence. Every field
 * here is read straight from the state database at call time; nothing is a target or a quota.
 *
 * The CEO's ruling is the one rule this file exists to obey: **zero activity is `N/A`, never a
 * passing zero.** A fresh or idle deployment fills `audit_events` and `telemetry_metrics` with
 * the daemon measuring itself — capacity probes, continuity reconciliation — while `runs` stays
 * empty. Gating the verdict on the *window* (first/last activity) would read that self-monitoring
 * as an observed, anomaly-free deployment. Gating it on `lifecycles.total` (terminal run outcomes)
 * instead means a database that is all telemetry and no lifecycle reports `N/A`, honestly.
 */

export const AcceptanceReportSchemaId = "agent-control-plane.acceptance-report.v1";

export interface AcceptanceWindow {
  /** `at` of the earliest audit or telemetry row. `null` when the database has neither. */
  firstActivityAt: string | null;
  /** `at` of the latest audit or telemetry row. */
  lastActivityAt: string | null;
  /** Milliseconds between them; `null` when there is no window to measure. */
  durationMs: number | null;
}

export interface AcceptanceLifecycles {
  completed: number;
  failed: number;
  /** Runs that reached `CANCELLED` — the terminal state `agentctl run cancel` produces. */
  abandoned: number;
  total: number;
}

/** A count backed by at least one observed lifecycle, or the literal marker `"N/A"` when none exist. */
export type AnomalyCount = number | "N/A";

export interface AcceptanceAnomalies {
  falseCompletions: AnomalyCount;
  duplicateDispatches: AnomalyCount;
  acceptedStaleGenerationResults: AnomalyCount;
  forgedGates: AnomalyCount;
  unauthorizedMerges: AnomalyCount;
}

export type AcceptanceVerdict = "N/A" | "OBSERVED_NO_ANOMALIES" | "ANOMALIES_PRESENT";

export interface AcceptanceReport {
  schema: typeof AcceptanceReportSchemaId;
  generatedAt: string;
  window: AcceptanceWindow;
  lifecycles: AcceptanceLifecycles;
  anomalies: AcceptanceAnomalies;
  verdict: AcceptanceVerdict;
  /** Always names the lifecycle count that backs the verdict — a verdict never stands alone. */
  verdictDetail: string;
}

/**
 * Each of the five anomaly categories PRD item 7 names is mapped to the `reason_code`(s) an
 * existing, negative-test-covered enforcement mechanism records when it refuses exactly that
 * anomaly. Counting `audit_events` rows against these codes is what makes a real zero here
 * *observed* rather than *hoped for*: if the guard had ever let one through, or ever had to
 * refuse an attempt, this is where it would show up.
 */
export const ANOMALY_REASON_CODES: Readonly<Record<keyof AcceptanceAnomalies, readonly string[]>> = {
  // ProductionGate refuses a completion that does not carry the authority to grant it —
  // tests/unit/core-r2.test.ts and others assert the denial by name.
  falseCompletions: [ReasonCode.COMPLETION_AUTHORITY_DENIED],
  // Outbox suppresses a second dispatch of the same message rather than sending it twice —
  // tests/unit/trusted-core.test.ts, tests/unit/outbox-buzz-claims-r2.test.ts.
  duplicateDispatches: [ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED],
  // The candidate pipeline refuses a result computed under a generation that is no longer
  // current rather than accepting it as if it were fresh — tests/unit/review-r2.test.ts.
  acceptedStaleGenerationResults: [ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE],
  // GitHub kernel refuses a gate created by an untrusted party or with unverifiable payload
  // provenance — tests/scenarios/github-hardening.test.ts, tests/scenarios/github-kernel.test.ts.
  forgedGates: [ReasonCode.GATE_CREATOR_UNTRUSTED, ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID],
  // Only the daemon's own approved finalizer may sequence a merge — tests/unit/guard-hardening.test.ts,
  // tests/scenarios/finalizer.test.ts.
  unauthorizedMerges: [ReasonCode.MERGE_AUTHORITY_DENIED],
};

interface ActivityWindowRow {
  first: string | null;
  last: string | null;
}

interface LifecycleRow {
  completed: number | null;
  failed: number | null;
  abandoned: number | null;
}

const readActivityWindow = (db: Db): AcceptanceWindow => {
  const row = db.get<ActivityWindowRow>(
    `SELECT MIN(at) AS first, MAX(at) AS last FROM (
       SELECT at FROM audit_events
       UNION ALL
       SELECT at FROM telemetry_metrics
     )`,
  );
  const firstActivityAt = row?.first ?? null;
  const lastActivityAt = row?.last ?? null;
  const durationMs =
    firstActivityAt !== null && lastActivityAt !== null
      ? new Date(lastActivityAt).getTime() - new Date(firstActivityAt).getTime()
      : null;
  return { firstActivityAt, lastActivityAt, durationMs };
};

const readLifecycles = (db: Db): AcceptanceLifecycles => {
  const row = db.get<LifecycleRow>(
    `SELECT
       SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN state = 'CANCELLED' THEN 1 ELSE 0 END) AS abandoned
     FROM runs`,
  );
  const completed = row?.completed ?? 0;
  const failed = row?.failed ?? 0;
  const abandoned = row?.abandoned ?? 0;
  return { completed, failed, abandoned, total: completed + failed + abandoned };
};

const countByReasonCodes = (db: Db, codes: readonly string[]): number => {
  const placeholders = codes.map(() => "?").join(",");
  const row = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM audit_events WHERE reason_code IN (${placeholders})`,
    [...codes],
  );
  return row?.count ?? 0;
};

/**
 * Builds the acceptance readout. Reads only — this never writes a row, so calling it repeatedly
 * against a live database is always safe.
 */
export const buildAcceptanceReport = (db: Db, clock: Clock): AcceptanceReport => {
  const window = readActivityWindow(db);
  const lifecycles = readLifecycles(db);

  // The load-bearing rule: with no lifecycle ever having reached a terminal state, none of the
  // five anomaly counts are *observed* — there is nothing they could have been measured against.
  // Printing 0 here would say "we looked and found nothing wrong"; the truth is "there was
  // nothing to look at."
  const observed = lifecycles.total > 0;

  const anomalies: AcceptanceAnomalies = observed
    ? {
        falseCompletions: countByReasonCodes(db, ANOMALY_REASON_CODES.falseCompletions),
        duplicateDispatches: countByReasonCodes(db, ANOMALY_REASON_CODES.duplicateDispatches),
        acceptedStaleGenerationResults: countByReasonCodes(
          db,
          ANOMALY_REASON_CODES.acceptedStaleGenerationResults,
        ),
        forgedGates: countByReasonCodes(db, ANOMALY_REASON_CODES.forgedGates),
        unauthorizedMerges: countByReasonCodes(db, ANOMALY_REASON_CODES.unauthorizedMerges),
      }
    : {
        falseCompletions: "N/A",
        duplicateDispatches: "N/A",
        acceptedStaleGenerationResults: "N/A",
        forgedGates: "N/A",
        unauthorizedMerges: "N/A",
      };

  let verdict: AcceptanceVerdict;
  let verdictDetail: string;
  if (!observed) {
    verdict = "N/A";
    verdictDetail =
      "no lifecycle reached a terminal state in this database, so the five anomaly counts are " +
      "unobserved rather than zero. Rows in audit_events or telemetry_metrics (the daemon " +
      "measuring itself) do not count as a lifecycle.";
  } else {
    const nonZero = (Object.entries(anomalies) as [keyof AcceptanceAnomalies, AnomalyCount][]).filter(
      ([, value]) => typeof value === "number" && value > 0,
    );
    if (nonZero.length === 0) {
      verdict = "OBSERVED_NO_ANOMALIES";
      verdictDetail =
        `observed ${lifecycles.total} lifecycle(s) — ${lifecycles.completed} completed, ` +
        `${lifecycles.failed} failed, ${lifecycles.abandoned} abandoned — with zero anomalies in ` +
        `all five categories. This describes what was observed over ${lifecycles.total} ` +
        "lifecycle(s); it is not a statement about long-term reliability.";
    } else {
      verdict = "ANOMALIES_PRESENT";
      verdictDetail =
        `observed ${lifecycles.total} lifecycle(s); anomalies present: ` +
        nonZero.map(([name, value]) => `${name}=${value}`).join(", ");
    }
  }

  return {
    schema: AcceptanceReportSchemaId,
    generatedAt: clock.nowIso(),
    window,
    lifecycles,
    anomalies,
    verdict,
    verdictDetail,
  };
};
