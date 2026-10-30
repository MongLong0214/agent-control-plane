import { StallSource, routeStallToCeo, type StallRouter, type StallRouting } from "../ceo/stall-notice.ts";
import { digestOf } from "../core/digest.ts";
import type { Db } from "../db/database.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import type { BlockingFinding } from "./daemon.ts";

/**
 * #1189 D1 — what a start that cannot resume dispatch is waiting on, said once and to someone.
 *
 * A start whose doctor blocks on a finding that cannot park refuses, releases its lock and exits, and
 * the supervisor tries again under the crash-loop backoff. Nothing in that loop says whether a retry can
 * ever succeed, and nothing tells anyone: the operator and CEO doors open only after a start succeeds.
 *
 * Each blocking finding is classified here:
 * - PERMANENT: no restart clears it. A credential, a security property of the host, an owner-gated
 *   repair, a dead session that still holds authority or work, or a decision about one run is missing,
 *   so a person or the CEO has to act.
 * - TRANSIENT: a later start may find it gone without anyone acting — a probe that did not complete,
 *   a worker process that was still running, capacity or coverage that returns.
 *
 * A stall with any PERMANENT finding is routed to the CEO as CRITICAL_SYSTEM_FAILURE, once per stall
 * (`routeStallToCeo`). A TRANSIENT-only stall is left to the backoff that retries it until the refusal
 * that reaches the daemon's existing crash-loop threshold: then the backoff has shown it does not clear
 * it, and it is routed the same way, once. Nothing here moves a run: a refused or parked start
 * completes, fails and dispatches nothing, and the blocked runs are reported with whether any execution
 * of theirs was ever started, so whoever resumes them knows which may have effects to check first.
 */
export type StartStallCause = "PERMANENT" | "TRANSIENT";

/** Who can clear a finding: a person, the CEO through its own tools, or the daemon on a later start. */
export type StartStallRepairOwner = "OWNER" | "CEO" | "DAEMON";

export interface ClassifiedStartFinding {
  code: string;
  scope: string;
  cause: StartStallCause;
  repairOwner: StartStallRepairOwner;
  /** Why it is that cause: SECURITY, CREDENTIAL, OWNER_GATED, DEAD_SESSION, RUN_DECISION, RECEIPT, PROBE, PROCESS, COVERAGE, UNCLASSIFIED. */
  basis: string;
  recoveryAction: string;
}

interface StartFindingClass {
  cause: StartStallCause;
  repairOwner: StartStallRepairOwner;
  basis: string;
  recoveryAction: string;
}

const permanent = (repairOwner: StartStallRepairOwner, basis: string, recoveryAction: string): StartFindingClass =>
  ({ cause: "PERMANENT", repairOwner, basis, recoveryAction });
const transient = (basis: string, recoveryAction: string): StartFindingClass =>
  ({ cause: "TRANSIENT", repairOwner: "DAEMON", basis, recoveryAction });

/**
 * Every blocking finding the system doctor can raise at start, by code, after the restart reconcile
 * has run. A code missing from this table is classified PERMANENT (`UNCLASSIFIED`): a stall nobody can
 * tell will clear is told to the CEO rather than left to a backoff that may never end.
 */
