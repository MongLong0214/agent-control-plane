import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/** The ordered registry is the only authority for changing a deployed schema. */
export const SCHEMA_VERSION = 22;

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export const schemaSql = (): string => readFileSync(schemaPath, "utf8");

/** Connection PRAGMAs are established by Db before any migration transaction begins. */
export const schemaDdl = (): string =>
  schemaSql().replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys|synchronous)\s*=\s*[^;]+;\s*$/gim, "");

export interface SchemaMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  /** Applies only additive DDL or an explicit, reviewed table rebuild. */
  apply(raw: Database.Database): void;
  /** Captures the exact source shape applied in this migration receipt. */
  checksum(): string;
  /** A reviewed parent-table rebuild may need foreign-key checks disabled for its transaction. */
  foreignKeysOffDuringApply?: boolean;
}

const sha256 = (input: string): string =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;

const migrationChecksum = (id: string): string => sha256(`${id}\n${schemaSql()}`);

/**
 * Migration metadata is intentionally separate from schema.sql. It is bootstrap state for
 * the migrator itself and is protected by the same connection-local authority model as
 * evidence rows, so a runtime handler cannot invent a successful upgrade receipt.
 */
export const installMigrationLedger = (raw: Database.Database): void => {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY CHECK (version > 0),
      migration_id    TEXT NOT NULL UNIQUE,
      checksum        TEXT NOT NULL CHECK (checksum LIKE 'sha256:%'),
      backup_file     TEXT,
      backup_checksum TEXT,
      applied_at      TEXT NOT NULL,
      CHECK ((backup_file IS NULL) = (backup_checksum IS NULL))
    );

    CREATE TRIGGER IF NOT EXISTS schema_migrations_insert_authority
    BEFORE INSERT ON schema_migrations
    WHEN acp_schema_migration_authorized() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_AUTHORITY_DENIED');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_immutable
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;
  `);
};

/**
 * v11 was the previous released state. v12 adds the durable migration ledger and replays
 * the idempotent schema objects so a v11 database missing a load-bearing trigger is repaired
 * only as part of this explicit upgrade. A same-version open never repairs corruption.
 *
 * Any later column/check/table change must add another ordered entry here. Re-running
 * CREATE TABLE IF NOT EXISTS is deliberately not presented as a general migration path.
 */
/**
 * The v12 replay reads the *live* schema.sql, so it drifts forward as the schema evolves. That
 * is fine for objects a v11 database can already satisfy, and it breaks for any object that
 * depends on a column a later migration adds: `CREATE TABLE IF NOT EXISTS assignments` is a
 * no-op against the existing v11 table, so a trigger naming `NEW.actor_id` is created against a
 * table that has no such column and the whole chain aborts.
 *
 * #449 is the first change to add a column to an existing table, which is why this was latent
 * until now. The two actor-dependent objects are withheld from the replay and created by v18,
 * which is the migration that adds the column they need. v20 adds a different failure mode:
 * replaying the live DDL at v12 creates its whole new tables early, so the ordered v20
 * `CREATE TABLE` statements later abort with "already exists". A fresh install never goes
 * through here — it applies schema.sql whole — so it still gets all current objects.
 *
 * The general rule this encodes: an object in schema.sql introduced by a migration after v12
 * must be excluded here and created by the migration that owns it.
 */
const REPLAY_EXCLUDES_INTRODUCED_AFTER_V12 = [
  /CREATE INDEX IF NOT EXISTS assignments_actor[^;]*;/,
  /-- CP-HI-04 — the identity columns of a binding are fixed once written\.[\s\S]*?CREATE TRIGGER IF NOT EXISTS assignments_generation_immutable[\s\S]*?\nEND;/,
  /-- ---------------------------------------------------------------------------\n-- conversational_actor_registrations[\s\S]*?(?=-- ---------------------------------------------------------------------------\n-- assignments)/,
];

export const replayDdlWithoutPostV12Columns = (): string =>
  REPLAY_EXCLUDES_INTRODUCED_AFTER_V12.reduce((ddl, pattern) => ddl.replace(pattern, ""), schemaDdl());

const v12: SchemaMigration = {
  id: "v12-migration-ledger-and-invariant-replay",
  fromVersion: 11,
  toVersion: 12,
  apply: (raw) => {
    raw.exec(replayDdlWithoutPostV12Columns());
    installMigrationLedger(raw);
  },
  checksum: () => migrationChecksum("v12-migration-ledger-and-invariant-replay"),
};

/**
 * v13 carries the finalization state machine introduced after the v12 ledger release. The
 * state CHECK and its transition/sealing triggers are part of the durable contract, so this
 * is an explicit parent-table rebuild rather than another `CREATE IF NOT EXISTS` replay.
 */
const v13: SchemaMigration = {
  id: "v13-finalization-state-machine",
  fromVersion: 12,
  toVersion: 13,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    raw.exec(`
      DROP TRIGGER IF EXISTS runs_state_transition_guard;
      DROP TRIGGER IF EXISTS runs_state_transition_authority_guard;
      DROP TRIGGER IF EXISTS tasks_run_work_sealed;

      CREATE TABLE runs_finalization_migration (
        run_id                    TEXT PRIMARY KEY,
        project_id                TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
        kind                      TEXT NOT NULL
                                  CHECK (kind IN ('STANDARD_WORK','PROJECT_BOOTSTRAP','CONTRACT_CHANGE')),
        execution_mode            TEXT NOT NULL CHECK (execution_mode IN ('SIMPLE','STANDARD','GUARDED')),
        priority                  TEXT NOT NULL CHECK (priority IN ('CRITICAL','NORMAL','LOW')),
        state                     TEXT NOT NULL
                                  CHECK (state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW',
                                                   'CEO_APPROVED','MERGING','POST_MERGE_VERIFYING',
                                                   'BLOCKED_POST_MERGE','REVISION_REQUIRED','AWAITING_HUMAN',
                                                   'COMPLETED','FAILED','CANCELLED')),
        goal                      TEXT NOT NULL,
        contract_digest           TEXT NOT NULL,
        pinned_manifest_digest    TEXT REFERENCES manifests(digest),
        pinned_run_scoped_commands_digest TEXT,
        pinned_run_scoped_commands_json   TEXT,
        owner_session_id          TEXT REFERENCES sessions(session_id),
        owner_binding_generation  INTEGER,
        owner_session_incarnation TEXT,
        owner_role_key            TEXT,
        current_candidate_digest  TEXT,
        human_gate_required       INTEGER NOT NULL DEFAULT 0 CHECK (human_gate_required IN (0,1)),
        revision_count            INTEGER NOT NULL DEFAULT 0,
        created_at                TEXT NOT NULL,
        dispatched_at             TEXT,
        ended_at                  TEXT,
        state_reason              TEXT,
        CHECK ((owner_session_id IS NULL) = (owner_binding_generation IS NULL)),
        CHECK ((owner_session_id IS NULL) = (owner_session_incarnation IS NULL)),
        CHECK ((owner_session_id IS NULL) = (owner_role_key IS NULL)),
        CHECK ((pinned_run_scoped_commands_digest IS NULL) = (pinned_run_scoped_commands_json IS NULL)),
        FOREIGN KEY (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation)
          REFERENCES assignments(role_key, binding_generation, session_id, session_incarnation)
          DEFERRABLE INITIALLY DEFERRED
      );

      INSERT INTO runs_finalization_migration (
        run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
        pinned_manifest_digest, pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json,
        owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key,
        current_candidate_digest, human_gate_required, revision_count, created_at, dispatched_at,
        ended_at, state_reason
      )
      SELECT
        run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
        pinned_manifest_digest, pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json,
        owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key,
        current_candidate_digest, human_gate_required, revision_count, created_at, dispatched_at,
        ended_at, state_reason
      FROM runs;

      DROP TABLE runs;
      ALTER TABLE runs_finalization_migration RENAME TO runs;
    `);

    // Re-run the current idempotent DDL after the rebuild. The three dropped triggers are
    // recreated with the finalization edges and the new task-sealing states.
    //
    // Same forward drift as the v12 replay, and the reason the pinned v11 fixture kept failing
    // after three fixes aimed at v18: this replays the live schema.sql while `assignments`
    // still has no `actor_id`, five migrations before v18 adds it.
    raw.exec(replayDdlWithoutPostV12Columns());
  },
  checksum: () => migrationChecksum("v13-finalization-state-machine"),
};

const BASELINE_RECORDS_DDL = `
  CREATE TABLE IF NOT EXISTS baseline_records (
    record_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    record_kind    TEXT NOT NULL,
    schema_id      TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (payload_digest LIKE 'sha256:%'),
    UNIQUE (run_id, record_kind, payload_digest)
  );

  CREATE TRIGGER IF NOT EXISTS baseline_records_immutable
  BEFORE UPDATE ON baseline_records
  BEGIN
    SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS baseline_records_no_delete
  BEFORE DELETE ON baseline_records
  BEGIN
    SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
  END;

  CREATE INDEX IF NOT EXISTS baseline_records_run_kind
    ON baseline_records(run_id, record_kind, recorded_at, record_id);
