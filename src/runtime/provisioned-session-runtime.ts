import { frontierReviewPolicy } from "../review/frontier-simplify-policy.ts";
import { MCP_MUTATION_RECOVERY } from "../core/mcp-recovery.ts";
import { randomUUID } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { fixedRuntimes } from "../domain/fixed-role-runtime.ts";
import { Role, type RoleBinding, RunKind, SessionLifecycle } from "../domain/types.ts";
import { HOLDER_CLAIMED_KINDS } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionAttestations } from "../session/session-attestations.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";
import type {
  ConversationStep,
  ProviderAdapter,
  ProviderRegistry,
  SessionHandle,
  SessionRelayRoute,
  SessionTurnResult,
} from "./provider.ts";

/**
 * The daemon's take-once launch channel, as the runtime driver uses it: open it, offer one
 * session's credential for exactly one turn, and take back whatever that turn's relay did not.
 */
export interface SessionCredentialDelivery {
  prepare(): Promise<Decision<void>>;
  provision(input: SessionLaunchCredential): Promise<Decision<void>>;
  /** True when the credential was still there to withdraw: the turn's relay never took it. */
  withdraw(externalSessionId: string): boolean;
}

export interface ProvisionedSessionRuntimePorts {
  readonly providers: Pick<ProviderRegistry, "requireForRole">;
  readonly sessions: Pick<SessionRegistry, "get">;
  readonly bindings: Pick<BindingRegistry, "active">;
  readonly attestations: SessionAttestations;
  readonly audit: AuditLog;
  /**
   * Where an in-band envelope's settlement is read. A trigger that names an outbox row is done when
   * that row has left PENDING — acknowledged over the authenticated relay, or rejected or expired —
   * and not when a turn for it exited 0.
   */
  readonly outbox: Pick<Outbox, "get" | "drivenModeOf" | "drivenSpawnRecordOf" | "hasHolderMessagesFor">;
  /**
   * #512 — where a turn's in-band envelope's run is read, so that the STANDARD_WORK directive is
   * written only into a turn that concerns a STANDARD_WORK run (CEO 07b5b0df).
   */
  readonly runs: Pick<RunEngine, "get">;
}

export interface ProvisionedSessionRuntimeOptions {
  turnTimeoutMs?: number;
}

/** What a turn is for; each has its own conditions, read again immediately before the provider call. */
export type TurnPurpose = "attestation" | "probe" | "work";

/**
 * #246 C4 — the one spawn attestation a driven PRIMARY_CTO's own spawn runs. It is the only thing
 * that lets a turn run for a session not yet bound (`PENDING`), and every field must equal the
 * current state exactly: the purpose it permits, the project and role key and the creation
 * generation its spawn record names, and the session row, incarnation and credential epoch the spawn
 * created. No partial match counts — an incarnation is not unique, and only the session id names one
 * row. No actor or assignment exists yet to name: the bind mints them after READY, as the assignment
 * at this role key and creation generation, and the bind re-checks that assignment and its actor.
 */
export interface SpawnAttestation {
  purpose: "spawn-attestation";
  projectId: string;
  roleKey: string;
  sessionId: string;
  incarnation: string;
  credentialEpoch: number;
  creationGeneration: number;
}

/** What a session's one driven-spawn record names, if it has exactly one. */
export interface DrivenSpawnRecord {
  projectId: string | null;
  roleKey: string | null;
  creationGeneration: number | null;
}

/** One reason a role's session is woken; `id` is what makes a second wake for it a duplicate. */
export interface SessionWakeTrigger {
  id: string;
  kind: string;
  /**
   * A trigger caused by a verified Buzz mention carries the mention's gate: whether the mention's
   * identity, role and room still stand behind the role's current holder. A bootstrap PLAN recovery
   * trigger carries its own: whether its run still needs a PLAN from that exact owner; a bootstrap
   * result recovery trigger, whether its run still needs a result for that PLAN from that exact
   * owner. It is asked again at the turn's final check, immediately before the provider call, and a
   * turn none of whose triggers still holds is refused there. Absent on every other trigger, which
   * the final check never asks.
   */
  stillAdmissible?: () => boolean;
  /**
   * For a mention's trigger: whether the work it stands for was taken up, which for a mention is
   * whether its event is spent. Read when its turn has ended: such a trigger is marked handled only
   * when this answers true; otherwise it is released, as a refused turn's are. Read again when a
   * wake names it, and at its turn's final check before the provider call: a true answer refuses
   * it as a duplicate, however its event came to be spent.
   */
  served?: () => boolean;
}

/** The roles all of whose sessions this runtime drives: a run's BOOTSTRAP_CTO. Never a canonical role. */
const DRIVEN_ROLES: ReadonlySet<Role> = new Set([Role.BOOTSTRAP_CTO]);

/**
 * #246 C4 — the audit kind that records a PRIMARY_CTO session spawned, for a bootstrap activation,
 * to be driven by this runtime. Written by `CtoLifecycle.spawn` in the transaction that creates the
 * session row, before its credential is adopted or anything can refuse it, and attributed there to
 * its project (`project_id`), role key (`role_key`), session (`session_id`) and the binding
 * generation it is created for (`evidence.creationGeneration`). The actor does not exist yet in that
 * transaction — the bind mints it after the session is READY — so the record names the creation
 * assignment instead, and that immutable row (`assignments_generation_immutable`) carries the actor.
 *
 * It proves the driving mode and nothing else: execution still needs the ACTIVE binding, a READY
 * session and a current attestation. `audit_events` is append only (`audit_events_append_only`,
 * `audit_events_no_delete`), so the fact can neither be added later nor taken back.
 *
 * An append-only spawn record rather than a new column or the shape of the session's workdir: the
 * schema is not changed for this, and a path is not a fact anybody recorded.
 */
export const DRIVEN_PRIMARY_CTO_SPAWN_RECORD = "PRIMARY_CTO_DRIVEN_SESSION_SPAWNED";

/**
 * What a session's spawn record says about driving it, read the same way by every reader.
 *
 * - `NONE`: no record. Never driven here; an interactive or canonical CTO's own path.
 * - `PENDING`: exactly one record, and the session holds no binding and its creation generation has
 *   not been granted yet: spawned driven, not yet bound. Only the spawn's own custody accepts it.
 * - `DRIVEN`: exactly one record; the creation assignment it names (role key, creation generation)
 *   was granted to this very session in its project; and the role's ACTIVE binding is held by this
 *   session for that assignment's actor, at the creation generation or a later one. A credential
 *   epoch change touches none of that, and neither does a renewal on the same session and actor.
 * - `CONTRADICTED`: a record that is anything else — a second one, another session's creation,
 *   another generation, another project, a session that no longer holds the role. Every reader
 *   fails closed on it: it is neither driven nor taken for interactive.
 */
export type DrivenMode = "NONE" | "PENDING" | "DRIVEN" | "CONTRADICTED";