const START_FINDING_CLASSES: Readonly<Record<string, StartFindingClass>> = {
  // Integrity findings (STATE_PATH_INSECURE, CANONICAL_TURN_CONTRADICTED, the trusted-gate credential)
  // block on purpose, and nothing here weakens that; it only says who can clear them.
  STATE_PATH_INSECURE: permanent("OWNER", "SECURITY", "restore owner-only, non-symlinked state paths, then restart the daemon"),
  TRUSTED_GATE_CREDENTIAL_MISSING: permanent("OWNER", "CREDENTIAL", "install the trusted GitHub credential, then restart the daemon"),
  TRUSTED_GATE_CREDENTIAL_PERMISSIONS: permanent("OWNER", "SECURITY", "restrict the secret directory to owner-only access, then restart the daemon"),
  CANONICAL_TURN_CONTRADICTED: permanent("OWNER", "SECURITY", "an operator adjudicates the contradicted turn (agentctl conversation adjudicate), citing every observation"),
  // A checkout that is not there or not a repository: restoring it, or the owner-gated project suspend.
  REPOSITORY_UNREADABLE: permanent("OWNER", "OWNER_GATED", "restore the checkout or re-register the repository; suspending the project is the owner's call"),
  // The restart reconcile marks a dead session ERROR and stops there: a binding it still holds or a run
  // it still owns is recovered through the operator door, which a refused start never opens.
  SESSION_PROCESS_MISSING: permanent("OWNER", "DEAD_SESSION", "recover the dead session's bindings or re-pin the runs it owns; no operator door opens while the start refuses"),
  // Re-pinning or ending a run is a decision about that run; no restart makes it.
  ACTIVE_RUN_WITHOUT_OWNER: permanent("CEO", "RUN_DECISION", "re-pin the run's owner or end the run; neither is reachable until the daemon starts"),
  // The restart reconcile already abandons every RUNNING receipt it can; one left names no worker it can verify.
  WORKER_IDENTITY_MISSING: permanent("OWNER", "RECEIPT", "the receipt names no worker; establish what ran, then settle the receipt"),
  WORKER_IDENTITY_UNVERIFIABLE: permanent("OWNER", "RECEIPT", "the receipt names no known worker; establish what ran, then settle the receipt"),
  // A receipt whose recorded process is still alive: the restart reconcile abandons it once that process is gone.
  DEAD_WORKER_WITH_OPEN_RECEIPT: transient("PROCESS", "the next start abandons the receipt once its process is gone; check the task's effects before it runs again"),
  REPOSITORY_PROBE_FAILED: transient("PROBE", "the next start probes the checkout again; if it keeps failing, restore the checkout"),
  WORKTREE_PROBE_FAILED: transient("PROBE", "the next start inspects the worktrees again; if it keeps failing, restore the checkout"),
};

export const classifyStartFinding = (finding: BlockingFinding): ClassifiedStartFinding => {
  const known = START_FINDING_CLASSES[finding.code] ??
    (finding.code.startsWith("ROLE_COVERAGE_") || finding.code.startsWith("CAPACITY_")
      ? transient("COVERAGE", "the next capacity reading may restore coverage; an operator observation can also clear it")
      : permanent("OWNER", "UNCLASSIFIED", "read the startup doctor report for this finding's remedy"));
  return { code: finding.code, scope: finding.scope, ...known };
};

/** A run a stalled start holds back: nonterminal, and whether any execution of it was ever started. */
export interface StartStallRun {
  runId: string;
  state: string;
  /** A task execution receipt of this run was opened: it may have effects to check before anything is re-run. */
  executionRan: boolean;
  /** Receipts still RUNNING after the restart reconcile: their effects are unknown, not absent. */
  openExecutions: string[];
  /** The run's merge finalization attempt, if one was ever leased (RUNNING, RELEASED, COMPLETED, BLOCKED). */
  finalizationAttempt: string | null;
}

export interface StartStall {
  phase: "REFUSED" | "PARKED";
  cause: StartStallCause;
  /** A TRANSIENT stall whose refusal reached the crash-loop threshold: the backoff is not clearing it. */
  crashLoop: boolean;
  stallId: string;
  findings: ClassifiedStartFinding[];
  blockedRunCount: number;
  /** At most `MAX_REPORTED_RUNS`, oldest first. */
  blockedRuns: StartStallRun[];
  routing: StallRouting | { status: "NOT_ROUTED_TRANSIENT" };
}

const MAX_REPORTED_RUNS = 50;