`;

/** v14 adds the immutable baseline evidence ledger after the reserved v13 state machine. */
const v14: SchemaMigration = {
  id: "v14-baseline-evidence-ledger",
  fromVersion: 13,
  toVersion: 14,
  apply: (raw) => raw.exec(BASELINE_RECORDS_DDL),
  checksum: () => sha256(`v14-baseline-evidence-ledger\n${BASELINE_RECORDS_DDL}`),
};

const VERIFICATION_WORKTREES_DDL = `
  CREATE TABLE IF NOT EXISTS verification_worktrees (
    worktree_id               TEXT PRIMARY KEY,
    run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    command_id                TEXT NOT NULL,
    candidate_snapshot_digest TEXT NOT NULL,
    repository_identity       TEXT NOT NULL,
    repository_checkout_path  TEXT NOT NULL,
    worktree_path             TEXT NOT NULL UNIQUE,
    head                      TEXT NOT NULL,
    owner_session_id          TEXT NOT NULL REFERENCES sessions(session_id),
    owner_binding_generation  INTEGER NOT NULL,
    owner_role_key            TEXT NOT NULL,
    state                     TEXT NOT NULL
                                CHECK (state IN ('CREATING','ACTIVE','DESTROYING','DESTROYED','FAILED')),
    created_at                TEXT NOT NULL,
    active_at                 TEXT,
    ended_at                  TEXT
  );

  CREATE INDEX IF NOT EXISTS verification_worktrees_live
    ON verification_worktrees(repository_identity, state, worktree_id);
`;

/** v15 makes verification worktree ownership durable before Git materialises the tree. */
const v15: SchemaMigration = {
  id: "v15-durable-verification-worktree-ownership",
  fromVersion: 14,
  toVersion: 15,
  apply: (raw) => raw.exec(VERIFICATION_WORKTREES_DDL),
  checksum: () => sha256(`v15-durable-verification-worktree-ownership\n${VERIFICATION_WORKTREES_DDL}`),
};

const SESSION_WORKDIR_DDL = `
  CREATE TRIGGER IF NOT EXISTS sessions_workdir_immutable
  BEFORE UPDATE OF workdir ON sessions
  WHEN OLD.workdir IS NOT NULL
    AND (NEW.workdir IS NULL OR NEW.workdir <> OLD.workdir)
  BEGIN
    SELECT RAISE(ABORT, 'SESSION_WORKDIR_IMMUTABLE');
  END;