/** SQL: the `DrivenMode` of the session `sessionExpr` names. */
export const drivenModeSql = (sessionExpr: string): string => `(CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM audit_events dm_any
     WHERE dm_any.kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}' AND dm_any.session_id = ${sessionExpr}
  ) THEN 'NONE'
  WHEN (
    SELECT COUNT(*) FROM audit_events dm_n
     WHERE dm_n.kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}' AND dm_n.session_id = ${sessionExpr}
  ) <> 1 THEN 'CONTRADICTED'
  WHEN EXISTS (
    SELECT 1 FROM audit_events dm
      JOIN assignments dm_c
        ON dm_c.role_key = dm.role_key
       AND dm_c.binding_generation = json_extract(dm.evidence_json, '$.creationGeneration')
       AND dm_c.role = 'PRIMARY_CTO'
       AND dm_c.project_id = dm.project_id
       AND dm_c.session_id = dm.session_id
      JOIN assignments dm_a
        ON dm_a.role_key = dm.role_key
       AND dm_a.status = 'ACTIVE'
       AND dm_a.actor_id = dm_c.actor_id
       AND dm_a.binding_generation >= dm_c.binding_generation
      LEFT JOIN conversational_actors dm_h ON dm_h.actor_id = dm_a.actor_id
     WHERE dm.kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}' AND dm.session_id = ${sessionExpr}
       AND COALESCE(dm_h.current_session_id, dm_a.session_id) = dm.session_id
  ) THEN 'DRIVEN'
  WHEN EXISTS (
    SELECT 1 FROM audit_events dm
     WHERE dm.kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}' AND dm.session_id = ${sessionExpr}
       AND dm.project_id IS NOT NULL
       AND dm.role_key = 'PRIMARY_CTO:' || dm.project_id
       AND json_type(dm.evidence_json, '$.creationGeneration') = 'integer'
       AND NOT EXISTS (SELECT 1 FROM assignments dm_x WHERE dm_x.session_id = dm.session_id)
       AND NOT EXISTS (SELECT 1 FROM conversational_actors dm_y WHERE dm_y.current_session_id = dm.session_id)
       AND NOT EXISTS (
         SELECT 1 FROM assignments dm_z
          WHERE dm_z.role_key = dm.role_key
            AND dm_z.binding_generation >= json_extract(dm.evidence_json, '$.creationGeneration')
       )
  ) THEN 'PENDING'
  ELSE 'CONTRADICTED'
END)`;

/** What the session's one driven-spawn record names, or null when it has none or more than one. */
export const drivenSpawnRecordOf = (db: Pick<Db, "all">, sessionId: string): DrivenSpawnRecord | null => {
  const records = db.all<{ project_id: string | null; role_key: string | null; generation: unknown }>(
    `SELECT project_id, role_key, json_extract(evidence_json, '$.creationGeneration') AS generation
       FROM audit_events WHERE kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}' AND session_id = ?`,
    [sessionId],
  );
  const [only] = records;
  if (records.length !== 1 || !only) return null;
  return {
    projectId: only.project_id,
    roleKey: only.role_key,
    creationGeneration: typeof only.generation === "number" ? only.generation : null,
  };
};

/** `drivenModeSql` for one session id. */
export const drivenModeOf = (db: Pick<Db, "get">, sessionId: string): DrivenMode =>
  db.get<{ mode: DrivenMode }>(`SELECT ${drivenModeSql("q.sid")} AS mode FROM (SELECT ? AS sid) q`, [sessionId])
    ?.mode ?? "CONTRADICTED";

interface HeldCredential {
  role: Role;
  sessionSecret: string;
  credentialEpoch: number;
}

interface TurnLane {
  /** The turn running now, and every one queued behind it; never two at once. */
  tail: Promise<unknown>;
  /** How many serialized operations are running or queued. */
  pending: number;
  /** The role key the session was last woken for; a coalesced follow-up turn is run for it. */
  roleKey: string | null;
  /** Triggers that arrived while a turn ran; they are served together by one follow-up turn. */
  coalesced: SessionWakeTrigger[];
  /**
   * Triggers queued (coalesced) or in the turn running now. A wake for one is refused: it would be a
   * second turn for work already on its way. Released when its turn ends, however it ended.
   */
  claimed: Set<string>;
  /**
   * Triggers that name no outbox row (an owner-message wake) whose turn completed: never run again.
   * An envelope trigger is never here: whether it is done is the outbox row's status, read at each
   * wake, so one a completed turn left PENDING — the model made no tool call, or its relay never
   * took the credential — is run again by the outbox's re-wake (review ROUND1-ESCAPE-01), and one a
   * failed turn left PENDING is too (review ACP-C1B-01).
   */
  handled: Set<string>;
}

/**
 * #246 C1b — drives a provisioned (non-canonical) CTO session's real headless runtime: the daemon's
 * one source of its turns, the holder of its credential, and the judge of its readiness.
 *
 * - **One conversation.** Every turn is a turn of the session's own provider conversation, in the
 *   session's fixed workdir. The caller says whether a turn opens it (`"new"`, the spawn's
 *   attestation) or continues it (`"resume"`, everything after), and the adapter passes exactly that.
 * - **The credential never travels as data.** The daemon keeps the plaintext in memory, offers it on
 *   the take-once launch channel for the length of one turn, and withdraws whatever that turn's
 *   relay did not take. Argv carries socket paths and the provider's conversation id; nothing else.
 * - **Readiness is authenticated.** `attest` checks the current credential and runtime liveness
 *   directly. The first work turn opens the conversation; readiness consumes no model turn.
 * - **Serialized.** A session runs one turn at a time. A wake that arrives while a turn runs is
 *   coalesced into one follow-up turn; a wake for a trigger queued or running is refused
 *   `SESSION_TURN_DUPLICATE`, and so is one for an envelope already settled, for an owner-message
 *   trigger a turn completed, or for a mention whose event is already spent. **Settled is the
 *   outbox's word, not the CLI's:** a turn that exited 0 without acknowledging its envelope
 *   settled nothing, so when its turn ends, however it ended, a
 *   still-PENDING envelope is released for the next wake that names it. That wake is the outbox's
 *   own re-wake, at most once per row per `IN_BAND_REWAKE_MS` and never past the row's TTL, so
 *   unacknowledged work is retried at that pace and never in a loop here. Turns start only from
 *   the existing event paths (an in-band dispatch, an owner message, a wake) and from the control
 *   plane's own spawn and recovery, the daemon's once-per-dispatch bootstrap PLAN recovery wake and
 *   once-per-PLAN bootstrap result recovery wake included; there is no timer here.
 *
 * In memory only: a restarted daemon holds no credential, and a session it holds none for cannot
 * run a turn until its credential is rotated and delivered again.
 */
export class ProvisionedSessionRuntime {
  #delivery: SessionCredentialDelivery | null = null;
  #route: SessionRelayRoute | null = null;
  readonly #held = new Map<string, HeldCredential>();
  /** Conversations not opened by a work turn yet; readiness no longer opens them. */
  readonly #newConversations = new Set<string>();
  readonly #lanes = new Map<string, TurnLane>();

  constructor(
    private readonly ports: ProvisionedSessionRuntimePorts,
    private readonly options: ProvisionedSessionRuntimeOptions = {},
  ) {}

  /**
   * Whether every session of this role is driven here (a run's BOOTSTRAP_CTO). A PRIMARY_CTO is
   * driven per session, never per role: ask `drivesSession`.
   */
  static drives(role: Role): boolean {
    return DRIVEN_ROLES.has(role);
  }

  /**
   * Whether this runtime drives `sessionId` holding `role`: every BOOTSTRAP_CTO, and a PRIMARY_CTO
   * only when its spawn record makes it `DRIVEN` — a missing or contradicted record never does.
   */
  /** #246 C4 — the session's `DrivenMode`, read as the outbox reads it. */
  drivenModeOf(sessionId: string): DrivenMode {
    return this.ports.outbox.drivenModeOf(sessionId);
  }

  drivesSession(sessionId: string, role: Role): boolean {
    if (DRIVEN_ROLES.has(role)) return true;
    return role === Role.PRIMARY_CTO && this.ports.outbox.drivenModeOf(sessionId) === "DRIVEN";
  }

