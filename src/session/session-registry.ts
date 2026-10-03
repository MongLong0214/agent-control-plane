import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail, isAcpError } from "../core/errors.ts";
import { newSessionId } from "../core/ids.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { nativeStartIsInLstartSecond, processStartedAt } from "../core/process-identity.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { SessionLifecycle } from "../domain/types.ts";
import { HOLDER_CLAIMED_KIND_SQL } from "../outbox/outbox.ts";
import { isBuzzKeyPossession, type BuzzKeyPossession } from "../buzz/buzz-bind-challenge.ts";
import { isAdmittedRuntime, type AdmittedRuntime } from "./runtime-lineage.ts";

export interface SessionRecord {
  sessionId: string;
  /** PRD §5.6 — one lifetime of a session; changes whenever the session is respawned. */
  incarnation: string;
  provider: string;
  model: string;
  effort: string | null;
  lifecycle: SessionLifecycle;
  buzzAddress: string | null;
  /** §27.2 — the authenticated Buzz channel identity identity this session speaks as, if bound. */
  buzzActorId: string | null;
  osPid: number | null;
  /**
   * The start time recorded for `osPid` when it was written, or null where it could not be
   * established (#505). Exposed because a pid alone cannot answer "is *this* process still
   * running": pids are reused, so only the `(pid, startedAt)` pair distinguishes the process
   * this session names from an unrelated one that inherited its number. A reader that has to
   * *prove* a session dead — rather than merely observe that some process answers — needs both
   * halves, and `create()` already stores them as one immutable pair for exactly that reason.
   */
  osProcessStartedAt: string | null;
  workdir: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
}

/**
 * The authority that can vouch for a Buzz channel identity identity.
 *
 * `IngressGuard.isAllowedActor` satisfies this structurally, which is deliberate: the only
 * thing in the deployment that knows which Buzz actors are authenticated is the ingress
 * policy (allowlist plus HMAC over the whole envelope, §27.1). Passing the authority in
 * rather than trusting the caller's word keeps this registry from becoming a second,
 * weaker source of truth about who an actor is.
 */
const NATIVE_START_PINNED = "SESSION_NATIVE_START_PINNED";

/**
 * The native token of a (native, lstart, native) snapshot when all three describe one process, or
 * null. Equal native reads around the lstart read mean nothing replaced the process in between;
 * the token's second matching the lstart's is the same fact checked once more against the text.
 */
const oneProcessStartToken = (before: string | null, startedAt: string | null, after: string | null): string | null => {
  if (before === null) return null;
  if (before !== after) return null;
  if (startedAt === null) return null;
  if (!nativeStartIsInLstartSecond(before, startedAt)) return null;
  return before;
};

export interface BuzzActorAuthenticator {
  isAllowedActor(channel: string, actor: string): boolean;
}

export interface BindBuzzActorInput {
  sessionId: string;
  /** Proof the caller is this session; a session id alone is public and proves nothing. */
  sessionSecret: string;
  buzzActorId: string;
}

/**
 * The same binding, with the caller's proof being a kernel-peer lineage admission rather than the
 * secret (#1037). The admission names the session; there is no separate session id to disagree
 * with it.
 */
export interface AdmittedBindBuzzActorInput {
  admitted: AdmittedRuntime;
  buzzActorId: string;
}

/**
 * The same binding, proven by the identity's own key: the runtime answered a challenge minted for
 * its lineage admission with an event that key signed (`BuzzBindChallenges`). The proof names both
 * the runtime and the identity; there is nothing beside it to disagree with either.
 */
export interface PossessedBindBuzzActorInput {
  possession: BuzzKeyPossession;
}

/** The creation response is the only time a runtime receives its session secret. */
export interface CreatedSession extends SessionRecord {
  sessionSecret: string | null;
}

const SESSION_SECRET_BYTES = 32;
const SESSION_SECRET_HASH = /^[a-f0-9]{64}$/;