`;

/**
 * v16 makes the workdir recorded for a provisioned session an immutable routing fact.
 *
 * Written against v14 on a branch that predates v15, and renumbered on landing rather than
 * merged into it: a migration's version is its position in an ordered chain that databases
 * have already walked, so two migrations cannot share one number and the earlier-landed
 * chain is the one that must not move.
 */
const v16: SchemaMigration = {
  id: "v16-session-workdir-immutability",
  fromVersion: 15,
  toVersion: 16,
  apply: (raw) => raw.exec(SESSION_WORKDIR_DDL),
  checksum: () => sha256(`v16-session-workdir-immutability\n${SESSION_WORKDIR_DDL}`),
};

const TELEGRAM_OWNER_PROMPTS_DDL = `
  CREATE TABLE IF NOT EXISTS telegram_owner_prompts (
    chat_id                    TEXT NOT NULL,
    message_id                 INTEGER NOT NULL CHECK (message_id > 0),
    correlation_id             TEXT NOT NULL,
    run_id                     TEXT NOT NULL,
    candidate_snapshot_digest  TEXT NOT NULL CHECK (candidate_snapshot_digest LIKE 'sha256:%'),
    created_at                 TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS telegram_owner_prompts_run
    ON telegram_owner_prompts(run_id, created_at);

  CREATE TRIGGER IF NOT EXISTS telegram_owner_prompts_immutable
  BEFORE UPDATE ON telegram_owner_prompts
  BEGIN
    SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS telegram_owner_prompts_no_delete
  BEFORE DELETE ON telegram_owner_prompts
  BEGIN
    SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
  END;

`;

/**
 * v17 persists the candidate shown by each Telegram owner gate prompt.
 *
 * Written against v14, and renumbered twice on the way in — this lane and the workdir lane
 * were both cut before v15 landed. The chain is ordered and databases have already walked
 * it, so a migration takes the next free number rather than the one it was written against.
 */
const v17: SchemaMigration = {
  id: "v17-telegram-owner-prompts",
  fromVersion: 16,
  toVersion: 17,
  apply: (raw) => raw.exec(TELEGRAM_OWNER_PROMPTS_DDL),
  checksum: () => sha256(`v17-telegram-owner-prompts\n${TELEGRAM_OWNER_PROMPTS_DDL}`),
};

/**
 * v18 separates the conversational actor from the model runtime serving it (#449).
 *
 * `assignments` bound a role to a session. A session is a replaceable runtime, so failover had
 * to write a new binding, which advanced `binding_generation` — and rotating the generation is
 * how this system fences a superseded role holder. The effect was that recovering a crashed
 * runtime silently retired the CTO the owner was mid-conversation with.
 *
 * The live runtime pointer moves to `conversational_actors.current_session_id`, which failover
 * updates in place. `binding_generation` then advances only when the actor itself is replaced,
 * which is what it was always meant to mean.
 *
 * `assignments.session_id` is deliberately kept and stays immutable, demoted from identity to
 * *the runtime at binding time*. That is the fact it always actually recorded, and keeping it
 * is what leaves `assignments_owner_tuple` — and therefore the composite FK from `runs` — valid
 * without rebuilding `runs`. The tuple identifies a binding row; it was never a live pointer.
 *
 * Backfill gives every existing binding its own actor rather than collapsing a role_key's
 * history into one. Before v18 a new generation was written precisely because the runtime was
 * replaced, and nothing observed whether the conversation survived it. One actor per row
 * asserts nothing; one actor per role_key would assert a continuity no row records.
 */
const CONVERSATIONAL_ACTOR_DDL = `
  CREATE TABLE IF NOT EXISTS conversational_actors (
    actor_id                    TEXT PRIMARY KEY,
    kind                        TEXT NOT NULL
                                  CHECK (kind IN ('CEO','BOOTSTRAP_CTO','PRIMARY_CTO',
                                                  'BLIND_REVIEWER','WORKER',
                                                  'OPTIONAL_ADVERSARIAL_REVIEWER')),
    current_session_id          TEXT REFERENCES sessions(session_id),
    current_session_incarnation TEXT,
    created_at                  TEXT NOT NULL,
    retired_at                  TEXT,
    retired_reason              TEXT,
    CHECK ((current_session_id IS NULL) = (current_session_incarnation IS NULL)),
    CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
  );

  CREATE INDEX IF NOT EXISTS conversational_actors_session
    ON conversational_actors(current_session_id);
`;

const V18_DDL = `
  DROP TRIGGER IF EXISTS assignments_generation_monotonic;
  DROP TRIGGER IF EXISTS assignments_generation_immutable;
  DROP TRIGGER IF EXISTS assignments_revocation_terminal;
  DROP TRIGGER IF EXISTS assignments_active_generation_current;
  DROP TRIGGER IF EXISTS assignments_active_generation_insert_guard;
  -- Not an assignments trigger, but it names the table, and SQLite validates every trigger
  -- body when a table is dropped. Recreated verbatim after the rename.
  DROP TRIGGER IF EXISTS task_executions_worker_binding_required;

${CONVERSATIONAL_ACTOR_DDL}

  INSERT INTO conversational_actors
    (actor_id, kind, current_session_id, current_session_incarnation, created_at,
     retired_at, retired_reason)
  SELECT 'actor:' || assignment_id,
         role,
         session_id,
         session_incarnation,
         created_at,
         revoked_at,
         CASE WHEN revoked_at IS NULL THEN NULL
              ELSE COALESCE(revoked_reason, 'BINDING_REVOKED') END
    FROM assignments;

  CREATE TABLE assignments_actor_migration (
    assignment_id      TEXT PRIMARY KEY,
    role_key           TEXT NOT NULL,
    role               TEXT NOT NULL
                         CHECK (role IN ('CEO','BOOTSTRAP_CTO','PRIMARY_CTO','BLIND_REVIEWER',
                                         'WORKER','OPTIONAL_ADVERSARIAL_REVIEWER')),
    project_id         TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
    run_id             TEXT,
    task_id            TEXT,
    actor_id           TEXT NOT NULL REFERENCES conversational_actors(actor_id),
    session_id         TEXT NOT NULL REFERENCES sessions(session_id),
    session_incarnation TEXT NOT NULL,
    binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
    mode               TEXT NOT NULL CHECK (mode IN ('PREFERRED','FALLBACK')),
    status             TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
    created_at         TEXT NOT NULL,
    revoked_at         TEXT,
    revoked_reason     TEXT
  );

  INSERT INTO assignments_actor_migration
    (assignment_id, role_key, role, project_id, run_id, task_id, actor_id, session_id,
     session_incarnation, binding_generation, mode, status, created_at, revoked_at,
     revoked_reason)
  SELECT assignment_id, role_key, role, project_id, run_id, task_id,
         'actor:' || assignment_id,
         session_id, session_incarnation, binding_generation, mode, status, created_at,
         revoked_at, revoked_reason
    FROM assignments;

  DROP TABLE assignments;
  ALTER TABLE assignments_actor_migration RENAME TO assignments;

  CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_role_key
    ON assignments(role_key) WHERE status = 'ACTIVE';
  CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_primary_cto
    ON assignments(project_id) WHERE role = 'PRIMARY_CTO' AND status = 'ACTIVE';
  CREATE UNIQUE INDEX IF NOT EXISTS assignments_owner_tuple
    ON assignments(role_key, binding_generation, session_id, session_incarnation);
  CREATE INDEX IF NOT EXISTS assignments_session ON assignments(session_id, status);
  CREATE INDEX IF NOT EXISTS assignments_run ON assignments(run_id);
  CREATE INDEX IF NOT EXISTS assignments_actor ON assignments(actor_id, status);

  CREATE TRIGGER IF NOT EXISTS assignments_generation_monotonic
  BEFORE INSERT ON assignments
  WHEN NEW.binding_generation <= COALESCE(
    (SELECT MAX(binding_generation) FROM assignments WHERE role_key = NEW.role_key), 0)
  BEGIN
    SELECT RAISE(ABORT, 'BINDING_GENERATION_NOT_MONOTONIC');
  END;

  CREATE TRIGGER IF NOT EXISTS assignments_generation_immutable
  BEFORE UPDATE OF binding_generation, role_key, actor_id, session_id, session_incarnation,
                   role, project_id, run_id, task_id ON assignments
  WHEN NEW.binding_generation <> OLD.binding_generation
    OR NEW.role_key <> OLD.role_key
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.session_id <> OLD.session_id
    OR NEW.session_incarnation <> OLD.session_incarnation
    OR NEW.role <> OLD.role
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.task_id IS NOT OLD.task_id
  BEGIN
    SELECT RAISE(ABORT, 'BINDING_IDENTITY_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS assignments_revocation_terminal
  BEFORE UPDATE OF status ON assignments
  WHEN OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED'
  BEGIN
    SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
  END;

  CREATE TRIGGER IF NOT EXISTS assignments_active_generation_current
  BEFORE UPDATE OF status ON assignments
  WHEN NEW.status = 'ACTIVE'
   AND NEW.binding_generation < COALESCE(
     (SELECT MAX(binding_generation)
        FROM assignments
       WHERE role_key = NEW.role_key AND assignment_id <> NEW.assignment_id),
     0
   )
  BEGIN
    SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
  END;

  CREATE TRIGGER IF NOT EXISTS assignments_active_generation_insert_guard
  BEFORE INSERT ON assignments
  WHEN EXISTS (
    SELECT 1 FROM assignments
     WHERE role_key = NEW.role_key
       AND status = 'ACTIVE'
       AND binding_generation < NEW.binding_generation
  )
  BEGIN
    SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
  END;

  CREATE TRIGGER IF NOT EXISTS task_executions_worker_binding_required
  BEFORE INSERT ON task_executions
  WHEN NOT EXISTS (
    SELECT 1 FROM assignments a
      JOIN conversational_actors c ON c.actor_id = a.actor_id
      JOIN sessions s ON s.session_id = c.current_session_id
     WHERE a.role = 'WORKER'
       AND a.role_key = 'WORKER:' || NEW.task_id
       AND a.task_id = NEW.task_id
       AND c.current_session_id = NEW.worker_session_id
       AND a.status = 'ACTIVE'
       AND s.lifecycle = 'READY'
  )
  BEGIN
    SELECT RAISE(ABORT, 'TASK_EXECUTION_WORKER_BINDING_REQUIRED');
  END;

  CREATE TRIGGER IF NOT EXISTS conversational_actors_runtime_ready
  BEFORE UPDATE OF current_session_id ON conversational_actors
  WHEN NEW.current_session_id IS NOT NULL
   AND NEW.current_session_id IS NOT OLD.current_session_id
   AND NOT EXISTS (
     SELECT 1 FROM sessions
      WHERE session_id = NEW.current_session_id AND lifecycle = 'READY'
   )
  BEGIN
    SELECT RAISE(ABORT, 'ACTOR_RUNTIME_NOT_READY');
  END;

  CREATE TRIGGER IF NOT EXISTS conversational_actors_retirement_terminal
  BEFORE UPDATE ON conversational_actors
  WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'ACTOR_RETIREMENT_TERMINAL');
  END;
`;

/**
 * SQLite validates every trigger body when a table is dropped, so rebuilding `assignments`
 * fails on any trigger that merely *names* it — including ones belonging to other tables, and
 * including era-specific triggers that a genuine v11 file carries but current schema.sql does
 * not. A hardcoded drop list only covers the names this version happens to know, which is why
 * the v11 fixture still failed after the first pass.
 *
 * So the dependents are discovered from sqlite_master and restored from their own captured SQL.
 * Triggers v18 redefines are excluded — those are recreated by V18_DDL in their new form, and
 * restoring the captured copy would reinstate the pre-v18 body.
 */
const V18_REDEFINED_TRIGGERS = new Set([
  "assignments_generation_monotonic",
  "assignments_generation_immutable",
  "assignments_revocation_terminal",
  "assignments_active_generation_current",
  "assignments_active_generation_insert_guard",
  "task_executions_worker_binding_required",
]);

const v18: SchemaMigration = {
  id: "v18-conversational-actor",
  fromVersion: 17,
  toVersion: 18,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    const dependents = raw
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND sql LIKE '%assignments%'`,
      )
      .all() as Array<{ name: string; sql: string | null }>;
    for (const trigger of dependents) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);

    raw.exec(V18_DDL);

    for (const trigger of dependents) {
      if (V18_REDEFINED_TRIGGERS.has(trigger.name) || !trigger.sql) continue;
      raw.exec(trigger.sql);
    }
  },
  checksum: () => sha256(`v18-conversational-actor\n${V18_DDL}`),
};

