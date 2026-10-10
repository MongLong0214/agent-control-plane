import { randomUUID } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import { Role, type RoleBinding } from "../domain/types.ts";
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
  readonly outbox: Pick<Outbox, "get">;
}

export interface ProvisionedSessionRuntimeOptions {
  attestTimeoutMs?: number;
  probeTimeoutMs?: number;
  turnTimeoutMs?: number;
}

/** One reason a role's session is woken; `id` is what makes a second wake for it a duplicate. */
export interface SessionWakeTrigger {
  id: string;
  kind: string;
}

/** The roles all of whose sessions this runtime drives: a run's BOOTSTRAP_CTO. Never a canonical role. */
const DRIVEN_ROLES: ReadonlySet<Role> = new Set([Role.BOOTSTRAP_CTO]);

/**
 * #246 C4 — the audit kind that records a PRIMARY_CTO session spawned, for a bootstrap activation,
 * to be driven by this runtime. Written by `CtoLifecycle.spawn` in the transaction that creates the
 * session row, before its credential is adopted or anything can refuse it. `audit_events` is append
 * only, so the fact can neither be added later nor taken back, and a session that does not carry it
 * — every interactive PRIMARY_CTO, every adopted canonical CTO — is never driven here, whatever its
 * role. The role alone never makes a PRIMARY_CTO driven.
 *
 * An append-only spawn record rather than a new column or the shape of the session's workdir: the
 * schema is not changed for this, and a path is not a fact anybody recorded.
 */
export const DRIVEN_PRIMARY_CTO_SPAWN_RECORD = "PRIMARY_CTO_DRIVEN_SESSION_SPAWNED";

/** SQL: whether the session `sessionExpr` names was spawned as a driven PRIMARY_CTO. */
export const drivenPrimaryCtoSessionSql = (sessionExpr: string): string => `EXISTS (
  SELECT 1 FROM audit_events driven_e
   WHERE driven_e.kind = '${DRIVEN_PRIMARY_CTO_SPAWN_RECORD}'
     AND driven_e.session_id = ${sessionExpr}
)`;

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
   * only when its own spawn recorded it driven (`DRIVEN_PRIMARY_CTO_SPAWN_RECORD`).
   */
  drivesSession(sessionId: string, role: Role): boolean {
    if (DRIVEN_ROLES.has(role)) return true;
    return role === Role.PRIMARY_CTO && this.#spawnedDriven(sessionId);
  }

  #spawnedDriven(sessionId: string): boolean {
    return this.ports.audit.byKind(DRIVEN_PRIMARY_CTO_SPAWN_RECORD).some((row) => row.sessionId === sessionId);
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
    if (!this.drivesSession(sessionId, role)) {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "this runtime drives provisioned sessions only: a bootstrap CTO, or a primary CTO spawned driven", {
        sessionId,
        role,
      });
    }
    this.#held.set(sessionId, { role, sessionSecret, credentialEpoch });
    return allow(ReasonCode.OK, undefined);
  }

  /** Forgets a session's credential and the record of its triggers; a running turn finishes. */
  release(sessionId: string): void {
    this.#held.delete(sessionId);
    this.#lanes.delete(sessionId);
  }

  /**
   * Proves the session's runtime is reachable and holds its current credential: one turn of its
   * own conversation whose relay presents a fresh challenge over an authenticated connection.
   */
  async attest(sessionId: string, conversation: ConversationStep): Promise<Decision<void>> {
    return this.#serialized(sessionId, async () => {
      const challenge = this.ports.attestations.challenge(sessionId);
      if (!challenge.allowed) return challenge as Decision<void>;
      const nonce = challenge.value.nonce;
      const turn = await this.#turn(sessionId, conversation, attestationPrompt(nonce), {
        relay: true,
        timeoutMs: this.options.attestTimeoutMs ?? 5 * 60_000,
        purpose: "attestation",
      });
      if (!turn.allowed) {
        this.ports.attestations.withdraw(sessionId, nonce);
        return turn as Decision<void>;
      }
      return this.ports.attestations.settle(sessionId, nonce);
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
      const turn = await this.#turn(binding.sessionId, "resume", workPrompt(binding, triggers), {
        relay: true,
        timeoutMs: this.options.turnTimeoutMs ?? 30 * 60_000,
        purpose: "work",
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
    turn: { relay: boolean; timeoutMs: number; purpose: string },
  ): Promise<Decision<SessionTurnResult>> {
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
    "When nothing addressed to you remains, reply with a one-line summary of what you did.",
  ].join("\n");
