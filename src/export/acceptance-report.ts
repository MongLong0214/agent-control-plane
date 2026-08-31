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
 *
 * **A third correction (CEO review of #736 at `b8c48eb`).** `preventedAttempts` keyed on
 * `reason_code` alone, and the reason codes are broader than the five categories:
 * `COMPLETION_AUTHORITY_DENIED` is also the reason code for an evidence-write authority
 * refusal, a schema-migration authority refusal, and five distinct canonical-turn authority
 * refusals (`src/db/database.ts` `TRIGGER_CODES`, ~line 907) — none of which is a false
 * completion. `MERGE_AUTHORITY_DENIED` is also written when the daemon's *own* finalizer lacks
 * completion authority mid-finalization (`src/daemon/finalizer.ts` `handleFailure`) — a
 * misconfiguration, not a blocked unauthorised-merge attempt. Counting either as the named
 * category would repeat the exact inversion the second correction fixed, one field deeper: a
 * broad reason code was read as if it named the narrow event.
 *
 * So `preventedAttempts` is now keyed on the **real writer** — `PREVENTED_ATTEMPT_WRITERS`
 * below names, for each category, the exact `(kind, reason_code)` an actual `audit.record(...)`
 * call site uses, found by reading every `.record(` call in `src/` rather than assumed from the
 * reason code alone. Two of the five pairs still collapse two different events even after
 * fixing `kind`; those two carry an `isGenuine` check against a field inside `evidence_json`
 * (the discriminator PRD item 7's third component asks for) rather than a reason code or kind
 * alone. Where no writer exists at all, the category reports `"UNKNOWN"` — the same non-zero
 * honesty `acceptedAnomalies` already has, for the same reason: a zero no writer could ever
 * have produced is not a measurement.
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

/**
 * A count backed by a named, real writer; `"UNKNOWN"` when no production `.record(` call was
 * found for this category, or when the only pair found still collapses more than one meaning
 * and cannot be narrowed. Never `"N/A"`: unlike `acceptedAnomalies`, this is not gated on any
 * lifecycle having happened — a guard can fire, or fail to have a writer, independent of that.
 */
export type PreventedAttemptCount = number | "UNKNOWN";

export type PreventedAttempts = AnomalyCategories<PreventedAttemptCount>;
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
 * One real, named production writer: the exact `(kind, reason_code)` an actual
 * `audit.record(...)` call site uses, found by reading `src/` rather than assumed from the
 * reason code. `isGenuine`, when present, narrows further inside that row's `evidence_json` —
 * present only where the `(kind, reason_code)` pair still collapses two different events.
 */
interface PreventedAttemptWriter {
  kind: string;
  reasonCode: string;
  isGenuine?: (evidence: Record<string, unknown>) => boolean;
}

/**
 * For each of the five categories, the real writer(s) — or `null` where none was found. Every
 * entry names the source file and line reasoning was checked against (2026-08-31, this branch),
 * because a hand-list like this rots the moment a call site moves; `verify-guards-are-
 * falsifiable.mjs` carries a row per pair to catch that, and
 * `tests/unit/acceptance-report.test.ts` asserts each pair's literal text is still present in
 * the named file.
 *
 * - **falseCompletions**: `src/daemon/finalizer.ts` `handleFailure` writes
 *   `(kind: "FINALIZATION_ATTEMPT_FAILED", reasonCode: failure.reasonCode)` for *any* denied
 *   step in a finalization attempt. The one step that can fail with
 *   `COMPLETION_AUTHORITY_DENIED` for a genuine reason is the `RunState.COMPLETED` transition in
 *   `src/run/run-engine.ts` `transition()` (its `deny()` calls at the authority and run-kind
 *   checks) — the real "something tried to complete this run without the authority to" guard.
 *   But the *same reason code* is also what seven unrelated SQLite trigger sentinels translate
 *   to (`src/db/database.ts` `TRIGGER_CODES`, e.g. `EVIDENCE_WRITE_AUTHORITY_DENIED`,
 *   `SCHEMA_MIGRATION_AUTHORITY_DENIED`, five `CANONICAL_TURN_*_AUTHORITY_DENIED` triggers), and
 *   if one of those fires inside the same finalization attempt and is caught into `failure`, the
 *   row looks identical by `(kind, reason_code)` alone. `translate()`
 *   (`src/db/database.ts:1012`) always stamps the tripped sentinel onto `evidence.sqlite`; the
 *   genuine `run-engine.ts` denial's evidence never has that key (its shapes are
 *   `{ runId, to, supplied }` and `{ runId, kind, expectedSource }`). So `evidence.sqlite`
 *   absent is the discriminator.
 * - **duplicateDispatches**: searched and found no writer. `Outbox.enqueue()` (`src/outbox/
 *   outbox.ts`) returns `OUTBOX_DUPLICATE_SUPPRESSED` as an *allowed* `Decision` value on an
 *   idempotent replay, and its `catch` block converts the trigger-sourced thrown version of the
 *   same code back into that same returned Decision — neither path ever calls `.record(`.
 *   `UNKNOWN`, not `0`.
 * - **acceptedStaleGenerationResults**: `src/run/candidate-pipeline.ts`
 *   `recordAttemptReclaimed` is the only writer of `kind: "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED"`
 *   in `src/`, and it always pairs that kind with the literal
 *   `ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE` — already unique, no discriminator needed.
 * - **forgedGates**: `src/github/github-kernel.ts` writes `kind: "GATE_REJECTED"` for three
 *   different reason codes from the same gate-check loop — `MERGE_GATE_MISSING` (a gate simply
 *   absent, not forged), `GATE_PAYLOAD_PROVENANCE_INVALID` and `GATE_CREATOR_UNTRUSTED` (both
 *   genuinely about a forged or unattributable gate). Filtering by `reason_code` inside that
 *   `kind` already excludes the non-forgery code; no further discriminator needed.
 * - **unauthorizedMerges**: `src/guard/managed-write-guard.ts` `ManagedWriteGuard.evaluate()`
 *   writes `(kind: "MANAGED_WRITE_GUARD", reasonCode: exposed.reasonCode)` for every guard
 *   decision, and the only place `decide()` returns `MERGE_AUTHORITY_DENIED` is the
 *   post-approval-write check ("post-approval GitHub writes require the daemon finalizer
 *   capability") — a genuine blocked unauthorised write during the merge/finalization phase.
 *   The *other* `MERGE_AUTHORITY_DENIED` site, `github-kernel.ts` `assertFreshDaemonFinalization`
 *   ("fresh GitHub finalization requires daemon authority"), is not this writer at all — it
 *   surfaces only through `finalizer.ts`'s `FINALIZATION_ATTEMPT_FAILED`, which this mapping
 *   does not read from for this category. `kind` alone already separates the two meanings; no
 *   evidence discriminator needed. (`managed-write-guard.ts:139,445` are composition-root
 *   construction guards reachable only at startup, never through a request path that reaches
 *   `.record(`, so they contribute no rows either way.)
 */
export const PREVENTED_ATTEMPT_WRITERS: Readonly<
  Record<keyof PreventedAttempts, readonly PreventedAttemptWriter[] | null>
> = {
  falseCompletions: [
    {
      kind: "FINALIZATION_ATTEMPT_FAILED",
      reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED,
      isGenuine: (evidence) => evidence["sqlite"] === undefined,
    },
  ],
  duplicateDispatches: null,
  acceptedStaleGenerationResults: [
    { kind: "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED", reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE },
  ],
  forgedGates: [
    { kind: "GATE_REJECTED", reasonCode: ReasonCode.GATE_CREATOR_UNTRUSTED },
    { kind: "GATE_REJECTED", reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID },
  ],
  unauthorizedMerges: [{ kind: "MANAGED_WRITE_GUARD", reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED }],
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

interface AuditEvidenceRow {
  evidence_json: string;
}

/** Counts rows for one writer, applying `isGenuine` in JS so evidence never needs a SQL parse. */
const countWriter = (db: Db, writer: PreventedAttemptWriter): number => {
  const rows = db.all<AuditEvidenceRow>(
    `SELECT evidence_json FROM audit_events WHERE kind = ? AND reason_code = ?`,
    [writer.kind, writer.reasonCode],
  );
  if (!writer.isGenuine) return rows.length;
  let count = 0;
  for (const row of rows) {
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    } catch {
      // A row whose evidence cannot be parsed cannot be shown genuine; excluding it is the
      // safe direction, the same way an unproven accepted anomaly reads UNKNOWN rather than 0.
      continue;
    }
    if (writer.isGenuine(evidence)) count += 1;
  }
  return count;
};

const PREVENTED_ATTEMPT_KEYS = Object.keys(PREVENTED_ATTEMPT_WRITERS) as (keyof PreventedAttempts)[];

const readPreventedAttempts = (db: Db): PreventedAttempts => {
  const result = {} as PreventedAttempts;
  for (const key of PREVENTED_ATTEMPT_KEYS) {
    const writers = PREVENTED_ATTEMPT_WRITERS[key];
    result[key] = writers === null ? "UNKNOWN" : writers.reduce((sum, writer) => sum + countWriter(db, writer), 0);
  }
  return result;
};

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
    // Categories with no writer (currently `duplicateDispatches`) contribute nothing to this
    // sum — "UNKNOWN" is not a quantity, and treating it as zero here would be the same error
    // this file exists to refuse, just inside a sentence instead of a field.
    const preventedTotal = Object.values(preventedAttempts).reduce(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );
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