/**
 * v19 records the start time of a session's OS process (#505).
 *
 * `os_pid` was resolved back to a session inside `assertReviewerIndependence` without ever being
 * verified. Pids are reused, so that lookup could name the wrong session — and the direction that
 * matters is the one where the real producer stops matching and is admitted as its own blind
 * reviewer. CP-HI-04 is what stops the referee playing, and it rested on an unverified integer.
 *
 * Additive: existing rows carry NULL, which the matcher treats as unverifiable rather than as a
 * match. That is the fail-closed direction — an unverifiable pid resolves to nothing.
 */
const V19_DDL = `
  ALTER TABLE sessions ADD COLUMN os_process_started_at TEXT;
`;

const v19: SchemaMigration = {
  id: "v19-session-process-identity",
  fromVersion: 18,
  toVersion: 19,
  apply: (raw) => {
    // The mirror of the v12/v13 replay drift. Those replay the *live* schema.sql, so a database
    // reconstructed part-way along the chain already has this column from the CREATE TABLE — and
    // a bare ALTER then fails with `duplicate column name`. Adding it only when absent keeps both
    // routes working: a genuine v18 file gains the column, a replayed one already had it.
    const present = (raw.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>)
      .some((column) => column.name === "os_process_started_at");
    if (!present) raw.exec(V19_DDL);
  },
  checksum: () => sha256(`v19-session-process-identity\n${V19_DDL}`),
};

