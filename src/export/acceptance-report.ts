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
 *
 * **A second correction, layered on the first (CEO review of #736 at `efe7552`).** The first cut
 * counted `audit_events` rows for reason codes like `MERGE_AUTHORITY_DENIED` and called a non-zero
 * count `ANOMALIES_PRESENT`. That inverted the meaning of the row it counted: a `MERGE_AUTHORITY_
 * DENIED` event is the record of the guard *working* — an unauthorised merge was attempted and
 * stopped, not one that happened. Reporting a prevented attempt as an anomaly says the system
 * failed at the exact moment it succeeded, which is the same error `N/A`-vs-zero exists to
 * prevent, one level deeper: "prevented" was misread as "occurred".
 *
 * So this file now keeps the two apart:
 *
 * - `preventedAttempts` — real counts of `audit_events` rows for the five reason codes. A
 *   non-zero value here is the guard doing its job. It is never `N/A` or `UNKNOWN`: the query
 *   that produces it is unambiguous regardless of whether any lifecycle ever completed.
 * - `acceptedAnomalies` — whether the bad thing actually *happened despite* the guard: a false
 *   completion that landed, a message actually sent twice, a stale-generation result actually
 *   used, a forged gate that actually got a merge through, a merge that actually landed without
 *   authority. `ACCEPTED_ANOMALY_SOURCES` below names, for each of the five, whichever production
 *   mechanism could prove this after the fact — and today there is none for any of them (see the
 *   per-field comments; this was searched, not assumed). Where no such mechanism exists, the count
 *   is `UNKNOWN` rather than `0`: this database cannot prove the anomaly did not happen, and `0`
 *   would claim it did.
 *
 * `verdict` follows `acceptedAnomalies`, never `preventedAttempts`: `ANOMALIES_PRESENT` may only
 * fire on a proven accepted anomaly. The realistic case — lifecycles exist, the guards have
 * fired, and every accepted-anomaly source is `UNKNOWN` — is its own verdict, `UNVERIFIED`, so a
 * reader cannot mistake "nothing here can prove or disprove it" for a clean bill of health.
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
  /**
   * Runs that reached `CANCELLED` — the terminal state `agentctl run cancel` produces, i.e. an
   * explicit, requested cancellation. This is *not* the same claim as an abandoned lifecycle (one
   * left to time out or orphaned with no terminal disposition at all); the schema has no separate
   * state or event for that, and `runs.state` has no `ABANDONED` value to count. If a real
   * abandoned-lifecycle count is ever needed, it needs its own source event — not a relabelling
   * of `CANCELLED`.
   */
  cancelled: number;
  total: number;
}

/** Categories PRD item 7 (#241) names. Every count in this file is keyed by these five. */
export interface AnomalyCategories<T> {
  falseCompletions: T;
  duplicateDispatches: T;
  acceptedStaleGenerationResults: T;
  forgedGates: T;
  unauthorizedMerges: T;
}

/**
 * A count backed by an actual, proven accepted anomaly; `"N/A"` when there were no lifecycles to
 * have gone wrong; `"UNKNOWN"` when at least one lifecycle happened but no source in this
 * database can prove or disprove this category either way. `"N/A"` and `"UNKNOWN"` are answers to
 * different questions — "was there anything to observe" versus "can this be observed at all" —
 * and a reader must be able to tell them apart.
 */
export type AcceptedAnomalyCount = number | "N/A" | "UNKNOWN";

export type PreventedAttempts = AnomalyCategories<number>;
export type AcceptedAnomalies = AnomalyCategories<AcceptedAnomalyCount>;

export type AcceptanceVerdict = "N/A" | "OBSERVED_NO_ANOMALIES" | "ANOMALIES_PRESENT" | "UNVERIFIED";

export interface AcceptanceReport {
  schema: typeof AcceptanceReportSchemaId;
  generatedAt: string;
  window: AcceptanceWindow;
  lifecycles: AcceptanceLifecycles;
  /** The guards working. Non-zero here is good news, not an anomaly — see the module comment. */
  preventedAttempts: PreventedAttempts;
  /** Whether the anomaly actually happened despite the guard. See `ACCEPTED_ANOMALY_SOURCES`. */
  acceptedAnomalies: AcceptedAnomalies;
  verdict: AcceptanceVerdict;
  /** Always names the lifecycle count and what backs the verdict — a verdict never stands alone. */
  verdictDetail: string;
}

/**
 * Each of the five categories mapped to the `reason_code`(s) an existing, negative-test-covered
 * enforcement mechanism records when it **refuses** exactly that attempt. This is prevention, not
 * occurrence — see the module comment. Counting `audit_events` rows against these codes is what
 * makes `preventedAttempts` real regardless of lifecycle count: the query is unambiguous.
 */