const blockedRunsOf = (db: Db): StartStallRun[] => {
  const terminal = TERMINAL_RUN_STATES.map(() => "?").join(", ");
  const runs = db.all<{ run_id: string; state: string; executions: number; finalization: string | null }>(
    `SELECT r.run_id, r.state, COUNT(e.execution_id) AS executions, f.state AS finalization
       FROM runs r
       LEFT JOIN task_executions e ON e.run_id = r.run_id
       LEFT JOIN finalization_attempts f ON f.run_id = r.run_id
      WHERE r.state NOT IN (${terminal})
      GROUP BY r.run_id
      ORDER BY r.created_at, r.run_id`,
    [...TERMINAL_RUN_STATES],
  );
  const open = new Map<string, string[]>();
  for (const row of db.all<{ run_id: string; execution_id: string }>(
    `SELECT run_id, execution_id FROM task_executions WHERE status = 'RUNNING' ORDER BY execution_id`,
  )) open.set(row.run_id, [...(open.get(row.run_id) ?? []), row.execution_id]);
  return runs.map((run) => ({
    runId: run.run_id,
    state: run.state,
    executionRan: run.executions > 0,
    openExecutions: open.get(run.run_id) ?? [],
    finalizationAttempt: run.finalization,
  }));
};

/**
 * One stall is one set of routed findings since the daemon last started: the PERMANENT ones, or for a
 * TRANSIENT-only stall all of them. A later refusal on the same set is the same stall and routes nothing
 * new; a successful start ends it, so the same finding arising after that is a new stall and is told again.
 */
const stallIdOf = (db: Db, findings: readonly ClassifiedStartFinding[], cause: StartStallCause): string => {
  const lastStart = db.get<{ eventId: number | null }>(
    `SELECT MAX(event_id) AS eventId FROM audit_events WHERE kind = 'DAEMON_STARTED'`,
  )?.eventId ?? null;
  return digestOf({
    since: lastStart,
    cause,
    findings: findings
      .filter((finding) => finding.cause === cause)
      .map((finding) => `${finding.code}|${finding.scope}`)
      .sort(),
  });
};

/**
 * Classifies, records and — for a PERMANENT stall, or a TRANSIENT one that reached the crash-loop
 * threshold — routes what a start that cannot resume dispatch waits on.
 */
export const describeStartStall = (
  router: StallRouter,
  blockingFindings: readonly BlockingFinding[],
  phase: StartStall["phase"],
  crashLoop: boolean,
): StartStall => {
  const { db } = router;
  const findings = blockingFindings
    .map(classifyStartFinding)
    .sort((a, b) => (a.code === b.code ? a.scope.localeCompare(b.scope) : a.code.localeCompare(b.code)));
  const cause: StartStallCause = findings.some((finding) => finding.cause === "PERMANENT") ? "PERMANENT" : "TRANSIENT";
  const crashLooping = cause === "TRANSIENT" && crashLoop;
  const runs = blockedRunsOf(db);
  const blockedRuns = runs.slice(0, MAX_REPORTED_RUNS);
  const stallId = stallIdOf(db, findings, cause);
  const routing = cause === "TRANSIENT" && !crashLooping
    ? { status: "NOT_ROUTED_TRANSIENT" as const }
    : routeStallToCeo(router, {
        source: StallSource.DAEMON_START,
        stallId,
        runId: null,
        describe: () => ({
          phase,
          cause,
          crashLoop: crashLooping,
          blocker: crashLooping
            ? "the daemon refuses to resume dispatch: its startup doctor keeps blocking on findings the restart backoff has not cleared"
            : "the daemon refuses to resume dispatch: its startup doctor blocks on findings no restart clears",
          findings,
          blockedRunCount: runs.length,
          blockedRuns,
          runEffect: "no run was completed, failed or dispatched by this start; a run whose execution ran may have effects to check before it runs again",
        }),
      });
  return { phase, cause, crashLoop: crashLooping, stallId, findings, blockedRunCount: runs.length, blockedRuns, routing };
};