const V20_CONVERSATIONAL_ACTOR_REGISTRY_DDL = `
  CREATE TABLE conversational_actor_registry_state (
    registry_id             INTEGER PRIMARY KEY CHECK (registry_id = 1),
    registry_set_generation INTEGER NOT NULL CHECK (registry_set_generation >= 0)
  );

  INSERT INTO conversational_actor_registry_state
    (registry_id, registry_set_generation) VALUES (1, 0);

  CREATE TABLE conversational_actor_registrations (
    actor_id           TEXT NOT NULL REFERENCES conversational_actors(actor_id),
    actor_generation   INTEGER NOT NULL CHECK (actor_generation > 0),
    registration_state TEXT NOT NULL CHECK (registration_state IN ('REGISTERED','RETIRED')),
    registered_at      TEXT NOT NULL,
    retired_at         TEXT,
    retired_reason     TEXT,
    PRIMARY KEY (actor_id, actor_generation),
    CHECK ((retired_at IS NULL) = (retired_reason IS NULL)),
    CHECK ((registration_state = 'REGISTERED') = (retired_at IS NULL))
  );

  CREATE UNIQUE INDEX conversational_actor_registrations_active_actor
    ON conversational_actor_registrations(actor_id)
    WHERE registration_state = 'REGISTERED';

  CREATE TRIGGER conversational_actor_registration_generation_monotonic
  BEFORE INSERT ON conversational_actor_registrations
  WHEN NEW.actor_generation <= COALESCE(
    (SELECT MAX(actor_generation) FROM conversational_actor_registrations
      WHERE actor_id = NEW.actor_id), 0)
  BEGIN
    SELECT RAISE(ABORT, 'ACTOR_REGISTRATION_GENERATION_NOT_MONOTONIC');
  END;

  CREATE TRIGGER conversational_actor_registration_retirement_terminal
  BEFORE UPDATE OF registration_state ON conversational_actor_registrations
  WHEN OLD.registration_state = 'RETIRED' AND NEW.registration_state <> 'RETIRED'
  BEGIN
    SELECT RAISE(ABORT, 'ACTOR_REGISTRATION_RETIREMENT_TERMINAL');
  END;
`;

/** v20 adds an empty canonical actor-registration set; existing actors are not auto-registered. */
const v20: SchemaMigration = {
  id: "v20-conversational-actor-registry",
  fromVersion: 19,
  toVersion: 20,
  apply: (raw) => raw.exec(V20_CONVERSATIONAL_ACTOR_REGISTRY_DDL),
  checksum: () => sha256(`v20-conversational-actor-registry\n${V20_CONVERSATIONAL_ACTOR_REGISTRY_DDL}`),
};


const V21_CANONICAL_TURNS_DDL = `
  CREATE TABLE canonical_turns (
    turn_request_id            TEXT PRIMARY KEY,
    -- Which conversation this turn serialises against. Today the composition root has no
    -- resolved canonical id to give, so what arrives is the source conversation's digest; the
    -- column is named for what it must become because the serialisation key is the whole point
    -- of the table, and #639 step 2 replaces the value without moving the column.
    target_conversation_digest TEXT NOT NULL,
    -- Where the turn came from. Kept so a resend can be grouped with its predecessor without
    -- reading the source channel's own tables, and so an operator can find the message.
    source_channel             TEXT NOT NULL,
    source_nonce               TEXT NOT NULL,
    -- Not identity. Same-id-different-intent is the case it exists to refuse.
    prompt_digest              TEXT NOT NULL,
    -- Evidence for matching a receipt, never a partition key: two failover generations write
    -- the same transcript, and splitting them reopens the overlap this table prevents.
    binding_generation         INTEGER,
    state                      TEXT NOT NULL CHECK (state IN ('IN_DOUBT', 'COMPLETED')),
    claimed_at                 TEXT NOT NULL,
    settled_at                 TEXT,
    CHECK ((state = 'COMPLETED') = (settled_at IS NOT NULL))
  );

  CREATE INDEX canonical_turns_target ON canonical_turns(target_conversation_digest, state);
  CREATE UNIQUE INDEX canonical_turns_source ON canonical_turns(source_channel, source_nonce);
`;

/**
 * v21 gives a turn its own row.
 *
 * It lived in `inbound_messages.result_json`, which is the source message's replay and
 * reply-delivery record. Those are different facts: one is "this Telegram update was seen and
 * answered", the other is "this conversation has a turn outstanding". Sharing a field made the
 * second a casualty of the first — `recordResultIf` replaces the whole document, so reserving
 * the outbound reply erased the claim, and the protection existed for a crash and not for an
 * ordinary timeout (#646).
 *
 * The table is created empty. Any claim currently sitting in `inbound_messages` belongs to a
 * turn whose outcome nobody established, and inventing a row for it here would assert a state
 * this migration cannot observe.
 */
const v21: SchemaMigration = {
  id: "v21-canonical-turns",
  fromVersion: 20,
  toVersion: 21,
  apply: (raw) => {
    // The v12/v13 replay trap, which v19 hit before this. Those migrations replay the *live*
    // `schema.sql`, so a database reconstructed part-way along the chain already has this table
    // from the CREATE — and a bare `CREATE TABLE` then fails with "table already exists". A
    // genuine v20 file gains the table; a replayed one already had it.
    const present = (raw.prepare(`PRAGMA table_list`).all() as Array<{ name: string }>)
      .some((table) => table.name === "canonical_turns");
    if (!present) raw.exec(V21_CANONICAL_TURNS_DDL);
  },
  checksum: () => sha256(`v21-canonical-turns\n${V21_CANONICAL_TURNS_DDL}`),
};