  /**
   * #246 C4 — whether a turn for `purpose` may run on this session now, read from current state and
   * never carried over from an earlier answer: `#turn` asks it immediately before the provider call,
   * after every awaited preparation; `wake` and `attest` ask it first, so a refusal costs nothing;
   * and `attest` asks it once more before it counts the turn.
   *
   * A session with no driven-spawn record (a run's BOOTSTRAP_CTO) keeps the contract C1b shipped and
   * is answered yes. A driven PRIMARY_CTO's turn needs its record to be `DRIVEN` — the current
   * creation and actor, holding the role's ACTIVE binding — and a READY or DRAINING session; work
   * uses the held current credential. The one exception is `PENDING`: only readiness for a new
   * conversation, carrying the exact `SpawnAttestation` of the spawn that created this STARTING
   * session, may run on it. No work, no probe, and no other session or spawn.
   */
  turnEligibility(
    sessionId: string,
    purpose: TurnPurpose,
    conversation: ConversationStep = "resume",
    spawn: SpawnAttestation | null = null,
  ): Decision<void> {
    const mode = this.ports.outbox.drivenModeOf(sessionId);
    if (mode === "NONE" && spawn === null) return allow(ReasonCode.OK, undefined);
    const session = this.ports.sessions.get(sessionId);
    const refuse = (reasonCode: ReasonCode, message: string): Decision<void> =>
      deny(reasonCode, message, { sessionId, purpose, drivenMode: mode, lifecycle: session?.lifecycle ?? null });
    if (!session) return refuse(ReasonCode.NOT_FOUND, "unknown session");
    if (mode === "PENDING") {
      const record = this.ports.outbox.drivenSpawnRecordOf(sessionId);
      const own = spawn !== null && record !== null && purpose === "attestation" && conversation === "new" &&
        session.lifecycle === SessionLifecycle.STARTING &&
        spawn.purpose === "spawn-attestation" &&
        spawn.projectId === record.projectId &&
        spawn.roleKey === record.roleKey &&
        spawn.sessionId === sessionId &&
        spawn.incarnation === session.incarnation &&
        spawn.credentialEpoch === session.credentialEpoch &&
        spawn.creationGeneration === record.creationGeneration;
      return own
        ? allow(ReasonCode.OK, undefined)
        : refuse(ReasonCode.CONFLICT, "a driven session not yet bound runs only the attestation of the spawn that created it");
    }
    if (mode !== "DRIVEN" || spawn !== null) {
      return refuse(ReasonCode.CONFLICT, "the session's driven-spawn record does not name a binding it holds");
    }
    if (session.lifecycle !== SessionLifecycle.READY && session.lifecycle !== SessionLifecycle.DRAINING) {
      return refuse(ReasonCode.SESSION_NOT_READY, "the session is not READY");
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The daemon's launch channel and socket paths. Until both are attached no turn can run. */
  attach(ports: { delivery?: SessionCredentialDelivery; route?: SessionRelayRoute }): void {
    if (ports.delivery) this.#delivery = ports.delivery;
    if (ports.route) this.#route = ports.route;
  }

  /** Whether the daemon holds this session's current credential to deliver. */
  holds(sessionId: string): boolean {
    const held = this.#held.get(sessionId);
    return held !== undefined && held.credentialEpoch === this.ports.sessions.get(sessionId)?.credentialEpoch;
  }

  /** Whether the daemon's launch channel and socket paths are attached: without both no relayed turn runs. */
  attachedToDaemon(): boolean {
    return this.#delivery !== null && this.#route !== null;
  }

  /**
   * Whether a turn of this session is running or queued here: any serialized operation (a work
   * turn, an attestation, a probe) or a coalesced follow-up still to run.
   */
  turnInProgress(sessionId: string): boolean {
    const lane = this.#lanes.get(sessionId);
    return lane !== undefined && (lane.pending > 0 || lane.coalesced.length > 0);
  }

  /**
   * Takes custody of a session's credential: the plaintext a spawn just issued, or the one a
   * rotation just replaced it with. Replaces any earlier one for the session.
   */
  adopt(sessionId: string, role: Role, sessionSecret: string, credentialEpoch: number): Decision<void> {
    const mode = role === Role.PRIMARY_CTO ? this.ports.outbox.drivenModeOf(sessionId) : null;
    if (!DRIVEN_ROLES.has(role) && mode !== "PENDING" && mode !== "DRIVEN") {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "this runtime drives provisioned sessions only: a bootstrap CTO, or a primary CTO spawned driven", {
        sessionId,
        role,
        drivenMode: mode,
      });
    }
    this.#held.set(sessionId, { role, sessionSecret, credentialEpoch });
    return allow(ReasonCode.OK, undefined);
  }

  /** Forgets a session's credential and the record of its triggers; a running turn finishes. */
  release(sessionId: string): void {
    this.#held.delete(sessionId);
    this.#newConversations.delete(sessionId);
    this.#lanes.delete(sessionId);
  }

  /**
   * #246 C4-R2 — gives up custody of exactly one credential: the session's, at this incarnation and
   * credential epoch. The held credential and its attestation are dropped only when they are for
   * that very epoch; a newer one adopted since, its attestation and the session's lane are kept.
   */
  relinquish(sessionId: string, incarnation: string, credentialEpoch: number): void {
    if (this.#held.get(sessionId)?.credentialEpoch === credentialEpoch) this.#held.delete(sessionId);
    if (this.ports.sessions.get(sessionId)?.incarnation === incarnation && !this.#held.has(sessionId)) {
      this.#newConversations.delete(sessionId);
    }
  }

  /** Authenticate the current credential and check runtime liveness without a model turn. */
  async attest(
    sessionId: string,
    conversation: ConversationStep,
    spawn: SpawnAttestation | null = null,
  ): Promise<Decision<void>> {
    return this.#serialized(sessionId, async () => {
      const eligible = this.turnEligibility(sessionId, "attestation", conversation, spawn);
      if (!eligible.allowed) return eligible;
      const session = this.ports.sessions.get(sessionId);
      const held = this.#held.get(sessionId);
      if (!session || !held || held.credentialEpoch !== session.credentialEpoch || !this.#delivery || !this.#route) {
        return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no current authenticated runtime route for this session", { sessionId });
      }
      const peer = { sessionId, sessionIncarnation: session.incarnation, sessionSecret: held.sessionSecret };
      const live = await this.#runtimeLiveness(session, held.role, conversation === "resume");
      if (!live.allowed) return live;
      // Keep the credential fence across the liveness await.
      const still = this.ports.attestations.attest(peer);
      if (!still.allowed) return still;
      if (this.#held.get(sessionId) !== held) {
        return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "runtime credential custody changed", { sessionId });
      }
      const current = this.turnEligibility(sessionId, "attestation", conversation, spawn);
      if (!current.allowed) return current;
      if (conversation === "new" || !this.ports.audit.byKind("SESSION_TURN").some((event) => event.sessionId === sessionId)) {
        this.#newConversations.add(sessionId);
      }
      return allow(ReasonCode.OK, undefined);
    });
  }

  /** Recovery checks runtime liveness directly; it never spends a model turn proving readiness. */
  async probe(sessionId: string): Promise<Decision<void>> {
    return this.#serialized(sessionId, async () => {
      const eligible = this.turnEligibility(sessionId, "probe");
      if (!eligible.allowed) return eligible;
      const session = this.ports.sessions.get(sessionId);
      if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });
      const role = this.#held.get(sessionId)?.role ??
        (this.drivenModeOf(sessionId) === "NONE" ? Role.BOOTSTRAP_CTO : Role.PRIMARY_CTO);
      const live = await this.#runtimeLiveness(session, role, true);
      return live;
    });
  }

  async #runtimeLiveness(session: SessionRecord, role: Role, resume: boolean): Promise<Decision<void>> {
    const adapter = this.#adapterFor(session, role);
    if (!adapter.allowed) return adapter as Decision<void>;
    try {
      if (await adapter.value.probeRuntime() === "UNAVAILABLE") {
        return deny(ReasonCode.SESSION_NOT_READY, "the selected runtime is unavailable", { sessionId: session.sessionId });
      }
      const attempted = this.ports.audit.byKind("SESSION_TURN").some((event) => event.sessionId === session.sessionId);
      const conversation = resume && attempted ? "resume" : "new";
      if (await adapter.value.probeSession(handleFor(session), { conversation }) === "UNAVAILABLE") {
        return deny(ReasonCode.SESSION_NOT_READY, "the provider no longer has this session", { sessionId: session.sessionId });
      }
      return allow(ReasonCode.OK, undefined);
    } catch (error) {
      return deny(ReasonCode.SESSION_NOT_READY, "the selected runtime liveness check failed", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.name === "ProbeProcessGroupUnconfirmed" && "reap" in error
          ? { processGroup: error.reap } : {}),
      });
    }
  }

  /**
   * Runs a turn for the role's current holder because of `triggers`, or folds them into the turn
   * that follows the one already running. A trigger queued, running, or completed by an earlier
   * turn is dropped, as is one whose `served` already answers true, and a wake whose every trigger
   * is refused `SESSION_TURN_DUPLICATE`; a trigger whose turn failed is taken again. Answers at
   * once with what happened; the turn itself runs behind the answer.
   */
  wake(roleKey: string, triggers: readonly SessionWakeTrigger[]): Decision<"STARTED" | "COALESCED"> {
    const binding = this.ports.bindings.active(roleKey);
    if (!binding || !this.drivesSession(binding.sessionId, binding.role)) {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no provisioned session holds this role", { roleKey });
    }
    if (!this.holds(binding.sessionId)) {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "the daemon holds no current credential for this session", {
        roleKey,
        sessionId: binding.sessionId,
      });
    }
    // #246 C4 — a driven PRIMARY_CTO only, rather than every provisioned role: a BOOTSTRAP_CTO's
    // turns keep the contract C1b shipped, and widening the gate to it is that role's change to make.
    // Admission only: the turn asks again when it runs (`#turn`).
    const eligible = this.turnEligibility(binding.sessionId, "work");
    if (!eligible.allowed) return eligible as Decision<"STARTED" | "COALESCED">;
    const lane = this.#lane(binding.sessionId);
    const fresh = triggers.filter((trigger, index) =>
      (!lane.claimed.has(trigger.id) || (lane.pending > 0 && (this.#isEnvelope(trigger.id) || trigger.served !== undefined) && !lane.coalesced.some((queued) => queued.id === trigger.id))) &&
      !lane.handled.has(trigger.id) &&
      !this.#settled(trigger.id) &&
      !this.#servedAlready(trigger, lane) &&
      triggers.findIndex((other) => other.id === trigger.id) === index);
    if (fresh.length === 0) {
      return deny(ReasonCode.SESSION_TURN_DUPLICATE, "every trigger of this wake is queued, running, settled or already handled; none is run twice", {
        roleKey,
        sessionId: binding.sessionId,
        triggers: triggers.map((trigger) => trigger.id),
      });
    }
    for (const trigger of fresh) lane.claimed.add(trigger.id);
    lane.roleKey = roleKey;
    if (lane.pending > 0) {
      lane.coalesced.push(...fresh);
      return allow(ReasonCode.OK, "COALESCED");
    }
    void this.#serialized(binding.sessionId, () => this.#workTurn(binding, fresh, lane));
    return allow(ReasonCode.OK, "STARTED");
  }

  /**
   * One work turn for the role's holder, serving every trigger handed to it. When it ends the
   * triggers are released. A completed turn marks handled only the triggers that name no outbox
   * row; an envelope's own status says whether it is done, so one the turn did not settle is left
   * for the next wake that names it, as is every trigger of a failed turn.
   */
  async #workTurn(
    binding: RoleBinding,
    triggers: readonly SessionWakeTrigger[],
    lane: TurnLane,
  ): Promise<Decision<void>> {
    let completed = false;
    // The mention triggers whose gate did not hold at the final check. The turn may still run for
    // the others, but these were not served by it: they are released, never marked handled.
    const notAdmitted = new Set<string>();
    // The triggers whose `served` already answered true at the final check: spent by another turn
    // (a running one that claimed a coalesced mention's message), so this turn drops them and they
    // are marked handled whether or not it runs for the others.
    const servedBefore = new Set<string>();
    try {
      // A refused turn is not a completed one: its triggers are released, never marked handled.
      // The prompt is written after the final check, so a gated trigger dropped there without a
      // `served` answer (a plan recovery whose run moved on) is not named in it. A mention's trigger
      // keeps its place in the prompt whatever its gate answered, as it always has.
      const prompt = () => {
        const admitted = triggers.filter((trigger) => trigger.served !== undefined || !notAdmitted.has(trigger.id));
        const ownerMail = this.ports.outbox.hasHolderMessagesFor({ roleKey: binding.roleKey,
          bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId,
          sessionIncarnation: binding.sessionIncarnation });
        return workPrompt(binding, admitted, admitted.some((trigger) => this.#concernsStandardWork(trigger)), ownerMail);
      };
      const turn = await this.#turn(binding.sessionId, "resume", prompt, {
        relay: true,
        timeoutMs: this.options.turnTimeoutMs ?? 30 * 60_000,
        purpose: "work",
        // Served while any trigger still wants it: an ordinary one always does, and a mention's
        // only while it is not already served and its gate holds, read at the final check below.
        admissible: () => {
          notAdmitted.clear();
          servedBefore.clear();
          for (const trigger of triggers) {
            if (trigger.served?.() === true) servedBefore.add(trigger.id);
            else if (trigger.stillAdmissible !== undefined && !trigger.stillAdmissible()) notAdmitted.add(trigger.id);
          }
          if (triggers.some((trigger) => !notAdmitted.has(trigger.id) && !servedBefore.has(trigger.id))) {
            return allow(ReasonCode.OK, undefined);
          }
          return notAdmitted.size > 0
            ? deny(ReasonCode.ROLE_PEER_STALE, "the mention that woke this turn no longer stands behind its holder", {
                sessionId: binding.sessionId,
                purpose: "work",
              })
            : deny(ReasonCode.SESSION_TURN_DUPLICATE, "every trigger of this turn was already served before its provider call", {
                sessionId: binding.sessionId,
                triggers: [...servedBefore],
              });
        },
      });
      completed = turn.allowed;
      return turn.allowed ? allow(ReasonCode.OK, undefined) : (turn as Decision<void>);
    } finally {
      for (const trigger of triggers) lane.claimed.delete(trigger.id);
      for (const id of servedBefore) lane.handled.add(id);
      if (completed) {
        for (const trigger of triggers) {
          if (this.#isEnvelope(trigger.id) || notAdmitted.has(trigger.id)) continue;
          // A mention's trigger is handled by what actually happened in the turn, not by the gate's
          // answer before the provider call: a claim refused mid-turn, or never made, leaves its
          // message PENDING and the trigger released. A gated trigger with no `served` (a plan
          // recovery) that its turn ran for is handled like an ordinary one.
          if (trigger.served !== undefined && trigger.served() !== true) continue;
          lane.handled.add(trigger.id);
        }
      }
    }
  }

  /**
   * #512 (CEO 07b5b0df) — whether a trigger concerns a STANDARD_WORK run: a standard work
   * continuation, or an in-band envelope (a RUN_DISPATCH, REVISION_REQUEST or ESCALATION_REPLY) whose
   * run is one. Only such a turn's prompt carries the STANDARD_WORK directive, so the prompt of a
   * turn for a bootstrap or CONTRACT_CHANGE run is exactly what it was before that directive existed.
   */
  #concernsStandardWork(trigger: SessionWakeTrigger): boolean {
    if (trigger.kind.startsWith(STANDARD_CONTINUATION_KIND_PREFIX)) return true;
    const runId = this.ports.outbox.get(trigger.id)?.runId ?? null;
    return runId !== null && this.ports.runs.get(runId)?.kind === RunKind.STANDARD_WORK;
  }

  /** Whether this trigger names an outbox row: its settlement is then the row's, not this lane's. */
  #isEnvelope(triggerId: string): boolean {
    return this.ports.outbox.get(triggerId) !== null;
  }

  /**
   * A trigger whose `served` already answers true has nothing left to run, whichever turn served it
   * (a mention released mid-call whose event a later ordinary turn claimed included), rather than
   * only one this lane's own turn marked handled: a wake that names it is a duplicate, and it is
   * marked handled so the next one is refused without asking again. A trigger with no `served`
   * (every ordinary one) is never judged here.
   */
  #servedAlready(trigger: SessionWakeTrigger, lane: TurnLane): boolean {
    if (trigger.served?.() !== true) return false;
    lane.handled.add(trigger.id);
    return true;
  }

  /** An envelope that has left PENDING — acknowledged, rejected or expired — has nothing left to run. */
  #settled(triggerId: string): boolean {
    const envelope = this.ports.outbox.get(triggerId);
    return envelope !== null && envelope.status !== "PENDING" &&
      !(HOLDER_CLAIMED_KINDS.has(envelope.kind) && envelope.status === "SENT");
  }

  /**
   * Runs `body` after every earlier operation on this session. When the last queued operation
   * finishes, the triggers that coalesced meanwhile are served by exactly one follow-up turn,
   * provided the session still holds the role they woke.
   */
  #serialized<T>(sessionId: string, body: () => Promise<Decision<T>>): Promise<Decision<T>> {
    const lane = this.#lane(sessionId);
    lane.pending += 1;
    const run = lane.tail.then(body, body);
    lane.tail = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      lane.pending -= 1;
      if (lane.pending > 0 || lane.coalesced.length === 0 || this.#lanes.get(sessionId) !== lane) return;
      const binding = lane.roleKey === null ? null : this.ports.bindings.active(lane.roleKey);
      const triggers = lane.coalesced.splice(0).filter((trigger) => !this.#settled(trigger.id) && trigger.served?.() !== true);
      if (triggers.length === 0) return;
      if (!binding || binding.sessionId !== sessionId || !this.holds(sessionId)) {
        // Nothing can run them now; they are released, so a later wake that names them is taken.
        for (const trigger of triggers) lane.claimed.delete(trigger.id);
        return;
      }
      void this.#serialized(sessionId, () => this.#workTurn(binding, triggers, lane));
    });
    return run;
  }

  #lane(sessionId: string): TurnLane {
    let lane = this.#lanes.get(sessionId);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, roleKey: null, coalesced: [], claimed: new Set(), handled: new Set() };
      this.#lanes.set(sessionId, lane);
    }
    return lane;
  }

  /**
   * One turn. With the relay, the held credential is offered on the launch channel for exactly
   * this turn and withdrawn after it, taken or not; without it the turn reaches nothing.
   */
  async #turn(
    sessionId: string,
    conversation: ConversationStep,
    /** The prompt, or how to write it once the final check below has passed. */
    prompt: string | (() => string),
    turn: {
      relay: boolean;
      timeoutMs: number;
      purpose: TurnPurpose;
      spawn?: SpawnAttestation | null;
      /** Whether the turn's triggers still want it, asked last before the provider call; a refusal is the turn's. */
      admissible?: () => Decision<void>;
    },
  ): Promise<Decision<SessionTurnResult>> {
    const refused = (decision: Decision<void>): Decision<SessionTurnResult> => {
      this.ports.audit.record({
        kind: "SESSION_TURN_REFUSED",
        reasonCode: decision.reasonCode,
        sessionId,
        evidence: { purpose: turn.purpose, step: conversation },
      });
      return decision as Decision<SessionTurnResult>;
    };
    const session = this.ports.sessions.get(sessionId);
    if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });
    const held = this.#held.get(sessionId);
    // With no credential held (a recovery's `probe`), the adapter is the one for the role the session
    // was spawned for: a driven PRIMARY_CTO's own role-scoped adapter, never the bootstrap CTO's.
    const adapter = this.#adapterFor(
      session,
      held?.role ?? (this.ports.outbox.drivenModeOf(sessionId) === "NONE" ? Role.BOOTSTRAP_CTO : Role.PRIMARY_CTO),
    );
    if (!adapter.allowed) return adapter as Decision<SessionTurnResult>;
    const provider = adapter.value;
    if (!provider.runSessionTurn) {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "the provider adapter cannot run a session turn", {
        sessionId,
        provider: session.provider,
      });
    }
    const handle = handleFor(session);
    let delivered = false;
    if (turn.relay) {
      if (!this.#route || !this.#delivery) {
        return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no route to the daemon is attached for a session turn", {
          sessionId,
        });
      }
      if (!held || held.credentialEpoch !== session.credentialEpoch) {
        return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "the daemon holds no current credential for this session", {
          sessionId,
          credentialEpoch: session.credentialEpoch,
        });
      }
      const prepared = await this.#delivery.prepare();
      if (!prepared.allowed) return prepared as Decision<SessionTurnResult>;
      // A credential left over from a turn that never withdrew it is not this turn's to reuse.
      this.#delivery.withdraw(handle.externalSessionId);
      const provisioned = await this.#delivery.provision({
        sessionId,
        sessionIncarnation: session.incarnation,
        externalSessionId: handle.externalSessionId,
        sessionSecret: held.sessionSecret,
      });
      if (!provisioned.allowed) return provisioned as Decision<SessionTurnResult>;
      delivered = true;
    }
    // #246 C4 — immediately before the provider call, after every await above: the answer on entry
    // is not reused. A turn refused here never reaches the provider, and its credential is taken back.
    // The credential it prepared must still be the session's: the same epoch (no rotation during the
    // awaits) and the same custody (nothing adopted over it or released).
    if (turn.relay) {
      const current = this.ports.sessions.get(sessionId);
      if (current?.credentialEpoch !== session.credentialEpoch || this.#held.get(sessionId) !== held) {
        if (delivered) this.#delivery!.withdraw(handle.externalSessionId);
        return refused(deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "the credential this turn prepared is no longer the session's", {
          sessionId,
          preparedEpoch: session.credentialEpoch,
          currentEpoch: current?.credentialEpoch ?? null,
        }));
      }
    }
    const now = this.turnEligibility(sessionId, turn.purpose, conversation, turn.spawn ?? null);
    if (!now.allowed) {
      if (delivered) this.#delivery!.withdraw(handle.externalSessionId);
      return refused(now);
    }
    // And, last, the triggers' own gate: a turn left with no trigger to serve (woken only by
    // mentions whose identity, role or room no longer stands behind this holder, or that another
    // turn has already served) is refused here with the gate's own answer, after every await and
    // with no provider contact. Like every refusal above it is not a completed turn.
    const wanted = turn.admissible?.();
    if (wanted !== undefined && !wanted.allowed) {
      if (delivered) this.#delivery!.withdraw(handle.externalSessionId);
      return refused(wanted);
    }
    const text = typeof prompt === "string" ? prompt : prompt();
    if (turn.purpose === "work" && this.#newConversations.delete(sessionId)) conversation = "new";
    let result: SessionTurnResult;
    try {
      result = await provider.runSessionTurn({
        handle,
        conversation,
        prompt: text,
        timeoutMs: turn.timeoutMs,
        correlationId: `turn_${randomUUID()}`,
        relay: turn.relay ? this.#route : null,
      });
    } catch (error) {
      result = {
        ok: false,
        text: "",
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        providerSessionId: null,
        durationMs: 0,
      };
    } finally {
      if (delivered) {
        const untaken = this.#delivery!.withdraw(handle.externalSessionId);
        if (untaken) {
          this.ports.audit.record({
            kind: "SESSION_CREDENTIAL_NOT_TAKEN",
            reasonCode: ReasonCode.SESSION_ATTESTATION_FAILED,
            sessionId,
            evidence: { purpose: turn.purpose, step: conversation },
          });
        }
      }
    }
    // #1104 — a turn that left its own process group unconfirmed is not a completed turn, whatever it
    // answered: it is refused below with the group named, and nothing more is signalled to it.
    const completed = result.ok && result.processGroup === undefined;
    this.ports.audit.record({
      kind: "SESSION_TURN",
      reasonCode: completed ? ReasonCode.OK : ReasonCode.SESSION_TURN_FAILED,
      sessionId,
      // `step` and `sameConversationId`, not "conversation": the audit stores no field named for
      // a conversation's content, and a key ending in it is redacted as one.
      evidence: {
        purpose: turn.purpose,
        step: conversation,
        relay: turn.relay,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sameConversationId: result.providerSessionId === handle.externalSessionId,
        // #1104 — the turn's own process group, when its cleanup could not confirm it ended.
        ...(result.processGroup === undefined ? {} : { processGroup: result.processGroup }),
      },
    });
    if (!completed) {
      return deny(
        ReasonCode.SESSION_TURN_FAILED,
        result.processGroup === undefined
          ? "the session's turn did not complete as its own conversation"
          : `the session's turn did not confirm its own process group ${result.processGroup.pgid} ended`,
        {
          sessionId,
          purpose: turn.purpose,
          step: conversation,
          exitCode: result.exitCode,
          sameConversationId: result.providerSessionId === handle.externalSessionId,
          ...(result.processGroup === undefined ? {} : { processGroup: result.processGroup }),
        },
      );
    }
    return allow(ReasonCode.OK, result);
  }

  #adapterFor(session: SessionRecord, role: Role): Decision<ProviderAdapter> {
    try {
      return allow(ReasonCode.OK, this.ports.providers.requireForRole(session.provider, role));
    } catch {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no adapter is registered for the session's provider and role", {
        sessionId: session.sessionId,
        provider: session.provider,
        role,
      });
    }
  }
}

