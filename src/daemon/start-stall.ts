import {
  CEO_NOTIFICATION_WITHDRAWN, DAEMON_START_SUBJECT, IncidentClass, type NoticePorts, correlationOf, deliverIncident,
} from "../ceo/ceo-incident-notices.ts";
import { digestOf } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { outboxDeliveryReadback } from "../outbox/outbox.ts";
import type { BlockingFinding } from "./daemon.ts";

/**
 * #1189 D1 — what a start that cannot resume dispatch is waiting on, said once and to someone.
 *
 * A start whose doctor blocks on a finding that cannot park refuses, releases its lock and exits, and
 * the supervisor tries again under the crash-loop backoff. Nothing in that loop says whether a retry can
 * ever succeed, and nothing tells anyone: the operator and CEO doors open only after a start succeeds.
 *
 * Each blocking finding is classified here:
 * - PERMANENT: no restart clears it. Either it is an explicit failure routed to the CEO that states the fact
 *   and the open decision and asks nobody to act (the trusted gate's GitHub App credential is missing, a
 *   checkout cannot be read, a dead session still holds authority or work, a conversation turn is
 *   contradicted, a receipt names no worker it can verify, a finding nobody classified), a decision about
 *   one run told to the CEO, or a security property of the host with its owner route.
 * - TRANSIENT: a later start may find it gone without anyone acting — a probe that did not complete,
 *   a worker process that was still running, capacity or coverage that returns.
 *
 * A stall with any PERMANENT finding is routed to the CEO as CRITICAL_SYSTEM_FAILURE. A TRANSIENT-only
 * stall is left to the backoff that retries it until the refusal that reaches the daemon's existing
 * crash-loop threshold: then the backoff has shown it does not clear it, and it is routed the same way.
 * Either is one incident of `ceo-incident-notices.ts` (RESOURCE_STALLED, subject `daemon-start`, episode
 * the stall's id), which owns its dedup and its re-delivery to a CEO that replaced the one it was sent to.
 * The notice says the start is refused and that ACP's action path is not running. Nothing here moves a
 * run: a refused or parked start completes, fails and dispatches nothing, and the blocked runs are
 * reported with whether any execution of theirs was ever started, so whoever resumes them knows which
 * may have effects to check first.
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
 *
 * #1189 WIP 2 (CEO msg_7cb20fea) and CEO msg_390e287c — a finding routed to the CEO as an explicit failed start
 * is told once and is never a wait on the owner or a request that anyone act: it states the fact and the open
 * decision, says the start stays refused, and may name a resolving command only as information. No degraded
 * start, and nothing is installed, inferred, settled or repaired. Each text is kept within the audit's
 * 200-character free-text bound, or the stall's records lose their evidence.
 */