const V22_CANONICAL_TURN_LEDGER_DDL = `
-- The canonical-turn ledger
--
-- Four tables, because four different facts were being asked of one:
--
--   actor_target_bindings       which Hermes conversation an ACP actor owns. Lifetime bijection.
--   actor_target_attestations   the authenticated proof of that binding, per runtime generation.
--   canonical_turns             one outstanding turn per actor, and how it ended.
--   canonical_turn_sources      which inbound messages a turn consumed, and the retry chain.
--
-- The shape this replaces put a digest of the *source* conversation in a column named for the
-- target, kept turn state in the row that also tracks the source message's reply delivery, and
-- permitted two outstanding turns on one conversation. Each was a different fact wearing another
-- one's name.
--
-- Nothing writes any of this before the target protocol exists, and that is structural rather
-- than a matter of discipline: a turn requires a binding and an attestation, and only an
-- authenticated preflight bind can produce them. Admission fails closed at the schema.

-- Seeded and immutable, so a new executor cannot be introduced by writing a string.
CREATE TABLE IF NOT EXISTS executor_kinds (
  executor_kind TEXT PRIMARY KEY
);
INSERT OR IGNORE INTO executor_kinds (executor_kind) VALUES ('hermes');

CREATE TABLE IF NOT EXISTS actor_target_bindings (
  target_binding_id     TEXT PRIMARY KEY,
  target_actor_id       TEXT NOT NULL REFERENCES conversational_actors(actor_id),
  executor_kind         TEXT NOT NULL REFERENCES executor_kinds(executor_kind),
  -- What the target itself accepts as a lookup handle. Not parsed from a command line, not
  -- echoed by the runtime, not typed twice by an operator — supplied by an authenticated
  -- preflight bind, because every other route is a claim rather than a proof.
  target_locator        TEXT NOT NULL,
  -- For comparison, logging and uniqueness. A digest cannot serve as a lookup handle; keeping
  -- both means neither has to do the other's job.
  target_locator_digest TEXT NOT NULL,
  bound_at              TEXT NOT NULL,
  -- Lifetime, not active-only. An active-only constraint would let a retired actor's target be
  -- rebound to a fresh actor, which is exactly the alias a re-bootstrap produces today.
  UNIQUE (target_actor_id),
  UNIQUE (executor_kind, target_locator_digest),
  -- Referenced as a pair by canonical_turns, so a turn cannot cite a binding that belongs to a
  -- different actor.
  UNIQUE (target_binding_id, target_actor_id)
);

-- Append-only. A binding is the actor's lifetime target; an attestation is the evidence that a
-- particular runtime, under a particular authority generation, verified it.
CREATE TABLE IF NOT EXISTS actor_target_attestations (
  target_attestation_id         TEXT PRIMARY KEY,
  target_binding_id             TEXT NOT NULL REFERENCES actor_target_bindings(target_binding_id),
  protocol_version              TEXT NOT NULL,
  attestation_digest            TEXT NOT NULL,
  executor_session_id           TEXT NOT NULL,
  executor_session_incarnation  TEXT NOT NULL,
  binding_generation            INTEGER NOT NULL,
  attested_at                   TEXT NOT NULL,
  UNIQUE (target_binding_id, attestation_digest),
  UNIQUE (target_attestation_id, target_binding_id)
);

-- Seeded vocabularies. Adding an outcome later must not rebuild canonical_turns, which is the
-- cost this schema is being written to pay exactly once.
CREATE TABLE IF NOT EXISTS turn_outcome_kinds (
  outcome_kind TEXT PRIMARY KEY
);
INSERT OR IGNORE INTO turn_outcome_kinds (outcome_kind) VALUES
  -- A terminal commit the target proved. Not "the answer was good".
  ('COMPLETED'),
  -- Typed pre-dispatch evidence that execution never started.
  ('NEVER_ADMITTED'),
  -- The target proved a stale execution can no longer append, run a tool, or commit.
  ('ABORTED');

CREATE TABLE IF NOT EXISTS turn_resolution_authorities (
  resolution_authority TEXT PRIMARY KEY
);
INSERT OR IGNORE INTO turn_resolution_authorities (resolution_authority) VALUES
  ('ACP_PRE_DISPATCH'),
  ('HERMES_TARGET'),
  ('OWNER_AFTER_TARGET_FENCE');

CREATE TABLE IF NOT EXISTS canonical_turns (
  turn_request_id               TEXT PRIMARY KEY,
  target_actor_id               TEXT NOT NULL,
  target_binding_id             TEXT NOT NULL,
  target_attestation_id         TEXT NOT NULL,
  executor_session_id           TEXT NOT NULL,
  executor_session_incarnation  TEXT NOT NULL,
  binding_generation            INTEGER NOT NULL,
  -- Not identity. The case it refuses is the same id arriving with a different intent.
  prompt_digest                 TEXT NOT NULL,
  lifecycle_state               TEXT NOT NULL CHECK (lifecycle_state IN ('IN_DOUBT', 'SETTLED')),
  outcome_kind                  TEXT REFERENCES turn_outcome_kinds(outcome_kind),
  settled_at                    TEXT,
  resolution_authority          TEXT REFERENCES turn_resolution_authorities(resolution_authority),
  reason_code                   TEXT,
  evidence_digest               TEXT,
  audit_event_id                TEXT,
  -- A relation, not an outcome. A replacement says what was run instead; it does not say the old
  -- turn ended safely, and an unfenced run-as-new leaves that one IN_DOUBT.
  replacement_turn_request_id   TEXT REFERENCES canonical_turns(turn_request_id),
  FOREIGN KEY (target_binding_id, target_actor_id)
    REFERENCES actor_target_bindings(target_binding_id, target_actor_id),
  FOREIGN KEY (target_attestation_id, target_binding_id)
    REFERENCES actor_target_attestations(target_attestation_id, target_binding_id),
  -- In doubt means nothing is known, so nothing is recorded.
  CHECK (lifecycle_state <> 'IN_DOUBT' OR (
    outcome_kind IS NULL AND settled_at IS NULL AND resolution_authority IS NULL
    AND reason_code IS NULL AND evidence_digest IS NULL AND audit_event_id IS NULL)),
  -- Settled means all of it is known. A settlement missing its authority or its evidence is a
  -- verdict with nothing behind it.
  CHECK (lifecycle_state <> 'SETTLED' OR (
    outcome_kind IS NOT NULL AND settled_at IS NOT NULL AND resolution_authority IS NOT NULL
    AND reason_code IS NOT NULL AND evidence_digest IS NOT NULL AND audit_event_id IS NOT NULL))
);

-- The property the table exists for, enforced by the database rather than by whoever remembers
-- to check. The shape this replaces named it and did not hold it.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_turns_one_unresolved
  ON canonical_turns(target_actor_id) WHERE lifecycle_state = 'IN_DOUBT';

-- Which inbound messages a turn consumed. N:1, because consecutive owner messages coalesce into
-- one turn with their ids and boundaries preserved — three messages are not three turns.
CREATE TABLE IF NOT EXISTS canonical_turn_sources (
  turn_request_id              TEXT NOT NULL REFERENCES canonical_turns(turn_request_id),
  source_channel               TEXT NOT NULL,
  source_nonce                 TEXT NOT NULL,
  -- Attempts are numbered and chained, because that is what makes a retry legal. A global unique
  -- on (channel, nonce) would forbid the second attempt the design requires; "not in two
  -- unresolved turns" alone would permit silently re-running a message that already completed.
  source_attempt               INTEGER NOT NULL CHECK (source_attempt > 0),
  batch_ordinal                INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  source_digest                TEXT NOT NULL,
  predecessor_turn_request_id  TEXT REFERENCES canonical_turns(turn_request_id),
  admission_audit_event_id     TEXT,
  PRIMARY KEY (source_channel, source_nonce, source_attempt),
  UNIQUE (turn_request_id, batch_ordinal),
  UNIQUE (turn_request_id, source_channel, source_nonce),
  -- The first attempt has no predecessor and every later one does. Which predecessor, and
  -- whether its outcome permits a retry, is checked in the admission transaction — SQLite cannot
  -- express "the previous attempt of this same source settled safely" as a constraint.
  CHECK ((source_attempt = 1) = (predecessor_turn_request_id IS NULL))
);
`;