/**
 * The provider's own conversation id is the incarnation's prefix (`CtoLifecycle.spawn` records
 * `<externalSessionId>#<spawn time>`); the control plane's `ses_cto_…` alias means nothing to it.
 */
const handleFor = (session: SessionRecord): SessionHandle => ({
  externalSessionId: session.incarnation.split("#")[0] ?? session.sessionId,
  provider: session.provider,
  model: session.model,
  effort: session.effort,
  pid: null,
  ...(session.workdir ? { workdir: session.workdir } : {}),
});

/** How many `plan_submit` calls one turn makes for one run before it stops correcting its PLAN. */
export const PLAN_SUBMISSIONS_PER_TURN = 4;

/**
 * What planning a run means, in the words both the RUN_DISPATCH line and the recovery line use: the
 * contract is read through `contract_get`, which for a project-less bootstrap also carries the
 * `bootstrapPlanGuide`, and a refused PLAN is corrected from the refusal's own evidence.
 */
const PLAN_STEPS =
  "read mcp__acp-cto__contract_get for that run; if it carries bootstrapPlanDigest, read mcp__acp-cto__bootstrap_plan_get and submit that digest with runId and idempotencyKey, without plan or tasks; otherwise write a PLAN that satisfies its contract, following the bootstrapPlanGuide it returns when there is one; " +
  "submit the PLAN with mcp__acp-cto__plan_submit; use the same key for an identical retry. " + MCP_MUTATION_RECOVERY + " " +
  `Only after proving non-execution, correct a refused PLAN from its evidence and submit the new request with a new key, at most ${PLAN_SUBMISSIONS_PER_TURN} plan_submit calls for that run in this turn`;