const START_FINDING_CLASSES: Readonly<Record<string, StartFindingClass>> = {
  // Integrity findings (STATE_PATH_INSECURE, CANONICAL_TURN_CONTRADICTED, the trusted-gate credential)
  // block on purpose, and nothing here weakens that; it only says who is told and who can clear them.
  STATE_PATH_INSECURE: permanent("OWNER", "SECURITY", "restore owner-only, non-symlinked state paths, then restart the daemon"),
  TRUSTED_GATE_CREDENTIAL_MISSING: permanent("CEO", "CREDENTIAL", "nothing is requested of anyone: this start failed without the trusted gate's GitHub App credential, and each later start fails the same way until the daemon can read it"),
  TRUSTED_GATE_CREDENTIAL_PERMISSIONS: permanent("OWNER", "SECURITY", "restrict the secret directory to owner-only access, then restart the daemon"),
  CANONICAL_TURN_CONTRADICTED: permanent("CEO", "SECURITY", "nothing is requested of anyone: two records disagree on how a conversation turn ended, so this start stays refused; resolution is an operator-socket action (agentctl conversation adjudicate)"),
  // A checkout that is not there or not a repository: its registration, or the owner-gated project suspend.
  REPOSITORY_UNREADABLE: permanent("CEO", "OWNER_GATED", "nothing is requested of anyone: a registered checkout is missing or not a repository, so this start stays refused; re-registering it or suspending its project is an open decision"),
  // The restart reconcile marks a dead session ERROR and stops there: a binding it still holds or a run
  // it still owns is released through the operator door, which a refused start never opens.
  SESSION_PROCESS_MISSING: permanent("CEO", "DEAD_SESSION", "nothing is requested of anyone: a dead session still holds a binding or owns work, so this start stays refused; releasing them is an open decision, and no operator door opens while starts refuse"),
  // Re-pinning or ending a run is a decision about that run; no restart makes it.
  ACTIVE_RUN_WITHOUT_OWNER: permanent("CEO", "RUN_DECISION", "re-pin the run's owner or end the run; neither is reachable until the daemon starts"),
  // The restart reconcile already abandons every RUNNING receipt it can; one left names no worker it can verify.
  // No tool that settles such a receipt is confirmed, so the text names none: the fact and the open decision only.
  WORKER_IDENTITY_MISSING: permanent("CEO", "RECEIPT", "nothing is requested of anyone: an open execution receipt names no worker, so what ran is unknown and this start stays refused; how that receipt is settled is an open decision"),
  WORKER_IDENTITY_UNVERIFIABLE: permanent("CEO", "RECEIPT", "nothing is requested of anyone: an open execution receipt names no known worker, so what ran is unknown and this start stays refused; how that receipt is settled is an open decision"),
  // A receipt whose recorded process is still alive: the restart reconcile abandons it once that process is gone.
  DEAD_WORKER_WITH_OPEN_RECEIPT: transient("PROCESS", "the next start abandons the receipt once its process is gone; check the task's effects before it runs again"),
  REPOSITORY_PROBE_FAILED: transient("PROBE", "the next start probes the checkout again; if it keeps failing, restore the checkout"),
  WORKTREE_PROBE_FAILED: transient("PROBE", "the next start inspects the worktrees again; if it keeps failing, restore the checkout"),
};

export const classifyStartFinding = (finding: BlockingFinding): ClassifiedStartFinding => {
  const known = START_FINDING_CLASSES[finding.code] ??
    (finding.code.startsWith("ROLE_COVERAGE_") || finding.code.startsWith("CAPACITY_")
      ? transient("COVERAGE", "the next capacity reading may restore coverage; an operator observation can also clear it")
      : permanent("CEO", "UNCLASSIFIED", "nothing is requested of anyone: this start is blocked on a finding whose cause is unconfirmed, and it stays refused; the startup doctor report carries that finding's evidence"));
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
  routing: StartStallRouting;
}

/**
 * Where the stall's notice stands. `delivery` is the outbox readback (`outboxDeliveryReadback`): a send
 * attempt is not delivery, and only an ACK is completion. `undelivered` says why this start's send did not
 * deliver it; the notice stays PENDING and the next start offers it again.
 */
export type StartStallRouting =
  | { status: "NOT_ROUTED_TRANSIENT" }
  | { status: "NOT_ROUTED"; reasonCode: ReasonCode }
  | {
      status: "ROUTED" | "ALREADY_ROUTED";
      messageId: string;
      redelivery: boolean;
      delivery: ReturnType<typeof outboxDeliveryReadback> & { attempts: number };
      undelivered?: string;
    };

/**
 * The subject every start-stall incident is about: the daemon's start, not any run. A successful start after
 * the incident opened resolves it (`resolutionOf`, DAEMON_STARTED): a notice of it still PENDING is withdrawn,
 * not delivered late (`withdrawResolvedNotices`).
 */
export const START_STALL_SUBJECT = DAEMON_START_SUBJECT;
/** The source a start-stall notice names, for its reader. */
export const START_STALL_SOURCE = "DAEMON_START_STALL";

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
 * #1189 — routes revised from the owner to an explicit failure told to the CEO: the trusted-gate credential (WIP 2),
 * then the remaining non-security owner routes (CEO msg_390e287c). The earlier routes named the owner as who clears
 * the finding and asked for a repair; a notice of one still owed when this build starts would otherwise be offered
 * again, because the stall it states is the same. The fallback for a code no table names has no code of its own, so
 * its basis names it. Changing one of these routes again needs a new revision, or ALREADY_ROUTED re-offers the
 * notice it replaced.
 */