/**
 * v22 rebuilds the turn ledger, and refuses to guess.
 *
 * v21's `canonical_turns` held a digest of the *source* conversation under a column named for
 * the target, no constraint on the property it existed for, and no room for an adjudicated
 * outcome. The fix is a rebuild rather than an alter: SQLite cannot change a CHECK, and the
 * shape needs four tables where there was one.
 *
 * **It does not backfill.** A row in v21 belongs to a turn whose actor and target nobody
 * established — deriving them from a source digest would put a guess where the schema promises
 * a proof. An empty table is rebuilt; a non-empty one fails with the database unchanged, which
 * is a state a person can look at.
 *
 * Production is empty today and stays empty until the target protocol exists: a turn requires a
 * binding and an attestation, and only an authenticated preflight bind produces those. The
 * embargo on admission is therefore enforced by the schema, not only by intent.
 */
const v22: SchemaMigration = {
  id: "v22-canonical-turn-ledger",
  fromVersion: 21,
  toVersion: 22,
  apply: (raw) => {
    const rows = raw.prepare(`SELECT COUNT(*) AS n FROM canonical_turns`).get() as { n: number };
    if (rows.n > 0) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "v22 will not migrate turn rows it cannot attribute; canonical_turns is not empty",
        { rows: rows.n },
      );
    }
    raw.exec(`DROP INDEX IF EXISTS canonical_turns_source`);
    raw.exec(`DROP INDEX IF EXISTS canonical_turns_target`);
    raw.exec(`DROP TABLE IF EXISTS canonical_turns`);
    raw.exec(V22_CANONICAL_TURN_LEDGER_DDL);
  },
  checksum: () => sha256(`v22-canonical-turn-ledger\n${V22_CANONICAL_TURN_LEDGER_DDL}`),
};

export const MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
  v12,
  v13,
  v14,
  v15,
  v16,
  v17,
  v18,
  v19,
  v20,
  v21,
  v22,
]);

interface RequiredTrigger {
  name: string;
  sentinel: string;
  /** The schema version whose migration made this trigger load-bearing. */
  introducedIn?: number;
}

const REQUIRED_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "runs_state_transition_authority_guard", sentinel: "RUN_STATE_TRANSITION_AUTHORITY_DENIED" },
  { name: "tasks_run_work_sealed", sentinel: "TASK_INSERT_RUN_SEALED" },
  { name: "run_artifacts_evidence_authority_guard", sentinel: "EVIDENCE_WRITE_AUTHORITY_DENIED" },
  { name: "run_artifacts_content_immutable", sentinel: "ARTIFACT_IMMUTABLE" },
  { name: "run_artifacts_no_delete", sentinel: "ARTIFACT_IMMUTABLE" },
  { name: "github_receipts_immutable", sentinel: "GITHUB_RECEIPT_IMMUTABLE" },
  { name: "github_receipts_no_delete", sentinel: "GITHUB_RECEIPT_IMMUTABLE" },
  { name: "sessions_workdir_immutable", sentinel: "SESSION_WORKDIR_IMMUTABLE", introducedIn: 16 },
];

/**
 * The rest of schema.sql's triggers. Splitting them out of REQUIRED_TRIGGERS records why the
 * original seven were listed and these twenty were not: the first list was assembled by hand
 * around the guards someone had reason to worry about, and nothing ever reconciled it against
 * the schema. A rule-inventory sweep found the gap — 20 of 29 triggers had no existence check,
 * so dropping one during a migration rewrite failed nothing. Most tests enter through the
 * application path, which never notices that the database-layer backstop is gone; the loss
 * would surface only when someone tried the raw-SQL bypass the trigger exists to refuse.
 *
 * `tests/unit/schema-trigger-coverage.test.ts` now reconciles the two mechanically, so this
 * list cannot fall behind schema.sql again.
 */