/**
 * The audit kind that records one bootstrap PLAN recovery wake, for its run, the owner's binding
 * generation and the acknowledged RUN_DISPATCH (`evidence.bindingGeneration`, `evidence.messageId`).
 * `audit_events` is append only, so a daemon that starts again reads the wake as already made.
 */
export const BOOTSTRAP_PLAN_RECOVERY_WAKE = "BOOTSTRAP_PLAN_RECOVERY_WAKE";

const PLAN_RECOVERY_KIND_PREFIX = "plan recovery: run ";

/** The wake kind that tells a run's owner why it was woken: its run still has no PLAN. */
export const planRecoveryTriggerKind = (runId: string): string => `${PLAN_RECOVERY_KIND_PREFIX}${runId} has no PLAN`;

/** The trigger id of one recovery wake: the runtime refuses a second wake for it as a duplicate. */
export const planRecoveryTriggerId = (runId: string, bindingGeneration: number, messageId: string): string =>
  `bootstrap-plan-recovery:${runId}:${bindingGeneration}:${messageId}`;

/**
 * What submitting a project-less bootstrap run's result means once its PLAN is accepted, in the words
 * both the result directive and the result recovery line use. Review entry needs no task success: the
 * PLAN's task is the external create, which the control plane settles at CEO CONFIRM from the
 * producer's create receipt and the activation result (CEO 1792120507). The blind review runs inside
 * `result_submit`; it needs nothing more.
 */
