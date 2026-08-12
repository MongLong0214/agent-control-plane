import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newSessionId } from "../core/ids.ts";
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
  osPid: number | null;
  workdir: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
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
                               buzz_address, os_pid, workdir, session_secret_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?, ?)`,
        [
          sessionId, incarnation, input.provider, input.model, input.effort ?? null,
          input.buzzAddress ?? null, input.osPid ?? null, input.workdir ?? null,
          hashSessionSecret(sessionSecret).toString("hex"), now, now,
        ],
      );
    } else {
      this.db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, effort, lifecycle,
                               buzz_address, os_pid, workdir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'STARTING', ?, ?, ?, ?, ?)`,
        [
          sessionId, incarnation, input.provider, input.model, input.effort ?? null,
          input.buzzAddress ?? null, input.osPid ?? null, input.workdir ?? null, now, now,
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
    this.db.run(
      `UPDATE sessions SET lifecycle = ?, updated_at = ?, stopped_at = ? WHERE session_id = ?`,
      [to, this.clock.nowIso(), to === SessionLifecycle.STOPPED ? this.clock.nowIso() : session.stoppedAt, sessionId],
    );
    this.audit.record({
      kind: "SESSION_LIFECYCLE",
      sessionId,
      evidence: { from: session.lifecycle, to, reason: reason ?? null },
    });
    return allow(ReasonCode.OK, this.require(sessionId));
  }

  setPid(sessionId: string, pid: number | null): void {
    this.db.run(`UPDATE sessions SET os_pid = ?, updated_at = ? WHERE session_id = ?`, [
      pid,
      this.clock.nowIso(),
      sessionId,
    ]);
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
            AND state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW','REVISION_REQUIRED','AWAITING_HUMAN')`,
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
  osPid: row.os_pid,
  workdir: row.workdir,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  stoppedAt: row.stopped_at,
});