const REQUIRED_SCHEMA_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "manifests_immutable", sentinel: "MANIFEST_IMMUTABLE" },
  { name: "sessions_incarnation_immutable", sentinel: "SESSION_INCARNATION_IMMUTABLE" },
  { name: "sessions_secret_hash_immutable", sentinel: "SESSION_SECRET_HASH_IMMUTABLE" },
  { name: "sessions_buzz_actor_immutable", sentinel: "SESSION_BUZZ_ACTOR_IMMUTABLE" },
  { name: "conversational_actors_retirement_terminal", sentinel: "ACTOR_RETIREMENT_TERMINAL", introducedIn: 18 },
  { name: "conversational_actors_runtime_ready", sentinel: "ACTOR_RUNTIME_NOT_READY", introducedIn: 18 },
  { name: "conversational_actor_registration_generation_monotonic", sentinel: "ACTOR_REGISTRATION_GENERATION_NOT_MONOTONIC", introducedIn: 20 },
  { name: "conversational_actor_registration_retirement_terminal", sentinel: "ACTOR_REGISTRATION_RETIREMENT_TERMINAL", introducedIn: 20 },
  { name: "assignments_generation_monotonic", sentinel: "BINDING_GENERATION_NOT_MONOTONIC" },
  { name: "assignments_generation_immutable", sentinel: "BINDING_IDENTITY_IMMUTABLE" },
  { name: "assignments_revocation_terminal", sentinel: "BINDING_REVOKED_TERMINAL" },
  { name: "assignments_active_generation_current", sentinel: "BINDING_REVOKED_TERMINAL" },
  { name: "assignments_active_generation_insert_guard", sentinel: "BINDING_REVOKED_TERMINAL" },
  { name: "runs_state_transition_guard", sentinel: "RUN_STATE_TRANSITION_ILLEGAL" },
  { name: "runs_pinned_manifest_immutable", sentinel: "PINNED_MANIFEST_IMMUTABLE" },
  { name: "runs_pinned_run_scoped_commands_immutable", sentinel: "PINNED_RUN_SCOPED_COMMANDS_IMMUTABLE" },
  { name: "task_executions_worker_binding_required", sentinel: "TASK_EXECUTION_WORKER_BINDING_REQUIRED" },
  { name: "task_executions_worker_identity_immutable", sentinel: "TASK_EXECUTION_WORKER_IDENTITY_IMMUTABLE" },
  { name: "run_artifacts_evidence_candidate_guard", sentinel: "EVIDENCE_CANDIDATE_MISMATCH" },
  { name: "outbox_request_fingerprint_immutable", sentinel: "OUTBOX_REQUEST_FINGERPRINT_IMMUTABLE" },
  { name: "github_receipts_applied_requires_reservation", sentinel: "GITHUB_RECEIPT_PROTOCOL_VIOLATION" },
  { name: "github_receipts_pending_completion", sentinel: "GITHUB_RECEIPT_PROTOCOL_VIOLATION" },
  { name: "audit_events_append_only", sentinel: "AUDIT_APPEND_ONLY" },
  { name: "audit_events_no_delete", sentinel: "AUDIT_APPEND_ONLY" },
];

const REQUIRED_LEDGER_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "schema_migrations_insert_authority", sentinel: "SCHEMA_MIGRATION_AUTHORITY_DENIED" },
  { name: "schema_migrations_immutable", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
  { name: "schema_migrations_no_delete", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
];

const REQUIRED_BASELINE_LEDGER_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "baseline_records_immutable", sentinel: "BASELINE_RECORD_IMMUTABLE" },
  { name: "baseline_records_no_delete", sentinel: "BASELINE_RECORD_IMMUTABLE" },
];

const REQUIRED_TELEGRAM_OWNER_PROMPT_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "telegram_owner_prompts_immutable", sentinel: "TELEGRAM_PROMPT_IMMUTABLE" },
  { name: "telegram_owner_prompts_no_delete", sentinel: "TELEGRAM_PROMPT_IMMUTABLE" },
];

/**
 * Names alone are not enough: a same-named no-op trigger would make a corrupt database look
 * healthy. The embedded denial marker proves that each load-bearing guard still has its
 * intended enforcement body. Historical backups are checked against the registry as it
 * existed at their recorded schema version, so a v11 image is not rejected merely because
 * a later migration added another load-bearing trigger.
 */
export const assertLoadBearingInvariants = (
  raw: Database.Database,
  options: {
    includeMigrationLedger: boolean;
    includeBaselineLedger?: boolean;
    includeTelegramOwnerPrompts?: boolean;
    schemaVersion?: number;
  },
): void => {
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  const expected = [
    ...REQUIRED_SCHEMA_TRIGGERS,
    ...(options.includeMigrationLedger
      ? [...REQUIRED_TRIGGERS, ...REQUIRED_LEDGER_TRIGGERS]
      : REQUIRED_TRIGGERS),
    ...(options.includeBaselineLedger ? REQUIRED_BASELINE_LEDGER_TRIGGERS : []),
    ...(options.includeTelegramOwnerPrompts ? REQUIRED_TELEGRAM_OWNER_PROMPT_TRIGGERS : []),
  ];
  for (const trigger of expected) {
    if (trigger.introducedIn !== undefined && trigger.introducedIn > schemaVersion) continue;
    const row = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger.name) as { sql?: string | null } | undefined;
    if (!row?.sql || !row.sql.includes(trigger.sentinel)) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database is missing a load-bearing schema invariant",
        { trigger: trigger.name, sentinel: trigger.sentinel },
      );
    }
  }
};

export const assertMigrationLedgerAt = (raw: Database.Database, version: number): void => {
  const table = raw
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { n: number };
  if (table.n !== 1) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "database has no migration ledger", { version });
  }
  const receipt = raw
    .prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = ?")
    .get(version) as { migration_id: string; checksum: string } | undefined;
  if (!receipt || !/^sha256:[a-f0-9]{64}$/.test(receipt.checksum)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "database migration receipt is missing or malformed", {
      version,
      receipt: receipt ?? null,
    });
  }
};

export const migrationChainFrom = (version: number): readonly SchemaMigration[] => {
  const chain: SchemaMigration[] = [];
  let cursor = version;
  while (cursor < SCHEMA_VERSION) {
    const next = MIGRATIONS.find((migration) => migration.fromVersion === cursor);
    if (!next) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database schema is older than this build and no ordered migration is defined",
        { expected: SCHEMA_VERSION, found: version, missingFromVersion: cursor },
      );
    }
    chain.push(next);
    cursor = next.toVersion;
  }
  return chain;
};

export const bootstrapChecksum = (): string => sha256(`bootstrap-v${SCHEMA_VERSION}\n${schemaSql()}`);