const RESULT_STEPS =
  "submit the result of its current PLAN with mcp__acp-cto__result_submit, its resultSummary and recommendation taken from that PLAN and a new idempotencyKey; " +
  "result_submit runs the blind review itself and answers when it is done. " +
  "Do not provision a worker or submit a task receipt for that run: its task is settled by the control plane at CEO CONFIRM";

/**
 * The audit kind that records one bootstrap result recovery wake, for its run, the owner's binding
 * generation and the PLAN it has no result for (`evidence.bindingGeneration`, `evidence.planDigest`).
 * `audit_events` is append only, so a daemon that starts again reads the wake as already made.
 */
export const BOOTSTRAP_RESULT_RECOVERY_WAKE = "BOOTSTRAP_RESULT_RECOVERY_WAKE";

const RESULT_RECOVERY_KIND_PREFIX = "result recovery: run ";

/** The wake kind that tells a run's owner why it was woken: its run has a PLAN and no result for it. */
export const resultRecoveryTriggerKind = (runId: string): string => `${RESULT_RECOVERY_KIND_PREFIX}${runId} has a PLAN and no result`;

/** The trigger id of one result recovery wake: the runtime refuses a second wake for it as a duplicate. */
export const resultRecoveryTriggerId = (runId: string, bindingGeneration: number, planDigest: string): string =>
  `bootstrap-result-recovery:${runId}:${bindingGeneration}:${planDigest}`;

