import type { Clock } from "../core/clock.ts";
import type { Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { Doctor, DoctorReport, DoctorScope, Finding } from "./doctor.ts";

export interface WatchdogDeadlines {
  /** A task execution with no receipt or activity for this long is overdue. */
  taskActivityMs: number;
  /** A run that has been ACTIVE this long without any task or artifact is overdue. */
  runProgressMs: number;
  /** A session left STARTING this long never came up. */
  sessionStartMs: number;
  /** A pending outbox message older than this has not been delivered. */
  outboxPendingMs: number;
}

export const DEFAULT_DEADLINES: WatchdogDeadlines = {
  taskActivityMs: 30 * 60 * 1000,
  runProgressMs: 2 * 60 * 60 * 1000,
  sessionStartMs: 5 * 60 * 1000,
  outboxPendingMs: 10 * 60 * 1000,
};

/**
 * #1189 C2 — an overdue resource as the CEO routing needs it: the run it belongs to, when there is one,
 * and the instant its stall is measured from, which identifies the stall across ticks. An outbox stall
 * also names its kind and role, so a stalled CEO notice is never routed to the CEO again.
 */
export interface WatchdogStall {
  kind: string;
  id: string;
  runId: string | null;
  since: string;
  messageKind?: string;
  roleKey?: string;
}

/** #1189 C2 — the CEO routing's record of a stall it routed. It is not progress of the run it names. */
export const OWNERLESS_STALL_ROUTED = "OWNERLESS_STALL_ROUTED";

/**
 * #1189 F3-2 — a stall the CEO is owed a notice of, written in the transaction that observed it, for a
 * stall the watchdog sees only once: a reclaimed candidate pipeline attempt is RELEASED by the very tick
 * that finds it, so no later tick finds it again. The routing delivers it on a later pass if the CEO
 * could not be told at once (no CEO bound, or its session not READY), and never twice.
 */
export const OWNERLESS_STALL_OWED = "OWNERLESS_STALL_OWED";

/**
 * #1344 — why ACP ended a candidate pipeline attempt's hold on its run: its persisted deadline passed (a watchdog
 * tick), or the daemon whose process ran it is gone (a restart's reconcile). An attempt runs in the process that
 * took it, so none outlives its daemon.
 */
export const AttemptReleaseReason = { DEADLINE: "deadline", DAEMON_RESTART: "daemon restart" } as const;
export type AttemptReleaseReason = (typeof AttemptReleaseReason)[keyof typeof AttemptReleaseReason];

/** A candidate pipeline attempt ACP released, why, and the release notice its run's owner CTO was given. */
export interface ReleasedPipelineAttempt {
  runId: string;
  attemptId: string;
  startedAt: string;
  deadlineAt: string;
  reason: AttemptReleaseReason;
  /** The stall's instant: the persisted deadline for a deadline release, the release itself for a restart's. */
  since: string;
  /** The owner CTO's notice (`CandidatePipeline.noticeAttemptReleased`), or null when it was given none now. */
  ownerNoticeId: string | null;
  /** Why a notice the owner is owed could not be written now (`ATTEMPT_RELEASE_NOTICE_DEFERRED`); a later tick retries it. */
  ownerNoticeDeferred: string | null;
}

/**
 * #1344 C1 — the owner CTO's release notice, keyed by its attempt: one per release, however often it is asked for.
 * A RELEASED attempt with a release record and no outbox row under this key is a notice still owed.
 */
const ATTEMPT_RELEASED_KEY_PREFIX = "attempt-released:";
export const attemptReleasedNoticeKey = (runId: string, attemptId: string): string =>
  `${ATTEMPT_RELEASED_KEY_PREFIX}${runId}:${attemptId}`;

/** #1344 C1 — a release notice its owner was owed and could not be given at once; `deliverOwedReleaseNotices` retries it. */
export const ATTEMPT_RELEASE_NOTICE_DEFERRED = "ATTEMPT_RELEASE_NOTICE_DEFERRED";

type ReleaseNotice = (released: { runId: string; attemptId: string; reason: AttemptReleaseReason }) => Decision<string | null>;

interface AttemptRow {
  run_id: string;
  attempt_id: string;
  started_at: string;
  deadline_at: string;
}

/**
 * #1189 F3-1 — a run's progress, defined by what it is rather than by what it is not: its state edges
 * (DISPATCHED, RUN_TRANSITION) and its own rows — tasks, task executions (started, active, ended),
 * artifacts (its PLAN, candidates, verification, reviews, results) and the start of a candidate pipeline
 * attempt. A notice about the run, its delivery bookkeeping or a stall record is none of these, so no
 * notification kind, present or future, starts a new stall episode. An attempt's release is not counted:
 * the watchdog's own reclaim writes it.
 */
const RUN_PROGRESS_SQL = `SELECT MAX(at) AS at FROM (
    SELECT at FROM audit_events WHERE run_id = ? AND kind IN ('DISPATCHED', 'RUN_TRANSITION')
    UNION ALL SELECT updated_at FROM tasks WHERE run_id = ?
    UNION ALL SELECT MAX(started_at, COALESCE(last_activity_at, ''), COALESCE(ended_at, '')) FROM task_executions WHERE run_id = ?
    UNION ALL SELECT created_at FROM run_artifacts WHERE run_id = ?
    UNION ALL SELECT started_at FROM candidate_pipeline_attempts WHERE run_id = ?
  )`;

/** The instant of the run's latest progress, as `RUN_PROGRESS_SQL` defines it, or null for a run with none. */
export const runProgressAt = (db: Pick<Db, "get">, runId: string): string | null =>
  db.get<{ at: string | null }>(RUN_PROGRESS_SQL, [runId, runId, runId, runId, runId])?.at ?? null;

export interface WatchdogTick {
  overdue: Array<{ kind: string; id: string; ageMs: number }>;
  stalls: WatchdogStall[];
  triggered: Array<{ scope: DoctorScope; target: string | null }>;
  reports: DoctorReport[];
  ranAt: string;
}

/**
 * PRD §25.3 — a cheap timer, not a monitor.
 *
 * It inspects only resources that are already past a deadline; it never walks the whole
 * system. When something is overdue it triggers a *scoped* doctor for that thing, which
 * is what keeps continuous full diagnostics off the hot path (§40 Performance).
 */
export class Watchdog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly doctor: Doctor,
    private readonly claims: ClaimRegistry,
    private readonly outbox: Outbox,
    private readonly deadlines: WatchdogDeadlines = DEFAULT_DEADLINES,
  ) {}

  #attemptReleased: ((attemptId: string) => void) | null = null;
  #attemptRunsHere: (attemptId: string) => boolean = () => false;
  #ownerNotice: ReleaseNotice | null = null;

  /**
   * `attemptReleased`: told of each candidate pipeline attempt this watchdog releases, once the release commits, to
   * stop its work. `attemptRunsHere`: whether this process runs an attempt (none, without a pipeline). `ownerNotice`:
   * the release notice to the run's owner CTO: its message id, null when none is owed, or a denial when one is owed
   * and cannot be written now.
   */
  attach(ports: {
    attemptReleased?: (attemptId: string) => void;
    attemptRunsHere?: (attemptId: string) => boolean;
    ownerNotice?: ReleaseNotice;
  }): void {
    if (ports.attemptReleased) this.#attemptReleased = ports.attemptReleased;
    if (ports.attemptRunsHere) this.#attemptRunsHere = ports.attemptRunsHere;
    if (ports.ownerNotice) this.#ownerNotice = ports.ownerNotice;
  }

  /**
   * #1344 — at a daemon's start, before it can start an attempt: every candidate pipeline attempt still RUNNING that
   * this process does not run is released, through the deadline release's own path (`#releaseAttempt`), with the
   * reason "daemon restart". Its daemon is gone, so its row would otherwise hold the run until its deadline and refuse
   * a fresh result_submit as CONFLICT meanwhile. An attempt this process runs is never released here.
   */
  releaseAttemptsOfEndedDaemons(): ReleasedPipelineAttempt[] {
    const nowIso = this.clock.nowIso();
    const released: ReleasedPipelineAttempt[] = [];
    for (const attempt of this.db.all<AttemptRow>(
      `SELECT run_id, attempt_id, started_at, deadline_at
         FROM candidate_pipeline_attempts WHERE state = 'RUNNING' ORDER BY started_at, run_id`,
    )) {
      if (this.#attemptRunsHere(attempt.attempt_id)) continue;
      const one = this.#releaseAttempt(attempt, nowIso, AttemptReleaseReason.DAEMON_RESTART);
      if (one) released.push(one);
    }
    return released;
  }

  /**
   * The one release of a candidate pipeline attempt's hold, for either reason. A conditional update of the exact row
   * read (and, for a deadline release, only once that deadline passed), so a concurrent fresh submit is never
   * released. #1189 F3-2, #1344 C1 — the release and the notices it owes are one transaction, the CEO's owed stall
   * record and the owner CTO's notice: only this pass sees the attempt RUNNING, so neither can rest on a later one.
   * The attempt's evidence rows are kept; only the hold ends.
   */
  #releaseAttempt(attempt: AttemptRow, nowIso: string, reason: AttemptReleaseReason): ReleasedPipelineAttempt | null {
    const since = reason === AttemptReleaseReason.DEADLINE ? attempt.deadline_at : nowIso;
    return this.db.tx(() => {
      const released = this.db.run(
        `UPDATE candidate_pipeline_attempts
            SET state = 'RELEASED', released_at = ?
          WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at = ?
            ${reason === AttemptReleaseReason.DEADLINE ? "AND deadline_at <= ?" : ""}`,
        [nowIso, attempt.run_id, attempt.attempt_id, attempt.deadline_at,
          ...(reason === AttemptReleaseReason.DEADLINE ? [nowIso] : [])],
      );
      if (released.changes !== 1) return null;
      const stop = this.#attemptReleased;
      if (stop) this.db.afterCommit(() => stop(attempt.attempt_id));
      this.audit.record({
        kind: OWNERLESS_STALL_OWED,
        runId: attempt.run_id,
        evidence: { kind: "candidate_pipeline_attempt", target: attempt.attempt_id, since, reason },
      });
      const notice = this.#ownerNotice?.({ runId: attempt.run_id, attemptId: attempt.attempt_id, reason }) ?? null;
      // #1344 — a notice owed and refused now (its owner's session not live, the role unbound) is not dropped: the
      // release record keeps it owed, this row says why it waits, and every tick retries it until it is written.
      if (notice !== null && !notice.allowed) {
        this.audit.record({
          kind: ATTEMPT_RELEASE_NOTICE_DEFERRED,
          runId: attempt.run_id,
          reasonCode: notice.reasonCode,
          evidence: { attemptId: attempt.attempt_id, reason },
        });
      }
      return {
        runId: attempt.run_id,
        attemptId: attempt.attempt_id,
        startedAt: attempt.started_at,
        deadlineAt: attempt.deadline_at,
        reason,
        since,
        ownerNoticeId: notice?.allowed ? notice.value : null,
        ownerNoticeDeferred: notice !== null && !notice.allowed ? notice.reasonCode : null,
      };
    });
  }

  /**
   * #1344 C1 — the release notices still owed: an attempt ACP released (its release record names it), still the run's
   * latest, on a run still ACTIVE, with no notice written under its key. Each is asked for again; the outbox writes it
   * once its owner's binding takes it. A fresh submission replaces the attempt row and so ends what is owed. The
   * message ids written.
   */
  deliverOwedReleaseNotices(): string[] {
    const notice = this.#ownerNotice;
    if (!notice) return [];
    const owed = this.db.all<{ run_id: string; attempt_id: string; reason: string | null }>(
      `SELECT a.run_id, a.attempt_id, json_extract(owed.evidence_json, '$.reason') AS reason
         FROM candidate_pipeline_attempts a
         JOIN runs r ON r.run_id = a.run_id AND r.state = 'ACTIVE'
         JOIN audit_events owed ON owed.run_id = a.run_id AND owed.kind = ?
                               AND json_extract(owed.evidence_json, '$.kind') = 'candidate_pipeline_attempt'
                               AND json_extract(owed.evidence_json, '$.target') = a.attempt_id
        WHERE a.state = 'RELEASED'
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.idempotency_key = ? || a.run_id || ':' || a.attempt_id)
        ORDER BY owed.event_id`,
      [OWNERLESS_STALL_OWED, ATTEMPT_RELEASED_KEY_PREFIX],
    );
    const written: string[] = [];
    for (const row of owed) {
      // A release recorded before #1344 named no reason; only the deadline release wrote one then.
      const reason = row.reason === AttemptReleaseReason.DAEMON_RESTART ? AttemptReleaseReason.DAEMON_RESTART : AttemptReleaseReason.DEADLINE;
      const answered = notice({ runId: row.run_id, attemptId: row.attempt_id, reason });
      if (answered.allowed && answered.value !== null) written.push(answered.value);
    }
    return written;
  }

  async tick(): Promise<WatchdogTick> {
    const nowIso = this.clock.nowIso();
    const now = new Date(nowIso).getTime();
    const overdue: WatchdogTick["overdue"] = [];
    const stalls: WatchdogStall[] = [];
    const scopes = new Map<string, { scope: DoctorScope; target: string | null }>();
    const stallFindings = new Map<string, Finding[]>();
    this.deliverOwedReleaseNotices();
    const addOverdue = (
      key: string,
      scope: DoctorScope,
      target: string | null,
      kind: string,
      id: string,
      ageMs: number,
      deadlineMs: number,
      stall: Omit<WatchdogStall, "kind" | "id">,
    ): void => {
      overdue.push({ kind, id, ageMs });
      stalls.push({ kind, id, ...stall });
      scopes.set(key, { scope, target });
      const findings = stallFindings.get(key) ?? [];
      findings.push({
        code: "WATCHDOG_STALL",
        severity: "ERROR",
        scope: `${kind}:${id}`,
        blocking: true,
        confidence: "HIGH",
        observedEvidence: { kind, id, ageMs, deadlineMs },
        recommendedAction: "inspect the stalled resource and repair or cancel it before resuming work",
      });
      stallFindings.set(key, findings);
    };

    for (const execution of this.db.all<{
      execution_id: string;
      run_id: string;
      started_at: string;
      last_activity_at: string | null;
    }>(`SELECT execution_id, run_id, started_at, last_activity_at
          FROM task_executions WHERE status = 'RUNNING'`)) {
      const since = new Date(execution.last_activity_at ?? execution.started_at).getTime();
      const ageMs = now - since;
      if (ageMs > this.deadlines.taskActivityMs) {
        addOverdue(
          `run:${execution.run_id}`,
          "run",
          execution.run_id,
          "task_execution",
          execution.execution_id,
          ageMs,
          this.deadlines.taskActivityMs,
          { runId: execution.run_id, since: execution.last_activity_at ?? execution.started_at },
        );
      }
    }

    // `candidate_pipeline_attempts` survives process death. Its persisted deadline is the
    // authoritative recovery fact: reconstructing it from started_at can silently change an
    // existing lease when policy changes. Keep the exact tuple conditional so a concurrent
    // fresh submit cannot be released accidentally (#335).
    for (const attempt of this.db.all<AttemptRow>(`SELECT run_id, attempt_id, started_at, deadline_at
          FROM candidate_pipeline_attempts
         WHERE state = 'RUNNING' AND deadline_at <= ?`, [nowIso])) {
      const ageMs = now - new Date(attempt.started_at).getTime();
      if (this.#releaseAttempt(attempt, nowIso, AttemptReleaseReason.DEADLINE) === null) continue;

      const key = `run:${attempt.run_id}`;
      overdue.push({ kind: "candidate_pipeline_attempt", id: attempt.attempt_id, ageMs });
      stalls.push({ kind: "candidate_pipeline_attempt", id: attempt.attempt_id, runId: attempt.run_id, since: attempt.deadline_at });
      scopes.set(key, { scope: "run", target: attempt.run_id });
      const findings = stallFindings.get(key) ?? [];
      findings.push({
        code: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
        severity: "ERROR",
        scope: `candidate_pipeline_attempt:${attempt.attempt_id}`,
        blocking: true,
        confidence: "HIGH",
        observedEvidence: {
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs,
          reclaimed: true,
        },
        recommendedAction: "inspect the interrupted candidate pipeline and submit a fresh result",
      });
      stallFindings.set(key, findings);
    }

    for (const run of this.db.all<{ run_id: string; dispatched_at: string | null }>(
      `SELECT run_id, dispatched_at FROM runs WHERE state = 'ACTIVE'`,
    )) {
      if (!run.dispatched_at) continue;
      const lastEvent = { at: runProgressAt(this.db, run.run_id) };
      const since = new Date(lastEvent.at ?? run.dispatched_at).getTime();
      const ageMs = now - since;
      if (ageMs > this.deadlines.runProgressMs) {
        addOverdue(
          `run:${run.run_id}`,
          "run",
          run.run_id,
          "run",
          run.run_id,
          ageMs,
          this.deadlines.runProgressMs,
          { runId: run.run_id, since: lastEvent.at ?? run.dispatched_at },
        );
      }
    }

    for (const session of this.db.all<{ session_id: string; created_at: string }>(
      `SELECT session_id, created_at FROM sessions WHERE lifecycle = 'STARTING'`,
    )) {
      const ageMs = now - new Date(session.created_at).getTime();
      if (ageMs > this.deadlines.sessionStartMs) {
        addOverdue(
          `session:${session.session_id}`,
          "session",
          session.session_id,
          "session",
          session.session_id,
          ageMs,
          this.deadlines.sessionStartMs,
          { runId: null, since: session.created_at },
        );
      }
    }

    const expiredClaims = this.claims.overdue();
    for (const claim of expiredClaims) {
      addOverdue(
        `run:${claim.runId}`,
        "run",
        claim.runId,
        "claim",
        claim.claimId,
        now - new Date(claim.expiresAt).getTime(),
        0,
        { runId: claim.runId, since: claim.expiresAt },
      );
    }

    for (const message of this.db.all<{ message_id: string; created_at: string; run_id: string | null; kind: string; role_key: string }>(
      `SELECT message_id, created_at, run_id, kind, role_key FROM outbox WHERE status = 'PENDING'`,
    )) {
      const ageMs = now - new Date(message.created_at).getTime();
      if (ageMs > this.deadlines.outboxPendingMs) {
        addOverdue(
          "outbox",
          "system",
          null,
          "outbox",
          message.message_id,
          ageMs,
          this.deadlines.outboxPendingMs,
          { runId: message.run_id, since: message.created_at, messageKind: message.kind, roleKey: message.role_key },
        );
      }
    }

    this.outbox.expireOverdue();

    const reports: DoctorReport[] = [];
    for (const [key, scope] of scopes) {
      reports.push(await this.doctor.run(scope.scope, scope.target ?? undefined, stallFindings.get(key)));
    }

    if (overdue.length > 0) {
      this.audit.record({
        kind: "WATCHDOG_STALL",
        reasonCode: ReasonCode.DOCTOR_DEGRADED,
        evidence: {
          overdue,
          triggeredScopes: [...scopes.values()],
          statuses: reports.map((r) => r.status),
        },
      });
    }

    return {
      overdue,
      stalls,
      triggered: [...scopes.values()],
      reports,
      ranAt: this.clock.nowIso(),
    };
  }
}
