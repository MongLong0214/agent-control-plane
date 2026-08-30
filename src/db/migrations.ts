import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/** The ordered registry is the only authority for changing a deployed schema. */
export const SCHEMA_VERSION = 34;

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

/**
 * Every ledger trigger, taken from the live schema.
 *
 * A migration that carried its own copy would drift from the file it is supposed to reproduce,
 * and drift is what put a database at version 24 with a different trigger set than version 24
 * defines. Pulling them from `schema.sql` means the migration owns the ordering and nothing else.
 */
/**
 * Every ledger trigger, in one place, because two lists of the same thing is how one goes stale.
 *
 * `ledgerTriggerDdl()` reads its bodies from schema.sql by these names; `ledgerTriggerDrops()`
 * drops exactly these. A migration that recreates the set therefore cannot repair some of it and
 * silently leave the rest — which is precisely what v25 did with a hand-picked list of eight.
 */
export const LEDGER_TRIGGER_NAMES: readonly string[] = [
    "canonical_turns_identity_immutable",
    "canonical_turns_born_in_doubt",
    "canonical_turns_settlement_authority",
    "canonical_turns_settlement_provenance_immutable",
    "canonical_turns_consistency_monotone",
    "canonical_turns_lifecycle_monotone",
    "canonical_turns_outcome_never_weakens",
    "canonical_turns_no_delete",
    "canonical_turns_no_replace",
    "canonical_turn_observations_write_authority",
    "canonical_turn_observations_append_only",
    "canonical_turn_observations_no_delete",
    "canonical_turn_observations_no_replace",
    "canonical_turn_dispatches_write_authority",
    "canonical_turn_dispatches_append_only",
    "canonical_turn_dispatches_no_delete",
    "canonical_turn_dispatches_no_replace",
    "canonical_turn_sources_immutable",
    "canonical_turn_sources_no_delete",
    "canonical_turn_sources_no_replace",
    "canonical_turn_sources_admission_matches_claim",
    "actor_target_attestations_append_only",
    "actor_target_attestations_no_delete",
    "actor_target_attestations_no_replace",
    "actor_target_bindings_immutable",
    "actor_target_bindings_no_delete",
    "actor_target_bindings_no_replace",
    "canonical_turn_adjudications_write_authority",
    "canonical_turn_adjudications_append_only",
    "canonical_turn_adjudications_no_delete",
    "canonical_turn_adjudication_citations_write_authority",
    "canonical_turn_adjudication_citations_append_only",
    "canonical_turn_adjudication_citations_no_delete",
    "canonical_turn_adjudication_citations_same_turn",
    "canonical_turn_adjudications_no_replace",
    "canonical_turn_adjudication_citations_no_replace",
];

/**
 * `DROP TRIGGER IF EXISTS` for every ledger trigger, derived from the list above.
 *
 * Dropping before recreating is what makes a repair migration a repair. `CREATE TRIGGER IF NOT
 * EXISTS` against a trigger that is already there is a no-op, so a body that drifted survives the
 * migration built to replace it — measured on a database created at `132309a`, which migrated to
 * v25, reported healthy, and then threw on every settlement because its settlement trigger still
 * called the four-argument marker that no longer exists.
 */
export const ledgerTriggerDrops = (): string =>
  `${dropsFor(LEDGER_TRIGGER_NAMES)}${dropsFor(PROVENANCE_NO_REPLACE_TRIGGERS)}`;

/**
 * Provenance tables that had UPDATE and DELETE guards and nothing on INSERT.
 *
 * Found by census after the same hole was closed on the ledger tables and missed here. Kept
 * separate from the ledger set because they are not part of the canonical turn's own schema, and
 * kept in this file because the repair migration has to install them for databases that already
 * exist.
 */
export const PROVENANCE_NO_REPLACE_TRIGGERS: readonly string[] = [
  "audit_events_no_replace",
  "baseline_records_no_replace",
  "telegram_owner_prompts_no_replace",
  "conversational_actors_no_replace",
  "manifests_no_replace",
  // Found when the census learned to see `BEFORE UPDATE OF <column>`, which four of this schema's
  // most load-bearing guards use and its first pattern did not match. `sessions` was among the
  // sixteen triggers it could not see, and a REPLACE rewrote a session's secret hash on ACP's own
  // connection while the census printed PASS.
  "sessions_no_replace",
  "runs_no_replace",
  "assignments_no_replace",
  "task_executions_no_replace",
  "conversational_actor_registrations_no_replace",
  "outbox_no_replace",
  "run_artifacts_no_replace",
  "github_receipts_no_replace",
];

/** `DROP TRIGGER IF EXISTS` for a set of triggers, so a repair replaces rather than skips. */
const dropsFor = (names: readonly string[]): string =>
  `${names.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n")}\n`;

/** The definitions of the named triggers, read out of the live schema so the two cannot drift. */
const triggerDdlFor = (names: readonly string[]): string => {
  const ddl = schemaDdl();
  const found = names.map((name) => {
    const pattern = new RegExp(
      `CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND;`,
      "m",
    );
    const match = pattern.exec(ddl);
    if (!match) {
      // A name here with no definition in schema.sql means the two have already drifted, which is
      // the failure this function exists to make impossible. Loud rather than partial.
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        `ledger trigger ${name} is named by the migration and absent from schema.sql`,
        { trigger: name },
      );
    }
    return match[0];
  });
  return `${found.join("\n\n")}\n`;
};

export const ledgerTriggerDdl = (): string => triggerDdlFor(LEDGER_TRIGGER_NAMES);
export const provenanceNoReplaceDdl = (): string => triggerDdlFor(PROVENANCE_NO_REPLACE_TRIGGERS);

/** The adjudication tables and their index, taken from the live schema for the same reason. */
export const adjudicationDdl = (): string => {
  const ddl = schemaDdl();
  const parts = [
    /CREATE TABLE IF NOT EXISTS canonical_turn_adjudications \([\s\S]*?\n\);/,
    /CREATE TABLE IF NOT EXISTS canonical_turn_adjudication_citations \([\s\S]*?\n\);/,
    /CREATE INDEX IF NOT EXISTS canonical_turn_adjudications_by_turn[^;]*;/,
  ].map((pattern) => {
    const match = pattern.exec(ddl);
    if (!match) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "an adjudication object is missing from schema.sql", {});
    }
    return match[0];
  });
  return `${parts.join("\n\n")}\n`;
};

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

/**
 * The two turn tables again, with the one column v22 left out.
 *
 * A turn in doubt is only actionable if someone can say *how long* it has been in doubt — that is
 * the whole of the doctor's escalation rule and the operator's first question. v22 recorded when a
 * turn settled and not when it was claimed, so an unresolved row had no age at all, and the only
 * ordering available was rowid. Reporting a rowid as a time would have been the same defect the
 * ledger was built to remove: a value standing in for a fact it is not.
 */
const V23_TURN_CLAIMED_AT_DDL = `
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
  -- When the right to run this turn was taken. NOT NULL because the age of an unresolved turn is
  -- the only thing that distinguishes a turn in flight from a wedged conversation.
  claimed_at                    TEXT NOT NULL,
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
-- to check.
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
 * Recreated rather than altered, for the same reason v22 was.
 *
 * `ALTER TABLE ADD COLUMN` cannot add a NOT NULL column without a default, and a default here
 * would be a fabricated claim time on any row that had one. Dropping is safe because it is not a
 * judgement call: the tables are structurally unwritable until an authenticated preflight bind
 * exists, and the emptiness is verified rather than assumed.
 */
const v23: SchemaMigration = {
  id: "v23-turn-claimed-at",
  fromVersion: 22,
  toVersion: 23,
  apply: (raw) => {
    for (const table of ["canonical_turn_sources", "canonical_turns"]) {
      const rows = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      if (rows.n > 0) {
        throw acpError(
          ReasonCode.INTERNAL_ERROR,
          `v23 will not invent a claim time for turns it did not observe; ${table} is not empty`,
          { table, rows: rows.n },
        );
      }
    }
    raw.exec(`DROP INDEX IF EXISTS canonical_turns_one_unresolved`);
    raw.exec(`DROP TABLE IF EXISTS canonical_turn_sources`);
    raw.exec(`DROP TABLE IF EXISTS canonical_turns`);
    raw.exec(V23_TURN_CLAIMED_AT_DDL);
  },
  checksum: () => sha256(`v23-turn-claimed-at\n${V23_TURN_CLAIMED_AT_DDL}`),
};


/**
 * The ledger records what authorities observed, and computes the outcome from that.
 *
 * Three defects, all reproduced before this was written.
 *
 * **Nothing paired an outcome with an authority that could have observed it.** The pairing lived
 * only in a TypeScript union, erased at runtime, so `COMPLETED` under `ACP_PRE_DISPATCH` — an
 * authority that by definition saw nothing run — was accepted by the database.
 *
 * **Nothing made the ledger append-only.** A plain `UPDATE canonical_turns SET
 * outcome_kind='ABORTED'` on a settled `COMPLETED` row makes the retry rule admit attempt 2, so
 * a completed exchange can be run again. Deleting the sources and then the turn clears the
 * "permanent" hold just as easily.
 *
 * **First settlement won.** A settlement was an UPDATE conditional on `IN_DOUBT`, which correctly
 * refuses an overwrite and therefore *discards the later, more authoritative* record. A mistaken
 * pre-dispatch refusal beating a real target receipt kept the false retry-safe answer and threw
 * away the true one. That is worse than the overwrite it prevents.
 *
 * So a settlement is no longer an UPDATE. Authorities append observations; the turn's outcome is
 * materialized from the set of them under a fixed conservative order, and the two records that
 * disagree are both kept. Consistency is a separate axis from lifecycle because they are separate
 * facts: a turn can be settled and later contradicted, and the actor may by then be holding a
 * different turn — one partial-unique slot cannot express both.
 */
const V24_OBSERVATION_LEDGER_DDL = `
-- Seeded here as well as in schema.sql, because a database that upgrades from v23 never runs the
-- fresh bootstrap. Without this the vocabulary row exists only on new installs, and an ordinary
-- ACP-observed reply on an upgraded deployment fails its foreign key and leaves the turn in
-- doubt — a defect no fresh-database test can see.
INSERT OR IGNORE INTO turn_resolution_authorities (resolution_authority) VALUES
  ('ACP_OBSERVED_HERMES_REPLY');