export const PREVENTED_ATTEMPT_REASON_CODES: Readonly<Record<keyof PreventedAttempts, readonly string[]>> = {
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

/**
 * A production mechanism that can count an *actually accepted* anomaly of one category, read
 * straight from the database — as opposed to a real-time guard that only ever refuses one.
 * `null` means the search below found none. Do not fill this in with something that only looks
 * like a source; each candidate considered is recorded in the comment beside the field it would
 * have backed, including why it was rejected.
 *
 * Searched and rejected, category by category (2026-08-31, against this branch):
 *
 * - **falseCompletions**: `assessBaselineMinimum` in `run-evidence.ts` computes a `falseCompletions`
 *   count from whether a `COMPLETED` run's baseline facts are all `present`, including
 *   `rollbackOrCompensation` and `defectEscape`. Those two facts come from `QUALITY_OBSERVATION`
 *   baseline records, written only by `RunEngine.recordQualityObservation` — which has **no
 *   production caller** (grepped `src/`; every call site is a test fixture). A real completed run
 *   would therefore almost always show these facts absent and `complete: false`, so reusing this
 *   as an "accepted false completion" count would flag nearly every real completion as anomalous —
 *   a false positive on the mechanism's own incompleteness, not a proof of an actual false
 *   completion. Rejected.
 * - **duplicateDispatches**: `outbox.attempts` counts retries of the *same* `message_id` (a
 *   legitimate resend of an undelivered envelope), not two sends of the same logical dispatch.
 *   No column or table records "this envelope was actually delivered twice." Rejected — no source.
 * - **acceptedStaleGenerationResults**: candidate-pipeline generation checks are enforced at
 *   write time (deny/trigger); nothing records a case where a stale-generation attempt was used
 *   anyway. Rejected — no source.
 * - **forgedGates**: `github_receipts` records `gate_publish` operations, but gate provenance is
 *   checked at publish time and denied inline (`GATE_CREATOR_UNTRUSTED` /
 *   `GATE_PAYLOAD_PROVENANCE_INVALID`); there is no separate post-hoc reconciliation that flags a
 *   merge which went through on a forged gate. Rejected — no source.
 * - **unauthorizedMerges**: `assessBaselineMinimum` reads `quality["unauthorizedMerges"]` off the
 *   exported baseline, but nothing in production ever writes that field — grepping every write
 *   site turns up only test fixtures (`tests/unit/baseline-export.test.ts:643,646`, which assign
 *   it directly onto a fixture object). Rejected — no source.
 *
 * If a real source is added for any of these, wire it in here and the corresponding count in
 * `acceptedAnomalies` stops being `UNKNOWN` automatically.
 */
export const ACCEPTED_ANOMALY_SOURCES: Readonly<
  Record<keyof AcceptedAnomalies, ((db: Db) => number) | null>
> = {
  falseCompletions: null,
  duplicateDispatches: null,
  acceptedStaleGenerationResults: null,
  forgedGates: null,
  unauthorizedMerges: null,
};

interface ActivityWindowRow {
  first: string | null;
  last: string | null;
}

interface LifecycleRow {
  completed: number | null;
  failed: number | null;
  cancelled: number | null;
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
       SUM(CASE WHEN state = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
     FROM runs`,
  );
  const completed = row?.completed ?? 0;
  const failed = row?.failed ?? 0;
  const cancelled = row?.cancelled ?? 0;
  return { completed, failed, cancelled, total: completed + failed + cancelled };
};

const countByReasonCodes = (db: Db, codes: readonly string[]): number => {
  const placeholders = codes.map(() => "?").join(",");
  const row = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM audit_events WHERE reason_code IN (${placeholders})`,
    [...codes],
  );
  return row?.count ?? 0;
};

const readPreventedAttempts = (db: Db): PreventedAttempts => ({
  falseCompletions: countByReasonCodes(db, PREVENTED_ATTEMPT_REASON_CODES.falseCompletions),
  duplicateDispatches: countByReasonCodes(db, PREVENTED_ATTEMPT_REASON_CODES.duplicateDispatches),
  acceptedStaleGenerationResults: countByReasonCodes(
    db,
    PREVENTED_ATTEMPT_REASON_CODES.acceptedStaleGenerationResults,
  ),
  forgedGates: countByReasonCodes(db, PREVENTED_ATTEMPT_REASON_CODES.forgedGates),
  unauthorizedMerges: countByReasonCodes(db, PREVENTED_ATTEMPT_REASON_CODES.unauthorizedMerges),
});

const ACCEPTED_ANOMALY_KEYS = Object.keys(ACCEPTED_ANOMALY_SOURCES) as (keyof AcceptedAnomalies)[];

const readAcceptedAnomalies = (db: Db, observed: boolean): AcceptedAnomalies => {
  const result = {} as AcceptedAnomalies;
  for (const key of ACCEPTED_ANOMALY_KEYS) {
    if (!observed) {
      result[key] = "N/A";
      continue;
    }
    const source = ACCEPTED_ANOMALY_SOURCES[key];
    result[key] = source === null ? "UNKNOWN" : source(db);
  }
  return result;
};

/**
 * The verdict logic, kept pure and separate from any database read so it can be tested directly
 * against contrived inputs — including states (`OBSERVED_NO_ANOMALIES`, a mix of zero and
 * `UNKNOWN`) that no source wired into this codebase today can actually produce end to end. See
 * `ACCEPTED_ANOMALY_SOURCES` for why every category currently reads `UNKNOWN` once lifecycles
 * exist, and the module comment for why `ANOMALIES_PRESENT` must never fire from
 * `preventedAttempts` alone.
 */
export const computeVerdict = (
  lifecycles: AcceptanceLifecycles,
  preventedAttempts: PreventedAttempts,
  acceptedAnomalies: AcceptedAnomalies,
): { verdict: AcceptanceVerdict; verdictDetail: string } => {
  // The load-bearing rule: with no lifecycle ever having reached a terminal state, none of the
  // five accepted-anomaly counts are *observed* — there is nothing they could have been measured
  // against. Printing 0 here would say "we looked and found nothing wrong"; the truth is "there
  // was nothing to look at."
  if (lifecycles.total === 0) {
    return {
      verdict: "N/A",
      verdictDetail:
        "no lifecycle reached a terminal state in this database, so the five accepted-anomaly " +
        "counts are unobserved rather than zero. Rows in audit_events or telemetry_metrics (the " +
        "daemon measuring itself) do not count as a lifecycle.",
    };
  }

  const entries = Object.entries(acceptedAnomalies) as [keyof AcceptedAnomalies, AcceptedAnomalyCount][];
  const positive = entries.filter(([, value]) => typeof value === "number" && value > 0);
  const unknown = entries.filter(([, value]) => value === "UNKNOWN").map(([name]) => name);

  // `ANOMALIES_PRESENT` is decided from `acceptedAnomalies` only. `preventedAttempts` never
  // enters this branch: a guard firing is the guard working, not proof that anything landed.
  if (positive.length > 0) {
    return {
      verdict: "ANOMALIES_PRESENT",
      verdictDetail:
        `observed ${lifecycles.total} lifecycle(s); accepted anomalies present: ` +
        positive.map(([name, value]) => `${name}=${value}`).join(", "),
    };
  }

  if (unknown.length > 0) {
    const preventedTotal = Object.values(preventedAttempts).reduce((sum, value) => sum + value, 0);
    return {
      verdict: "UNVERIFIED",
      verdictDetail:
        `observed ${lifecycles.total} lifecycle(s) and ${preventedTotal} prevented attempt(s) ` +
        "(the guards working, not a defect); no source in this database can prove or disprove " +
        `an accepted anomaly for: ${unknown.join(", ")}. This is not a clean bill of health — ` +
        "it is an absence of evidence either way.",
    };
  }

  return {
    verdict: "OBSERVED_NO_ANOMALIES",
    verdictDetail:
      `observed ${lifecycles.total} lifecycle(s) — ${lifecycles.completed} completed, ` +
      `${lifecycles.failed} failed, ${lifecycles.cancelled} cancelled — with a verified zero ` +
      `accepted anomalies in all five categories. This describes what was observed over ` +
      `${lifecycles.total} lifecycle(s); it is not a statement about long-term reliability.`,
  };
};

/**
 * Builds the acceptance readout. Reads only — this never writes a row, so calling it repeatedly
 * against a live database is always safe.
 */
export const buildAcceptanceReport = (db: Db, clock: Clock): AcceptanceReport => {
  const window = readActivityWindow(db);
  const lifecycles = readLifecycles(db);
  const observed = lifecycles.total > 0;
  const preventedAttempts = readPreventedAttempts(db);
  const acceptedAnomalies = readAcceptedAnomalies(db, observed);
  const { verdict, verdictDetail } = computeVerdict(lifecycles, preventedAttempts, acceptedAnomalies);

  return {
    schema: AcceptanceReportSchemaId,
    generatedAt: clock.nowIso(),
    window,
    lifecycles,
    preventedAttempts,
    acceptedAnomalies,
    verdict,
    verdictDetail,
  };
};
