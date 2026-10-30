import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { OWNERLESS_STALL_OWED, OWNERLESS_STALL_ROUTED, type WatchdogStall } from "../doctor/watchdog.ts";
import { ArtifactKind, Role, RunState, roleKeyFor, type RoleBinding, type RunRow } from "../domain/types.ts";
import { HOLDER_CLAIMED_KINDS, MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import {
  type Incident,
  IncidentClass,
  type NoticeState,
  NotificationKind,
  deliverIncident,
  runEpisode,
  runProgressedPast,
  runStateEntry,
} from "./ceo-incident-notices.ts";
import type { ProductionGate } from "./production-gate.ts";

/**
 * #1189 B4, B6, B7, B10 (CEO ruling 4) — the waits whose next move belongs to an agent, not the owner:
 * a CTO escalation the CEO has not resolved, a candidate at CEO review, a run the CEO returned with
 * FINAL_REVISE and has not dispatched again, and a run continuity holds for a role it cannot cover.
 * An owner decision (AWAITING_HUMAN without continuity's hold) and an owner's project suspension are
 * the owner's, and are never touched here.
 */
export const AgentWaitKind = {
  ESCALATION: "ESCALATION",
  CEO_REVIEW: "CEO_REVIEW",
  REVISION: "REVISION",
  CONTINUITY_HOLD: "CONTINUITY_HOLD",
} as const;
export type AgentWaitKind = (typeof AgentWaitKind)[keyof typeof AgentWaitKind];

/**
 * The deadline ladder. Each step is taken once per wait, one deadline after the step before it (the
 * first, one deadline after the wait began):
 *
 * - RENOTIFY: the wait's owner is told again, through the wait's own notice (READY_FOR_CEO_REVIEW for a
 *   review, TRUE_ESCALATION otherwise), whether or not an earlier notice was ACKed — an ACK is receipt,
 *   not a decision;
 * - REASSIGN: a CEO-owned wait is delivered to whoever holds the CEO role now (a recovered or re-adopted
 *   CEO included); a continuity hold gets a recovery attempt, continuity's own reconcile, which releases
 *   the hold once its role is covered;
 * - CEO_ESCALATION: a CRITICAL_SYSTEM_FAILURE notice to the CEO naming the owner, the recovery action and
 *   the blocker.
 *
 * After the last step the wait stays as it is, and its CRITICAL_SYSTEM_FAILURE reaches a CEO that replaced
 * the one it went to, once (`ceo-incident-notices.ts`). No step moves the run: a deadline is never a FAILED,
 * and a terminal outcome stays with the existing explicit paths (run_cancel, a CEO decision).
 */
export const AgentWaitStep = {
  RENOTIFY: "RENOTIFY",
  REASSIGN: "REASSIGN",
  CEO_ESCALATION: "CEO_ESCALATION",
} as const;
export type AgentWaitStep = (typeof AgentWaitStep)[keyof typeof AgentWaitStep];
const LADDER: readonly AgentWaitStep[] = [AgentWaitStep.RENOTIFY, AgentWaitStep.REASSIGN, AgentWaitStep.CEO_ESCALATION];

/** How long each kind of wait may sit before its next step (configured on the daemon). */
export interface AgentWaitDeadlines {
  escalationMs: number;
  ceoReviewMs: number;
  revisionMs: number;
  continuityHoldMs: number;
}

export const DEFAULT_AGENT_WAIT_DEADLINES: AgentWaitDeadlines = {
  escalationMs: 60 * 60 * 1000,
  ceoReviewMs: 2 * 60 * 60 * 1000,
  revisionMs: 2 * 60 * 60 * 1000,
  continuityHoldMs: 2 * 60 * 60 * 1000,
};

/** The record of one ladder step, keyed by the wait's episode (the RUN_TRANSITION that entered it). */
export const AGENT_WAIT_DEADLINE = "AGENT_WAIT_DEADLINE";
/** The record of a pending review delivered again to the CEO role's current holder. */
export const CEO_REVIEW_REDELIVERED = "CEO_REVIEW_REDELIVERED";

export interface AgentWait {
  kind: AgentWaitKind;
  runId: string;
  projectId: string | null;
  /** The RUN_TRANSITION event that entered the wait: a run that leaves and comes back is a new wait. */
  episode: number;
  since: string;
  /** The role that owns the wait's next move: the CEO, or the role continuity holds the run for. */
  owner: string;
  recoveryAction: string;
  blocker: string;
  escalation?: { escalationId: number; question: unknown; options: unknown; recommendation: unknown; blocksCriticalPath: unknown };
  review?: { candidateSnapshotDigest: string; packetDigest: string };
}

export interface AgentWaitSweepReport {
  taken: Array<{ runId: string; kind: AgentWaitKind; step: AgentWaitStep; messageId: string | null }>;
  deferred: Array<{ runId: string; kind: AgentWaitKind; step: AgentWaitStep; reasonCode: string }>;
}

/** The daemon's recovery attempt for a continuity hold: its own continuity reconcile. */
export type ContinuityRecovery = (wait: AgentWait) => Promise<unknown> | unknown;

/**
 * #1189 B12, C2 (CEO ruling 5) — a stall no agent is watching, routed to the CEO as the existing
 * CRITICAL_SYSTEM_FAILURE notice. It names who owns the stalled thing, what recovers it and the concrete
 * blocker, and whether something it started may have had effects, in which case the recovery checks
 * them before anything is run again. A delivery timeout is a delivery problem, never a product failure.
 */
export interface OwnerlessStall {
  source: "STANDARD_WORK_CONTINUATION" | "WATCHDOG";
  kind: string;
  id: string;
  /** What identifies this stall across passes: the same episode is routed once. */
  episode: string;
  runId: string | null;
  since: string | null;
  owner: { role: string | null; sessionId: string | null; generation: number | null };
  recoveryAction: string;
  blocker: string;
  /** NONE_STARTED: proven not started. MAY_HAVE_RUN / UNKNOWN: check its effects before re-running. */
  effects: "NONE_STARTED" | "NONE" | "MAY_HAVE_RUN" | "UNKNOWN";
  deliveryTimeout: boolean;
  /** A stall of a run stated again in the incident episode it was first routed in; absent, the run's current one. */
  incidentEpisode?: string;
  /**
   * A stall of a run its detector settles when the run progresses past its episode (every watchdog stall: one
   * stated in its run's current episode is never stated in an earlier one, and an owed one, a reclaimed attempt,
   * is settled when its run moved on), so that progress also resolves its incident (`Incident.settlesOnProgress`).
   * Absent, it does not.
   */
  settlesOnProgress?: boolean;
}

/** What routing one ownerless stall did: see `AgentOwnedWaits.routeOwnerlessStall`. */
export interface RoutedStall {
  messageId: string | null;
  routed: boolean;
  state: NoticeState;
  episode: string;
}

export interface AgentOwnedWaitsPorts {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  runs: RunEngine;
  bindings: BindingRegistry;
  outbox: Outbox;
  artifacts: ArtifactStore;
  gate: Pick<ProductionGate, "openEscalationOf" | "humanGateStatus">;
}

const evidenceOf = (json: string | null | undefined): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** Per watchdog stall kind: what recovers it and whether what it started may have had effects. */
const WATCHDOG_STALL_ROUTES: Readonly<Record<string, { recoveryAction: string; effects: OwnerlessStall["effects"]; what: string }>> = {
  task_execution: {
    what: "a task execution RUNNING with no activity past its deadline",
    effects: "MAY_HAVE_RUN",
    recoveryAction:
      "doctor_run scope run, and settle the execution before anything is run again (its worker may have written effects); " +
      "then the run's CTO re-staffs the task, or the CEO replaces the CTO (cto_replace) or cancels the run (run_cancel)",
  },
  candidate_pipeline_attempt: {
    what: "a candidate pipeline attempt past its deadline, released by the watchdog",
    effects: "MAY_HAVE_RUN",
    recoveryAction:
      "read the attempt's verification and review records, then the run's CTO submits a fresh result (result_submit), " +
      "or the CEO replaces the CTO (cto_replace)",
  },
  run: {
    what: "an ACTIVE run with no progress past its deadline",
    effects: "UNKNOWN",
    recoveryAction:
      "doctor_run scope run and check what its executions wrote before re-running any of them; then the CEO wakes or replaces " +
      "the run's CTO (cto_replace) or cancels the run (run_cancel)",
  },
  session: {
    what: "a session left STARTING past its deadline",
    effects: "NONE",
    recoveryAction: "the daemon's reconcile settles the session; a role waiting on it is given a new holder (cto_replace)",
  },
  claim: {
    what: "a resource claim held past its expiry",
    effects: "UNKNOWN",
    recoveryAction: "doctor_run scope run; the claim's run releases or renews it, or the CEO cancels the run (run_cancel)",
  },
  outbox: {
    what: "messages PENDING past the delivery deadline",
    effects: "NONE",
    recoveryAction: "retry the delivery (repair_execute retry_outbox, HERMES authority); a delivery timeout does not fail the run",
  },
};

/**
 * The incident an ownerless stall is, in `ceo-incident-notices.ts`'s one correlation per (subject, class):
 * a stall of a run is that run's RUN_STALLED incident in its current progress episode (F3-1), so two
 * watchdog findings, or a watchdog finding and another detector, on one unchanged run are one notice;
 * messages stalled to a role are that role's DELIVERY_STALLED; anything else is its own RESOURCE_STALLED.
 */
const stallIncident = (db: Db, stall: OwnerlessStall): Incident => {
  const checkBeforeRerun = stall.effects === "MAY_HAVE_RUN" || stall.effects === "UNKNOWN";
  const placed = stall.kind === "outbox"
    ? { cls: IncidentClass.DELIVERY_STALLED, subject: stall.owner.role ?? "unknown", episode: stall.episode }
    : stall.runId !== null
      ? { cls: IncidentClass.RUN_STALLED, subject: stall.runId, episode: stall.incidentEpisode ?? runEpisode(db, stall.runId) }
      : { cls: IncidentClass.RESOURCE_STALLED, subject: `${stall.kind}:${stall.id}`, episode: stall.episode };
  return {
    ...placed,
    ...(stall.settlesOnProgress === true && placed.cls === IncidentClass.RUN_STALLED ? { settlesOnProgress: true } : {}),
    runId: stall.runId,
    payload: {
      stall: stall.kind,
      source: stall.source,
      resource: stall.id,
      since: stall.since,
      owner: stall.owner,
      recoveryAction: stall.recoveryAction,
      blocker: stall.blocker,
      effects: stall.effects,
      checkBeforeRerun,
      deliveryTimeout: stall.deliveryTimeout,
      productFailure: false,
    },
    record: {
      source: stall.source,
      kind: stall.kind,
      target: stall.id,
      since: stall.since,
      owner: stall.owner,
      action: stall.recoveryAction,
      detail: stall.blocker,
      effects: stall.effects,
      deliveryTimeout: stall.deliveryTimeout,
    },
  };
};

/** One component for the agent-owned waits' deadlines, the review re-delivery and the ownerless stall routing. */
export class AgentOwnedWaits {
  constructor(
    private readonly ports: AgentOwnedWaitsPorts,
    private readonly deadlines: AgentWaitDeadlines = DEFAULT_AGENT_WAIT_DEADLINES,
  ) {}

  /** Every agent-owned wait there is now. */
  waits(): AgentWait[] {
    const waits: AgentWait[] = [];
    for (const state of [RunState.BLOCKED, RunState.READY_FOR_CEO_REVIEW, RunState.REVISION_REQUIRED, RunState.AWAITING_HUMAN]) {
      for (const run of this.ports.runs.list({ state })) {
        const wait = this.#waitOf(run);
        if (wait) waits.push(wait);
      }
    }
    return waits;
  }

  /**
   * Takes every ladder step that is due, one per wait per pass. A step that cannot be delivered (no CEO
   * bound, or its session not READY) is left untaken and asked again next pass: a delivery that cannot
   * happen yet is not a failure of the run.
   */
  async sweep(recover: ContinuityRecovery): Promise<AgentWaitSweepReport> {
    const report: AgentWaitSweepReport = { taken: [], deferred: [] };
    const now = Date.parse(this.ports.clock.nowIso());
    for (const wait of this.waits()) {
      const markers = this.#markers(wait);
      const step = LADDER[markers.length];
      if (step === undefined) {
        // #1189 round 2, item 1 — after its last step the wait's CRITICAL_SYSTEM_FAILURE is still its open
        // incident. Stated again on every pass while the wait lasts, it reaches a CEO generation that has not
        // had it, once; the CEO that already has it, ACKed or not, is not told again.
        this.#restateEscalation(wait, markers.at(-1)?.evidence ?? {});
        continue;
      }
      const deadlineMs = this.#deadlineOf(wait.kind);
      const from = markers.at(-1)?.at ?? wait.since;
      if (now - Date.parse(from) < deadlineMs) continue;
      if (step === AgentWaitStep.REASSIGN && wait.kind === AgentWaitKind.CONTINUITY_HOLD) await recover(wait);
      const taken = this.#takeStep(wait, step, deadlineMs, markers);
      if (taken.allowed) report.taken.push({ runId: wait.runId, kind: wait.kind, step, messageId: taken.value });
      // A wait that ended meanwhile (its recovery attempt released it, or a decision moved it) needs no step.
      else if (taken.reasonCode !== ReasonCode.RUN_TRANSITION_ILLEGAL) {
        report.deferred.push({ runId: wait.runId, kind: wait.kind, step, reasonCode: taken.reasonCode });
      }
    }
    return report;
  }

  /**
   * B6 (CEO ruling 4) — after the CEO role is recovered, each review still pending is delivered to the role's
   * current holder: a run at READY_FOR_CEO_REVIEW, for its current candidate and that candidate's packet,
   * when no CEO decision exists for them. An earlier holder's ACK says nothing about whether this holder
   * knows, so it is not what dedupes; a decision is. A review the current holder already has a notice of
   * (its own, one moved to it, or one delivered here before) is not delivered twice, and a superseded
   * candidate is never delivered. Idempotent: every pass may ask.
   */
  redeliverPendingReviews(): Array<{ runId: string; messageId: string }> {
    const delivered: Array<{ runId: string; messageId: string }> = [];
    for (const listed of this.ports.runs.list({ state: RunState.READY_FOR_CEO_REVIEW })) {
      const outcome = this.ports.db.txDecision((): Decision<string | null> => {
        const ceo = this.#ceo();
        if (!ceo) return allow(ReasonCode.OK, null);
        const run = this.ports.runs.get(listed.runId);
        const wait = run ? this.#waitOf(run) : null;
        if (!run || wait?.kind !== AgentWaitKind.CEO_REVIEW || !wait.review) return allow(ReasonCode.OK, null);
        if (this.#decided(wait)) return allow(ReasonCode.OK, null);
        if (this.#holderHasReview(run.runId, wait.review.candidateSnapshotDigest, ceo)) return allow(ReasonCode.OK, null);
        const enqueued = this.ports.outbox.enqueue({
          idempotencyKey: `ceo-review-redelivery:${run.runId}:${digestOf({
            candidateSnapshotDigest: wait.review.candidateSnapshotDigest,
            packetDigest: wait.review.packetDigest,
            generation: ceo.bindingGeneration,
            sessionId: ceo.sessionId,
          })}`,
          roleKey: ceo.roleKey,
          bindingGeneration: ceo.bindingGeneration,
          targetSessionId: ceo.sessionId,
          runId: run.runId,
          kind: MessageKind.CEO_NOTIFICATION,
          payload: { ...this.#reviewNotice(run, wait.review), redelivered: true },
        });
        if (!enqueued.allowed) return enqueued as Decision<string | null>;
        this.ports.audit.record({
          kind: CEO_REVIEW_REDELIVERED,
          runId: run.runId,
          projectId: run.projectId,
          sessionId: ceo.sessionId,
          evidence: {
            notification: NotificationKind.READY_FOR_CEO_REVIEW,
            candidateSnapshotDigest: wait.review.candidateSnapshotDigest,
            digest: wait.review.packetDigest,
            messageId: enqueued.value.messageId,
            generation: ceo.bindingGeneration,
          },
        });
        return allow(ReasonCode.OK, enqueued.value.messageId);
      });
      if (outcome.allowed && outcome.value !== null) delivered.push({ runId: listed.runId, messageId: outcome.value });
    }
    return delivered;
  }

  /**
   * B12, C2 — routes one ownerless stall to the CEO as CRITICAL_SYSTEM_FAILURE through
   * `ceo-incident-notices.ts`: once per incident episode and CEO generation, with its delivery record
   * (OWNERLESS_STALL_ROUTED). With no CEO bound (or its session not READY) nothing is written and the next
   * pass asks again. `routed` is whether this call delivered a notice; `messageId` is the notice that covers
   * the stall, delivered now or before; `state` is what the CEO has of it, in the incident `episode`.
   */
  routeOwnerlessStall(stall: OwnerlessStall): Decision<RoutedStall> {
    const incident = stallIncident(this.ports.db, stall);
    const delivered = deliverIncident(this.ports, incident);
    if (!delivered.allowed) return delivered as unknown as Decision<RoutedStall>;
    return allow(delivered.reasonCode, {
      messageId: delivered.value.messageId,
      routed: delivered.value.created,
      state: delivered.value.state,
      episode: incident.episode,
    });
  }

  /**
   * C2 — the watchdog's overdue resources, routed to the CEO. A stalled CEO notice is never routed (it is
   * already addressed to the CEO, and routing it would only add another notice to the same stuck route),
   * and the other stalled messages are routed one notice per role, keyed by that role's oldest one.
   * F3-2 — then every stall the watchdog recorded as owed (`OWNERLESS_STALL_OWED`): a stall seen once, such
   * as a reclaimed attempt, reaches the CEO when it is back, once. H3-2 — it is stated again on every pass, in
   * the incident episode it was first routed in, until it is settled, so a CEO generation that has not had it
   * is told once while it is open. It is settled when its run moved on since (F3-1's positive progress: the
   * stall cleared), or when `resolutionOf` closed its incident; its incident says so (`settlesOnProgress`), so
   * the same progress also resolves its notice wherever it is asked. H4-2 — an owed stall the watchdog found
   * on this pass is routed as owed the first time: when the run's existing notice covers it, the episode it is
   * stated in from then on is recorded at once, before any progress can move the run's episode on.
   * H5-1 — every watchdog stall of a run says so too: the watchdog states it only in its run's current episode,
   * and again in the next one if it outlasts the progress, so a run stall's notice that covered a reclaimed
   * attempt is resolved by the progress that settled both, unless an incident progress does not settle (an
   * agent-owned wait's escalation) was stated in that episode as well and is still open (H6-1: its wait lasts).
   */
  routeWatchdogStalls(stalls: readonly WatchdogStall[]): Array<{ kind: string; id: string; messageId: string | null; reasonCode: string }> {
    const routed: Array<{ kind: string; id: string; messageId: string | null; reasonCode: string }> = [];
    const oldestByRole = new Map<string, { stall: WatchdogStall; count: number; group: WatchdogStall[] }>();
    const asked = new Set<string>();
    const keyOf = (stall: WatchdogStall): string => `${stall.kind}:${stall.id}:${stall.since}`;
    const owedStalls = this.#owedStalls();
    const owedByKey = new Map(owedStalls.map(({ stall, episode }) => [keyOf(stall), { episode }]));
    const routeOne = (stall: WatchdogStall, blocker: string, recovery?: Pick<OwnerlessStall, "owner" | "recoveryAction">): void => {
      const route = WATCHDOG_STALL_ROUTES[stall.kind];
      const key = keyOf(stall);
      if (!route || asked.has(key)) return;
      asked.add(key);
      const owed = owedByKey.get(key) ?? null;
      if (owed?.episode != null && stall.runId !== null && runProgressedPast(this.ports.db, stall.runId, owed.episode)) {
        this.#settleOwed(stall, { settled: "RUN_PROGRESSED" });
        return;
      }
      const decision = this.routeOwnerlessStall({
        source: "WATCHDOG",
        kind: stall.kind,
        id: stall.id,
        episode: stall.since,
        runId: stall.runId,
        since: stall.since,
        ...(recovery ?? { owner: this.#stallOwner(stall), recoveryAction: route.recoveryAction }),
        blocker,
        effects: route.effects,
        deliveryTimeout: stall.kind === "outbox",
        ...(owed?.episode != null ? { incidentEpisode: owed.episode } : {}),
        settlesOnProgress: true,
      });
      if (owed && decision.allowed) {
        if (decision.value.state === "RESOLVED") {
          this.#settleOwed(stall, { settled: "RESOLVED" });
        } else if (owed.episode === null && !decision.value.routed) {
          // Its run's notice for this episode already covers it: the episode it is stated in from now on.
          this.#settleOwed(stall, { covered: true, messageId: decision.value.messageId, episode: decision.value.episode });
        }
      }
      routed.push({
        kind: stall.kind,
        id: stall.id,
        messageId: decision.allowed && decision.value.routed ? decision.value.messageId : null,
        reasonCode: decision.reasonCode,
      });
    };
    for (const stall of stalls) {
      if (stall.kind === "outbox") {
        if (stall.messageKind === MessageKind.CEO_NOTIFICATION) continue;
        const role = stall.roleKey ?? "unknown";
        const held = oldestByRole.get(role);
        if (!held) oldestByRole.set(role, { stall, count: 1, group: [stall] });
        else {
          held.group.push(stall);
          oldestByRole.set(role, { stall: Date.parse(stall.since) < Date.parse(held.stall.since) ? stall : held.stall, count: held.count + 1, group: held.group });
        }
        continue;
      }
      routeOne(stall, `${WATCHDOG_STALL_ROUTES[stall.kind]?.what ?? stall.kind}: ${stall.kind} ${stall.id}, since ${stall.since}`);
    }
    for (const [role, { stall, count, group }] of oldestByRole) {
      routeOne(stall, `${count} ${WATCHDOG_STALL_ROUTES["outbox"]!.what} to ${role}; the oldest is ${stall.id}, since ${stall.since}`,
        this.#deliveryRecovery(group));
    }
    for (const { stall: owed } of owedStalls) {
      routeOne(owed, `${WATCHDOG_STALL_ROUTES[owed.kind]?.what ?? owed.kind}: ${owed.kind} ${owed.id}, since ${owed.since}`);
    }
    return routed;
  }

  /**
   * The owed stalls not settled yet, each with the incident episode it was first routed in (null before that).
   * A stall whose routed records name no episode was routed before episodes were recorded, and is answered, as
   * it was then.
   */
  #owedStalls(): Array<{ stall: WatchdogStall; episode: string | null }> {
    const sameStall = (alias: string): string => `${alias}.kind = '${OWNERLESS_STALL_ROUTED}'
      AND json_extract(${alias}.evidence_json, '$.kind') = json_extract(owed.evidence_json, '$.kind')
      AND json_extract(${alias}.evidence_json, '$.target') = json_extract(owed.evidence_json, '$.target')
      AND json_extract(${alias}.evidence_json, '$.since') = json_extract(owed.evidence_json, '$.since')`;
    return this.ports.db.all<{ run_id: string | null; evidence_json: string; episode: string | null; routed: number }>(
      `SELECT owed.run_id, owed.evidence_json,
              (SELECT json_extract(pin.evidence_json, '$.episode') FROM audit_events pin
                WHERE ${sameStall("pin")} AND json_extract(pin.evidence_json, '$.episode') IS NOT NULL
                ORDER BY pin.event_id LIMIT 1) AS episode,
              EXISTS (SELECT 1 FROM audit_events any_route WHERE ${sameStall("any_route")}) AS routed
        FROM audit_events owed
        WHERE owed.kind = ?
          AND NOT EXISTS (SELECT 1 FROM audit_events settled WHERE ${sameStall("settled")}
                            AND json_extract(settled.evidence_json, '$.settled') IS NOT NULL)
        ORDER BY owed.event_id`,
      [OWNERLESS_STALL_OWED],
    ).flatMap((row) => {
      const evidence = evidenceOf(row.evidence_json) ?? {};
      const [kind, id, since] = [evidence["kind"], evidence["target"], evidence["since"]];
      if (typeof kind !== "string" || typeof id !== "string" || typeof since !== "string") return [];
      if (row.routed === 1 && row.episode === null) return [];
      return [{ stall: { kind, id, runId: row.run_id, since }, episode: row.episode }];
    });
  }

  /** An owed stall's own routed record: the episode it is stated in, or why it is settled. */
  #settleOwed(stall: WatchdogStall, outcome: Record<string, unknown>): void {
    this.ports.audit.record({
      kind: OWNERLESS_STALL_ROUTED,
      runId: stall.runId,
      evidence: { source: "WATCHDOG", kind: stall.kind, target: stall.id, since: stall.since, ...outcome },
    });
  }

  /**
   * The recovery of one role's stalled messages, which share one notice: every recovery their kinds need.
   * Undefined when none is holder-claimed, which keeps the route's retry. With only holder-claimed ones, the
   * claim of the oldest of them; with both, the retry for the pushed ones and the claim for the holder-claimed
   * ones, each naming its messages, and the session and generation are the holder-claimed row's.
   */
  #deliveryRecovery(group: readonly WatchdogStall[]): Pick<OwnerlessStall, "owner" | "recoveryAction"> | undefined {
    const isHeld = (stall: WatchdogStall): boolean => (HOLDER_CLAIMED_KINDS as ReadonlySet<string>).has(stall.messageKind ?? "");
    const held = group.filter(isHeld);
    if (held.length === 0) return undefined;
    const claim = this.#holderClaimedStall(held.reduce((a, b) => Date.parse(b.since) < Date.parse(a.since) ? b : a));
    const pushed = group.filter((stall) => !isHeld(stall));
    if (pushed.length === 0) return claim;
    const named = (stalls: readonly WatchdogStall[]): string =>
      `${stalls.length} (${stalls.slice(0, 10).map((stall) => stall.id).join(", ")}${stalls.length > 10 ? `, and ${stalls.length - 10} more` : ""})`;
    return {
      owner: claim.owner,
      recoveryAction: `pushed messages ${named(pushed)}: ${WATCHDOG_STALL_ROUTES["outbox"]!.recoveryAction}. ` +
        `Holder-claimed messages ${named(held)}: ${claim.recoveryAction}`,
    };
  }

  /**
   * A stalled message of a holder-claimed kind (`HOLDER_CLAIMED_KINDS`) is never pushed: the delivery pass
   * does not pick it up and a delivery retry cannot deliver it, so its recovery is its receiving session's
   * claim. It names the session and binding generation the row is addressed to, and whether that session is
   * live.
   */
  #holderClaimedStall(stall: WatchdogStall): Pick<OwnerlessStall, "owner" | "recoveryAction"> {
    const row = this.ports.db.get<{ role_key: string; binding_generation: number; target_session_id: string; lifecycle: string | null }>(
      `SELECT o.role_key, o.binding_generation, o.target_session_id, s.lifecycle
         FROM outbox o LEFT JOIN sessions s ON s.session_id = o.target_session_id
        WHERE o.message_id = ?`,
      [stall.id],
    );
    const role = row?.role_key ?? stall.roleKey ?? null;
    const claim = `the receiving session claims it (role_owner_message_claim); if its relay or attachment is gone, ` +
      `it reconnects and then claims it. A ${stall.messageKind} is delivered only by its holder's claim, never by the ` +
      `delivery pass, so a delivery retry cannot deliver it; a delivery timeout does not fail the run`;
    if (!row) return { owner: { role, sessionId: null, generation: null }, recoveryAction: `${claim}. Its row is no longer readable` };
    const current = this.ports.bindings.active(row.role_key);
    const isCurrent = current?.bindingGeneration === row.binding_generation && current.sessionId === row.target_session_id;
    const ready = row.lifecycle === "READY" || row.lifecycle === "DRAINING";
    const liveness = ready && isCurrent
      ? `live (${row.lifecycle}, the role's current binding)`
      : `not live (session ${row.lifecycle ?? "unknown"}; ${current
        ? `the role's current binding is generation ${current.bindingGeneration}, session ${current.sessionId}`
        : "the role has no current binding"})`;
    return {
      owner: { role: row.role_key, sessionId: row.target_session_id, generation: row.binding_generation },
      recoveryAction: `${claim}. It is addressed to session ${row.target_session_id} at binding generation ` +
        `${row.binding_generation} of ${row.role_key}, which is ${liveness}`,
    };
  }

  #stallOwner(stall: WatchdogStall): OwnerlessStall["owner"] {
    if (stall.kind === "outbox") return { role: stall.roleKey ?? null, sessionId: null, generation: null };
    if (stall.kind === "session") return { role: null, sessionId: stall.id, generation: null };
    const run = stall.runId ? this.ports.runs.get(stall.runId) : null;
    return { role: run?.ownerRoleKey ?? null, sessionId: run?.ownerSessionId ?? null, generation: run?.ownerBindingGeneration ?? null };
  }

  #deadlineOf(kind: AgentWaitKind): number {
    const byKind: Record<AgentWaitKind, number> = {
      [AgentWaitKind.ESCALATION]: this.deadlines.escalationMs,
      [AgentWaitKind.CEO_REVIEW]: this.deadlines.ceoReviewMs,
      [AgentWaitKind.REVISION]: this.deadlines.revisionMs,
      [AgentWaitKind.CONTINUITY_HOLD]: this.deadlines.continuityHoldMs,
    };
    return byKind[kind];
  }

  #ceo(): RoleBinding | null {
    return this.ports.bindings.active(roleKeyFor(Role.CEO));
  }

  /** The wait `run` is in, read from the RUN_TRANSITION that entered its current state (`runStateEntry`), or null. */
  #waitOf(run: RunRow): AgentWait | null {
    const entered = runStateEntry(this.ports.db, run);
    if (!entered) return null;
    const transition = entered.evidence;
    const base = { runId: run.runId, projectId: run.projectId, episode: entered.eventId, since: entered.at };
    if (run.state === RunState.READY_FOR_CEO_REVIEW) {
      const review = this.#currentReview(run.runId);
      return {
        ...base,
        kind: AgentWaitKind.CEO_REVIEW,
        owner: Role.CEO,
        ...(review ? { review } : {}),
        recoveryAction:
          "ceo_decision_submit CONFIRM or FINAL_REVISE for the current candidate; OWNER_DECISION_REQUIRED only with an owner-only reason",
        blocker: `the run waits at READY_FOR_CEO_REVIEW for a CEO decision on candidate ${review?.candidateSnapshotDigest ?? "unknown"}`,
      };
    }
    if (run.state === RunState.REVISION_REQUIRED) {
      return {
        ...base,
        kind: AgentWaitKind.REVISION,
        owner: Role.CEO,
        recoveryAction: "run_dispatch the run so its CTO revises it, or run_cancel",
        blocker: "the run is REVISION_REQUIRED after the CEO's FINAL_REVISE and has not been dispatched again",
      };
    }
    const held = run.state === RunState.BLOCKED
      ? run.continuityHoldRoleKey ?? null
      : run.state === RunState.AWAITING_HUMAN && transition["continuityAction"] === "PAUSE_NEW_WORK"
        ? (typeof transition["continuityHold"] === "string" ? transition["continuityHold"] : "the role continuity paused it for")
        : null;
    if (held !== null) {
      return {
        ...base,
        kind: AgentWaitKind.CONTINUITY_HOLD,
        owner: held,
        recoveryAction:
          `continuity releases the hold once ${held} is covered again; otherwise give the role a covered holder (cto_replace), or run_cancel`,
        blocker: `${held} is not covered, and continuity holds the run ${run.state} for it`,
      };
    }
    if (run.state !== RunState.BLOCKED) return null;
    // A BLOCKED run with no open escalation is held by something else (an owner's project suspension, B8),
    // which is not an agent's wait.
    const open = this.ports.gate.openEscalationOf(run.runId);
    if (!open) return null;
    const opened = evidenceOf(this.ports.db.get<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE event_id = ?`,
      [open.escalationId],
    )?.evidence_json) ?? {};
    return {
      ...base,
      kind: AgentWaitKind.ESCALATION,
      owner: Role.CEO,
      escalation: {
        escalationId: open.escalationId,
        question: opened["question"] ?? null,
        options: opened["options"] ?? null,
        recommendation: opened["recommendation"] ?? null,
        blocksCriticalPath: opened["blocksCriticalPath"] ?? true,
      },
      recoveryAction: `escalation_resolve escalation ${open.escalationId}, or run_cancel`,
      blocker: `the run is BLOCKED on CTO escalation ${open.escalationId} (CEO_DECISION_REQUIRED)`,
    };
  }

  /** The run's current candidate and that candidate's production-ready packet, or null. */
  #currentReview(runId: string): AgentWait["review"] | null {
    const candidate = this.ports.runs.currentCandidate(runId);
    if (!candidate) return null;
    const packet = this.ports.artifacts.latestForSnapshot(runId, ArtifactKind.PRODUCTION_READY_PACKET, candidate);
    return packet ? { candidateSnapshotDigest: candidate, packetDigest: packet.digest } : null;
  }

  /** Whether a CEO decision exists for the review's candidate since its packet put the run at review. */
  #decided(wait: AgentWait): boolean {
    return Boolean(this.ports.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION' AND event_id > ?
         AND json_extract(evidence_json, '$.candidateSnapshotDigest') = ? LIMIT 1`,
      [wait.runId, wait.episode, wait.review?.candidateSnapshotDigest ?? ""],
    ));
  }

  /** Whether the CEO role's current holder already has a review notice of this candidate, in any live or ACKed state. */
  #holderHasReview(runId: string, candidate: string, ceo: RoleBinding): boolean {
    return Boolean(this.ports.db.get<{ n: number }>(
      `SELECT 1 AS n FROM outbox WHERE run_id = ? AND kind = 'CEO_NOTIFICATION' AND role_key = ?
         AND binding_generation = ? AND target_session_id = ?
         AND status IN ('PENDING','IN_FLIGHT','SENT','ACKED')
         AND json_extract(payload_json, '$.notification') = ?
         AND json_extract(payload_json, '$.candidateSnapshotDigest') = ? LIMIT 1`,
      [runId, ceo.roleKey, ceo.bindingGeneration, ceo.sessionId, NotificationKind.READY_FOR_CEO_REVIEW, candidate],
    ));
  }

  #reviewNotice(run: RunRow, review: NonNullable<AgentWait["review"]>): Record<string, unknown> {
    return {
      notification: NotificationKind.READY_FOR_CEO_REVIEW,
      runId: run.runId,
      goal: run.goal,
      candidateSnapshotDigest: review.candidateSnapshotDigest,
      packetDigest: review.packetDigest,
      humanGate: this.ports.gate.humanGateStatus(run.runId),
    };
  }

  #markers(wait: AgentWait): Array<{ at: string; evidence: Record<string, unknown> }> {
    return this.ports.db.all<{ at: string; evidence_json: string }>(
      `SELECT at, evidence_json FROM audit_events WHERE run_id = ? AND kind = ?
         AND json_extract(evidence_json, '$.episode') = ? ORDER BY event_id`,
      [wait.runId, AGENT_WAIT_DEADLINE, wait.episode],
    ).map((row) => ({ at: row.at, evidence: evidenceOf(row.evidence_json) ?? {} }));
  }

  /**
   * One step, in one transaction with its record: the wait is read again and must be the same episode
   * with the same steps taken, so a run that moved since the pass read it, or a step another pass took,
   * writes nothing.
   */
  #takeStep(
    listed: AgentWait,
    step: AgentWaitStep,
    deadlineMs: number,
    listedMarkers: ReadonlyArray<{ evidence: Record<string, unknown> }>,
  ): Decision<string | null> {
    return this.ports.db.txDecision((): Decision<string | null> => {
      const run = this.ports.runs.get(listed.runId);
      const wait = run ? this.#waitOf(run) : null;
      if (!run || !wait || wait.kind !== listed.kind || wait.episode !== listed.episode) {
        return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "the wait ended before its deadline step", { runId: listed.runId });
      }
      if (this.#markers(wait).length !== listedMarkers.length) {
        return deny(ReasonCode.CONFLICT, "the deadline step was already taken", { runId: wait.runId });
      }
      let messageId: string | null = null;
      let holder: { generation: number; sessionId: string } | null = null;
      let reassigned: boolean | null = null;
      let incidentEpisode: string | null = null;
      const recovery = step === AgentWaitStep.REASSIGN && wait.kind === AgentWaitKind.CONTINUITY_HOLD;
      if (step === AgentWaitStep.CEO_ESCALATION) {
        // The wait's CRITICAL_SYSTEM_FAILURE is its run's RUN_STALLED incident: one notice per unchanged run,
        // whichever detector told the CEO first, delivered and deduplicated in `ceo-incident-notices.ts`.
        const ceo = this.#ceo();
        if (!ceo) return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive the wait's notice", { runId: wait.runId });
        incidentEpisode = runEpisode(this.ports.db, wait.runId);
        const delivered = deliverIncident(this.ports, this.#waitIncident(run, wait, deadlineMs, incidentEpisode));
        if (!delivered.allowed) return delivered as unknown as Decision<string | null>;
        messageId = delivered.value.messageId;
        holder = { generation: ceo.bindingGeneration, sessionId: ceo.sessionId };
      } else if (!recovery) {
        const ceo = this.#ceo();
        if (!ceo) return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive the wait's notice", { runId: wait.runId });
        const enqueued = this.ports.outbox.enqueue({
          idempotencyKey: `agent-wait:${wait.runId}:${wait.episode}:${step}`,
          roleKey: ceo.roleKey,
          bindingGeneration: ceo.bindingGeneration,
          targetSessionId: ceo.sessionId,
          runId: wait.runId,
          kind: MessageKind.CEO_NOTIFICATION,
          payload: this.#noticeOf(run, wait, step, deadlineMs),
        });
        if (!enqueued.allowed) return enqueued as unknown as Decision<string | null>;
        messageId = enqueued.value.messageId;
        holder = { generation: ceo.bindingGeneration, sessionId: ceo.sessionId };
        if (step === AgentWaitStep.REASSIGN) {
          const told = listedMarkers[0]?.evidence ?? {};
          reassigned = told["generation"] !== ceo.bindingGeneration || told["sessionId"] !== ceo.sessionId;
        }
      }
      this.ports.audit.record({
        kind: AGENT_WAIT_DEADLINE,
        reasonCode: ReasonCode.OK,
        runId: wait.runId,
        projectId: wait.projectId,
        evidence: {
          waitKind: wait.kind,
          step,
          episode: wait.episode,
          startedAt: wait.since,
          deadlineMs,
          owner: wait.owner,
          action: recovery ? "CONTINUITY_RECONCILE" : step === AgentWaitStep.CEO_ESCALATION ? NotificationKind.CRITICAL_SYSTEM_FAILURE : "NOTIFY",
          messageId,
          ...(holder ? { generation: holder.generation, sessionId: holder.sessionId } : {}),
          ...(reassigned === null ? {} : { reassigned }),
          ...(recovery ? { released: false } : {}),
          ...(incidentEpisode === null ? {} : { incidentEpisode }),
        },
      });
      return allow(ReasonCode.OK, messageId);
    });
  }

  /** The wait's CRITICAL_SYSTEM_FAILURE, stated again in the episode its CEO_ESCALATION step opened it in. */
  #restateEscalation(wait: AgentWait, escalated: Record<string, unknown>): void {
    const [episode, deadlineMs] = [escalated["incidentEpisode"], escalated["deadlineMs"]];
    const run = this.ports.runs.get(wait.runId);
    if (!run || typeof episode !== "string" || typeof deadlineMs !== "number") return;
    deliverIncident(this.ports, this.#waitIncident(run, wait, deadlineMs, episode));
  }

  /** The wait's CEO_ESCALATION notice as its run's RUN_STALLED incident, stated for the wait while it lasts (H6-1). */
  #waitIncident(run: RunRow, wait: AgentWait, deadlineMs: number, episode: string): Incident {
    const step = AgentWaitStep.CEO_ESCALATION;
    const { notification: _notification, runId: _runId, ...notice } = this.#noticeOf(run, wait, step, deadlineMs);
    return {
      cls: IncidentClass.RUN_STALLED,
      subject: wait.runId,
      runId: wait.runId,
      episode,
      waitEpisode: wait.episode,
      payload: notice,
      record: { waitKind: wait.kind, step, owner: wait.owner, action: wait.recoveryAction, detail: wait.blocker, productFailure: false },
    };
  }

  #noticeOf(run: RunRow, wait: AgentWait, step: AgentWaitStep, deadlineMs: number): Record<string, unknown> {
    const deadline = {
      waitKind: wait.kind,
      step,
      waitingSince: wait.since,
      deadlineMs,
      owner: wait.owner,
      recoveryAction: wait.recoveryAction,
      blocker: wait.blocker,
      productFailure: false,
    };
    if (step === AgentWaitStep.CEO_ESCALATION) {
      return { notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, runId: wait.runId, ...deadline };
    }
    if (wait.kind === AgentWaitKind.CEO_REVIEW && wait.review) return { ...this.#reviewNotice(run, wait.review), ...deadline };
    if (wait.kind === AgentWaitKind.ESCALATION && wait.escalation) {
      return { notification: NotificationKind.TRUE_ESCALATION, runId: wait.runId, ...wait.escalation, ...deadline };
    }
    return {
      notification: NotificationKind.TRUE_ESCALATION,
      runId: wait.runId,
      question: wait.blocker,
      recommendation: wait.recoveryAction,
      blocksCriticalPath: true,
      ...deadline,
    };
  }
}