CREATE TABLE IF NOT EXISTS turn_observation_consistency (
  observation_consistency TEXT PRIMARY KEY
);
INSERT OR IGNORE INTO turn_observation_consistency (observation_consistency) VALUES
  -- Every observation on this turn agrees about whether it ran and how it ended.
  ('CONSISTENT'),
  -- Two authorities reported outcomes that cannot both be true. Both are kept; the actor is
  -- quarantined until someone adjudicates.
  ('CONTRADICTED'),
  -- An adjudication citing the conflicting observations has closed the disagreement. It closes
  -- consistency only; it can never choose an outcome more retry-safe than the conservative order
  -- already produced.
  ('ADJUDICATED');

CREATE TABLE IF NOT EXISTS canonical_turns (
  turn_request_id               TEXT PRIMARY KEY,
  target_actor_id               TEXT NOT NULL,
  target_binding_id             TEXT NOT NULL,
  target_attestation_id         TEXT NOT NULL,
  executor_session_id           TEXT NOT NULL,
  executor_session_incarnation  TEXT NOT NULL,
  binding_generation            INTEGER NOT NULL,
  prompt_digest                 TEXT NOT NULL,
  claimed_at                    TEXT NOT NULL,
  -- The audit row this claim is explained by. A real foreign key to a real primary key: the
  -- shape this replaces minted an \`ev_<uuid>\` string that identified no row at all.
  claim_audit_event_id          INTEGER NOT NULL REFERENCES audit_events(event_id),
  lifecycle_state               TEXT NOT NULL CHECK (lifecycle_state IN ('IN_DOUBT', 'SETTLED')),
  -- Materialized from the observations, never written directly by a settling caller.
  outcome_kind                  TEXT REFERENCES turn_outcome_kinds(outcome_kind),
  settled_at                    TEXT,
  resolution_authority          TEXT REFERENCES turn_resolution_authorities(resolution_authority),
  reason_code                   TEXT,
  evidence_digest               TEXT,
  observation_consistency       TEXT NOT NULL DEFAULT 'CONSISTENT'
                                REFERENCES turn_observation_consistency(observation_consistency),
  replacement_turn_request_id   TEXT REFERENCES canonical_turns(turn_request_id),
  FOREIGN KEY (target_binding_id, target_actor_id)
    REFERENCES actor_target_bindings(target_binding_id, target_actor_id),
  FOREIGN KEY (target_attestation_id, target_binding_id)
    REFERENCES actor_target_attestations(target_attestation_id, target_binding_id),
  CHECK (lifecycle_state <> 'IN_DOUBT' OR (
    outcome_kind IS NULL AND settled_at IS NULL AND resolution_authority IS NULL
    AND reason_code IS NULL AND evidence_digest IS NULL)),
  CHECK (lifecycle_state <> 'SETTLED' OR (
    outcome_kind IS NOT NULL AND settled_at IS NOT NULL AND resolution_authority IS NOT NULL
    AND reason_code IS NOT NULL AND evidence_digest IS NOT NULL)),
  -- An outcome may only stand under an authority that could have observed it.
  --
  --   NEVER_ADMITTED  only pre-dispatch evidence can say nothing ran
  --   COMPLETED       only the target's own receipt
  --   ABORTED         requires a fence, which only the target or the owner-after-fence can give
  CHECK (outcome_kind IS NULL OR (
    (outcome_kind = 'NEVER_ADMITTED' AND resolution_authority = 'ACP_PRE_DISPATCH')
    OR (outcome_kind = 'COMPLETED' AND resolution_authority = 'HERMES_TARGET')
    OR (outcome_kind = 'ABORTED'
        AND resolution_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE'))))
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_turns_one_unresolved
  ON canonical_turns(target_actor_id) WHERE lifecycle_state = 'IN_DOUBT';

CREATE TABLE IF NOT EXISTS canonical_turn_sources (
  turn_request_id              TEXT NOT NULL REFERENCES canonical_turns(turn_request_id),
  source_channel               TEXT NOT NULL,
  source_nonce                 TEXT NOT NULL,
  source_attempt               INTEGER NOT NULL CHECK (source_attempt > 0),
  batch_ordinal                INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  source_digest                TEXT NOT NULL,
  predecessor_turn_request_id  TEXT REFERENCES canonical_turns(turn_request_id),
  -- Filled at INSERT, from the same transaction's audit row. Nothing patches it later, because
  -- an append-only table that has to be updated to become complete is not append-only.
  admission_audit_event_id     INTEGER NOT NULL REFERENCES audit_events(event_id),
  PRIMARY KEY (source_channel, source_nonce, source_attempt),
  UNIQUE (turn_request_id, batch_ordinal),
  UNIQUE (turn_request_id, source_channel, source_nonce),
  CHECK ((source_attempt = 1) = (predecessor_turn_request_id IS NULL))
);

-- What an authority reported about a turn. Append-only, and the only way an outcome is ever set.
--
-- A settling caller inserts here; nothing writes canonical_turns' outcome columns directly. Two
-- authorities that disagree both leave a row, which is the whole point: the record that arrives
-- second is often the one that knows.
CREATE TABLE IF NOT EXISTS canonical_turn_observations (
  observation_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_request_id           TEXT NOT NULL REFERENCES canonical_turns(turn_request_id),
  observed_outcome          TEXT NOT NULL REFERENCES turn_outcome_kinds(outcome_kind),
  observing_authority       TEXT NOT NULL REFERENCES turn_resolution_authorities(resolution_authority),
  -- Authority-scoped receipt identity. The same receipt redelivered is a no-op rather than a
  -- second opinion, so a retrying transport cannot manufacture a contradiction.
  receipt_id                TEXT NOT NULL,
  evidence_digest           TEXT NOT NULL,
  reason_code               TEXT NOT NULL,
  observed_at               TEXT NOT NULL,
  audit_event_id            INTEGER NOT NULL REFERENCES audit_events(event_id),
  -- An adjudication cites the observation it resolves. It closes consistency; it cannot choose a
  -- more retry-safe outcome than the conservative order already produced.
  adjudicates_observation_id INTEGER REFERENCES canonical_turn_observations(observation_id),
  -- Scoped to the turn, not global. A global key made one turn's receipt id collide with
  -- another's: a genuine target receipt for turn B, numbered the same as one turn A had already
  -- consumed, was silently discarded and turn B kept its weaker outcome. Measured.
  UNIQUE (turn_request_id, observing_authority, receipt_id),
  CHECK (
    (observed_outcome = 'NEVER_ADMITTED' AND observing_authority = 'ACP_PRE_DISPATCH')
    OR (observed_outcome = 'COMPLETED'
        AND observing_authority IN ('HERMES_TARGET', 'ACP_OBSERVED_HERMES_REPLY'))
    OR (observed_outcome = 'ABORTED'
        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE')))
);

CREATE INDEX IF NOT EXISTS canonical_turn_observations_by_turn
  ON canonical_turn_observations(turn_request_id, observation_id);

-- CP-HI-06 — a turn's identity and the claim it was admitted under are exact evidence. Only the
-- materialized outcome columns and the consistency axis may move, and only upward.
CREATE TRIGGER IF NOT EXISTS canonical_turns_identity_immutable
BEFORE UPDATE ON canonical_turns
WHEN OLD.target_actor_id IS NOT NEW.target_actor_id
  OR OLD.target_binding_id IS NOT NEW.target_binding_id
  OR OLD.target_attestation_id IS NOT NEW.target_attestation_id
  OR OLD.executor_session_id IS NOT NEW.executor_session_id
  OR OLD.executor_session_incarnation IS NOT NEW.executor_session_incarnation
  OR OLD.binding_generation IS NOT NEW.binding_generation
  OR OLD.prompt_digest IS NOT NEW.prompt_digest
  OR OLD.claimed_at IS NOT NEW.claimed_at
  OR OLD.claim_audit_event_id IS NOT NEW.claim_audit_event_id
  -- The retry lineage. Left out of every guard it belonged in, so a settled turn could be
  -- pointed at an unrelated replacement, repointed, and cleared — editable history of what was
  -- run instead of what.
  OR (OLD.replacement_turn_request_id IS NOT NULL
      AND OLD.replacement_turn_request_id IS NOT NEW.replacement_turn_request_id)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_IDENTITY_IMMUTABLE');
END;

-- CP-HI-06 — the lifecycle is monotone. A settled turn never returns to doubt, which would put
-- the hold back on a conversation whose outcome is known.
CREATE TRIGGER IF NOT EXISTS canonical_turns_lifecycle_monotone
BEFORE UPDATE ON canonical_turns
WHEN OLD.lifecycle_state = 'SETTLED' AND NEW.lifecycle_state = 'IN_DOUBT'
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_LIFECYCLE_NOT_MONOTONE');
END;

-- CP-HI-06 — an outcome may only become *more* retry-blocking, never less.
--
-- COMPLETED forbids a re-run, ABORTED and NEVER_ADMITTED permit one. Lowering an outcome is
-- therefore how a completed exchange becomes runnable again, and it is exactly the measured
-- defect: a plain UPDATE from COMPLETED to ABORTED made the retry rule admit attempt 2.
CREATE TRIGGER IF NOT EXISTS canonical_turns_outcome_never_weakens
BEFORE UPDATE OF outcome_kind ON canonical_turns
WHEN OLD.outcome_kind IS NOT NULL
  AND (NEW.outcome_kind IS NULL
       OR (OLD.outcome_kind = 'COMPLETED' AND NEW.outcome_kind <> 'COMPLETED')
       OR (OLD.outcome_kind = 'ABORTED' AND NEW.outcome_kind = 'NEVER_ADMITTED'))
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OUTCOME_WEAKENED');
END;

-- CP-HI-02 — a turn is born in doubt. Settlement is something an observation causes, never
-- something a row arrives already carrying.
--
-- The authority trigger beside this one guards UPDATE, and an INSERT of a fully settled row with
-- zero observations walked past it: the CHECKs accept any syntactically valid settled tuple, and
-- the one-unresolved index only constrains IN_DOUBT rows. A review found it in a test comment of
-- mine that called it "a different hole named in its own issue" — an issue that did not exist.
CREATE TRIGGER IF NOT EXISTS canonical_turns_born_in_doubt
BEFORE INSERT ON canonical_turns
WHEN NEW.lifecycle_state <> 'IN_DOUBT'
  OR NEW.outcome_kind IS NOT NULL
  OR NEW.settled_at IS NOT NULL
  OR NEW.resolution_authority IS NOT NULL
  OR NEW.evidence_digest IS NOT NULL
  OR NEW.observation_consistency <> 'CONSISTENT'
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_NOT_BORN_IN_DOUBT');
END;

-- CP-HI-02 — only the materializer may move a turn's settlement columns or its consistency.
--
-- The version this replaces guarded the *weakening* of an outcome and nothing else, so an
-- ordinary UPDATE setting lifecycle_state='SETTLED' and outcome_kind='ABORTED' on a
-- turn that had never been settled succeeded with **zero observations**, and the retry rule then
-- read that forged outcome and admitted attempt 2. Reproduced on the previous head.
--
-- acp_turn_materialization_authorized is a connection-local marker in the same shape as the
-- run-state and evidence guards: a raw SQL caller can invoke it and cannot make it answer true
-- outside the owning operation. It is bound to the exact tuple being written, not merely to the
-- row, so the materializer's own transaction cannot be cover for a different write.
CREATE TRIGGER IF NOT EXISTS canonical_turns_settlement_authority
BEFORE UPDATE ON canonical_turns
WHEN (OLD.lifecycle_state IS NOT NEW.lifecycle_state
      OR OLD.outcome_kind IS NOT NEW.outcome_kind
      OR OLD.settled_at IS NOT NEW.settled_at
      OR OLD.resolution_authority IS NOT NEW.resolution_authority
      OR OLD.reason_code IS NOT NEW.reason_code
      OR OLD.evidence_digest IS NOT NEW.evidence_digest
      OR OLD.observation_consistency IS NOT NEW.observation_consistency)
  AND acp_turn_materialization_authorized(NEW.turn_request_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED');
END;

-- CP-HI-06 — a settled turn's provenance is the evidence, and evidence that can be rewritten is
-- not evidence. The authority trigger above stops an unauthorised writer; this stops the
-- materializer itself from moving a terminal time or a digest it already recorded.
CREATE TRIGGER IF NOT EXISTS canonical_turns_settlement_provenance_immutable
BEFORE UPDATE ON canonical_turns
WHEN OLD.lifecycle_state = 'SETTLED'
  AND (OLD.settled_at IS NOT NEW.settled_at
       OR (OLD.outcome_kind IS NEW.outcome_kind
           AND (OLD.evidence_digest IS NOT NEW.evidence_digest
                OR OLD.reason_code IS NOT NEW.reason_code
                OR OLD.resolution_authority IS NOT NEW.resolution_authority)))
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SETTLEMENT_PROVENANCE_IMMUTABLE');
END;

-- CP-HI-08 — a quarantine that ordinary SQL can lift silently is not a quarantine. Consistency
-- moves only under the materializer, and only forward: CONSISTENT may become CONTRADICTED, and
-- CONTRADICTED may become ADJUDICATED. Nothing returns to CONSISTENT, because the disagreement
-- happened and erasing it is how the record stops being one.
CREATE TRIGGER IF NOT EXISTS canonical_turns_consistency_monotone
BEFORE UPDATE OF observation_consistency ON canonical_turns
WHEN NOT (
  OLD.observation_consistency = NEW.observation_consistency
  OR (OLD.observation_consistency = 'CONSISTENT' AND NEW.observation_consistency = 'CONTRADICTED')
  OR (OLD.observation_consistency = 'CONTRADICTED' AND NEW.observation_consistency = 'ADJUDICATED')
  -- An adjudication closes the disagreement it read. A *new* disagreement is a different fact,
  -- and it has to be able to re-open the turn — otherwise the first adjudication makes the ledger
  -- deaf: every later observation recomputes a consistency the trigger refuses, and the whole
  -- transaction rolls back, discarding evidence that arrived after someone said the matter was
  -- settled. Monotone here means "never silently consistent", not "never re-opened".
  OR (OLD.observation_consistency = 'ADJUDICATED' AND NEW.observation_consistency = 'CONTRADICTED')
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_CONSISTENCY_NOT_MONOTONE');
END;

-- CP-HI-08 — deleting a turn clears a hold that is releasable only by an observed outcome, and
-- leaves nothing that says it happened.
CREATE TRIGGER IF NOT EXISTS canonical_turns_no_delete
BEFORE DELETE ON canonical_turns
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_NO_DELETE');
END;

-- CP-HI-02 — an observation is what the outcome is computed from, so a row that appears without
-- the materializer having run leaves the computed columns describing a set that no longer exists.
--
-- Measured on a review head: settle NEVER_ADMITTED normally, then insert a valid
-- HERMES_TARGET/COMPLETED observation directly. The records disagreed while the turn still read
-- NEVER_ADMITTED / CONSISTENT, so the doctor stayed green, the quarantine did not engage, and a
-- later legitimate redelivery took the receipt fast path and never recomputed.
CREATE TRIGGER IF NOT EXISTS canonical_turn_observations_write_authority
BEFORE INSERT ON canonical_turn_observations
WHEN acp_turn_materialization_authorized(NEW.turn_request_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_AUTHORITY_DENIED');
END;

-- CP-HI-06 — an observation is what an authority reported. Editing one rewrites the testimony
-- the outcome was computed from.
CREATE TRIGGER IF NOT EXISTS canonical_turn_observations_append_only
BEFORE UPDATE ON canonical_turn_observations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_APPEND_ONLY');
END;

-- CP-HI-06 — removing an observation removes the testimony the outcome was computed from.
CREATE TRIGGER IF NOT EXISTS canonical_turn_observations_no_delete
BEFORE DELETE ON canonical_turn_observations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_APPEND_ONLY');
END;

-- CP-HI-06 — which messages a turn consumed is the other half of "this must not run again".
CREATE TRIGGER IF NOT EXISTS canonical_turn_sources_immutable
BEFORE UPDATE ON canonical_turn_sources
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SOURCE_IMMUTABLE');
END;

-- CP-HI-08 — a source removed from under a turn makes the retry rule read a turn that
-- consumed nothing, and nothing reports the loss.
CREATE TRIGGER IF NOT EXISTS canonical_turn_sources_no_delete
BEFORE DELETE ON canonical_turn_sources
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SOURCE_IMMUTABLE');
END;

-- CP-HI-04 — an attestation is a named runtime generation's proof about a binding. v22 called
-- this table append-only and nothing enforced it; an editable one lets a stale generation be
-- presented as current, which is exactly what admission reads.
CREATE TRIGGER IF NOT EXISTS actor_target_attestations_append_only
BEFORE UPDATE ON actor_target_attestations
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_ATTESTATION_APPEND_ONLY');
END;

-- CP-HI-06 — removing an attestation removes the evidence a settled turn cites.
CREATE TRIGGER IF NOT EXISTS actor_target_attestations_no_delete
BEFORE DELETE ON actor_target_attestations
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_ATTESTATION_APPEND_ONLY');
END;

-- CP-HI-04 — the binding is a lifetime bijection between an actor and one conversation. A
-- rewritable one is how a retired actor's target gets re-pointed at a fresh actor.
CREATE TRIGGER IF NOT EXISTS actor_target_bindings_immutable
BEFORE UPDATE ON actor_target_bindings
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_BINDING_IMMUTABLE');
END;

-- CP-HI-04 — a deleted binding frees its target locator for a different actor, which is the
-- same alias arriving by removal rather than by edit.
CREATE TRIGGER IF NOT EXISTS actor_target_bindings_no_delete
BEFORE DELETE ON actor_target_bindings
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_BINDING_IMMUTABLE');
END;
`;

/**
 * Recreated rather than altered, for the third time and the same reason: SQLite cannot add a
 * CHECK to an existing table. Safe for the same reason as before, and verified rather than
 * assumed — the migration refuses to run against rows it cannot attribute.
 */
const v24: SchemaMigration = {
  id: "v24-observation-ledger",
  fromVersion: 23,
  toVersion: 24,
  apply: (raw) => {
    for (const table of ["canonical_turn_sources", "canonical_turns"]) {
      const rows = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      if (rows.n > 0) {
        throw acpError(
          ReasonCode.INTERNAL_ERROR,
          `v24 cannot reconstruct observations for turns it did not see; ${table} is not empty`,
          { table, rows: rows.n },
        );
      }
    }
    raw.exec(`DROP INDEX IF EXISTS canonical_turns_one_unresolved`);
    raw.exec(`DROP TABLE IF EXISTS canonical_turn_sources`);
    raw.exec(`DROP TABLE IF EXISTS canonical_turns`);
    raw.exec(V24_OBSERVATION_LEDGER_DDL);
  },
  checksum: () => sha256(`v24-observation-ledger\n${V24_OBSERVATION_LEDGER_DDL}`),
};

/**
 * The guards v24 should have carried, for databases that already ran it.
 *
 * v24's DDL was edited in place across two correction rounds. That is the one thing this file's
 * whole discipline exists to prevent: a database that ran the earlier v24 is at version 24, has
 * none of the later triggers, and takes the same-version path at startup — where the required
 * trigger registry now demands objects it does not have and refuses to open it. It never
 * migrates, because as far as the ledger is concerned it is already current.
 *
 * A review found it by instantiating the previous v24 schema and starting against it. Neither a
 * fresh install nor a v11-to-current replay can show it, because both build the current DDL.
 */
const V25_LEDGER_GUARDS_DDL = `
INSERT OR IGNORE INTO turn_resolution_authorities (resolution_authority) VALUES
  ('ACP_OBSERVED_HERMES_REPLY');

DROP TRIGGER IF EXISTS canonical_turns_identity_immutable;
DROP TRIGGER IF EXISTS canonical_turns_born_in_doubt;
DROP TRIGGER IF EXISTS canonical_turn_observations_write_authority;
DROP TRIGGER IF EXISTS canonical_turns_no_replace;
DROP TRIGGER IF EXISTS canonical_turn_observations_no_replace;
DROP TRIGGER IF EXISTS canonical_turn_sources_no_replace;
DROP TRIGGER IF EXISTS actor_target_bindings_no_replace;
DROP TRIGGER IF EXISTS actor_target_attestations_no_replace;
`;

/**
 * Applies the current ledger trigger set to a database that ran an earlier v24.
 *
 * The triggers themselves come from the live schema so the two cannot drift; this migration owns
 * only the ordering — drop what the earlier v24 left, then create what the current one defines.
 */
const v25: SchemaMigration = {
  id: "v25-ledger-guards",
  fromVersion: 24,
  toVersion: 25,
  apply: (raw) => {
    raw.exec(V25_LEDGER_GUARDS_DDL);
    raw.exec(adjudicationDdl());
    raw.exec(ledgerTriggerDdl());
  },
  checksum: () =>
    sha256(`v25-ledger-guards\n${V25_LEDGER_GUARDS_DDL}\n${adjudicationDdl()}\n${ledgerTriggerDdl()}`),
};

/** One object out of the live schema, by pattern, so a rebuild cannot invent its own definition. */
const schemaObject = (pattern: RegExp, what: string): string => {
  const match = pattern.exec(schemaDdl());
  if (!match) {
    throw acpError(ReasonCode.INTERNAL_ERROR, `${what} is missing from schema.sql`, {});
  }
  return match[0];
};

const observationsTableOnlyDdl = (): string =>
  schemaObject(
    /CREATE TABLE IF NOT EXISTS canonical_turn_observations \([\s\S]*?\n\);/,
    "the observations table",
  );

/**
 * The `canonical_turns` table on its own, for a rebuild that changes one of its CHECKs.
 *
 * It is the parent of three tables, so the rebuild follows the order the observations rebuild
 * documents: build under a temporary name, copy, drop the old, rename the new. Renaming the *old*
 * table first would make SQLite rewrite every foreign key that names it, leaving the children
 * pointing at a table this function then drops.
 */
/**
 * The columns two tables share, read from the database rather than typed out.
 *
 * A rebuild copies rows from the old table into the new one, and the copy list was written by hand.
 * `rebuildCanonicalTurnsIfStale` omitted four NOT NULL columns — `executor_session_id`,
 * `executor_session_incarnation`, `binding_generation`, `claim_audit_event_id` — so the INSERT
 * would have failed on any database holding a single turn. Nothing caught it because every test
 * database is empty when a migration runs: a fresh install applies schema.sql whole and never
 * copies anything.
 *
 * Read from `pragma_table_info` on both sides, so the list cannot disagree with either table and a
 * column added later is carried without anyone remembering to add it here.
 */
export const sharedColumns = (raw: Database.Database, from: string, to: string): string[] => {
  // `table_xinfo` rather than `table_info`, because the latter omits generated and hidden columns —
  // so a source column of either kind would be invisible to the check below and the rebuild would
  // report a lossless copy it had not made.
  const names = (table: string): Array<{ name: string; hidden: number }> =>
    raw.prepare(`SELECT name, hidden FROM pragma_table_xinfo(?)`).all(table) as Array<{
      name: string;
      hidden: number;
    }>;
  const destination = new Map(names(to).map((row) => [row.name, row.hidden]));
  const source = names(from);
  // A column the destination does not have would be dropped when the old table goes, silently and
  // permanently. Narrowing a table may be a deliberate migration one day; it is never something a
  // rebuild helper should do because nobody listed the column.
  const lost = source.filter((row) => !destination.has(row.name)).map((row) => row.name);
  if (lost.length > 0) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      `rebuilding ${from} would drop column(s) the new table does not have; a narrowing rebuild has to say so`,
      { table: from, dropped: lost },
    );
  }
  // Generated columns are computed by SQLite and cannot be inserted into, so they are excluded from
  // the copy on purpose — present in both tables, and not carried.
  //
  // Judged on the **destination**, which is where the INSERT happens. The first version read the
  // source's `hidden` and a review built the case it gets wrong: an ordinary column that becomes
  // generated in the new table passes the missing-column check, reads `hidden = 0` on the source,
  // and lands in the INSERT — which SQLite refuses with "cannot INSERT into generated column". The
  // property is not "was this computed before" but "can this be written now".
  //
  // A column the destination computes and the source stored is a third kind of loss, and the
  // missing-column check above cannot see it: the name exists on both sides, the filter drops it
  // from the copy, and the stored values are replaced by whatever the expression yields. A review
  // built it and pointed out that the first test for this codified the replacement as correct.
  const overwritten = source.filter((row) => {
    const kind = destination.get(row.name);
    return (kind === 2 || kind === 3) && row.hidden !== 2 && row.hidden !== 3;
  });
  if (overwritten.length > 0) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      `rebuilding ${from} would replace stored column(s) with a computed value; that is a transformation, not a rebuild`,
      { table: from, overwritten: overwritten.map((row) => row.name) },
    );
  }
  // Generated on both sides: SQLite computes them and refuses an INSERT, so they are excluded from
  // the copy and nothing is lost. Judged on the destination, which is where the INSERT happens —
  // `hidden === 1` is a virtual-table hidden column, which can accept values and stays in.
  return source
    .filter((row) => {
      const kind = destination.get(row.name);
      return kind !== 2 && kind !== 3;
    })
    .map((row) => row.name);
};

