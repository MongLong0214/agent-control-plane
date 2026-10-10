import { randomUUID } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, type RoleBinding, SessionLifecycle } from "../domain/types.ts";
import type { Outbox } from "../outbox/outbox.ts";
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
  readonly outbox: Pick<Outbox, "get" | "drivenModeOf" | "drivenSpawnRecordOf">;
}

export interface ProvisionedSessionRuntimeOptions {
  attestTimeoutMs?: number;
  probeTimeoutMs?: number;
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
   * identity, role and room still stand behind the role's current holder. It is asked again at the
   * turn's final check, immediately before the provider call, and a turn none of whose triggers
   * still holds is refused there. Absent on every other trigger, which the final check never asks.
   */
  stillAdmissible?: () => boolean;
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
 * - **Readiness is authenticated.** `attest` mints a challenge, runs a turn whose relay must present
 *   it over a connection authenticated with the delivered credential, and only a settled challenge
 *   answers OK. A turn that exited 0 proves nothing on its own.
 * - **Serialized.** A session runs one turn at a time. A wake that arrives while a turn runs is
 *   coalesced into one follow-up turn; a wake for a trigger queued or running is refused
 *   `SESSION_TURN_DUPLICATE`, and so is one for an envelope already settled or for an owner-message
 *   trigger a turn completed. **Settled is the outbox's word, not the CLI's:** a turn that exited 0
 *   without acknowledging its envelope settled nothing, so when its turn ends, however it ended, a
 *   still-PENDING envelope is released for the next wake that names it. That wake is the outbox's
 *   own re-wake, at most once per row per `IN_BAND_REWAKE_MS` and never past the row's TTL, so
 *   unacknowledged work is retried at that pace and never in a loop here. Turns start only from
 *   the existing event paths (an in-band dispatch, an owner message, a wake) and from the control
 *   plane's own spawn and recovery; there is no timer here.
 *
 * In memory only: a restarted daemon holds no credential, and a session it holds none for cannot
 * run a turn until its credential is rotated and delivered again.
 */
export class ProvisionedSessionRuntime {
  #delivery: SessionCredentialDelivery | null = null;
  #route: SessionRelayRoute | null = null;
  readonly #held = new Map<string, HeldCredential>();
  /** The incarnation and epoch each session last proved by an attestation; a failed one clears it. */
  readonly #attested = new Map<string, { incarnation: string; credentialEpoch: number }>();
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
   * #246 C4 — whether a driven PRIMARY_CTO session may run work now: its last attestation, for its
   * current incarnation and credential epoch, succeeded. READY is what was last written about the
   * session; a failed attestation since then is newer than it, and no work turn runs past it.
   */
  #attestedNow(sessionId: string): boolean {
    const attested = this.#attested.get(sessionId);
    const session = this.ports.sessions.get(sessionId);
    return attested !== undefined && session !== null &&
      attested.incarnation === session.incarnation && attested.credentialEpoch === session.credentialEpoch;
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
   * also needs a current attestation. The one exception is `PENDING`: only an attestation of a new
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
    if (purpose === "work" && !this.#attestedNow(sessionId)) {
      return refuse(ReasonCode.SESSION_NOT_READY, "the session has no current attestation; a stale READY runs no work");
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
    // A credential nobody has presented yet is not attested, whatever the last one was.
    this.#attested.delete(sessionId);
    return allow(ReasonCode.OK, undefined);
  }

  /** Forgets a session's credential and the record of its triggers; a running turn finishes. */
  release(sessionId: string): void {
    this.#held.delete(sessionId);
    this.#attested.delete(sessionId);
    this.#lanes.delete(sessionId);
  }