const REVISED_ROUTE = {
  codes: [
    "TRUSTED_GATE_CREDENTIAL_MISSING", "CANONICAL_TURN_CONTRADICTED", "REPOSITORY_UNREADABLE", "SESSION_PROCESS_MISSING",
    "WORKER_IDENTITY_MISSING", "WORKER_IDENTITY_UNVERIFIABLE",
  ] as readonly string[],
  basis: "UNCLASSIFIED",
  revision: "no-owner-wait",
  obsoleteRepairOwner: "OWNER",
} as const;

const routeRevised = (finding: ClassifiedStartFinding): boolean =>
  REVISED_ROUTE.codes.includes(finding.code) || finding.basis === REVISED_ROUTE.basis;

/**
 * The episode a stall is told in, bounded by the daemon's last successful start: a successful start ends
 * it, so the same failure arising after that is a new episode and is told again.
 * - PERMANENT: one episode per set of PERMANENT findings. A later refusal on the same set is the same stall;
 *   a different set needs a different remedy and is told.
 * - TRANSIENT at the crash-loop threshold: one episode per failure episode, whatever transient findings each
 *   refusal of it meets. The crash loop is what is told, and it lasts until a start succeeds.
 * - TRANSIENT below it: routed to no one, so only health.json carries its id.
 * A finding whose route was revised (`REVISED_ROUTE`) carries its revision, so the revised statement is a new
 * episode and reaches the CEO once; every other finding's stall keeps the id an earlier build gave it.
 */
const stallIdOf = (db: Db, findings: readonly ClassifiedStartFinding[], cause: StartStallCause, crashLoop: boolean): string => {
  const lastStart = db.get<{ eventId: number | null }>(
    `SELECT MAX(event_id) AS eventId FROM audit_events WHERE kind = 'DAEMON_STARTED'`,
  )?.eventId ?? null;
  if (crashLoop) return digestOf({ since: lastStart, cause, crashLoop: true });
  return digestOf({
    since: lastStart,
    cause,
    findings: findings
      .filter((finding) => finding.cause === cause)
      .map((finding) => routeRevised(finding)
        ? `${finding.code}|${finding.scope}|${REVISED_ROUTE.revision}`
        : `${finding.code}|${finding.scope}`)
      .sort(),
  });
};

/**
 * Withdraws every daemon-start notice still owed (PENDING or SENT) that states a revised finding (`REVISED_ROUTE`)
 * with its obsolete owner route, as `withdrawResolvedNotices` withdraws a resolved one: REJECTED, with one
 * CEO_NOTIFICATION_WITHDRAWN record. So is one left IN_FLIGHT by a claim the outbox's lease rule presumes dead
 * (`staleClaimCutoff`, the rule `reclaimStaleLeases` applies): withdrawn now, a later reclaim has nothing to put
 * back. A claim still within its lease is that send's; an ACKed notice was received and stays as it is. No other
 * stall's notice is touched.
 */