const hashSessionSecret = (secret: string): Buffer =>
  createHash("sha256").update(secret, "utf8").digest();

const LEGAL_LIFECYCLE: Readonly<Record<SessionLifecycle, readonly SessionLifecycle[]>> = {
  [SessionLifecycle.STARTING]: [SessionLifecycle.READY, SessionLifecycle.ERROR, SessionLifecycle.STOPPED],
  [SessionLifecycle.READY]: [SessionLifecycle.DRAINING, SessionLifecycle.STOPPED, SessionLifecycle.ERROR],
  [SessionLifecycle.DRAINING]: [SessionLifecycle.STOPPED, SessionLifecycle.ERROR, SessionLifecycle.READY],
  [SessionLifecycle.STOPPED]: [],
  [SessionLifecycle.ERROR]: [SessionLifecycle.STOPPED],
};

/**
 * PRD §9.3. The lifecycle enum is exactly the five documented states — `BUSY` is
 * deliberately absent, because it is a derived fact about owned active runs and storing
 * it would create a second, drift-prone source of truth.
 */
export class SessionRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  create(input: {
    provider: string;
    model: string;
    effort?: string | null;
    workdir?: string | null;
    buzzAddress?: string | null;
    osPid?: number | null;
    /**
     * A caller that already verified `(osPid, osStartedAt)` as one immutable pair — e.g. the
     * canonical self-claim primitive's ancestry walk (#760) — passes its exact verified value
     * here so it is the value stored, not a fresh read of `ps` taken at write time. Independently
     * re-deriving the start time at this point would be a TOCTOU window: if `osPid` has been
     * reused by an unrelated process between verification and this write, `processStartedAt`
     * would silently record *that* process's start time as if it were the verified one. Every
     * caller that has not independently verified identity omits this field and gets
     * `processStartedAt`'s own derive-at-write-time value instead, which is correct for them
     * since there is no prior verification for a reused pid to invalidate.
     */
    osStartedAt?: string | null;
    sessionId?: string;
    incarnation?: string;
  }): CreatedSession {
    const now = this.clock.nowIso();
    const sessionId = input.sessionId ?? newSessionId();
    const incarnation = input.incarnation ?? `${sessionId}#${now}`;
    const sessionSecret = this.secretStorageAvailable()
      ? randomBytes(SESSION_SECRET_BYTES).toString("base64url")
      : null;
    const osStartedAt = input.osStartedAt !== undefined ? input.osStartedAt : processStartedAt(input.osPid);
    if (sessionSecret) {
      this.db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, effort, lifecycle,
                               buzz_address, os_pid, os_process_started_at, workdir,
                               session_secret_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId, incarnation, input.provider, input.model, input.effort ?? null,
          input.buzzAddress ?? null, input.osPid ?? null, osStartedAt,
          input.workdir ?? null,
          hashSessionSecret(sessionSecret).toString("hex"), now, now,
        ],
      );
    } else {
      this.db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, effort, lifecycle,
                               buzz_address, os_pid, os_process_started_at, workdir,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?, ?)`,
        [
          sessionId, incarnation, input.provider, input.model, input.effort ?? null,
          input.buzzAddress ?? null, input.osPid ?? null, osStartedAt,
          input.workdir ?? null, now, now,
        ],
      );
    }
    this.audit.record({
      kind: "SESSION_CREATED",
      sessionId,
      evidence: { provider: input.provider, model: input.model, effort: input.effort ?? null },
    });
    return { ...this.require(sessionId), sessionSecret };
  }

  /**
   * Verifies an opaque secret without exposing the stored hash. Deployments missing the
   * required migration refuse authentication explicitly; they never treat an ID alone as
   * a session proof.
   */
  verifySecret(sessionId: string, sessionSecret: string): Decision<SessionRecord> {
    if (!this.secretStorageAvailable()) {
      return deny(
        ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
        "session secret storage is unavailable; apply the sessions.session_secret_hash migration",
        { sessionId },
      );
    }
    const row = this.db.get<RawSession & { session_secret_hash: string | null }>(
      `SELECT * FROM sessions WHERE session_id = ?`,
      [sessionId],
    );
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });

    const expected = hashSessionSecret(sessionSecret);
    const validStoredHash =
      typeof row.session_secret_hash === "string" && SESSION_SECRET_HASH.test(row.session_secret_hash);
    const stored = validStoredHash
      ? Buffer.from(row.session_secret_hash!, "hex")
      : Buffer.alloc(SESSION_SECRET_BYTES);
    const matches = timingSafeEqual(expected, stored);
    if (!validStoredHash || !matches ||
        row.lifecycle === SessionLifecycle.STOPPED || row.lifecycle === SessionLifecycle.ERROR) {
      return deny(ReasonCode.SESSION_SECRET_INVALID, "session secret does not authenticate this session", {
        sessionId,
      });
    }
    return allow(ReasonCode.OK, hydrate(row));
  }

  transition(sessionId: string, to: SessionLifecycle, reason?: string): Decision<SessionRecord> {
    const session = this.get(sessionId);
    if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });
    if (session.lifecycle === to) return allow(ReasonCode.OK, session);
    if (!LEGAL_LIFECYCLE[session.lifecycle].includes(to)) {
      return deny(
        ReasonCode.CONFLICT,
        `session lifecycle ${session.lifecycle} -> ${to} is not legal`,
        { sessionId, from: session.lifecycle, to },
      );
    }
    // The lifecycle write and the outbox fence are one transaction: a message left claimed
    // for a session that has just died would otherwise stay IN_FLIGHT until some later
    // delivery loop happened to sweep it, and a crash between the two writes would leave it
    // there permanently.
    return this.db.tx(() => {
      this.db.run(
        `UPDATE sessions SET lifecycle = ?, updated_at = ?, stopped_at = ? WHERE session_id = ?`,
        [to, this.clock.nowIso(), to === SessionLifecycle.STOPPED ? this.clock.nowIso() : session.stoppedAt, sessionId],
      );
      const fenced = this.fenceUndeliveredMessages(sessionId, to);
      this.audit.record({
        kind: "SESSION_LIFECYCLE",
        sessionId,
        evidence: { from: session.lifecycle, to, reason: reason ?? null },
      });
      if (fenced.length > 0) {
        this.audit.record({
          kind: "OUTBOX_FENCE",
          sessionId,
          reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
          evidence: { rejected: fenced, to, reason: reason ?? null },
        });
      }
      return allow(ReasonCode.OK, this.require(sessionId));
    });
  }

  /**
   * §15.7 — a session entering a terminal state can never receive or acknowledge anything,
   * so every queued or claimed message addressed to it is fenced here rather than left for
   * a delivery loop to notice. Claimed rows are included: the claim belongs to a runtime
   * that is gone, and reclaiming it would only re-offer the message to the same dead target.
   *
   * Holder-claimed kinds are the one exception, and the exclusion is the same one
   * `Outbox.fenceUndeliverable` makes. Every other kind here is addressed to *this session*, so a
   * session that is gone means the message is undeliverable. An `OWNER_MESSAGE` is addressed to a
   * **role**: while it is `PENDING` nobody has been handed it, nothing observable has happened to
   * it, and it belongs to whoever takes the role next — `Outbox.retargetOrReject` carries it to a
   * successor on a takeover and terminally closes it on a revoke, settling its ingress claim in the
   * same transaction either way.
   *
   * This write cannot do that. It is direct SQL that knows nothing about ingress claims, so an
   * owner-message reaching it went terminal with its claim left unresolved — the `(buzz, nonce)`
   * slot then permanently exempt from `IngressGuard.prune`, and the turn reported outstanding
   * forever. It also fired *first* in the ordinary failure ordering (the runtime dies, then a
   * successor binds), so it destroyed the message before the takeover could ever reach it.
   */
  private fenceUndeliveredMessages(sessionId: string, to: SessionLifecycle): string[] {
    if (to !== SessionLifecycle.ERROR && to !== SessionLifecycle.STOPPED) return [];
    const doomed = this.db
      .all<{ message_id: string }>(
        `SELECT message_id FROM outbox
          WHERE target_session_id = ? AND status IN ('PENDING','IN_FLIGHT')
            AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL})`,
        [sessionId],
      )
      .map((row) => row.message_id);
    if (doomed.length === 0) return [];
    this.db.run(
      `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE target_session_id = ? AND status IN ('PENDING','IN_FLIGHT')
          AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL})`,
      [ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, sessionId],
    );
    return doomed;
  }

  setPid(sessionId: string, pid: number | null): void {
    // #505 — the start time is captured with the pid, not later. Capturing it separately would
    // leave a window where the row names a pid nothing has identified.
    this.db.run(
      `UPDATE sessions SET os_pid = ?, os_process_started_at = ?, updated_at = ? WHERE session_id = ?`,
      [pid, processStartedAt(pid), this.clock.nowIso(), sessionId],
    );
  }

  /**
   * The exact native start token pinned for a session's process, or null.
   *
   * `os_process_started_at` keeps whatever form its writer chose. `create()` without a verified
   * pair records `ps` lstart, and `probeSessionLiveness`, the dead-binding recovery door and the
   * delegated binding's liveness check compare it as lstart. So the exact token lives beside it
   * rather than replacing it: rewriting the column to the token was rejected rather than done,
   * because those readers would then call a live process dead. Kept as the first
   * `SESSION_NATIVE_START_PINNED` audit event for the session: append-only and never rewritten,
   * so the first pin is the pin. A dedicated column would need a migration, and the migration list
   * is frozen. One pin serves every writer: a runtime the daemon starts (`createWithPinnedStart`),
   * the unread-capacity keep's legacy row, and a Gateway as incumbent adoption binds it (#1037).
   * The lineage admission and the Gateway delivery authority compare against it and never write it.
   */
  pinnedNativeStart(sessionId: string): string | null {
    const row = this.db.get<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = ? AND session_id = ? ORDER BY event_id LIMIT 1`,
      [NATIVE_START_PINNED, sessionId],
    );
    if (row === undefined) return null;
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidence_json);
    } catch {
      return null;
    }
    const startedAt = (evidence as { startedAt?: unknown } | null)?.startedAt;
    return typeof startedAt === "string" ? startedAt : null;
  }

  /** Pins `startToken` for the session unless a pin already exists; the first pin stands. */
  pinNativeStart(sessionId: string, startToken: string): void {
    if (this.pinnedNativeStart(sessionId) !== null) return;
    this.audit.record({ kind: NATIVE_START_PINNED, sessionId, evidence: { startedAt: startToken } });
  }

  /**
   * `create()` for a runtime the daemon has just started, with that runtime's native start pinned
   * beside the lstart the row records (ACP1045-R2-01, R3-01).
   *
   * The two are read as one snapshot of one process: the native token, then the lstart, then the
   * native token again. The token is pinned only when both native reads agree and the token falls
   * in the lstart's second; the row records the lstart read between them, so the row and the pin
   * name the same process. Reading the token after `create()` had recorded its own lstart, as the
   * first version did, pinned whatever held the pid by then — a successor that took it in between
   * became the incumbent the keep trusts indefinitely. When the reads disagree nothing is pinned,
   * the row keeps the lstart that was read, and the keep decides it by the legacy lstart rule.
   * The lstart is read from `ps` rather than rendered from the token: `probeSessionLiveness` and
   * the dead-binding readers compare the column with `ps` output as a string, so a rendering that
   * differed in any detail would have them call a live process dead.
   *
   * What this cannot see: a runtime that had already exited and lost its pid before the first read.
   * Then every read describes the successor, consistently, as `create()` alone always has.
   */
  createWithPinnedStart(input: Omit<Parameters<SessionRegistry["create"]>[0], "osStartedAt">): CreatedSession {
    const pid = input.osPid ?? null;
    const before = pid === null ? null : readProcessStartToken(pid);
    const startedAt = processStartedAt(pid);
    const after = pid === null ? null : readProcessStartToken(pid);
    const created = this.create({ ...input, osStartedAt: startedAt });
    const token = oneProcessStartToken(before, startedAt, after);
    if (token !== null) this.pinNativeStart(created.sessionId, token);
    return created;
  }

  /**
   * §27.2, finding #214 — binds the Buzz channel identity identity an inbound message may be resolved
   * through.
   *
   * Two independent proofs are required because either alone is forgeable. The session
   * secret proves the caller *is* the session it names. The ingress authenticator proves the
   * actor id is one the deployment authenticated on the Buzz channel — a Buzz display name
   * or channel address is attacker-chosen, so without this a local caller could map any
   * actor id onto any session and inherit the role that session holds. The binding is
   * write-once (schema trigger) and unique among live sessions (partial unique index), so a
   * later caller cannot re-point an authenticated identity at a different session.
   *
   * #1037 — the first proof has a second form. A runtime that holds no secret (an adopted Gateway
   * keeps none) proves it is this session by a lineage admission instead: the kernel peer descends
   * from the process the row recorded. That proof is accepted here as issued and not re-derived,
   * and everything after it — the allowlist, the lifecycle, the one UPDATE below — is the same code
   * for both forms. There is one writer of this column, with two ways in.
   *
   * A third way in, for the adopted CEO, which holds neither the session secret nor a signer for the
   * relay's HMAC: a possession proof. It carries the lineage admission and an identity whose key
   * signed a challenge minted for that admission, and it is accepted only as the value
   * `BuzzBindChallenges` minted after verifying that event (`isBuzzKeyPossession`).
   */
  bindBuzzActor(
    input: BindBuzzActorInput | AdmittedBindBuzzActorInput | PossessedBindBuzzActorInput,
    authenticator: BuzzActorAuthenticator,
  ): Decision<SessionRecord> {
    if ("possession" in input) return this.#bindPossessedBuzzActor(input.possession, authenticator);
    if ("admitted" in input) return this.#bindAdmittedBuzzActor(input, authenticator);
    const authenticated = this.verifySecret(input.sessionId, input.sessionSecret);
    if (!authenticated.allowed) return authenticated;

    const actorId = input.buzzActorId.trim();
    if (actorId.length === 0 || !authenticator.isAllowedActor("buzz", actorId)) {
      return deny(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "buzz channel identity identity is not authenticated by the deployment's ingress policy",
        { sessionId: input.sessionId, buzzActorId: actorId },
      );
    }
    return this.#writeBuzzActor(input.sessionId, authenticated, actorId);
  }

  /** The admitted form's proof and allowlist, then the same write. */
  #bindAdmittedBuzzActor(
    input: AdmittedBindBuzzActorInput,
    authenticator: BuzzActorAuthenticator,
  ): Decision<SessionRecord> {
    const sessionId = input.admitted.sessionId;
    const authenticated = this.#admittedSession(input.admitted);
    if (!authenticated.allowed) return authenticated;
    const actorId = input.buzzActorId.trim();
    const unauthenticated = (): Decision<SessionRecord> =>
      deny(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "buzz channel identity is not authenticated by the deployment's ingress policy",
        { sessionId, buzzActorId: actorId },
      );
    if (actorId.length === 0) return unauthenticated();
    if (!authenticator.isAllowedActor("buzz", actorId)) return unauthenticated();
    return this.#writeBuzzActor(sessionId, authenticated, actorId);
  }

  /**
   * The possession form's proof and allowlist, then the refusals the admitted ingress gives before it
   * writes — a terminal runtime, a different identity already held, a key any other row carries —
   * and the same write. The identity the session already holds is answered as bound, unwritten.
   */
  #bindPossessedBuzzActor(
    possession: BuzzKeyPossession,
    authenticator: BuzzActorAuthenticator,
  ): Decision<SessionRecord> {
    if (!isBuzzKeyPossession(possession)) {
      return deny(ReasonCode.CONFLICT, "the identity proof was not issued by a verified Buzz binding event", {});
    }
    const sessionId = possession.runtime.sessionId;
    const authenticated = this.#admittedSession(possession.runtime);
    if (!authenticated.allowed) return authenticated;
    const actorId = possession.buzzActorId;
    if (!authenticator.isAllowedActor("buzz", actorId)) {
      return deny(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "buzz channel identity is not authenticated by the deployment's ingress policy",
        { sessionId, buzzActorId: actorId },
      );
    }
    const lifecycle = authenticated.value.lifecycle;
    if (lifecycle === SessionLifecycle.STOPPED || lifecycle === SessionLifecycle.ERROR) {
      return deny(ReasonCode.SESSION_NOT_READY, "a terminal session cannot acquire an actor identity", {
        sessionId,
        lifecycle,
      });
    }
    if (authenticated.value.buzzActorId === actorId) return authenticated;
    if (authenticated.value.buzzActorId !== null) {
      return deny(ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE, "session already speaks as a different buzz channel identity", {
        sessionId,
      });
    }
    if (this.otherSessionCarrying(actorId, sessionId) !== null) {
      return deny(ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND, "another session row already carries this identity", {
        sessionId,
      });
    }
    return this.#writeBuzzActor(sessionId, authenticated, actorId);
  }

  /**
   * An admission this registry did not see happen is accepted only as the value its issuer minted
   * (`isAdmittedRuntime`), and only while the row is still the incarnation it was admitted as.
   */
  #admittedSession(admitted: AdmittedRuntime): Decision<SessionRecord> {
    if (!isAdmittedRuntime(admitted)) {
      return deny(ReasonCode.CONFLICT, "the session proof was not issued by a lineage admission", {});
    }
    const session = this.get(admitted.sessionId);
    if (session === null) {
      return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: admitted.sessionId });
    }
    if (session.incarnation !== admitted.sessionIncarnation) {
      return deny(ReasonCode.ACTOR_SESSION_INCARNATION_MISMATCH, "the admitted runtime was respawned", {
        sessionId: admitted.sessionId,
      });
    }
    return allow(ReasonCode.OK, session);
  }

  /** The one write of `sessions.buzz_actor_id`, after either form of proof. */
  #writeBuzzActor(
    sessionId: string,
    authenticated: { value: SessionRecord },
    actorId: string,
  ): Decision<SessionRecord> {
    if (
      authenticated.value.lifecycle === SessionLifecycle.STOPPED ||
      authenticated.value.lifecycle === SessionLifecycle.ERROR
    ) {
      return deny(
        ReasonCode.SESSION_NOT_READY,
        "a terminal session cannot acquire an actor identity",
        { sessionId, lifecycle: authenticated.value.lifecycle },
      );
    }

    try {
      // Re-binding the identity it already holds is idempotent; anything else is refused
      // rather than overwritten, which is what makes the mapping non-transferable.
      const changes = this.db.run(
        `UPDATE sessions SET buzz_actor_id = ?, updated_at = ?
          WHERE session_id = ? AND (buzz_actor_id IS NULL OR buzz_actor_id = ?)`,
        [actorId, this.clock.nowIso(), sessionId, actorId],
      ).changes;
      if (changes !== 1) {
        return deny(
          ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE,
          "session already speaks as a different buzz channel identity identity",
          { sessionId, buzzActorId: actorId },
        );
      }
    } catch (err) {
      if (isAcpError(err) && err.reasonCode === ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND) {
        return deny(err.reasonCode, err.message, {
          sessionId,
          buzzActorId: actorId,
        });
      }
      throw err;
    }

    this.audit.record({
      kind: "SESSION_BUZZ_ACTOR_BOUND",
      sessionId,
      // The identity itself belongs in the actor column, which is where every other
      // channel-scoped actor is recorded; evidence stays a decision summary.
      actor: `buzz:${actorId}`,
      evidence: { channel: "buzz" },
    });
    return allow(ReasonCode.OK, this.require(sessionId));
  }

  /**
   * Another session row that carries this Buzz channel identity, live or not; a read for refusing
   * early. A stopped row keeps the column, and #1038's peer rule reads any other holder of a key as
   * making that key's events ambiguous, so a binding onto it would bind nothing usable.
   */
  otherSessionCarrying(buzzActorId: string, sessionId: string): string | null {
    const row = this.db.get<{ session_id: string }>(
      `SELECT session_id FROM sessions WHERE buzz_actor_id = ? AND session_id <> ? ORDER BY session_id LIMIT 1`,
      [buzzActorId, sessionId],
    );
    return row?.session_id ?? null;
  }

  setBuzzAddress(sessionId: string, address: string | null): void {
    this.db.run(`UPDATE sessions SET buzz_address = ?, updated_at = ? WHERE session_id = ?`, [
      address,
      this.clock.nowIso(),
      sessionId,
    ]);
  }

  /** PRD §9.3 — BUSY is computed, not stored. */
  isBusy(sessionId: string): boolean {
    return this.ownedActiveRuns(sessionId).length > 0;
  }

  ownedActiveRuns(sessionId: string): string[] {
    return this.db
      .all<{ run_id: string }>(
        `SELECT run_id FROM runs
          WHERE owner_session_id = ?
            AND state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW','CEO_APPROVED',
                          'MERGING','POST_MERGE_VERIFYING','REVISION_REQUIRED','AWAITING_HUMAN')`,
        [sessionId],
      )
      .map((r) => r.run_id);
  }

  get(sessionId: string): SessionRecord | null {
    const row = this.db.get<RawSession>(`SELECT * FROM sessions WHERE session_id = ?`, [sessionId]);
    return row ? hydrate(row) : null;
  }

  require(sessionId: string): SessionRecord {
    return this.get(sessionId) ?? fail(ReasonCode.NOT_FOUND, "unknown session", { sessionId });
  }

  list(lifecycle?: SessionLifecycle): SessionRecord[] {
    const rows = lifecycle
      ? this.db.all<RawSession>(`SELECT * FROM sessions WHERE lifecycle = ? ORDER BY created_at, session_id`, [
          lifecycle,
        ])
      : this.db.all<RawSession>(`SELECT * FROM sessions ORDER BY created_at, session_id`);
    return rows.map(hydrate);
  }

  live(): SessionRecord[] {
    return this.db
      .all<RawSession>(
        `SELECT * FROM sessions WHERE lifecycle IN ('STARTING','READY','DRAINING') ORDER BY created_at, session_id`,
      )
      .map(hydrate);
  }

  private secretStorageAvailable(): boolean {
    return this.db
      .all<{ name: string }>(`PRAGMA table_info(sessions)`)
      .some((column) => column.name === "session_secret_hash");
  }
}

interface RawSession {
  session_id: string;
  incarnation: string;
  provider: string;
  model: string;
  effort: string | null;
  lifecycle: SessionLifecycle;
  buzz_address: string | null;
  buzz_actor_id: string | null;
  os_pid: number | null;
  os_process_started_at: string | null;
  workdir: string | null;
  created_at: string;
  updated_at: string;
  stopped_at: string | null;
}

const hydrate = (row: RawSession): SessionRecord => ({
  sessionId: row.session_id,
  incarnation: row.incarnation,
  provider: row.provider,
  model: row.model,
  effort: row.effort,
  lifecycle: row.lifecycle,
  buzzAddress: row.buzz_address,
  buzzActorId: row.buzz_actor_id,
  osPid: row.os_pid,
  osProcessStartedAt: row.os_process_started_at,
  workdir: row.workdir,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  stoppedAt: row.stopped_at,
});
