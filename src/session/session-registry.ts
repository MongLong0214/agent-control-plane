import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail, isAcpError } from "../core/errors.ts";
import { newSessionId } from "../core/ids.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { SessionLifecycle } from "../domain/types.ts";

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
export interface BuzzActorAuthenticator {
  isAllowedActor(channel: string, actor: string): boolean;
}

export interface BindBuzzActorInput {
  sessionId: string;
  /** Proof the caller is this session; a session id alone is public and proves nothing. */
  sessionSecret: string;
  buzzActorId: string;
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
    sessionId?: string;
    incarnation?: string;
  }): CreatedSession {
    const now = this.clock.nowIso();
    const sessionId = input.sessionId ?? newSessionId();
    const incarnation = input.incarnation ?? `${sessionId}#${now}`;
    const sessionSecret = this.secretStorageAvailable()
      ? randomBytes(SESSION_SECRET_BYTES).toString("base64url")
      : null;
    if (sessionSecret) {
      this.db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, effort, lifecycle,
                               buzz_address, os_pid, os_process_started_at, workdir,
                               session_secret_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId, incarnation, input.provider, input.model, input.effort ?? null,
          input.buzzAddress ?? null, input.osPid ?? null, processStartedAt(input.osPid),
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
          input.buzzAddress ?? null, input.osPid ?? null, processStartedAt(input.osPid),
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
    if (!validStoredHash || !matches) {
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
   */
  private fenceUndeliveredMessages(sessionId: string, to: SessionLifecycle): string[] {
    if (to !== SessionLifecycle.ERROR && to !== SessionLifecycle.STOPPED) return [];
    const doomed = this.db
      .all<{ message_id: string }>(
        `SELECT message_id FROM outbox
          WHERE target_session_id = ? AND status IN ('PENDING','IN_FLIGHT')`,
        [sessionId],
      )
      .map((row) => row.message_id);
    if (doomed.length === 0) return [];
    this.db.run(
      `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE target_session_id = ? AND status IN ('PENDING','IN_FLIGHT')`,
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
   */
  bindBuzzActor(
    input: BindBuzzActorInput,
    authenticator: BuzzActorAuthenticator,
  ): Decision<SessionRecord> {
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
    if (
      authenticated.value.lifecycle === SessionLifecycle.STOPPED ||
      authenticated.value.lifecycle === SessionLifecycle.ERROR
    ) {
      return deny(
        ReasonCode.SESSION_NOT_READY,
        "a terminal session cannot acquire an actor identity",
        { sessionId: input.sessionId, lifecycle: authenticated.value.lifecycle },
      );
    }

    try {
      // Re-binding the identity it already holds is idempotent; anything else is refused
      // rather than overwritten, which is what makes the mapping non-transferable.
      const changes = this.db.run(
        `UPDATE sessions SET buzz_actor_id = ?, updated_at = ?
          WHERE session_id = ? AND (buzz_actor_id IS NULL OR buzz_actor_id = ?)`,
        [actorId, this.clock.nowIso(), input.sessionId, actorId],
      ).changes;
      if (changes !== 1) {
        return deny(
          ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE,
          "session already speaks as a different buzz channel identity identity",
          { sessionId: input.sessionId, buzzActorId: actorId },
        );
      }
    } catch (err) {
      if (isAcpError(err) && err.reasonCode === ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND) {
        return deny(err.reasonCode, err.message, {
          sessionId: input.sessionId,
          buzzActorId: actorId,
        });
      }
      throw err;
    }

    this.audit.record({
      kind: "SESSION_BUZZ_ACTOR_BOUND",
      sessionId: input.sessionId,
      // The identity itself belongs in the actor column, which is where every other
      // channel-scoped actor is recorded; evidence stays a decision summary.
      actor: `buzz:${actorId}`,
      evidence: { channel: "buzz" },
    });
    return allow(ReasonCode.OK, this.require(input.sessionId));
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
      ? this.db.all<RawSession>(`SELECT * FROM sessions WHERE lifecycle = ? ORDER BY created_at`, [
          lifecycle,
        ])
      : this.db.all<RawSession>(`SELECT * FROM sessions ORDER BY created_at`);
    return rows.map(hydrate);
  }

  live(): SessionRecord[] {
    return this.db
      .all<RawSession>(
        `SELECT * FROM sessions WHERE lifecycle IN ('STARTING','READY','DRAINING') ORDER BY created_at`,
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
  workdir: row.workdir,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  stoppedAt: row.stopped_at,
});