  /**
   * Proves the session's runtime is reachable and holds its current credential: one turn of its
   * own conversation whose relay presents a fresh challenge over an authenticated connection.
   */
  async attest(
    sessionId: string,
    conversation: ConversationStep,
    spawn: SpawnAttestation | null = null,
  ): Promise<Decision<void>> {
    return this.#serialized(sessionId, async () => {
      // Refused before any turn: nothing was learned about the runtime, so an attestation it already
      // has stands — a turn it may not run is no evidence against the one it ran.
      const eligible = this.turnEligibility(sessionId, "attestation", conversation, spawn);
      if (!eligible.allowed) return eligible;
      const challenge = this.ports.attestations.challenge(sessionId);
      if (!challenge.allowed) return challenge as Decision<void>;
      const nonce = challenge.value.nonce;
      const turn = await this.#turn(sessionId, conversation, attestationPrompt(nonce), {
        relay: true,
        timeoutMs: this.options.attestTimeoutMs ?? 5 * 60_000,
        purpose: "attestation",
        spawn,
      });
      // The turn awaited; whatever made it eligible is read again before the answer counts.
      const still = turn.allowed ? this.turnEligibility(sessionId, "attestation", conversation, spawn) : turn;
      if (!still.allowed) {
        this.#attested.delete(sessionId);
        this.ports.attestations.withdraw(sessionId, nonce);
        return still as Decision<void>;
      }
      const settled = this.ports.attestations.settle(sessionId, nonce);
      const session = this.ports.sessions.get(sessionId);
      if (settled.allowed && session) {
        this.#attested.set(sessionId, { incarnation: session.incarnation, credentialEpoch: session.credentialEpoch });
      } else {
        this.#attested.delete(sessionId);
      }
      return settled;
    });
  }

  /**
   * Asks the session's own conversation to answer, continuing it, with no MCP server and no
   * credential: the provider still has this conversation. Never readiness on its own.
   */
  async probe(sessionId: string): Promise<Decision<void>> {
    return this.#serialized(sessionId, async () => {
      const turn = await this.#turn(sessionId, "resume", "Reply with the single word READY.", {
        relay: false,
        timeoutMs: this.options.probeTimeoutMs ?? 2 * 60_000,
        purpose: "probe",
      });
      return turn.allowed ? allow(ReasonCode.OK, undefined) : (turn as Decision<void>);
    });
  }

  /**
   * Runs a turn for the role's current holder because of `triggers`, or folds them into the turn
   * that follows the one already running. A trigger queued, running, or completed by an earlier
   * turn is dropped, and a wake whose every trigger is refused `SESSION_TURN_DUPLICATE`; a trigger
   * whose turn failed is taken again. Answers at once with what happened; the turn itself runs
   * behind the answer.
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
      !lane.claimed.has(trigger.id) &&
      !lane.handled.has(trigger.id) &&
      !this.#settled(trigger.id) &&
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
    try {
      // A refused turn is not a completed one: its triggers are released, never marked handled.
      const turn = await this.#turn(binding.sessionId, "resume", workPrompt(binding, triggers), {
        relay: true,
        timeoutMs: this.options.turnTimeoutMs ?? 30 * 60_000,
        purpose: "work",
        // Served while any trigger still holds: an ordinary one always does, and a mention's holds
        // only while its gate does, read at the final check below.
        admissible: () => triggers.some((trigger) => trigger.stillAdmissible === undefined || trigger.stillAdmissible()),
      });
      completed = turn.allowed;
      return turn.allowed ? allow(ReasonCode.OK, undefined) : (turn as Decision<void>);
    } finally {
      for (const trigger of triggers) lane.claimed.delete(trigger.id);
      if (completed) {
        for (const trigger of triggers) if (!this.#isEnvelope(trigger.id)) lane.handled.add(trigger.id);
      }
    }
  }

  /** Whether this trigger names an outbox row: its settlement is then the row's, not this lane's. */
  #isEnvelope(triggerId: string): boolean {
    return this.ports.outbox.get(triggerId) !== null;
  }

  /** An envelope that has left PENDING — acknowledged, rejected or expired — has nothing left to run. */
  #settled(triggerId: string): boolean {
    const envelope = this.ports.outbox.get(triggerId);
    return envelope !== null && envelope.status !== "PENDING";
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
      const triggers = lane.coalesced.splice(0);
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
    prompt: string,
    turn: {
      relay: boolean;
      timeoutMs: number;
      purpose: TurnPurpose;
      spawn?: SpawnAttestation | null;
      /** Whether the turn's triggers still want it, asked last before the provider call. */
      admissible?: () => boolean;
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
    const adapter = this.#adapterFor(session, held?.role ?? Role.BOOTSTRAP_CTO);
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
    // And, last, the triggers' own gate: a turn woken only by mentions whose identity, role or room
    // no longer stands behind this holder is refused here, after every await and with no provider
    // contact. Like every refusal above it is not a completed turn, so nothing is marked handled.
    if (turn.admissible !== undefined && !turn.admissible()) {
      if (delivered) this.#delivery!.withdraw(handle.externalSessionId);
      return refused(deny(ReasonCode.ROLE_PEER_STALE, "the mention that woke this turn no longer stands behind its holder", {
        sessionId,
        purpose: turn.purpose,
      }));
    }
    let result: SessionTurnResult;
    try {
      result = await provider.runSessionTurn({
        handle,
        conversation,
        prompt,
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
    this.ports.audit.record({
      kind: "SESSION_TURN",
      reasonCode: result.ok ? ReasonCode.OK : ReasonCode.SESSION_TURN_FAILED,
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
      },
    });
    if (!result.ok) {
      return deny(ReasonCode.SESSION_TURN_FAILED, "the session's turn did not complete as its own conversation", {
        sessionId,
        purpose: turn.purpose,
        step: conversation,
        exitCode: result.exitCode,
        sameConversationId: result.providerSessionId === handle.externalSessionId,
      });
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

const attestationPrompt = (nonce: string): string =>
  [
    "Control-plane readiness check for this session.",
    `Call the tool mcp__acp-cto__session_attest exactly once with the argument nonce set to "${nonce}".`,
    "Do not call any other tool. After the tool answers, reply with the single word ATTESTED.",
  ].join("\n");

const workPrompt = (binding: RoleBinding, triggers: readonly SessionWakeTrigger[]): string =>
  [
    `You are the ${binding.role}${binding.runId ? ` of run ${binding.runId}` : ""} in the agent control plane, at binding generation ${binding.bindingGeneration}.`,
    `The control plane woke you for: ${[...new Set(triggers.map((trigger) => trigger.kind))].join(", ")}.`,
    "Your only interface is the acp-cto tools. Call mcp__acp-cto__role_dispatch_pending to read the messages addressed to you.",
    "Act on each message as its kind requires, using the acp-cto tools, and acknowledge each one with mcp__acp-cto__run_ack (or mcp__acp-cto__role_dispatch_ack when it names no run).",
    "A HANDOFF_PACKAGE is accepted with mcp__acp-cto__handoff_ack for its handoffId before it is acknowledged.",
    "When nothing addressed to you remains, reply with a one-line summary of what you did.",
  ].join("\n");