const canonicalTurnsTableOnlyDdl = (): string =>
  schemaObject(
    /CREATE TABLE IF NOT EXISTS canonical_turns \([\s\S]*?\n\);/,
    "the canonical turns table",
  );

const canonicalTurnsIndexDdl = (): string =>
  schemaObject(
    /CREATE UNIQUE INDEX IF NOT EXISTS canonical_turns_one_unresolved[\s\S]*?;/,
    "the one-unresolved index",
  );

/**
 * Rebuilds `canonical_turns` when its stored definition is not the current one.
 *
 * v28 widens the outcome/authority pairing CHECK to admit `OPERATOR_AFTER_REVIEW` for `ABORTED`.
 * A CHECK cannot be altered in place, and the table carries the pairing on both sides — the
 * observation row and the materialized tuple — so widening one without the other produces a
 * settlement the observations accept and the turn refuses, which is a resolution that reports
 * success and leaves the conversation exactly as wedged.
 */
export const rebuildCanonicalTurnsIfStale = (raw: Database.Database): void => {
  const stored = (
    raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turns'")
      .get() as { sql?: string } | undefined
  )?.sql;
  if (stored === undefined) return;
  const wanted = /CREATE TABLE IF NOT EXISTS canonical_turns \([\s\S]*?\n\);/.exec(schemaDdl());
  const normalise = (sql: string): string =>
    sql
      .replace(/CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ")
      .replace(/"/g, "")
      .replace(/;\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  if (wanted && normalise(stored) === normalise(wanted[0])) return;

  raw.exec(
    canonicalTurnsTableOnlyDdl().replace(
      "CREATE TABLE IF NOT EXISTS canonical_turns",
      "CREATE TABLE canonical_turns_rebuilt",
    ),
  );
  const columns = sharedColumns(raw, "canonical_turns", "canonical_turns_rebuilt").join(", ");
  raw.exec(`INSERT INTO canonical_turns_rebuilt (${columns}) SELECT ${columns} FROM canonical_turns`);
  // `canonical_turn_sources_admission_matches_claim` lives on a *different* table
  // (`canonical_turn_sources`) and reads `canonical_turns` in a subquery — so dropping
  // `canonical_turns` does not drop it the way v26/v27's comment describes for `canonical_turns`'
  // own triggers. Left in place, the very next schema-changing statement (the rename below) makes
  // SQLite eagerly recompile every trigger's SQL and find `canonical_turns` momentarily gone:
  // "no such table: main.canonical_turns", thrown from a rename that has nothing to do with
  // sources. Dropped here and recreated once the rename has restored the table's real name, so no
  // schema-changing statement ever runs while this trigger's referenced table does not exist.
  // Guarded on `canonical_turn_sources` existing at all — a rebuild exercised on a bare
  // `canonical_turns` fixture (no sibling table) has nothing to drop or recreate.
  const hasSources = raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turn_sources'")
    .get();
  if (hasSources) raw.exec(`DROP TRIGGER IF EXISTS canonical_turn_sources_admission_matches_claim`);
  raw.exec("DROP TABLE canonical_turns");
  raw.exec("ALTER TABLE canonical_turns_rebuilt RENAME TO canonical_turns");
  raw.exec(canonicalTurnsIndexDdl());
  if (hasSources) raw.exec(sourceAdmissionMatchesClaimTriggerDdl());
};

const dispatchesDdl = (): string =>
  schemaObject(
    /CREATE TABLE IF NOT EXISTS canonical_turn_dispatches \([\s\S]*?\n\);/,
    "the dispatches table",
  );

const attestationGenerationTriggerDdl = (): string =>
  schemaObject(
    /CREATE TRIGGER IF NOT EXISTS attestation_generation_matches_assignment\n[\s\S]*?\nEND;/,
    "the attestation generation trigger",
  );

const actorIncarnationTriggersDdl = (): string =>
  [
    schemaObject(
      /CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_insert\n[\s\S]*?\nEND;/,
      "the actor incarnation insert trigger",
    ),
    schemaObject(
      /CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_update\n[\s\S]*?\nEND;/,
      "the actor incarnation update trigger",
    ),
  ].join("\n\n");

const sourceAdmissionMatchesClaimTriggerDdl = (): string =>
  schemaObject(
    /CREATE TRIGGER IF NOT EXISTS canonical_turn_sources_admission_matches_claim\n[\s\S]*?\nEND;/,
    "the source admission-matches-claim trigger",
  );

const observationsIndexDdl = (): string =>
  schemaObject(
    /CREATE INDEX IF NOT EXISTS canonical_turn_observations_by_turn[^;]*;/,
    "the observations index",
  );

/**
 * Rebuilds `canonical_turn_observations` when its stored definition is not the current one.
 *
 * v24 created it with `UNIQUE (turn_request_id, observing_authority, receipt_id)`. The live schema
 * scopes receipt identity to the authority across all turns, because per-turn scoping let one
 * authority's receipt id land on two turns — a wrong-turn completion laundering path. Nothing
 * rebuilt the table, so *every* database upgrading from v23 or earlier through v24 gets the old
 * constraint and keeps it: the code queries globally while the index only enforces per-turn.
 *
 * A duplicate that the new constraint forbids is refused rather than dropped. Losing an
 * observation is losing the evidence a turn's outcome was computed from, and a migration that
 * quietly discards one is worse than a migration that stops.
 */
export const rebuildObservationsIfStale = (raw: Database.Database): void => {
  const stored = (
    raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turn_observations'")
      .get() as { sql?: string } | undefined
  )?.sql;
  if (stored === undefined) return;
  const wanted = /CREATE TABLE IF NOT EXISTS canonical_turn_observations \([\s\S]*?\n\);/.exec(schemaDdl());
  // Quote-insensitive, because `ALTER TABLE … RENAME TO` writes the name back quoted. Comparing
  // the raw text would report a table this migration had just rebuilt as still stale.
  const normalise = (sql: string): string =>
    sql
      .replace(/CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ")
      .replace(/"/g, "")
      .replace(/;\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  if (wanted && normalise(stored) === normalise(wanted[0])) return;

  const clash = raw
    .prepare(
      `SELECT observing_authority AS a, receipt_id AS r, COUNT(*) AS n
         FROM canonical_turn_observations
        GROUP BY observing_authority, receipt_id HAVING n > 1`,
    )
    .all() as Array<{ a: string; r: string; n: number }>;
  if (clash.length > 0) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "receipt ids are reused across turns, which the current identity forbids and this migration will not discard",
      { duplicates: clash.length, first: clash[0] ?? null },
    );
  }

  // SQLite's documented order, and the reason it is that order: renaming the *old* table makes
  // SQLite rewrite every foreign key that names it, so the adjudication citations came out of the
  // first attempt pointing at `canonical_turn_observations_stale` — a table this function then
  // dropped. Building the replacement under a temporary name and renaming *it* leaves every
  // existing reference textually correct, because nothing references the temporary name.
  raw.exec(
    observationsTableOnlyDdl().replace(
      "CREATE TABLE IF NOT EXISTS canonical_turn_observations",
      "CREATE TABLE canonical_turn_observations_rebuilt",
    ),
  );
  // Derived for the same reason as the turns rebuild: this list happened to be complete, and a
  // column added to the table later would have made it silently lossy.
  const columns = sharedColumns(
    raw,
    "canonical_turn_observations",
    "canonical_turn_observations_rebuilt",
  ).join(", ");
  raw.exec(
    `INSERT INTO canonical_turn_observations_rebuilt (${columns})
     SELECT ${columns} FROM canonical_turn_observations`,
  );
  raw.exec("DROP TABLE canonical_turn_observations");
  raw.exec("ALTER TABLE canonical_turn_observations_rebuilt RENAME TO canonical_turn_observations");
  raw.exec(observationsIndexDdl());

  // The check that would have caught the first attempt. A dangling reference survives
  // `foreign_key_check` when the table it names does not exist, so ask the schema directly.
  const dangling = raw
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND sql LIKE '%canonical_turn_observations_rebuilt%'`,
    )
    .all() as Array<{ name: string }>;
  if (dangling.length > 0) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "rebuilding the observations table left a reference to its temporary name",
      { tables: dangling.map((row) => row.name) },
    );
  }
};

/**
 * Replaces every ledger trigger body, for databases whose triggers drifted under an earlier head.
 *
 * v25 dropped eight triggers by name and then ran `CREATE TRIGGER IF NOT EXISTS` for all
 * twenty-eight, so the other twenty kept whatever body they already had. Measured on a database
 * built by `132309a` and opened by this head:
 *
 * ```
 * opened; user_version now: 25
 * canonical_turns_settlement_authority  { fourArgCall: true }
 * SETTLEMENT THREW: wrong number of arguments to function acp_turn_materialization_authorized()
 * ```
 *
 * The turn stays IN_DOUBT — nothing can settle it, `adjudicate()` refuses it because it is not
 * contradicted, and the actor's next claim is refused because the first is unresolved. A
 * conversation wedged with no exit, arriving through the migration written to prevent exactly
 * that.
 *
 * This runs after v25 rather than editing it, because a database created at the head that shipped
 * v25 has already taken it and would otherwise keep the same stale bodies one version later.
 */
const v26: SchemaMigration = {
  id: "v26-ledger-trigger-bodies",
  fromVersion: 25,
  toVersion: 26,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    raw.exec(ledgerTriggerDrops());
    rebuildObservationsIfStale(raw);
    raw.exec(adjudicationDdl());
    raw.exec(ledgerTriggerDdl());
    raw.exec(provenanceNoReplaceDdl());
  },
  checksum: () =>
    sha256(
      `v26-ledger-trigger-bodies\n${ledgerTriggerDrops()}\n${adjudicationDdl()}\n` +
        `${ledgerTriggerDdl()}\n${provenanceNoReplaceDdl()}`,
    ),
};

/**
 * Requires an observation to carry the three fields that make it evidence.
 *
 * `receipt_id`, `evidence_digest` and `reason_code` were NOT NULL and nothing said they could not
 * be empty, so `ports.target.completed(permit, { receiptId: "", evidenceDigest: "", reasonCode: ""
 * })` was accepted and stored blank — measured on 74c37fa, the head that merged the ledger. A
 * settlement could say COMPLETED and cite nothing, and the retry rule would then refuse to re-run
 * the owner's message on the strength of it.
 *
 * The coordinator refuses this now too. Both, because the whole table is written on the premise
 * that a property stated in a caller is a property nothing enforces — and `receipt_id` in
 * particular is half of `(observing_authority, receipt_id)`, so a blank one is not merely thin
 * evidence, it is an identity collision waiting for the second blank settlement.
 *
 * A row that already violates it stops the migration rather than being discarded. Rows here are
 * the testimony an outcome was computed from; dropping one to make a constraint pass is the
 * failure the constraint exists to prevent.
 */
const v27: SchemaMigration = {
  id: "v27-an-observation-carries-its-evidence",
  fromVersion: 26,
  toVersion: 27,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    const blank = raw
      .prepare(
        `SELECT observation_id AS id, observing_authority AS authority
           FROM canonical_turn_observations
          WHERE receipt_id = '' OR evidence_digest = '' OR reason_code = ''`,
      )
      .all() as Array<{ id: number; authority: string }>;
    if (blank.length > 0) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "observations exist with no receipt id, evidence digest or reason code; they are testimony and this migration will not discard them",
        { unevidenced: blank.length, first: blank[0] ?? null },
      );
    }
    rebuildObservationsIfStale(raw);
    // The rebuild drops the table, and a table's triggers go with it. v26 restores them by running
    // the whole ledger DDL after its rebuild for the same reason; leaving it out would carry the
    // CHECK in and take the authority, append-only and no-delete guards out.
    raw.exec(ledgerTriggerDdl());
  },
  checksum: () => sha256(`v27-an-observation-carries-its-evidence\n${observationsTableOnlyDdl()}\n${ledgerTriggerDdl()}`),
};

/**
 * Adds the authority a person settles under, and lets an observation carry it.
 *
 * The permit that settles a turn is signed with a key that dies with the coordinator instance, so
 * a turn held across a restart had no settler at all: `contradictions()` does not list it because
 * its records do not disagree, `adjudicate()` refuses it for the same reason, and the actor's next
 * message is refused because the first is unresolved. Doctor reported the state and named no
 * command. #668, found by an independent review of the merged head.
 *
 * `OPERATOR_AFTER_REVIEW` is restricted to `ABORTED` by the outcome-pairing CHECK, which is why
 * this migration rebuilds the observation table rather than only seeding a vocabulary row. An
 * operator did not watch the target commit, so a completion under this authority would be a person
 * asserting something nobody observed — and `COMPLETED` is the direction that loses the owner's
 * question for good.
 */
const v28: SchemaMigration = {
  id: "v28-an-operator-can-settle-a-turn-nobody-observed",
  fromVersion: 27,
  toVersion: 28,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    // Before the rebuild: the table's CHECK names the authority, so the row it references has to
    // exist first or every insert into the rebuilt table fails its foreign key.
    raw.exec(
      `INSERT OR IGNORE INTO turn_resolution_authorities (resolution_authority) VALUES ('OPERATOR_AFTER_REVIEW');`,
    );
    rebuildCanonicalTurnsIfStale(raw);
    rebuildObservationsIfStale(raw);
    // Each rebuild drops its table and a table's triggers go with it, as v26 and v27 both note.
    raw.exec(ledgerTriggerDdl());
  },
  checksum: () =>
    sha256(
      `v28-an-operator-can-settle-a-turn-nobody-observed\n${canonicalTurnsTableOnlyDdl()}\n` +
        `${observationsTableOnlyDdl()}\n${ledgerTriggerDdl()}`,
    ),
};

/**
 * Records which turns were dispatched, so an authority's claim can be checked rather than believed.
 *
 * `ports.preDispatch.neverAdmitted` says nothing ran, and it was reachable after a dispatch exactly
 * as easily as before one — the retry rule then admits attempt 2 while attempt 1 may still commit.
 * Signing the outcome into the permit does not close that: a caller would hold a signature for
 * every outcome it might report and choose one. The phase is checkable and the outcome is not,
 * because the ledger can watch the phase happen. #662.
 */
const v29: SchemaMigration = {
  id: "v29-a-dispatch-is-a-fact",
  fromVersion: 28,
  toVersion: 29,
  apply: (raw) => {
    raw.exec(dispatchesDdl());
    raw.exec(ledgerTriggerDdl());
  },
  checksum: () => sha256(`v29-a-dispatch-is-a-fact\n${dispatchesDdl()}\n${ledgerTriggerDdl()}`),
};

/**
 * Gives the turn claim its own column, and moves the claims that are in the reply's.
 *
 * `result_json` is this Telegram message's reply-delivery lifecycle. The turn claim lived there
 * too, and the reply reservation writes that field whole under a precondition — "not PENDING and
 * not APPLIED" — that a claimed turn satisfies. So an ordinary timeout, which at a measured 3m15s
 * turn against a 120s deadline is the common case rather than the rare one, produced a reply, the
 * reservation overwrote the claim, and the turn identity went with it (#646).
 *
 * Rows already holding a claim are moved rather than dropped: the identity is what a receipt would
 * be matched against, and the row is the only record that a handler may already have run.
 */
const v30: SchemaMigration = {
  id: "v30-a-turn-and-a-reply-are-two-lifecycles",
  fromVersion: 29,
  toVersion: 30,
  apply: (raw) => {
    const columns = (
      raw.prepare(`SELECT name FROM pragma_table_info('inbound_messages')`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    if (!columns.includes("turn_claim_json")) {
      raw.exec(`ALTER TABLE inbound_messages ADD COLUMN turn_claim_json TEXT`);
    }
    // A claim that is still in the reply's field. `result_json` is cleared for those rows because a
    // claimed turn has no reply yet — that is what made the overwrite possible in the first place.
    // `json_valid` first. `json_extract` on a malformed value is an error, not NULL, so one
    // unparseable row aborted the UPDATE and with it the migration — and it would abort every
    // retry, because the row that caused it is still there. A row nobody can parse holds no claim
    // anyone can act on, so it is left where it is rather than made fatal.
    raw.exec(
      `UPDATE inbound_messages
          SET turn_claim_json = result_json, result_json = NULL
        WHERE turn_claim_json IS NULL
          AND result_json IS NOT NULL
          AND json_valid(result_json)
          AND json_extract(result_json, '$.deliveryStatus') = 'TURN_CLAIMED'`,
    );
  },
  checksum: () => migrationChecksum("v30-a-turn-and-a-reply-are-two-lifecycles"),
};

/**
 * Gives an attestation the one identity that has no ambiguity: the specific `assignments` row it
 * was made under.
 *
 * Neither `role` nor a bare generation number said enough on their own (#666 round 4). Generation
 * is minted per `role_key`, and `bind()` can reuse one physical actor across *different*
 * role_keys that share one `role` (#657) — each counting its own generation from 1. A stale
 * attestation for one role_key's now-superseded generation could be revived by an unrelated
 * role_key's identical, unrelated generation number, because nothing named which role_key a
 * generation belonged to. The assignment id has no such ambiguity: minted once per bind or
 * rebind and never reused, naming it names the exact role_key and generation together.
 *
 * Nullable, and left that way rather than backfilled: nothing in production writes an attestation
 * yet (the activation embargo's writer is a separate gap, #638), so there is no existing row to
 * lose. `claim()` cannot match a NULL to any assignment, so an unfilled row reads as unverifiable
 * rather than as current — the fail-closed direction.
 */
const v31: SchemaMigration = {
  id: "v31-a-generation-means-nothing-without-its-role-key",
  fromVersion: 30,
  toVersion: 31,
  apply: (raw) => {
    const columns = (
      raw.prepare(`SELECT name FROM pragma_table_info('actor_target_attestations')`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    if (!columns.includes("assignment_id")) {
      raw.exec(`ALTER TABLE actor_target_attestations ADD COLUMN assignment_id TEXT REFERENCES assignments(assignment_id)`);
    }
    // A write-time backstop for the same round: an attestation's own copy of `binding_generation`
    // must agree with the assignment it names, so a database mid-migration gets the guard the
    // fresh schema ships rather than a window without it.
    raw.exec(`DROP TRIGGER IF EXISTS attestation_generation_matches_assignment`);
    raw.exec(attestationGenerationTriggerDdl());
    // A second write-time backstop, one table further out: `conversational_actors`'s own copy of
    // a session's incarnation must agree with `sessions.incarnation` itself, not only with
    // whatever an attestation separately claims.
    raw.exec(`DROP TRIGGER IF EXISTS conversational_actors_incarnation_matches_session_on_insert`);
    raw.exec(`DROP TRIGGER IF EXISTS conversational_actors_incarnation_matches_session_on_update`);
    raw.exec(actorIncarnationTriggersDdl());
  },
  checksum: () => migrationChecksum("v31-a-generation-means-nothing-without-its-role-key"),
};

/**
 * v33 records why a session is DRAINING, not just that it is (#692 round 2), and — round 3 —
 * whether the operation that caused it is still running.
 *
 * `resumeProject` reversed *any* DRAINING session back to READY, keyed on the bare lifecycle
 * state. A replacement drains the same way a suspend does (requestReplacement, DRAIN_REQUEST) —
 * so `requestReplacement` then `resumeProject` returned the outgoing CTO to READY out from under
 * its own still-outstanding DRAIN_REQUEST, letting new runs dispatch against it while the
 * standing assumption (work stays QUEUED during a replacement) said they could not.
 *
 * Additive and nullable, like v19's `os_process_started_at`: existing rows carry NULL, and
 * `resumeProject` treats NULL the same as a non-suspend cause — fail closed, not "assume it was a
 * suspend". Nothing production writes today reaches a DRAINING session with this column unset
 * except through the exact crash this migration is too late to have recorded, which is why the
 * fail-closed reading is the only one available for pre-migration rows.
 *
 * `draining_stop_pid` is round 3's addition: a cause is not a lock. `suspendProject` commits
 * `draining_cause = SUSPEND` and *then* awaits `stopSession()` — a `resumeProject` landing in
 * that window read only the cause, saw SUSPEND, and reversed a suspend that was still running.
 * The pid (the daemon process currently awaiting that stop) is the fence: `resumeProject`
 * refuses whenever it is set and that process is still alive, exactly the way
 * `daemon.ts reconcile()`'s existing dead-session sweep already treats `sessions.os_pid` — the
 * same tolerance for pid reuse (a plain liveness check, not the stricter `(pid, startedAt)`
 * tuple `assertReviewerIndependence` needs for a security-sensitive lookup) is enough here too.
 * A crash that kills the daemon mid-await leaves this pid stamped but dead; `reconcile()` sweeps
 * exactly that shape to ERROR on the next startup (mirroring its `os_pid` loop immediately
 * above it), and `resumeProject` performs the identical check inline so it self-heals even
 * before the next restart, rather than depending on reconcile() having already run.
 *
 */
const V33_DDL = `
  ALTER TABLE sessions ADD COLUMN draining_cause TEXT
    CHECK (draining_cause IS NULL OR draining_cause IN ('SUSPEND','REPLACEMENT'));
  ALTER TABLE sessions ADD COLUMN draining_stop_pid INTEGER;
`;

const v33: SchemaMigration = {
  id: "v33-draining-remembers-its-cause",
  fromVersion: 32,
  toVersion: 33,
  apply: (raw) => {
    // The v12/v19 replay trap: a database reconstructed through the migration chain may already
    // carry this column from a replayed CREATE TABLE, and a bare ALTER then fails with
    // `duplicate column name`. Adding it only when absent keeps both routes working. The two
    // columns are checked (and, if necessary, added) independently: a database that already
    // replayed a CREATE TABLE carrying `draining_cause` but not yet `draining_stop_pid` (or vice
    // versa, mid-migration-history) must not skip the one it is actually missing.
    const columns = (raw.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    if (!columns.includes("draining_cause")) {
      raw.exec(
        `ALTER TABLE sessions ADD COLUMN draining_cause TEXT
           CHECK (draining_cause IS NULL OR draining_cause IN ('SUSPEND','REPLACEMENT'));`,
      );
    }
    if (!columns.includes("draining_stop_pid")) {
      raw.exec(`ALTER TABLE sessions ADD COLUMN draining_stop_pid INTEGER;`);
    }
  },
  checksum: () => sha256(`v33-draining-remembers-its-cause\n${V33_DDL}`),
};

/**
 * #693 — a source could be attached to an already-claimed turn by a plain `INSERT`, because the
 * no-replace trigger only refused a colliding or moved row, never a fresh one. This adds the
 * write-time backstop for the invariant `canonical_turn_sources.admission_audit_event_id` already
 * documented: every source `claim()` writes shares its turn's own `claim_audit_event_id`, because
 * the whole batch is inserted in the same transaction as the turn. A source citing a *fresh*,
 * honestly-produced audit event — including one attached after the claim transaction has closed —
 * is refused. It is an equality check, not a provenance proof: a raw writer that reads
 * `claim_audit_event_id` back out and copies it into the new row's `admission_audit_event_id`
 * passes, the same residual every trigger in this schema carries against a privileged raw-SQL
 * writer (one can always `DROP TRIGGER` too) — see `canonical_turn_sources_admission_matches_claim`
 * in schema.sql for the fuller account, and the "does NOT refuse a source that copies …" tests for
 * where it is pinned.
 *
 * Install-only: this migration adds the trigger for future writes and does not scan existing rows
 * for ones that already violate it. Harmless today because the canonical-turn ledger this trigger
 * guards has no production writer (`claim()` — #638/#639). If a production writer ever lands, it
 * ships onto a ledger this migration never audited for pre-existing violations; whoever adds that
 * writer should add a one-time backfill check (or confirm the ledger is still empty) rather than
 * assume this migration already did it.
 */
const v32: SchemaMigration = {
  id: "v32-a-source-can-only-cite-its-turns-own-claim-event",
  fromVersion: 31,
  toVersion: 32,
  apply: (raw) => {
    raw.exec(`DROP TRIGGER IF EXISTS canonical_turn_sources_admission_matches_claim`);
    raw.exec(sourceAdmissionMatchesClaimTriggerDdl());
  },
  checksum: () => migrationChecksum("v32-a-source-can-only-cite-its-turns-own-claim-event"),
};

/**
 * #674 — durable, per-session results for raw Buzz channel reads. The CLI surface can verify
 * channel traffic and read availability; it cannot expose mention classification, `needs_action`,
 * or canonical-turn delivery, so the table does not name or model those stronger states.
 *
 * Keyed on `session_id` rather than `channel_id` (#710): production sessions can share one
 * `ACP_BUZZ_CHANNEL`, while each daemon target still owns an independent measurement window.
 */
const v34: SchemaMigration = {
  id: "v34-buzz-channel-traffic-between-watch-checks",
  fromVersion: 33,
  toVersion: 34,
  apply: (raw) => {
    raw.exec(`
      CREATE TABLE IF NOT EXISTS buzz_channel_traffic_watch (
        session_id        TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        cursor_generation TEXT NOT NULL,
        baseline_at       INTEGER,
        baseline_event_ids TEXT NOT NULL DEFAULT '[]',
        window_started_at INTEGER,
        window_ended_at   INTEGER,
        observed_count    INTEGER NOT NULL DEFAULT 0,
        window_incomplete INTEGER NOT NULL DEFAULT 0,
        last_attempt_at   TEXT,
        attempt_in_progress INTEGER NOT NULL DEFAULT 0,
        last_read_success_at TEXT,
        last_error        TEXT,
        last_error_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS buzz_channel_traffic_watch_channel
        ON buzz_channel_traffic_watch(channel_id);
    `);
  },
  checksum: () => migrationChecksum("v34-buzz-channel-traffic-between-watch-checks"),
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
  v23,
  v24,
  v25,
  v26,
  v27,
  v28,
  v29,
  v30,
  v31,
  v32,
  v33,
  v34,
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
  { name: "conversational_actors_no_replace", sentinel: "CONVERSATIONAL_ACTOR_NO_REPLACE", introducedIn: 26 },
  { name: "manifests_no_replace", sentinel: "MANIFEST_NO_REPLACE", introducedIn: 26 },
  { name: "sessions_no_replace", sentinel: "SESSION_NO_REPLACE", introducedIn: 26 },
  { name: "runs_no_replace", sentinel: "RUN_NO_REPLACE", introducedIn: 26 },
  { name: "assignments_no_replace", sentinel: "ASSIGNMENT_NO_REPLACE", introducedIn: 26 },
  { name: "task_executions_no_replace", sentinel: "TASK_EXECUTION_NO_REPLACE", introducedIn: 26 },
  { name: "conversational_actor_registrations_no_replace", sentinel: "CONVERSATIONAL_ACTOR_REGISTRATION_NO_REPLACE", introducedIn: 26 },
  { name: "outbox_no_replace", sentinel: "OUTBOX_NO_REPLACE", introducedIn: 26 },
  { name: "run_artifacts_no_replace", sentinel: "RUN_ARTIFACT_NO_REPLACE", introducedIn: 26 },
  { name: "github_receipts_no_replace", sentinel: "GITHUB_RECEIPT_NO_REPLACE", introducedIn: 26 },
  { name: "canonical_turn_adjudications_no_replace", sentinel: "CANONICAL_TURN_ADJUDICATION_NO_REPLACE", introducedIn: 26 },
  { name: "canonical_turn_adjudication_citations_no_replace", sentinel: "CANONICAL_TURN_ADJUDICATION_CITATION_NO_REPLACE", introducedIn: 26 },
  { name: "audit_events_no_replace", sentinel: "AUDIT_NO_REPLACE", introducedIn: 26 },
  { name: "audit_events_append_only", sentinel: "AUDIT_APPEND_ONLY" },
  { name: "audit_events_no_delete", sentinel: "AUDIT_APPEND_ONLY" },
  { name: "canonical_turns_identity_immutable", sentinel: "CANONICAL_TURN_IDENTITY_IMMUTABLE", introducedIn: 24 },
  { name: "canonical_turns_lifecycle_monotone", sentinel: "CANONICAL_TURN_LIFECYCLE_NOT_MONOTONE", introducedIn: 24 },
  { name: "canonical_turns_outcome_never_weakens", sentinel: "CANONICAL_TURN_OUTCOME_WEAKENED", introducedIn: 24 },
  { name: "canonical_turns_born_in_doubt", sentinel: "CANONICAL_TURN_NOT_BORN_IN_DOUBT", introducedIn: 24 },
  { name: "canonical_turn_observations_write_authority", sentinel: "CANONICAL_TURN_OBSERVATION_AUTHORITY_DENIED", introducedIn: 24 },
  { name: "canonical_turn_adjudications_write_authority", sentinel: "CANONICAL_TURN_ADJUDICATION_AUTHORITY_DENIED", introducedIn: 25 },
  { name: "canonical_turn_adjudications_append_only", sentinel: "CANONICAL_TURN_ADJUDICATION_APPEND_ONLY", introducedIn: 25 },
  { name: "canonical_turn_adjudications_no_delete", sentinel: "CANONICAL_TURN_ADJUDICATION_APPEND_ONLY", introducedIn: 25 },
  { name: "canonical_turn_adjudication_citations_write_authority", sentinel: "CANONICAL_TURN_ADJUDICATION_CITATION_AUTHORITY_DENIED", introducedIn: 26 },
  { name: "canonical_turn_adjudication_citations_append_only", sentinel: "CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY", introducedIn: 25 },
  { name: "canonical_turn_adjudication_citations_no_delete", sentinel: "CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY", introducedIn: 25 },
  { name: "canonical_turn_adjudication_citations_same_turn", sentinel: "CANONICAL_TURN_ADJUDICATION_CITATION_FOREIGN", introducedIn: 25 },
  { name: "canonical_turn_dispatches_write_authority", sentinel: "CANONICAL_TURN_DISPATCH_AUTHORITY_DENIED", introducedIn: 29 },
  { name: "canonical_turn_dispatches_append_only", sentinel: "CANONICAL_TURN_DISPATCH_IMMUTABLE", introducedIn: 29 },
  { name: "canonical_turn_dispatches_no_delete", sentinel: "CANONICAL_TURN_DISPATCH_IMMUTABLE", introducedIn: 29 },
  { name: "canonical_turn_dispatches_no_replace", sentinel: "CANONICAL_TURN_DISPATCH_NO_REPLACE", introducedIn: 29 },
  { name: "canonical_turns_no_replace", sentinel: "CANONICAL_TURN_NO_REPLACE", introducedIn: 25 },
  { name: "canonical_turn_observations_no_replace", sentinel: "CANONICAL_TURN_OBSERVATION_NO_REPLACE", introducedIn: 25 },
  { name: "canonical_turn_sources_no_replace", sentinel: "CANONICAL_TURN_SOURCE_NO_REPLACE", introducedIn: 25 },
  { name: "actor_target_bindings_no_replace", sentinel: "ACTOR_TARGET_BINDING_NO_REPLACE", introducedIn: 25 },
  { name: "actor_target_attestations_no_replace", sentinel: "ACTOR_TARGET_ATTESTATION_NO_REPLACE", introducedIn: 25 },
  { name: "canonical_turns_settlement_authority", sentinel: "CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED", introducedIn: 24 },
  { name: "canonical_turns_settlement_provenance_immutable", sentinel: "CANONICAL_TURN_SETTLEMENT_PROVENANCE_IMMUTABLE", introducedIn: 24 },
  { name: "canonical_turns_consistency_monotone", sentinel: "CANONICAL_TURN_CONSISTENCY_NOT_MONOTONE", introducedIn: 24 },
  { name: "canonical_turns_no_delete", sentinel: "CANONICAL_TURN_NO_DELETE", introducedIn: 24 },
  { name: "canonical_turn_observations_append_only", sentinel: "CANONICAL_TURN_OBSERVATION_APPEND_ONLY", introducedIn: 24 },
  { name: "canonical_turn_observations_no_delete", sentinel: "CANONICAL_TURN_OBSERVATION_APPEND_ONLY", introducedIn: 24 },
  { name: "canonical_turn_sources_immutable", sentinel: "CANONICAL_TURN_SOURCE_IMMUTABLE", introducedIn: 24 },
  { name: "canonical_turn_sources_no_delete", sentinel: "CANONICAL_TURN_SOURCE_IMMUTABLE", introducedIn: 24 },
  { name: "actor_target_attestations_append_only", sentinel: "ACTOR_TARGET_ATTESTATION_APPEND_ONLY", introducedIn: 24 },
  { name: "actor_target_attestations_no_delete", sentinel: "ACTOR_TARGET_ATTESTATION_APPEND_ONLY", introducedIn: 24 },
  { name: "actor_target_bindings_immutable", sentinel: "ACTOR_TARGET_BINDING_IMMUTABLE", introducedIn: 24 },
  { name: "actor_target_bindings_no_delete", sentinel: "ACTOR_TARGET_BINDING_IMMUTABLE", introducedIn: 24 },
  { name: "attestation_generation_matches_assignment", sentinel: "ATTESTATION_GENERATION_MISMATCH", introducedIn: 31 },
  { name: "conversational_actors_incarnation_matches_session_on_insert", sentinel: "ACTOR_SESSION_INCARNATION_MISMATCH", introducedIn: 31 },
  { name: "conversational_actors_incarnation_matches_session_on_update", sentinel: "ACTOR_SESSION_INCARNATION_MISMATCH", introducedIn: 31 },
  { name: "canonical_turn_sources_admission_matches_claim", sentinel: "CANONICAL_TURN_SOURCE_NOT_CLAIM_TIME", introducedIn: 32 },
];

const REQUIRED_LEDGER_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "schema_migrations_insert_authority", sentinel: "SCHEMA_MIGRATION_AUTHORITY_DENIED" },
  { name: "schema_migrations_immutable", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
  { name: "schema_migrations_no_delete", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
];

const REQUIRED_BASELINE_LEDGER_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "baseline_records_no_replace", sentinel: "BASELINE_RECORD_NO_REPLACE", introducedIn: 26 },
  { name: "baseline_records_immutable", sentinel: "BASELINE_RECORD_IMMUTABLE" },
  { name: "baseline_records_no_delete", sentinel: "BASELINE_RECORD_IMMUTABLE" },
];

const REQUIRED_TELEGRAM_OWNER_PROMPT_TRIGGERS: ReadonlyArray<RequiredTrigger> = [
  { name: "telegram_owner_prompts_no_replace", sentinel: "TELEGRAM_PROMPT_NO_REPLACE", introducedIn: 26 },
  { name: "telegram_owner_prompts_immutable", sentinel: "TELEGRAM_PROMPT_IMMUTABLE" },
  { name: "telegram_owner_prompts_no_delete", sentinel: "TELEGRAM_PROMPT_IMMUTABLE" },
];

/**
 * Names alone are not enough: a same-named no-op trigger would make a corrupt database look
 * healthy. Historical backups are checked against the registry as it existed at their recorded
 * schema version, so a v11 image is not rejected merely because a later migration added another
 * load-bearing trigger.
 *
 * The denial marker is not enough either, and that is what this file learned the expensive way. A
 * database created at `132309a` kept a settlement trigger calling a four-argument marker that no
 * longer exists; the body was wrong in the one way that mattered and still contained
 * `CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED`, so this check passed it as healthy and every
 * settlement afterwards threw. A substring proves a name is present in a body. It does not prove
 * the body is the one the guard was written as.
 *
 * So for the ledger triggers — the set whose bodies this module can produce — the whole body is
 * compared against the live schema, normalised the way SQLite stores it. The rest still rest on
 * their sentinel, which is a weaker check and is written down as one: there is no extractor for
 * their definitions, and a check that quietly skipped what it could not verify would be the same
 * defect wearing this function's name.
 */
const normaliseTriggerSql = (sql: string): string =>
  sql.replace(/CREATE TRIGGER IF NOT EXISTS /, "CREATE TRIGGER ").replace(/;\s*$/, "").trim();

/** The body each ledger trigger is defined as, by name, taken from the live schema. */
const ledgerTriggerBodies = (): ReadonlyMap<string, string> => {
  const bodies = new Map<string, string>();
  for (const match of ledgerTriggerDdl().matchAll(
    /CREATE TRIGGER IF NOT EXISTS (\w+)\n[\s\S]*?\nEND;/g,
  )) {
    bodies.set(match[1]!, normaliseTriggerSql(match[0]));
  }
  return bodies;
};

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
  // Only for a database at the current version. An older image's ledger triggers are legitimately
  // the older definitions, and rejecting a v11 backup for not carrying today's bodies would make
  // this check refuse the archives it exists to validate.
  const bodies = schemaVersion === SCHEMA_VERSION ? ledgerTriggerBodies() : new Map<string, string>();
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
    const expectedBody = bodies.get(trigger.name);
    if (row?.sql && expectedBody !== undefined && normaliseTriggerSql(row.sql) !== expectedBody) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        `load-bearing trigger ${trigger.name} does not have the body this schema defines`,
        { trigger: trigger.name, schemaVersion },
      );
    }
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