/**
 * The audit kind that records one bootstrap review retry wake: the run's current candidate, frozen
 * from its current PLAN, whose latest blind review ended unavailable (`evidence.bindingGeneration`,
 * `evidence.candidateSnapshotDigest`, `evidence.unavailableEventId`). Append only, as above.
 */
export const BOOTSTRAP_REVIEW_RETRY_WAKE = "BOOTSTRAP_REVIEW_RETRY_WAKE";

const REVIEW_RETRY_KIND_PREFIX = "review retry: run ";

/** The wake kind that tells a run's owner its submitted result's blind review was unavailable. */
export const reviewRetryTriggerKind = (runId: string): string =>
  `${REVIEW_RETRY_KIND_PREFIX}${runId} has a result whose blind review was unavailable`;

/** The trigger id of one review retry wake, built from the unavailable review it answers. */
export const reviewRetryTriggerId = (
  runId: string,
  bindingGeneration: number,
  candidateSnapshotDigest: string,
  unavailableEventId: number,
): string => `bootstrap-review-retry:${runId}:${bindingGeneration}:${candidateSnapshotDigest}:${unavailableEventId}`;

/** The provider this prompt tells the caller to name. Staffing still refuses any name the worker table does not list. */
const STANDARD_WORK_WORKER_PROVIDER = fixedRuntimes(Role.WORKER).find((runtime) => runtime.provider === "claude")!.provider;

/**
 * #512 — what carrying a STANDARD_WORK run past its accepted PLAN means, in the words both its
 * directive and the continuation wake's line use. The run's record, as `contract_get` answers it
 * (each task's state, spec, worker and executions), decides every step, never what the conversation
 * kept (CEO e64aa10b). Every task is taken whatever its state (CEO 07b5b0df): its existing execution,
 * if it has one, is read by its id first, and a RUNNING one is read until it settles; one that
 * SUCCEEDED leaves the task done, and one that did not succeed or cannot be read is escalated, never
 * retried. Only a READY task with no execution gets a first execution: its worker reused if it has
 * one, otherwise staffed; the claim takes the write target recorded in the task's spec, with the
 * registered checkout as its worktree: the control plane records it when it provisions the task's
 * worker (#512 S-TB, CEO 0a16329c) and `task_worker_run` makes or re-enters that branch on that
 * checkout; no branch is chosen here. Once every task SUCCEEDED, the result is submitted, which runs
 * the blind review.
 */
const STANDARD_WORK_STEPS =
  "staffing no more workers at once than its contract allows, one at a time when it states no limit, first read mcp__acp-cto__contract_get for that run: its tasks list each task's taskId, state, spec, worker and executions, and they are the record to go by, whatever this conversation remembers. " +
  "Then take every task of the run, whatever its state, in turn. " +
  "First, if the task has executions, read its newest execution with mcp__acp-cto__task_execution_get by that executionId; while that execution is RUNNING, read it again until it is not; " +
  "an execution that SUCCEEDED leaves its task done; an execution that did not succeed, or one you cannot read, is reported for that run with mcp__acp-cto__escalation_open, its task is never run again, and no result is submitted. " +
  "Only a READY task with no execution gets a first execution: reuse its worker if it has one and never provision another (a worker whose state is not ACTIVE is reported with mcp__acp-cto__escalation_open); " +
  `otherwise staff it with mcp__acp-cto__task_worker_provision, using a new idempotencyKey and provider "${STANDARD_WORK_WORKER_PROVIDER}" with no model (the control plane fixes it); ` +
  "then claim its write target with mcp__acp-cto__resource_claim exactly as its spec's writeTarget names it: repositoryIdentity, branch and paths as declaredPaths, with that repository's checkoutPath from contract_get's repositories as the worktreeId (the control plane records a task's writeTarget when it provisions the task's worker and answers task_worker_provision with it, so after provisioning take it from that answer or read contract_get again); " +
  "task_worker_run then creates that branch at the run's pinned base and checks it out, or continues on it, and refuses a checkout that is not clean, so never choose, derive, create or change a branch yourself; when the spec names no writeTarget, report it with mcp__acp-cto__escalation_open (task_worker_provision answers writeTargetRefused when the control plane cannot record one); " +
  "start that first execution with mcp__acp-cto__task_worker_run, naming the task and the claimId resource_claim returned for that worktree, and read the execution it returns as above. " +
  "A task with no execution that is not READY is left as it is. " +
  "Once every task of the run has SUCCEEDED, submit the run's result with mcp__acp-cto__result_submit and a new idempotencyKey; result_submit runs the blind review itself and answers when it is done. " +
  "A refused provision, claim or task_worker_run is reported for that run with mcp__acp-cto__escalation_open, and no result is submitted: never run an execution again or retry one on your own. " +
  "Never submit that run's PLAN again to carry it on: a second plan_submit adds its tasks again; only a PLAN that declares or re-links a Repo Factory project's workUnits, with tasks omitted, may be submitted again";

/**
 * #512 — what a STANDARD_WORK run's PLAN gives each task, so that its claim later takes a declared
 * write target rather than one chosen at claim time (CEO e64aa10b). The branch is the control plane's
 * to derive (S-TB, CEO f5879479) unless the run's contract names one.
 */
const STANDARD_PLAN_WRITE_TARGET =
  "When you plan such a run, give each task's spec a writeTarget: repositoryIdentity (one of the repositories contract_get returned), paths (the repository-relative paths the task changes) and branch only when the run's contract names a work branch for that repository; otherwise leave branch out rather than choose one: the control plane derives the task's branch and records the whole writeTarget when it provisions the task's worker";

/**
 * #1240 — what a Repo Factory project's STANDARD_WORK PLAN also declares: its tasks' responsibility
 * units, each linked to a GitHub issue and milestone (`WorkScopeTracking`). Adoption comes first; one
 * deliverable's tasks share a unit; a re-link PLAN carries no tasks.
 */
const STANDARD_PLAN_WORK_UNITS =
  "For a Repo Factory project (plan_submit refuses WORK_UNITS_MISSING without it) the PLAN also declares plan.workUnits, each {key, tasks: [this PLAN's task keys or the run's task ids], issue: {number} | {new: {title, body}}, milestone: {number} | {new: {title}}}: adopt the existing issue and milestone by number first, and declare new only for work no issue covers; the tasks of one deliverable (its implementation, review and correction) share one unit, and every live task is in exactly one; a plan_submit that only declares or re-links workUnits omits tasks";

/**
 * The audit kind that records one standard work continuation wake: an ACTIVE STANDARD_WORK run whose
 * PLAN was accepted and whose RUN_DISPATCH its driven owner acknowledged, left with a READY task no
 * execution was started for, with no worker or with the one it was given. Keyed by its run,
 * `evidence.taskId` and `evidence.taskState`, the continuation state (`STANDARD_CONTINUATION_STATE`);
 * `evidence.bindingGeneration` is recorded but is not part of the key, so a renewed owner generation
 * does not earn the same state another wake. Append only, as above.
 */
export const STANDARD_WORK_CONTINUATION_WAKE = "STANDARD_WORK_CONTINUATION_WAKE";

/**
 * The audit kind that records the explicit blocker a continuation leaves when the one turn it woke
 * made no progress: the same run, task and continuation state, and no turn of the owner running or
 * queued. Written once per that tuple, whatever the owner's generation; nothing wakes the owner for
 * it again.
 */
export const STANDARD_WORK_CONTINUATION_STALLED = "STANDARD_WORK_CONTINUATION_STALLED";