const withdrawObsoleteRouteNotices = (ports: NoticePorts): void => {
  const correlation = correlationOf(IncidentClass.RESOURCE_STALLED, START_STALL_SUBJECT);
  const staleClaim = ports.outbox.staleClaimCutoff();
  const owed = `(status IN ('PENDING', 'SENT') OR (status = 'IN_FLIGHT' AND claimed_at <= ?))`;
  const rows = ports.db.all<{
    message_id: string; role_key: string; target_session_id: string; binding_generation: number; status: string; episode: unknown;
  }>(
    `SELECT o.message_id, o.role_key, o.target_session_id, o.binding_generation, o.status,
            json_extract(o.payload_json, '$.episode') AS episode
       FROM outbox o
      WHERE o.kind = 'CEO_NOTIFICATION' AND o.run_id IS NULL AND ${owed}
        AND json_valid(o.payload_json) = 1 AND json_extract(o.payload_json, '$.correlation') = ?
        AND EXISTS (SELECT 1 FROM json_each(o.payload_json, '$.findings') AS f
                     WHERE json_extract(f.value, '$.repairOwner') = ?
                       AND (json_extract(f.value, '$.code') IN (${REVISED_ROUTE.codes.map(() => "?").join(", ")})
                            OR json_extract(f.value, '$.basis') = ?))
      ORDER BY o.created_at, o.rowid`,
    [staleClaim, correlation, REVISED_ROUTE.obsoleteRepairOwner, ...REVISED_ROUTE.codes, REVISED_ROUTE.basis],
  );
  for (const row of rows) {
    ports.db.tx(() => {
      const changed = ports.db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND ${owed}`,
        [ReasonCode.EVIDENCE_STALE, row.message_id, staleClaim],
      ).changes;
      if (changed !== 1) return;
      ports.audit.record({
        kind: CEO_NOTIFICATION_WITHDRAWN,
        reasonCode: ReasonCode.EVIDENCE_STALE,
        runId: null,
        roleKey: row.role_key,
        sessionId: row.target_session_id,
        evidence: {
          messageId: row.message_id,
          status: row.status,
          fromGeneration: row.binding_generation,
          incidentClass: IncidentClass.RESOURCE_STALLED,
          correlation,
          episode: typeof row.episode === "string" ? row.episode : null,
          withdrawnFor: "ROUTE_REVISED",
          revision: REVISED_ROUTE.revision,
        },
      });
    });
  }
};

/** What the start-stall incident's delivery answered, with the readback of the notice it names. */
const routingOf = (ports: NoticePorts, delivered: ReturnType<typeof deliverIncident>): StartStallRouting => {
  const message = delivered.allowed && delivered.value.messageId !== null ? ports.outbox.get(delivered.value.messageId) : null;
  if (!delivered.allowed || !message) return { status: "NOT_ROUTED", reasonCode: delivered.reasonCode };
  return {
    status: delivered.value.created ? "ROUTED" : "ALREADY_ROUTED",
    messageId: message.messageId,
    redelivery: delivered.value.redelivery,
    delivery: { ...outboxDeliveryReadback(message), attempts: message.attempts },
  };
};

/**
 * Classifies, records and — for a PERMANENT stall, or a TRANSIENT one that reached the crash-loop
 * threshold — routes what a start that cannot resume dispatch waits on.
 */
export const describeStartStall = (
  ports: NoticePorts,
  blockingFindings: readonly BlockingFinding[],
  phase: StartStall["phase"],
  crashLoop: boolean,
): StartStall => {
  const { db } = ports;
  const findings = blockingFindings
    .map(classifyStartFinding)
    .sort((a, b) => (a.code === b.code ? a.scope.localeCompare(b.scope) : a.code.localeCompare(b.code)));
  const cause: StartStallCause = findings.some((finding) => finding.cause === "PERMANENT") ? "PERMANENT" : "TRANSIENT";
  const crashLooping = cause === "TRANSIENT" && crashLoop;
  const runs = blockedRunsOf(db);
  const blockedRuns = runs.slice(0, MAX_REPORTED_RUNS);
  const stallId = stallIdOf(db, findings, cause, crashLooping);
  withdrawObsoleteRouteNotices(ports);
  const routing = cause === "TRANSIENT" && !crashLooping
    ? { status: "NOT_ROUTED_TRANSIENT" as const }
    : routingOf(ports, deliverIncident(ports, {
        cls: IncidentClass.RESOURCE_STALLED,
        subject: START_STALL_SUBJECT,
        runId: null,
        episode: stallId,
        payload: {
          source: START_STALL_SOURCE,
          stallId,
          phase,
          cause,
          crashLoop: crashLooping,
          startRefused: true,
          acpActionPath: "NOT_RUNNING",
          blocker: phase === "PARKED"
            ? "the daemon start is refused: it is parked on its startup doctor, dispatch is not resumed and ACP's action path is not running; only the operator bootstrap door is open"
            : crashLooping
              ? "the daemon start is refused and ACP's action path is not running: its startup doctor keeps blocking on findings the restart backoff has not cleared"
              : "the daemon start is refused and ACP's action path is not running: its startup doctor blocks on findings no restart clears",
          findings,
          blockedRunCount: runs.length,
          blockedRuns,
          runEffect: "no run was completed, failed or dispatched by this start; a run whose execution ran may have effects to check before it runs again",
          whyItMatters: "until a start succeeds no run is dispatched and no ACP tool acts on the CEO's behalf; the findings name who can clear them",
        },
      }));
  return { phase, cause, crashLoop: crashLooping, stallId, findings, blockedRunCount: runs.length, blockedRuns, routing };
};
