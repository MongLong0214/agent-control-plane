import { resolve } from "node:path";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { acpError, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export type SqliteDatabase = Database.Database;

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * Version of the shape in schema.sql. Bump this whenever a constraint, trigger or column
 * changes. There is no ordered migration path: `CREATE TABLE IF NOT EXISTS` would silently
 * preserve an older table whose constraints are weaker, so version mismatch is refused
 * instead of pretending that a deployed database was migrated (§40 Maintainability).
 */
export const SCHEMA_VERSION = 7;

/**
 * SQLite handle plus the transaction discipline required by PRD §30.3.
 *
 * Every section listed there — binding failover, run owner takeover, gate publish
 * record, merge receipt, claim acquire/release, state transition + outbox enqueue —
 * goes through `tx()`, which uses BEGIN IMMEDIATE so two writers cannot interleave
 * a read-then-write race.
 */
export class Db {
  readonly raw: SqliteDatabase;
  #depth = 0;
  #poisoned = false;

  /**
   * The file this connection opened. Capability issuance is keyed by it: two `Db` objects
   * over the same file are the same resource, and keying by instance let a second one mint
   * a fresh set of evidence writers for rows the composition root already owned (#352).
   */
  readonly file: string;

  constructor(filename: string) {
    this.file = filename === ":memory:" ? `:memory:${Math.random()}` : resolve(filename);
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.raw = new Database(filename);
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("busy_timeout = 10000");
    if (filename !== ":memory:") {
      this.raw.pragma("journal_mode = WAL");
      this.raw.pragma("synchronous = FULL");
    }
    this.applySchema();
  }

  /**
   * Applies the schema exactly once and pins the version. Anything unexpected fails
   * closed rather than running against a database whose constraints are unknown.
   */
  private applySchema(): void {
    const version = Number(this.raw.pragma("user_version", { simple: true }));
    const alreadyPopulated =
      this.raw
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
        .get() as { n: number };

    if (version === 0 && alreadyPopulated.n > 0) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database predates schema versioning; its constraints cannot be verified",
        { expected: SCHEMA_VERSION, found: version, action: "recreate or migrate the database" },
      );
    }
    if (version === 0) {
      this.raw.exec(readFileSync(schemaPath, "utf8"));
      this.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (version !== SCHEMA_VERSION) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        version < SCHEMA_VERSION
          ? "database schema is older than this build and no migration is defined"
          : "database schema is newer than this build",
        { expected: SCHEMA_VERSION, found: version },
      );
    }
    // Same version: re-running the idempotent DDL adds nothing, but it does verify the
    // file still parses against this SQLite build.
    this.raw.exec(readFileSync(schemaPath, "utf8"));
  }

  /**
   * Runs `fn` inside a single write transaction. Nested calls join the outer
   * transaction rather than opening a second one — SQLite has no real nesting and a
   * silent second BEGIN would commit the outer work early.
   */
  tx<T>(fn: () => T): T {
    this.assertUsable();
    if (this.#depth > 0) return this.guardSync(fn());
    this.raw.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const out = this.guardSync(fn());
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* rollback of an already-aborted tx is not itself an error */
      }
      if (isAsyncTransactionError(err)) this.poison();
      throw translate(err);
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * A transaction body must be synchronous. An async callback would return a pending
   * promise, COMMIT would run before the work finished, and writes after the first await
   * would land outside the transaction with no way to roll them back — silently voiding
   * every §30.3 atomicity guarantee.
   */
  private guardSync<T>(out: T): T {
    if (out && typeof (out as { then?: unknown }).then === "function") {
      // The callback cannot be cancelled. Consume its rejection and poison the handle after
      // the owner rolls back, so code after its first await cannot escape into autocommit.
      void Promise.resolve(out).catch(() => undefined);
      throw asyncTransactionError();
    }
    return out;
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  exec(sql: string): void {
    this.assertUsable();
    this.raw.exec(sql);
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    this.assertUsable();
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    this.assertUsable();
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, params: unknown[] = []): Database.RunResult {
    this.assertUsable();
    try {
      return this.raw.prepare(sql).run(...(params as never[]));
    } catch (err) {
      throw translate(err);
    }
  }

  close(): void {
    if (this.raw.open) this.raw.close();
  }

  private assertUsable(): void {
    if (!this.#poisoned) return;
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "database handle was poisoned by an asynchronous transaction callback",
      {},
    );
  }

  private poison(): void {
    this.#poisoned = true;
    if (this.raw.open) this.raw.close();
  }
}

const ASYNC_TRANSACTION = Symbol("async-transaction");

type AsyncTransactionError = Error & { [ASYNC_TRANSACTION]: true };

const asyncTransactionError = (): AsyncTransactionError =>
  Object.assign(
    acpError(
      ReasonCode.INTERNAL_ERROR,
      "transaction callback returned a promise; transaction bodies must be synchronous",
      {},
    ),
    { [ASYNC_TRANSACTION]: true as const },
  );

const isAsyncTransactionError = (err: unknown): err is AsyncTransactionError =>
  Boolean(
    err &&
      typeof err === "object" &&
      ASYNC_TRANSACTION in err &&
      (err as { [ASYNC_TRANSACTION]?: unknown })[ASYNC_TRANSACTION] === true,
  );

/**
 * Turn the DB-level guard rails into the same reason codes the service layer uses,
 * so a constraint violation is never reported as an opaque SQLITE_CONSTRAINT.
 */
const TRIGGER_CODES: Record<string, ReasonCode> = {
  SESSION_INCARNATION_IMMUTABLE: ReasonCode.SESSION_INCARNATION_IMMUTABLE,
  SESSION_BUZZ_ACTOR_IMMUTABLE: ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE,
  OUTBOX_REQUEST_FINGERPRINT_IMMUTABLE: ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
  BINDING_GENERATION_NOT_MONOTONIC: ReasonCode.BINDING_GENERATION_STALE,
  BINDING_IDENTITY_IMMUTABLE: ReasonCode.BINDING_GENERATION_STALE,
  BINDING_REVOKED_TERMINAL: ReasonCode.BINDING_REVOKED,
  PINNED_MANIFEST_IMMUTABLE: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
  RUN_STATE_TRANSITION_ILLEGAL: ReasonCode.RUN_TRANSITION_ILLEGAL,
  EVIDENCE_CANDIDATE_MISMATCH: ReasonCode.SNAPSHOT_DIGEST_MISMATCH,
  ARTIFACT_IMMUTABLE: ReasonCode.CONFLICT,
  GITHUB_RECEIPT_IMMUTABLE: ReasonCode.CONFLICT,
  GITHUB_RECEIPT_PROTOCOL_VIOLATION: ReasonCode.GITHUB_RECEIPT_PROTOCOL_VIOLATION,
  MANIFEST_IMMUTABLE: ReasonCode.CONFLICT,
  AUDIT_APPEND_ONLY: ReasonCode.CONFLICT,
};

/**
 * SQLite reports a partial-index violation by column list, not by index name, so the
 * patterns below match the columns each guard rail is built on.
 */
const INDEX_CODES: Array<[RegExp, ReasonCode, string]> = [
  [/assignments\.project_id/, ReasonCode.PRIMARY_CTO_ALREADY_BOUND, "project already has an active primary CTO binding"],
  [/assignments\.role_key/, ReasonCode.BINDING_ALREADY_ACTIVE, "role key already has an active binding"],
  [/resource_claims\.worktree_id/, ReasonCode.CLAIM_WORKTREE_CONFLICT, "worktree already claimed by another holder"],
  [/resource_claims\.branch/, ReasonCode.CLAIM_BRANCH_CONFLICT, "branch already claimed by another holder"],
  [/resource_claims\.declared_path/, ReasonCode.CLAIM_PATH_CONFLICT, "declared write path already claimed by another holder"],
  [/outbox\.idempotency_key/, ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, "outbox idempotency key already used"],
  [/sessions\.buzz_actor_id/, ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND, "buzz actor identity is already bound to a live session"],
  [/github_receipts\.idempotency_key/, ReasonCode.MERGE_IDEMPOTENT_REPLAY, "github operation already executed"],
  [/capacity_snapshots\./, ReasonCode.CONFLICT, "duplicate capacity snapshot"],
  [/verification_results\./, ReasonCode.CONFLICT, "duplicate verification result for this candidate"],
  [/task_executions\./, ReasonCode.CONFLICT, "duplicate task execution attempt"],
  [/manifests\./, ReasonCode.CONFLICT, "manifest digest already stored"],
];

export const translate = (err: unknown): unknown => {
  if (!(err instanceof Error) || isAcpError(err)) return err;
  const msg = err.message;
  for (const [key, code] of Object.entries(TRIGGER_CODES)) {
    if (msg.includes(key)) return acpError(code, msg, { sqlite: key });
  }
  for (const [pattern, code, message] of INDEX_CODES) {
    if (pattern.test(msg)) return acpError(code, message, { sqlite: msg });
  }
  if (msg.includes("FOREIGN KEY constraint failed")) {
    return acpError(ReasonCode.RUN_OWNER_REVOKED, "foreign-key authority tuple is invalid", {
      sqlite: msg,
    });
  }
  return err;
};

export const openDb = (filename: string): Db => new Db(filename);