/**
 * #512 (CEO e64aa10b) — the state component of a continuation's once-key. The task's own state is
 * READY in both, so it does not tell a task nothing was started for from one whose worker was
 * provisioned and never ran; each is a state of its own, woken at most once.
 */
export const STANDARD_CONTINUATION_STATE = Object.freeze({
  /** READY, no WORKER ever bound, no execution: the unprogressed state `taskState: "READY"` named before. */
  UNSTAFFED: "READY",
  /** READY, its WORKER bound and ACTIVE, no execution: provisioned, never run. */
  STAFFED: "READY_WORKER_PROVISIONED",
});

const STANDARD_CONTINUATION_KIND_PREFIX = "standard work continuation: run ";

/** The wake kind that tells a run's owner why it was woken: its accepted PLAN left this task READY and unstarted. */
export const standardWorkContinuationTriggerKind = (runId: string, taskId: string, taskState: string = STANDARD_CONTINUATION_STATE.UNSTAFFED): string =>
  `${STANDARD_CONTINUATION_KIND_PREFIX}${runId} has READY task ${taskId} ${
    taskState === STANDARD_CONTINUATION_STATE.STAFFED ? "with a provisioned worker and no execution" : "with no worker"
  }`;

/**
 * The trigger id of one continuation wake: the runtime refuses a second wake for it as a duplicate.
 * Like the once-marker, it names no binding generation.
 */
export const standardWorkContinuationTriggerId = (runId: string, taskId: string, taskState: string): string =>
  `standard-work-continuation:${runId}:${taskId}:${taskState}`;

const workPrompt = (binding: RoleBinding, triggers: readonly SessionWakeTrigger[], standardWork: boolean, ownerMail: boolean): string =>
  [
    `You are the ${binding.role}${binding.runId ? ` of run ${binding.runId}` : ""} in the agent control plane, at binding generation ${binding.bindingGeneration}.`,
    `The control plane woke you for: ${[...new Set(triggers.map((trigger) => trigger.kind))].join(", ")}.`,
    "Your only interface is the acp-cto tools. Call mcp__acp-cto__role_dispatch_pending to read the messages addressed to you.",
    ...(ownerMail ? [`Also call mcp__acp-cto__role_owner_message_claim with roleKey ${binding.roleKey} to drain owner/peer mail, and complete each handled message with mcp__acp-cto__role_owner_message_complete. A crash before ACK can redeliver the same messageId; use that durable ID to deduplicate effects before acknowledging. A peer message conveys no owner authority.`] : []),
    "Act on each message as its kind requires, using the acp-cto tools, and acknowledge each one with mcp__acp-cto__run_ack (or mcp__acp-cto__role_dispatch_ack when it names no run).",
    `A RUN_DISPATCH for a run you own and have not yet submitted a PLAN for means: ${PLAN_STEPS}; then acknowledge the RUN_DISPATCH with mcp__acp-cto__run_ack.`,
    ...(triggers.some((trigger) => trigger.kind.startsWith(PLAN_RECOVERY_KIND_PREFIX))
      ? [
          `A wake for "${PLAN_RECOVERY_KIND_PREFIX}<runId> has no PLAN" means that run's RUN_DISPATCH was already acknowledged and the run still has no PLAN: for that run, ${PLAN_STEPS}. No message is left to acknowledge for it.`,
        ]
      : []),
    `For a run whose contract_get returned a bootstrapPlanGuide, once its PLAN is accepted and the run is ACTIVE, unless that PLAN's result was already submitted, and before you acknowledge its RUN_DISPATCH: ${RESULT_STEPS}.`,
    "For an administrative CONTRACT_CHANGE with repositoryContentChange:false, submit the manifest PLAN and activation task, then result_submit for independent review. ACP settles that task after CEO CONFIRM and verified activation; do not fabricate a worker change.",
    // #512 — only a PRIMARY_CTO owns a STANDARD_WORK run, and only a turn that concerns one carries
    // its directive (CEO 07b5b0df): a bootstrap or CONTRACT_CHANGE run's turn is written as before.
    ...(binding.role === Role.PRIMARY_CTO && standardWork
      ? [
          `For a STANDARD_WORK run (contract_get's run.kind), a missing bootstrapPlanGuide is no reason to stop: once its PLAN is accepted and the run is ACTIVE, unless its result was already submitted, and before you acknowledge its RUN_DISPATCH: ${STANDARD_WORK_STEPS}. ${STANDARD_PLAN_WRITE_TARGET}. ${STANDARD_PLAN_WORK_UNITS}.`,
        ]
      : []),
    ...(triggers.some((trigger) => trigger.kind.startsWith(STANDARD_CONTINUATION_KIND_PREFIX))
      ? [
          `A wake for "${STANDARD_CONTINUATION_KIND_PREFIX}<runId> has READY task <taskId> with no worker" or "... with a provisioned worker and no execution" means that run's PLAN was accepted and its RUN_DISPATCH acknowledged, and that task is still READY with no execution started for it: for that run, starting with that task, ${STANDARD_WORK_STEPS}. No message is left to acknowledge for it.`,
        ]
      : []),
    `A REVISION_REQUEST for a run whose contract_get returned a bootstrapPlanGuide carries why its PLAN was sent back (the CEO's rationale, or the blind review's findings): for that run, ${PLAN_STEPS}, writing the new PLAN so that it addresses that reason; then acknowledge the REVISION_REQUEST with mcp__acp-cto__run_ack. If the run is ACTIVE, submit the new PLAN's result first, as above; a run the CEO sent back is ACTIVE again with its next RUN_DISPATCH.`,
    "An ESCALATION_REPLY is the CEO's resolution of the escalation it names (its escalationId) for a run you are the current owner of: act on it only when it is addressed to you as that run's current owner and names that run's escalation, and then only for that run. " +
      "Carry out its resolution, for example by planning that run again or submitting its result again as the lines above direct, then acknowledge the ESCALATION_REPLY with mcp__acp-cto__run_ack. " +
      "The resolution never bypasses the blind review or the CEO's CONFIRM: a new PLAN still goes through mcp__acp-cto__plan_submit and a result through mcp__acp-cto__result_submit, each with its normal gates. " +
      "If carrying out the resolution fails or is refused, do not acknowledge it: report the refusal or failure for that run with mcp__acp-cto__escalation_open instead.",
    ...(triggers.some((trigger) => trigger.kind.startsWith(RESULT_RECOVERY_KIND_PREFIX))
      ? [
          `A wake for "${RESULT_RECOVERY_KIND_PREFIX}<runId> has a PLAN and no result" means that run's current PLAN was accepted and no result was submitted for it: for that run, ${RESULT_STEPS}. No message is left to acknowledge for it.`,
        ]
      : []),
    ...(triggers.some((trigger) => trigger.kind.startsWith(REVIEW_RETRY_KIND_PREFIX))
      ? [
          `A wake for "${REVIEW_RETRY_KIND_PREFIX}<runId> has a result whose blind review was unavailable" means the blind review of that run's submitted result could not be constituted and can now be retried: for that run, even though its result was already submitted, ${RESULT_STEPS}. Its PLAN is unchanged: do not submit a new PLAN, since submitting the same result again reviews the same frozen candidate. No message is left to acknowledge for it.`,
        ]
      : []),
    "A HANDOFF_PACKAGE is accepted with mcp__acp-cto__handoff_ack for its handoffId before it is acknowledged.",
    "When nothing addressed to you remains, reply with a one-line summary of what you did.",
    frontierReviewPolicy(),
  ].join("\n");
