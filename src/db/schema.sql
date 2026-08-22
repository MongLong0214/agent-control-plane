-- Agent Control Plane — persistence model.
--
-- PRD §30. Table count is not a quality goal: a table exists only where there is an
-- independent lifecycle, an integrity constraint that needs enforcing, or a query that
-- cannot be answered from a JSON blob. Each table below carries its justification.
--
-- Explicitly excluded (PRD §30.4): event sourcing, audit hash chain, generic policy DSL,
-- distributed consensus, cloud DB.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

-- ---------------------------------------------------------------------------
-- manifests
--   Lifecycle: portable project contract, immutable, outlives any single run.
--   Integrity: content is addressed by its own canonical digest (§30.2 #10 — the
--   active manifest digest must be an immutable artifact reference).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manifests (
  digest        TEXT PRIMARY KEY,
  schema_id     TEXT NOT NULL,
  content_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (digest LIKE 'sha256:%')
);

-- CP-HI-03 — an approved contract cannot be edited after approval; verification pins this digest.
CREATE TRIGGER IF NOT EXISTS manifests_immutable
BEFORE UPDATE ON manifests
BEGIN
  SELECT RAISE(ABORT, 'MANIFEST_IMMUTABLE');
END;

-- CP-HI-06 — same census, same hole: a manifest is immutable and REPLACE rewrote it by digest.
CREATE TRIGGER IF NOT EXISTS manifests_no_replace
BEFORE INSERT ON manifests
WHEN EXISTS (SELECT 1 FROM manifests WHERE digest = NEW.digest)
BEGIN
  SELECT RAISE(ABORT, 'MANIFEST_NO_REPLACE');
END;

-- ---------------------------------------------------------------------------
-- projects  (PRD §9.1)
--   Holds identity + activation reference only. NOT a copy of the manifest.
--   activity is DERIVED from primary CTO binding presence and is therefore not
--   stored as an independent column; availability comes from runtime health.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  project_id             TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  active_manifest_digest TEXT REFERENCES manifests(digest),
  availability           TEXT NOT NULL DEFAULT 'HEALTHY'
                           CHECK (availability IN ('HEALTHY','DEGRADED','UNAVAILABLE')),
  suspended              INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  created_at             TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- repositories  (PRD §9.2, Integration §11)
--   Machine-local binding SSOT. Absolute checkout paths live here and nowhere
--   else — never in a committed manifest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repositories (
  repository_id          TEXT PRIMARY KEY,
  identity               TEXT NOT NULL UNIQUE,     -- normalized remote identity
  checkout_path          TEXT NOT NULL,            -- absolute, machine-local
  project_id             TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
  repository_role        TEXT,                     -- 'primary' | 'secondary' | ...
  trust_class            TEXT NOT NULL DEFAULT 'OWNER_TRUSTED'
                           CHECK (trust_class IN ('OWNER_TRUSTED','UNTRUSTED')),
  active_manifest_digest TEXT REFERENCES manifests(digest),
  observed_remote_url    TEXT,
  last_observed_head     TEXT,
  last_observed_at       TEXT,
  drift_state            TEXT NOT NULL DEFAULT 'UNKNOWN'
                           CHECK (drift_state IN ('UNKNOWN','IN_SYNC','DRIFTED')),
  registration           TEXT NOT NULL DEFAULT 'REGISTERED'
                           CHECK (registration IN ('REGISTERED','TEMPORARY')),
  temporary_for_run      TEXT,                     -- §16.3 run-scoped binding
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS repositories_project ON repositories(project_id);

-- A checkout is a machine-local identity binding, not an alias that two repository
-- identities may claim. Sharing it would let write guards disagree about provenance.
CREATE UNIQUE INDEX IF NOT EXISTS repositories_checkout_path ON repositories(checkout_path);

-- ---------------------------------------------------------------------------
-- sessions  (PRD §9.3, §5.5, §5.6)
--   A runtime session, not an organisational identity. BUSY is derived from owned
--   active runs and deliberately absent from the lifecycle enum.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  incarnation    TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  effort         TEXT,
  lifecycle      TEXT NOT NULL
                   CHECK (lifecycle IN ('STARTING','READY','DRAINING','STOPPED','ERROR')),
  buzz_address   TEXT,
  -- §27.2 — the Buzz *actor* identity this session speaks as, which is not the same fact
  -- as `buzz_address`: an address is a shared routing destination anybody can name, so it
  -- can never authorize an inbound message. This column is the separately authenticated
  -- identity an inbound actor is resolved through, and it is written only by
  -- SessionRegistry.bindBuzzActor, which requires the session secret plus an ingress
  -- authenticator that vouches for the actor id.
  buzz_actor_id  TEXT,
  -- Never retain the session secret itself. The hash is enough to bind a local
  -- handshake while keeping credentials out of durable state (§31.5).
  session_secret_hash TEXT,
  os_pid         INTEGER,
  -- CP-HI-04 — a pid alone does not identify a process. Pids are reused, and this column is
  -- resolved back to a session inside assertReviewerIndependence, so a reused pid could hide a
  -- producer and let it review its own run (#505). The start time makes the pair unique for as
  -- long as the process lives.
  os_process_started_at TEXT,
  workdir        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  stopped_at     TEXT
);

-- CP-HI-02 — incarnation is the session's identity; rewriting it re-points every receipt that named it.
-- §30.2 #3 — session incarnation is immutable for the life of the session row.
CREATE TRIGGER IF NOT EXISTS sessions_incarnation_immutable
BEFORE UPDATE OF incarnation ON sessions
WHEN NEW.incarnation <> OLD.incarnation
BEGIN
  SELECT RAISE(ABORT, 'SESSION_INCARNATION_IMMUTABLE');
END;

-- CP-HI-06 — the session credential, rewritable by an ordinary statement.
--
-- Every guard on this table is `BEFORE UPDATE OF <column>`, and `INSERT OR REPLACE` is a delete
-- and an insert: no UPDATE fires, so none of them sees it. `recursive_triggers` does not help
-- either — it makes the implicit delete fire DELETE triggers, and this table has none. Measured
-- on ACP's own connection, which sets that pragma ON:
--
--   UPDATE session_secret_hash  -> refused
--   INSERT OR REPLACE           -> hash, incarnation, Buzz channel identity and workdir rewritten
--
-- The comment above `sessions_secret_hash_immutable` says a rewritable hash lets a local caller
-- mint itself a new credential. That was true and the guard did not cover the statement that
-- does it.
CREATE TRIGGER IF NOT EXISTS sessions_no_replace
BEFORE INSERT ON sessions
WHEN EXISTS (
  SELECT 1 FROM sessions
   WHERE (session_id = NEW.session_id)
           OR (buzz_actor_id = NEW.buzz_actor_id AND (buzz_actor_id IS NOT NULL AND lifecycle IN ('STARTING','READY','DRAINING')) AND (NEW.buzz_actor_id IS NOT NULL AND NEW.lifecycle IN ('STARTING','READY','DRAINING')))
)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_NO_REPLACE');
END;

-- CP-HI-02 — a rotated secret would let a second peer inherit an established session's authority.
-- An issued session secret cannot be rotated in place or cleared: the peer that holds
-- the plaintext is the only thing that proves an MCP caller is this session, so a
-- rewritable hash would let a local caller mint itself a new credential for an existing
-- session. A respawn issues a new session row instead.
CREATE TRIGGER IF NOT EXISTS sessions_secret_hash_immutable
BEFORE UPDATE OF session_secret_hash ON sessions
WHEN OLD.session_secret_hash IS NOT NULL
  AND (NEW.session_secret_hash IS NULL OR NEW.session_secret_hash <> OLD.session_secret_hash)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_SECRET_HASH_IMMUTABLE');
END;

-- Only one *live* session may speak as a given Buzz channel identity. Two live sessions holding the
-- same actor id would make inbound resolution ambiguous, which is how an actor could be
-- routed onto a role it never held. Terminal sessions are excluded so a respawn can
-- re-register the actor the stopped incarnation used.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_buzz_actor
  ON sessions(buzz_actor_id)
  WHERE buzz_actor_id IS NOT NULL AND lifecycle IN ('STARTING','READY','DRAINING');

-- CP-HI-02 — channel identity is write-once, so allowlist membership cannot be moved onto a live session.
-- An actor binding is write-once. If it could be rewritten, one authenticated write would
-- be enough to later re-point an authenticated actor identity at a different session and
-- inherit whatever role that session holds.
CREATE TRIGGER IF NOT EXISTS sessions_buzz_actor_immutable
BEFORE UPDATE OF buzz_actor_id ON sessions
WHEN OLD.buzz_actor_id IS NOT NULL
  AND (NEW.buzz_actor_id IS NULL OR NEW.buzz_actor_id <> OLD.buzz_actor_id)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_BUZZ_ACTOR_IMMUTABLE');
END;

-- A runtime's workdir is a durable fact used when a session is routed again. Once a
-- provisioned session records it, callers may not rewrite or clear it behind the runtime's
-- back; a new process gets a new session row instead.
-- CP-HI-01 — a session's managed workdir is fixed at admission; a moved root would put
-- agent writes outside the boundary the Guard was told to enforce.
CREATE TRIGGER IF NOT EXISTS sessions_workdir_immutable
BEFORE UPDATE OF workdir ON sessions
WHEN OLD.workdir IS NOT NULL
  AND (NEW.workdir IS NULL OR NEW.workdir <> OLD.workdir)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_WORKDIR_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- conversational_actors  (#449)
--   The long-lived counterpart that owns a transcript. A session is a replaceable model
--   runtime; the actor is what survives replacing one. Failover moves current_session_id
--   here and leaves the binding — and therefore binding_generation — alone.
-- ---------------------------------------------------------------------------
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

-- CP-HI-08 — an actor's runtime may only ever point at a READY session (#493).
--
-- task_executions_worker_binding_required used to rest on assignments.session_id, which is
-- immutable under assignments_generation_immutable. After #493 it rests on this column, which is
-- mutable — so the guard would have traded an enforced dependency for a conventional one, and a
-- convention is what CP-HI-08 exists to catch. This makes it enforced again: nothing can repoint
-- an actor at a session that is not ready to work, whatever writes it.
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

-- CP-HI-04 — retirement is terminal, for the same reason revocation is: an actor brought back
-- after its bindings were fenced would make superseded authority current again.
CREATE TRIGGER IF NOT EXISTS conversational_actors_retirement_terminal
BEFORE UPDATE ON conversational_actors
WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_RETIREMENT_TERMINAL');
END;

-- CP-HI-06 — retirement is terminal, and REPLACE undid it.
--
-- `conversational_actors_retirement_terminal` guards UPDATE, so it never saw an
-- `INSERT OR REPLACE` on an existing actor_id: SQLite skips the implicit delete's triggers when
-- `recursive_triggers` is off, which it is on any connection ACP did not open. Measured — a
-- retired actor's `retired_at` went from a timestamp to NULL under the same id, and retirement is
-- what stops an actor taking turns.
--
-- Found by the census in scripts/verify-append-only-tables-are-closed.mjs rather than by anyone
-- looking, which is the point of having it.
CREATE TRIGGER IF NOT EXISTS conversational_actors_no_replace
BEFORE INSERT ON conversational_actors
WHEN EXISTS (SELECT 1 FROM conversational_actors WHERE actor_id = NEW.actor_id)
BEGIN
  SELECT RAISE(ABORT, 'CONVERSATIONAL_ACTOR_NO_REPLACE');
END;

-- ---------------------------------------------------------------------------
-- conversational_actor_registrations  (L5 canonical active-set authority)
--   Registration binds an existing first-class actor identity to a caller-owned actor
--   generation. It neither creates an actor nor starts or assigns a runtime.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversational_actor_registry_state (
  registry_id             INTEGER PRIMARY KEY CHECK (registry_id = 1),
  registry_set_generation INTEGER NOT NULL CHECK (registry_set_generation >= 0)
);

INSERT OR IGNORE INTO conversational_actor_registry_state
  (registry_id, registry_set_generation) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS conversational_actor_registrations (
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

CREATE UNIQUE INDEX IF NOT EXISTS conversational_actor_registrations_active_actor
  ON conversational_actor_registrations(actor_id)
  WHERE registration_state = 'REGISTERED';

-- CP-HI-04 — registration generations only advance; reusing an older generation would
-- make superseded actor membership current again.
CREATE TRIGGER IF NOT EXISTS conversational_actor_registration_generation_monotonic
BEFORE INSERT ON conversational_actor_registrations
WHEN NEW.actor_generation <= COALESCE(
  (SELECT MAX(actor_generation) FROM conversational_actor_registrations
    WHERE actor_id = NEW.actor_id), 0)
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_REGISTRATION_GENERATION_NOT_MONOTONIC');
END;

-- CP-HI-06 — registration state is monotone under UPDATE only.
--
-- The whole key, not its first column. This table's key is (actor_id, actor_generation),
-- and a version of this trigger that named only the actor refused a *rotation* — a new row
-- at a higher generation, which is the operation the registry exists to perform. A REPLACE
-- guard that names less than the key refuses legitimate inserts; one that names more lets
-- the collision through.
CREATE TRIGGER IF NOT EXISTS conversational_actor_registrations_no_replace
BEFORE INSERT ON conversational_actor_registrations
WHEN EXISTS (
  SELECT 1 FROM conversational_actor_registrations
   WHERE (actor_id = NEW.actor_id AND actor_generation = NEW.actor_generation)
           OR (actor_id = NEW.actor_id AND (registration_state = 'REGISTERED') AND (NEW.registration_state = 'REGISTERED'))
)
BEGIN
  SELECT RAISE(ABORT, 'CONVERSATIONAL_ACTOR_REGISTRATION_NO_REPLACE');
END;

-- CP-HI-04 — registration retirement is terminal; reactivation would bypass the fencing
-- generation required for a new membership decision.
CREATE TRIGGER IF NOT EXISTS conversational_actor_registration_retirement_terminal
BEFORE UPDATE OF registration_state ON conversational_actor_registrations
WHEN OLD.registration_state = 'RETIRED' AND NEW.registration_state <> 'RETIRED'
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_REGISTRATION_RETIREMENT_TERMINAL');
END;

-- ---------------------------------------------------------------------------
-- assignments  (PRD §9.4 role binding)
--   role_key is the logical endpoint: 'CEO', 'PRIMARY_CTO:<projectId>',
--   'BLIND_REVIEWER:<runId>', 'WORKER:<taskId>', 'BOOTSTRAP_CTO:<runId>'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id      TEXT PRIMARY KEY,
  role_key           TEXT NOT NULL,
  role               TEXT NOT NULL
                       CHECK (role IN ('CEO','BOOTSTRAP_CTO','PRIMARY_CTO','BLIND_REVIEWER',
                                       'WORKER','OPTIONAL_ADVERSARIAL_REVIEWER')),
  project_id         TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
  run_id             TEXT,
  task_id            TEXT,
  actor_id           TEXT NOT NULL REFERENCES conversational_actors(actor_id),
  -- The runtime at binding time, not the live one. #449 moved the live pointer to
  -- conversational_actors.current_session_id; this stays immutable so assignments_owner_tuple
  -- and the composite FK from runs keep identifying one binding row.
  session_id         TEXT NOT NULL REFERENCES sessions(session_id),
  session_incarnation TEXT NOT NULL,
  binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
  mode               TEXT NOT NULL CHECK (mode IN ('PREFERRED','FALLBACK')),
  status             TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoked_reason     TEXT
);

-- §30.2 #2 — at most one ACTIVE binding per logical role key.
CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_role_key
  ON assignments(role_key) WHERE status = 'ACTIVE';

-- §30.2 #1 — at most one ACTIVE primary CTO per project (defence in depth over the
-- role_key uniqueness above, which already embeds the project id).
CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_primary_cto
  ON assignments(project_id) WHERE role = 'PRIMARY_CTO' AND status = 'ACTIVE';

-- CP-HI-04 — fencing generations only advance; a lowered one revives a superseded role holder.
-- §30.2 #4 — binding generation is monotonic per role key.
CREATE TRIGGER IF NOT EXISTS assignments_generation_monotonic
BEFORE INSERT ON assignments
WHEN NEW.binding_generation <= COALESCE(
  (SELECT MAX(binding_generation) FROM assignments WHERE role_key = NEW.role_key), 0)
BEGIN
  SELECT RAISE(ABORT, 'BINDING_GENERATION_NOT_MONOTONIC');
END;

-- CP-HI-06 — revocation is terminal, and REPLACE un-revokes.
CREATE TRIGGER IF NOT EXISTS assignments_no_replace
BEFORE INSERT ON assignments
WHEN EXISTS (
  SELECT 1 FROM assignments
   WHERE (assignment_id = NEW.assignment_id)
           OR (role_key = NEW.role_key AND (status = 'ACTIVE') AND (NEW.status = 'ACTIVE'))
           OR (project_id = NEW.project_id AND (role = 'PRIMARY_CTO' AND status = 'ACTIVE') AND (NEW.role = 'PRIMARY_CTO' AND NEW.status = 'ACTIVE'))
           OR (role_key = NEW.role_key AND binding_generation = NEW.binding_generation AND session_id = NEW.session_id AND session_incarnation = NEW.session_incarnation)
)
BEGIN
  SELECT RAISE(ABORT, 'ASSIGNMENT_NO_REPLACE');
END;

-- CP-HI-04 — the identity columns of a binding are fixed once written.
-- INSERT-only monotonicity is not enough: lowering binding_generation, or moving a low
-- generation into another role's history via role_key, would reactivate stale authority.
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

-- CP-HI-04 — revocation is terminal; re-activating a revoked binding defeats fencing.
-- Revocation advances a fencing generation. Re-activating an old row would make stale
-- authority current again after every newer generation has been revoked.
CREATE TRIGGER IF NOT EXISTS assignments_revocation_terminal
BEFORE UPDATE OF status ON assignments
WHEN OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED'
BEGIN
  SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
END;

-- CP-HI-04 — the ACTIVE row for a role key is always its newest generation.
-- Defence in depth over the monotonic insertion trigger: an ACTIVE row is always the
-- newest generation for its logical role endpoint.
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

-- CP-HI-04 — refuses an insert that would sit behind a live binding, closing the INSERT side of the same rule.
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

-- A run owner pin has to identify one actual role binding, not a mix of fields from
-- different rows. The unique parent key is immutable under the trigger above.
CREATE UNIQUE INDEX IF NOT EXISTS assignments_owner_tuple
  ON assignments(role_key, binding_generation, session_id, session_incarnation);

CREATE INDEX IF NOT EXISTS assignments_session ON assignments(session_id, status);
CREATE INDEX IF NOT EXISTS assignments_run ON assignments(run_id);
CREATE INDEX IF NOT EXISTS assignments_actor ON assignments(actor_id, status);

-- ---------------------------------------------------------------------------
-- runs  (PRD §11, §29)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
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
  -- §17.5 has no project manifest; its first verified command set is pinned here instead.
  pinned_run_scoped_commands_digest TEXT,
  pinned_run_scoped_commands_json   TEXT,
  -- §30.2 #6 — run owner is (session, binding generation), pinned at dispatch admission.
  owner_session_id          TEXT REFERENCES sessions(session_id),
  owner_binding_generation  INTEGER,
  owner_session_incarnation TEXT,
  owner_role_key            TEXT,
  -- The candidate every read of this run's evidence must agree with. Freezing a new
  -- candidate moves this pointer and supersedes prior evidence in one transaction, so a
  -- crash cannot leave stale evidence looking current (CP-HI-06).
  current_candidate_digest  TEXT,
  human_gate_required       INTEGER NOT NULL DEFAULT 0 CHECK (human_gate_required IN (0,1)),
  revision_count            INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  dispatched_at             TEXT,
  ended_at                  TEXT,
  state_reason              TEXT,
  -- owner pinning is all-or-nothing
  CHECK ((owner_session_id IS NULL) = (owner_binding_generation IS NULL)),
  CHECK ((owner_session_id IS NULL) = (owner_session_incarnation IS NULL)),
  CHECK ((owner_session_id IS NULL) = (owner_role_key IS NULL)),
  CHECK ((pinned_run_scoped_commands_digest IS NULL) = (pinned_run_scoped_commands_json IS NULL)),
  FOREIGN KEY (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation)
    REFERENCES assignments(role_key, binding_generation, session_id, session_incarnation)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner_session_id, state);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, state);

-- ---------------------------------------------------------------------------
-- candidate_pipeline_attempts  (PRD §30.3 candidate-pipeline attempt lease)
--   Lifecycle: one active orchestration attempt owns a run until its conditional release.
--   Integrity: run_id is the lease key, so concurrent submissions collide atomically.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidate_pipeline_attempts (
  -- The foreign key is what stops rows accumulating for runs that never existed: the lease is
  -- taken by run id, and without it a bogus submission leaves a permanent orphan (#344).
  run_id                   TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id               TEXT NOT NULL,
  owner_session_id         TEXT NOT NULL,
  owner_binding_generation INTEGER NOT NULL,
  candidate_digest         TEXT,
  state                    TEXT NOT NULL CHECK (state IN ('RUNNING','RELEASED')),
  started_at               TEXT NOT NULL,
  -- A lease is reclaimable by the fact persisted at acquisition, not by a watchdog's
  -- later reconstruction of policy from started_at (#335).
  deadline_at              TEXT NOT NULL,
  released_at              TEXT
);

-- The watchdog reads only expired RUNNING leases, so recovery stays a deadline probe rather
-- than a full attempt-history scan as the table grows (#335).
CREATE INDEX IF NOT EXISTS candidate_pipeline_attempts_running_deadline
  ON candidate_pipeline_attempts(state, deadline_at);

-- ---------------------------------------------------------------------------
-- finalization_attempts
--   Lifecycle: the daemon owns one recoverable finalization lease per CEO-approved run.
--   Integrity: the lease is durable independently of individual GitHub receipts, so a
--   restart can resume the same ordered sequence without inventing a second attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finalization_attempts (
  run_id                 TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id             TEXT NOT NULL,
  lease_owner            TEXT NOT NULL,
  candidate_digest       TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN ('RUNNING','RELEASED','COMPLETED','BLOCKED')),
  started_at             TEXT NOT NULL,
  deadline_at            TEXT NOT NULL,
  released_at            TEXT,
  completed_at           TEXT,
  last_step              TEXT NOT NULL,
  failure_reason         TEXT,
  compensation_plan_json TEXT,
  CHECK (compensation_plan_json IS NULL OR json_valid(compensation_plan_json) = 1)
);

CREATE INDEX IF NOT EXISTS finalization_attempts_running_deadline
  ON finalization_attempts(state, deadline_at);

-- CP-HI-02 — §29's state machine is enforced in the database, not only in the service that usually writes it.
-- §29 is a persisted state machine. The service owns authority/evidence/outbox work,
-- while this guard rejects topology bypasses even from a raw SQLite caller.
CREATE TRIGGER IF NOT EXISTS runs_state_transition_guard
BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
 AND NOT (
   (OLD.state = 'QUEUED' AND NEW.state IN ('ACTIVE','CANCELLED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('BLOCKED','READY_FOR_CEO_REVIEW','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'BLOCKED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'READY_FOR_CEO_REVIEW' AND NEW.state IN ('CEO_APPROVED','COMPLETED','REVISION_REQUIRED','AWAITING_HUMAN')) OR
   (OLD.state = 'CEO_APPROVED' AND NEW.state IN ('MERGING')) OR
   (OLD.state = 'MERGING' AND NEW.state IN ('POST_MERGE_VERIFYING','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'POST_MERGE_VERIFYING' AND NEW.state IN ('MERGING','COMPLETED','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'REVISION_REQUIRED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED')) OR
   (OLD.state = 'AWAITING_HUMAN' AND NEW.state IN ('ACTIVE','CANCELLED','FAILED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'RUN_STATE_TRANSITION_ILLEGAL');
END;

-- CP-HI-06 — same shape: the pinned manifest and the state guards are all BEFORE UPDATE OF.
CREATE TRIGGER IF NOT EXISTS runs_no_replace
BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'RUN_NO_REPLACE');
END;

-- CP-HI-02 — a legal edge still requires daemon authority; the connection marker proves it.
-- A legal edge is not, by itself, authority to take it. The marker is connection-local and
-- scoped to one run and target state while Db.applyRunStateTransition writes the audit proof
-- and outbox envelope in the same transaction; a raw UPDATE cannot manufacture that fact.
CREATE TRIGGER IF NOT EXISTS runs_state_transition_authority_guard
BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
 AND (
   (OLD.state = 'QUEUED' AND NEW.state IN ('ACTIVE','CANCELLED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('BLOCKED','READY_FOR_CEO_REVIEW','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'BLOCKED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'READY_FOR_CEO_REVIEW' AND NEW.state IN ('CEO_APPROVED','COMPLETED','REVISION_REQUIRED','AWAITING_HUMAN')) OR
   (OLD.state = 'CEO_APPROVED' AND NEW.state IN ('MERGING')) OR
   (OLD.state = 'MERGING' AND NEW.state IN ('POST_MERGE_VERIFYING','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'POST_MERGE_VERIFYING' AND NEW.state IN ('MERGING','COMPLETED','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'REVISION_REQUIRED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED')) OR
   (OLD.state = 'AWAITING_HUMAN' AND NEW.state IN ('ACTIVE','CANCELLED','FAILED'))
 )
 AND acp_run_state_transition_authorized(NEW.run_id, NEW.state) <> 1
BEGIN
  SELECT RAISE(ABORT, 'RUN_STATE_TRANSITION_AUTHORITY_DENIED');
END;

-- CP-HI-03 — dispatch/pinning may fill an empty pin once; no later operation may
-- rewrite, clear, or replace the contract that the run will be judged against.
CREATE TRIGGER IF NOT EXISTS runs_pinned_manifest_immutable
BEFORE UPDATE OF pinned_manifest_digest ON runs
WHEN NEW.pinned_manifest_digest IS NOT OLD.pinned_manifest_digest
 AND NOT (OLD.pinned_manifest_digest IS NULL AND NEW.pinned_manifest_digest IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PINNED_MANIFEST_IMMUTABLE');
END;

-- CP-HI-03 — a candidate cannot alter the commands that will judge it.
-- The temporary-repository path has no project manifest at dispatch time. Its command
-- contract may be filled once by VerificationEngine, but never changed after a result
-- reveals that the first suite failed.
CREATE TRIGGER IF NOT EXISTS runs_pinned_run_scoped_commands_immutable
BEFORE UPDATE OF pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json ON runs
WHEN (
  NEW.pinned_run_scoped_commands_digest IS NOT OLD.pinned_run_scoped_commands_digest
  OR NEW.pinned_run_scoped_commands_json IS NOT OLD.pinned_run_scoped_commands_json
)
 AND NOT (
  OLD.pinned_run_scoped_commands_digest IS NULL
  AND OLD.pinned_run_scoped_commands_json IS NULL
  AND NEW.pinned_run_scoped_commands_digest IS NOT NULL
  AND NEW.pinned_run_scoped_commands_json IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'PINNED_RUN_SCOPED_COMMANDS_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- run_repositories
--   Lifecycle: per-run repository participation (§11.4 multi-repository run).
--   Integrity: merge order and per-repo branch contract need relational queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_repositories (
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  repository_id   TEXT NOT NULL REFERENCES repositories(repository_id),
  repository_role TEXT NOT NULL,
  base_branch     TEXT NOT NULL,
  work_branch     TEXT,
  worktree_id     TEXT,
  merge_order     INTEGER NOT NULL DEFAULT 0,
  merge_state     TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (merge_state IN ('PENDING','MERGED','FAILED','SKIPPED','ROLLED_BACK')),
  PRIMARY KEY (run_id, repository_id)
);

-- ---------------------------------------------------------------------------
-- tasks  (PRD §5.4, §11.3 dynamic task graph)
--   Lifecycle: a task node persists across multiple execution attempts, so it is
--   distinct from task_executions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL
                   CHECK (category IN ('mechanical','implementation','investigation','integration',
                                       'test','review','docs','migration','benchmark','security')),
  state          TEXT NOT NULL
                   CHECK (state IN ('PENDING','READY','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  spec_json      TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id, state);

-- CP-HI-02 — task admission closes when the run seals; late work cannot join a run being completed.
-- §34.3 — task admission is closed as soon as a packet exists, while an owner is deciding
-- on that packet, or after the run ends. TaskGraph returns the same denial at its public
-- admission point; this trigger protects direct SQL writers and cross-connection races.
CREATE TRIGGER IF NOT EXISTS tasks_run_work_sealed
BEFORE INSERT ON tasks
WHEN EXISTS (
  SELECT 1 FROM runs
   WHERE run_id = NEW.run_id
     AND state IN ('READY_FOR_CEO_REVIEW','CEO_APPROVED','MERGING','POST_MERGE_VERIFYING',
                   'BLOCKED_POST_MERGE','AWAITING_HUMAN','COMPLETED','FAILED','CANCELLED')
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_INSERT_RUN_SEALED');
END;

-- DAG edges. Separate table because the dependency relation is queried in both
-- directions (readiness and blast radius) and must be integrity-checked.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  depends_on   TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

-- ---------------------------------------------------------------------------
-- task_executions  (PRD §25.2 minimum runtime resource receipt)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_executions (
  execution_id             TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id                  TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt                  INTEGER NOT NULL,
  owner_binding_generation INTEGER NOT NULL,
  -- CP-HI-04 — a receipt cannot omit the session that produced the work. The trigger
  -- below additionally proves that this session held the worker binding at admission.
  worker_session_id        TEXT NOT NULL REFERENCES sessions(session_id),
  worker_process_id        INTEGER,
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL,
  repository_id            TEXT REFERENCES repositories(repository_id),
  worktree_id              TEXT,
  concurrency_width        INTEGER,
  started_at               TEXT NOT NULL,
  last_activity_at         TEXT,
  ended_at                 TEXT,
  status                   TEXT NOT NULL
                             CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','ABANDONED','TIMEOUT')),
  failure_class            TEXT CHECK (failure_class IN ('transient','repairable','contract','security',
                                                         'policy','capacity','infrastructure',
                                                         'unknown_observed')),
  result_digest            TEXT,
  UNIQUE (task_id, attempt)
);

CREATE INDEX IF NOT EXISTS task_executions_open ON task_executions(status, started_at);

-- CP-HI-04 — an execution names a real bound worker rather than an arbitrary session.
-- A caller cannot fabricate a receipt for an arbitrary session. At insertion the named
-- session must be the runtime currently serving the actor that holds the active, canonical
-- WORKER:<taskId> binding, and be ready to work.
--
-- #493 — this asks about the *live* runtime, not the runtime at binding time. Resting on
-- assignments.session_id meant that after a surviving failover the worker's own executions were
-- refused, because that column still named the session that died. A guard that refuses correct
-- work is a bug, not safety. `conversational_actors_runtime_ready` keeps the dependency enforced:
-- current_session_id can only ever name a READY session.
-- TaskGraph performs the same check for an explainable denial; this is the durable backstop
-- for every raw SQL writer.
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

-- CP-HI-06 — the worker identity is immutable under UPDATE and was rewritable by REPLACE.
CREATE TRIGGER IF NOT EXISTS task_executions_no_replace
BEFORE INSERT ON task_executions
WHEN EXISTS (
  SELECT 1 FROM task_executions
   WHERE (execution_id = NEW.execution_id)
           OR (task_id = NEW.task_id AND attempt = NEW.attempt)
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_EXECUTION_NO_REPLACE');
END;

-- CP-HI-04 — recorded producer identity is historical provenance and cannot be rewritten.
-- The identity recorded at admission is historical provenance. Rewriting its task, run,
-- or worker afterwards would turn a valid receipt into a claim for someone else's work.
CREATE TRIGGER IF NOT EXISTS task_executions_worker_identity_immutable
BEFORE UPDATE OF run_id, task_id, worker_session_id ON task_executions
WHEN NEW.run_id <> OLD.run_id
  OR NEW.task_id <> OLD.task_id
  OR NEW.worker_session_id <> OLD.worker_session_id
BEGIN
  SELECT RAISE(ABORT, 'TASK_EXECUTION_WORKER_IDENTITY_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- run_artifacts  (PRD §30.1) — typed immutable artifacts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_artifacts (
  artifact_id              TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL
                             CHECK (kind IN ('TASK_CONTRACT','PLAN','CANDIDATE_SNAPSHOT',
                                             'VERIFICATION','BLIND_REVIEW','PRODUCTION_READY_PACKET',
                                             'APPROVAL','HANDOFF','CONTINUITY_SUMMARY',
                                             'REPO_FACTORY_RESULT','BOOTSTRAP_ACTIVATION_RESULT',
                                             'ROLE_COVERAGE_PLAN','DOCTOR_REPORT','REPAIR_RECEIPT')),
  digest                   TEXT NOT NULL,
  candidate_snapshot_digest TEXT,
  content_json             TEXT NOT NULL,
  -- Which trusted component wrote this. Evidence kinds may only be written by the engine
  -- that owns them, so a forged JSON blob cannot pass as verification or review output.
  produced_by              TEXT NOT NULL DEFAULT 'unspecified',
  created_at               TEXT NOT NULL,
  superseded               INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1)),
  -- §30.2 #7 — verification and review artifacts must carry the exact candidate digest.
  CHECK (kind NOT IN ('VERIFICATION','BLIND_REVIEW','PRODUCTION_READY_PACKET')
         OR candidate_snapshot_digest IS NOT NULL),
  CHECK ((kind <> 'VERIFICATION' OR produced_by = 'verification-engine')
    AND (kind <> 'BLIND_REVIEW' OR produced_by = 'blind-review-gate')
    AND (kind <> 'PRODUCTION_READY_PACKET' OR produced_by = 'production-gate')),
  UNIQUE (run_id, kind, digest, candidate_snapshot_digest)
);

-- CP-HI-06 — evidence binds the exact candidate snapshot; metadata alone cannot make it look bound.
-- A raw insert must not make evidence appear bound merely by filling a metadata column.
-- SQLite can verify the evidence envelope's declared candidate and that the run owns a
-- snapshot with that binding; ArtifactStore additionally validates the snapshot schema
-- and canonical digest before this point.
CREATE TRIGGER IF NOT EXISTS run_artifacts_evidence_candidate_guard
BEFORE INSERT ON run_artifacts
WHEN NEW.kind IN ('VERIFICATION','BLIND_REVIEW','PRODUCTION_READY_PACKET')
 AND (
   json_valid(NEW.content_json) = 0
   OR json_extract(NEW.content_json, '$.candidateSnapshotDigest') IS NOT NEW.candidate_snapshot_digest
   OR NOT EXISTS (
     SELECT 1 FROM run_artifacts snapshot
      WHERE snapshot.run_id = NEW.run_id
        AND snapshot.kind = 'CANDIDATE_SNAPSHOT'
        AND snapshot.candidate_snapshot_digest = NEW.candidate_snapshot_digest
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_CANDIDATE_MISMATCH');
END;

-- CP-HI-06 — evidence content is immutable under UPDATE and was rewritable by REPLACE.
CREATE TRIGGER IF NOT EXISTS run_artifacts_no_replace
BEFORE INSERT ON run_artifacts
WHEN EXISTS (
  SELECT 1 FROM run_artifacts
   WHERE (artifact_id = NEW.artifact_id)
           OR (run_id = NEW.run_id AND kind = NEW.kind AND digest = NEW.digest AND candidate_snapshot_digest = NEW.candidate_snapshot_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'RUN_ARTIFACT_NO_REPLACE');
END;

-- CP-HI-06 — evidence requires the producer label *and* the authority marker, so raw SQL cannot forge it.
-- A matching candidate and the expected producer label are necessary evidence facts, but
-- neither identifies who wrote the row. Only ArtifactStore can hold the connection-local
-- marker carried by an issued writer capability, which closes direct Db.run insertions (#70).
CREATE TRIGGER IF NOT EXISTS run_artifacts_evidence_authority_guard
BEFORE INSERT ON run_artifacts
WHEN NEW.kind IN ('VERIFICATION','BLIND_REVIEW','PRODUCTION_READY_PACKET')
 AND json_valid(NEW.content_json) = 1
 AND json_extract(NEW.content_json, '$.candidateSnapshotDigest') IS NEW.candidate_snapshot_digest
 AND EXISTS (
   SELECT 1 FROM run_artifacts snapshot
    WHERE snapshot.run_id = NEW.run_id
      AND snapshot.kind = 'CANDIDATE_SNAPSHOT'
      AND snapshot.candidate_snapshot_digest = NEW.candidate_snapshot_digest
 )
 AND acp_evidence_write_authorized() <> 1
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_WRITE_AUTHORITY_DENIED');
END;

-- CP-HI-06 — content-addressed evidence is append-only but for the one-way staleness mark.
-- Evidence is append-only except for one one-way staleness mark. Every metadata field,
-- including row identity and timestamp, participates in authority and must stay fixed.
CREATE TRIGGER IF NOT EXISTS run_artifacts_content_immutable
BEFORE UPDATE ON run_artifacts
WHEN NOT (
  OLD.superseded = 0 AND NEW.superseded = 1
  AND NEW.artifact_id IS OLD.artifact_id
  AND NEW.run_id IS OLD.run_id
  AND NEW.kind IS OLD.kind
  AND NEW.digest IS OLD.digest
  AND NEW.candidate_snapshot_digest IS OLD.candidate_snapshot_digest
  AND NEW.content_json IS OLD.content_json
  AND NEW.produced_by IS OLD.produced_by
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;

-- CP-HI-08 — deleting evidence would make a failed or stale run indistinguishable from one with none.
CREATE TRIGGER IF NOT EXISTS run_artifacts_no_delete
BEFORE DELETE ON run_artifacts
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;

CREATE INDEX IF NOT EXISTS run_artifacts_run_kind ON run_artifacts(run_id, kind, created_at);
CREATE INDEX IF NOT EXISTS run_artifacts_snapshot ON run_artifacts(candidate_snapshot_digest);

-- ---------------------------------------------------------------------------
-- handoffs  (PRD §10.2 handoff package, §10.3 recovery package)
--   Lifecycle: project-scoped and outlives any run — a replacement happens precisely
--   when the outgoing CTO has zero active runs, so this cannot live in run_artifacts.
--   Integrity: the ACK is a state machine, and §10.1 forbids switching over before it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id        TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('HANDOFF','RECOVERY','BOOTSTRAP')),
  from_session_id   TEXT,
  from_generation   INTEGER,
  to_session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  package_json      TEXT NOT NULL,
  digest            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PENDING','ACKED','REJECTED')),
  created_at        TEXT NOT NULL,
  acked_at          TEXT,
  ack_by_session_id TEXT
);

CREATE INDEX IF NOT EXISTS handoffs_project ON handoffs(project_id, status);

-- ---------------------------------------------------------------------------
-- verification_results  (PRD §17.6, §17.7)
--   Lifecycle: one row per (snapshot, command, repository) execution.
--   Integrity: the completeness gate counts these rows; a JSON blob cannot be
--   counted or uniquely constrained.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_results (
  result_id                 TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  candidate_snapshot_digest TEXT NOT NULL,
  command_id                TEXT NOT NULL,
  repository_identity       TEXT NOT NULL,
  source                    TEXT NOT NULL CHECK (source IN ('local','ci')),
  exact_head                TEXT NOT NULL,
  started_at                TEXT NOT NULL,
  ended_at                  TEXT NOT NULL,
  exit_code                 INTEGER,
  output_digest             TEXT NOT NULL,
  output_truncated          INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0,1)),
  status                    TEXT NOT NULL
                              CHECK (status IN ('PASS','FAIL','TIMEOUT','ERROR','SKIPPED')),
  reason_code               TEXT,
  UNIQUE (candidate_snapshot_digest, command_id, repository_identity, source)
);

-- ---------------------------------------------------------------------------
-- verification_worktrees  (PRD §17.4 durable ownership record)
--   Lifecycle: one row is written before a disposable verification checkout is
--   materialised and remains attributable until its teardown has completed.
--   Repair must treat CREATING/ACTIVE/DESTROYING rows whose pinned owner is live
--   as live, rather than inferring ownership from task execution receipts.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- capacity_snapshots  (PRD §14.3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capacity_snapshots (
  snapshot_id          TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  bucket_id            TEXT NOT NULL,
  remaining_percent    REAL,
  reset_at             TEXT,
  capabilities_json    TEXT NOT NULL,
  sensor_health        TEXT NOT NULL CHECK (sensor_health IN ('HEALTHY','STALE','ERROR')),
  -- UNKNOWN is recorded, not smoothed away: an unprobed runtime is not a routable one.
  runtime_health       TEXT NOT NULL CHECK (runtime_health IN ('HEALTHY','DEGRADED','UNAVAILABLE','UNKNOWN')),
  allocation_admission TEXT NOT NULL CHECK (allocation_admission IN ('OPEN','CONSERVE','SUSPENDED')),
  observed_at          TEXT NOT NULL,
  source               TEXT NOT NULL,
  -- §30.2 #8
  UNIQUE (provider, bucket_id, observed_at)
);

CREATE INDEX IF NOT EXISTS capacity_recent ON capacity_snapshots(provider, observed_at DESC);

-- ---------------------------------------------------------------------------
-- resource_claims  (PRD §23.2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_claims (
  claim_id                 TEXT PRIMARY KEY,
  repository_identity      TEXT NOT NULL,
  branch                   TEXT,
  worktree_id              TEXT,
  declared_path            TEXT,        -- one row per exact declared write path
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  owner_session_id         TEXT NOT NULL REFERENCES sessions(session_id),
  owner_binding_generation INTEGER NOT NULL,
  acquired_at              TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  released_at              TEXT,
  status                   TEXT NOT NULL CHECK (status IN ('HELD','RELEASED','EXPIRED')),
  CHECK (branch IS NOT NULL OR worktree_id IS NOT NULL OR declared_path IS NOT NULL)
);

-- §30.2 #9 — hard rejects for simultaneous writers.
CREATE UNIQUE INDEX IF NOT EXISTS claims_unique_worktree
  ON resource_claims(repository_identity, worktree_id)
  WHERE status = 'HELD' AND worktree_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS claims_unique_branch
  ON resource_claims(repository_identity, branch)
  WHERE status = 'HELD' AND branch IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS claims_unique_path
  ON resource_claims(repository_identity, declared_path)
  WHERE status = 'HELD' AND declared_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS claims_expiry ON resource_claims(status, expires_at);

-- ---------------------------------------------------------------------------
-- outbox  (PRD §15.7 fenced envelope, §27.5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  message_id         TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL,
  role_key           TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  target_session_id  TEXT NOT NULL,
  run_id             TEXT,
  kind               TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  payload_digest     TEXT NOT NULL,
  -- A retry/recovery path must bind its request and policy explicitly rather than infer
  -- either from a mutable payload after an outage.
  -- The original enqueue identity is retained across retargeting. It must be present and
  -- cannot be rewritten, otherwise an idempotency-key collision could be made to look like
  -- a replay after the fact.
  request_fingerprint TEXT NOT NULL,
  retry_max_attempts  INTEGER NOT NULL DEFAULT 5 CHECK (retry_max_attempts >= 0),
  retry_backoff_ms    INTEGER NOT NULL DEFAULT 1000 CHECK (retry_backoff_ms >= 0),
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  -- 'RETARGETED' is not a status: retargeting moves binding_generation and
  -- target_session_id while the row stays PENDING, and the fact is recorded in
  -- reason_code. Keeping it in this enum let a row be parked in a state no delivery loop
  -- selects and no fence sweeps, which is neither queued nor terminal.
  status             TEXT NOT NULL
                       CHECK (status IN ('PENDING','IN_FLIGHT','SENT','ACKED','REJECTED',
                                         'EXPIRED')),
  -- §34.1 — a delivery loop *claims* a message rather than merely selecting it, so two
  -- overlapping loops cannot both send the same envelope.
  claim_token        TEXT,
  claimed_at         TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  -- Retry state is durable, not delivery-loop-local: after a crash the next loop must be
  -- able to tell a failure that may be attempted again from one that may not, and when.
  -- The vocabulary is the same as task_executions.failure_class.
  failure_class      TEXT CHECK (failure_class IN ('transient','repairable','contract','security',
                                                   'policy','capacity','infrastructure',
                                                   'unknown_observed')),
  retry_eligible     INTEGER NOT NULL DEFAULT 0 CHECK (retry_eligible IN (0,1)),
  next_attempt_at    TEXT,
  sent_at            TEXT,
  acked_at           TEXT,
  reason_code        TEXT,
  -- What makes the class meaningful rather than decorative: only a class whose cause can
  -- plausibly clear on its own may be retried, so a contract, security or policy failure
  -- cannot be marked retryable by any writer, including raw SQL.
  CHECK (retry_eligible = 0 OR failure_class IN ('transient','capacity','infrastructure')),
  -- A retry must be deferred to an instant. Eligibility without a next attempt time is the
  -- immediate re-send loop §34.1 forbids, and a next attempt time on an ineligible row
  -- would be a deferral nobody honours.
  CHECK (retry_eligible = 0 OR next_attempt_at IS NOT NULL),
  CHECK (next_attempt_at IS NULL OR retry_eligible = 1)
);

-- CP-HI-05 — the fingerprint is the replay identity of an external write; rewriting it enables a double send.
CREATE TRIGGER IF NOT EXISTS outbox_request_fingerprint_immutable
BEFORE UPDATE OF request_fingerprint ON outbox
WHEN NEW.request_fingerprint <> OLD.request_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_REQUEST_FINGERPRINT_IMMUTABLE');
END;

-- CP-HI-06 — the request fingerprint is what makes a send idempotent.
CREATE TRIGGER IF NOT EXISTS outbox_no_replace
BEFORE INSERT ON outbox
WHEN EXISTS (
  SELECT 1 FROM outbox
   WHERE (message_id = NEW.message_id)
           OR (idempotency_key = NEW.idempotency_key)
)
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_NO_REPLACE');
END;

-- §30.2 #5
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idempotency ON outbox(idempotency_key);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS outbox_role ON outbox(role_key, binding_generation, status);
-- The delivery loop selects queued rows whose deferral window has opened.
CREATE INDEX IF NOT EXISTS outbox_retry_ready ON outbox(next_attempt_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- inbound_messages
--   Lifecycle: ingress replay defence (§27.1 nonce/idempotency, §27.3 MCP).
--   Integrity: unique nonce per channel is the whole point.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_messages (
  channel     TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  received_at TEXT NOT NULL,
  result_json TEXT,
  PRIMARY KEY (channel, nonce)
);

CREATE INDEX IF NOT EXISTS inbound_received ON inbound_messages(received_at);

-- ---------------------------------------------------------------------------
-- telegram_owner_prompts
--   Lifecycle: an owner-facing Telegram gate prompt and the candidate it showed.
--   Integrity: a reply can resolve only through the exact chat/message pair; the
--   candidate binding is immutable once Telegram has accepted the prompt.
-- ---------------------------------------------------------------------------
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

-- CP-HI-07 — an owner prompt is the record of what the owner was actually asked; rewriting it
-- would let a decision be attributed to a question that was never put.
CREATE TRIGGER IF NOT EXISTS telegram_owner_prompts_immutable
BEFORE UPDATE ON telegram_owner_prompts
BEGIN
  SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
END;

-- CP-HI-06 — same census, same hole. These rows are the owner's own messages.
CREATE TRIGGER IF NOT EXISTS telegram_owner_prompts_no_replace
BEFORE INSERT ON telegram_owner_prompts
WHEN EXISTS (SELECT 1 FROM telegram_owner_prompts
              WHERE chat_id = NEW.chat_id AND message_id = NEW.message_id)
BEGIN
  SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_NO_REPLACE');
END;

-- CP-HI-08 — a deleted prompt would make an unanswered gate indistinguishable from one never raised.
CREATE TRIGGER IF NOT EXISTS telegram_owner_prompts_no_delete
BEFORE DELETE ON telegram_owner_prompts
BEGIN
  SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- github_receipts  (PRD §24.6 idempotent receipt, Integration §13.3)
--   Lifecycle: external side effects outlive the run that produced them.
--   Integrity: idempotency key uniqueness is what prevents a duplicate merge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_receipts (
  receipt_id          TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  operation           TEXT NOT NULL
                        CHECK (operation IN ('pr_prepare','gate_publish','merge_execute',
                                             'post_merge_verify','release_tag','rollback_prepare',
                                             'issue_project')),
  -- Receipts outlive their run. Keeping the opaque historical run id avoids a mutable
  -- ON DELETE SET NULL update on an otherwise append-only receipt.
  run_id              TEXT,
  repository_identity TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_identity   TEXT NOT NULL,
  preexisting         INTEGER NOT NULL DEFAULT 0 CHECK (preexisting IN (0,1)),
  before_state_digest TEXT,
  after_state_digest  TEXT,
  request_digest      TEXT NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  reread_at           TEXT,
  verified            INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  status              TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('PENDING','APPLIED')),
  CHECK (
    status <> 'PENDING' OR (
      preexisting = 0
      AND after_state_digest IS NULL
      AND reread_at IS NULL
      AND verified = 0
      AND response_json = '{"pending":true}'
    )
  )
);

CREATE INDEX IF NOT EXISTS github_receipts_run ON github_receipts(run_id, operation);

-- CP-HI-05 — the receipt is the replay marker for a credentialed write.
-- An external-write receipt is the replay marker. Rewriting or deleting it would turn a
-- completed side effect into an apparently new operation.
-- A receipt is reserved PENDING *before* the external call and completed once, after the
-- result has been reread. That one-way completion is the only permitted update: every
-- identity column stays fixed, an APPLIED receipt can never be touched again, and a
-- replay therefore cannot rewrite the record of what was already done (§24.5).
CREATE TRIGGER IF NOT EXISTS github_receipts_immutable
BEFORE UPDATE ON github_receipts
WHEN NOT (
  OLD.status = 'PENDING' AND NEW.status = 'APPLIED'
  AND NEW.receipt_id = OLD.receipt_id
  AND NEW.idempotency_key = OLD.idempotency_key
  AND NEW.operation = OLD.operation
  AND NEW.run_id IS OLD.run_id
  AND NEW.repository_identity = OLD.repository_identity
  AND NEW.resource_type = OLD.resource_type
  AND NEW.resource_identity = OLD.resource_identity
  AND NEW.request_digest = OLD.request_digest
  AND NEW.before_state_digest IS OLD.before_state_digest
  AND NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_IMMUTABLE');
END;

-- CP-HI-06 — a receipt is the proof an operation already happened.
CREATE TRIGGER IF NOT EXISTS github_receipts_no_replace
BEFORE INSERT ON github_receipts
WHEN EXISTS (
  SELECT 1 FROM github_receipts
   WHERE (receipt_id = NEW.receipt_id)
           OR (idempotency_key = NEW.idempotency_key)
)
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_NO_REPLACE');
END;

-- CP-HI-05 — an APPLIED row must descend from a reservation, so a write cannot mint its own proof.
-- A direct APPLIED row would make it possible to perform a write and create its replay
-- marker only afterwards. Writes that this kernel originates must first reserve PENDING.
-- `pr_prepare` may record a pre-existing pull request, which is an observation rather
-- than a write and therefore remains eligible for direct APPLIED recording.
CREATE TRIGGER IF NOT EXISTS github_receipts_applied_requires_reservation
BEFORE INSERT ON github_receipts
WHEN NEW.status = 'APPLIED'
 AND (
   NEW.operation IN ('gate_publish','merge_execute','release_tag','issue_project')
   OR (NEW.operation = 'pr_prepare' AND NEW.preexisting = 0)
 )
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_PROTOCOL_VIOLATION');
END;

-- CP-HI-05 — completion proves a reread and closes exactly one unfinished reservation.
-- Completion has to prove a reread and move exactly one unfinished reservation forward.
-- The immutable trigger above prevents every other edit; this trigger gives malformed
-- completion attempts their own stable denial rather than treating them as generic edits.
CREATE TRIGGER IF NOT EXISTS github_receipts_pending_completion
BEFORE UPDATE ON github_receipts
WHEN OLD.status = 'PENDING' AND NEW.status = 'APPLIED'
 AND (
   NEW.preexisting <> 0
   OR NEW.after_state_digest IS NULL
   OR NEW.reread_at IS NULL
   OR NEW.verified <> 1
   OR NEW.response_json = '{"pending":true}'
 )
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_PROTOCOL_VIOLATION');
END;

-- CP-HI-05 — erasing a receipt would let the same external write replay as new.
-- A PENDING reservation records an *intent* whose external write demonstrably did not
-- happen, so releasing it destroys no evidence and lets the operation be retried. An
-- APPLIED receipt is the record of something that did happen and can never be removed.
CREATE TRIGGER IF NOT EXISTS github_receipts_no_delete
BEFORE DELETE ON github_receipts
WHEN NOT (OLD.status = 'PENDING' AND OLD.verified = 0 AND OLD.after_state_digest IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- audit_events  (PRD §30.1)
--   Append-only record of authority decisions. Deliberately NOT a hash chain
--   (§30.4) and deliberately NOT the state SSOT — state lives in its own tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  reason_code  TEXT,
  run_id       TEXT,
  project_id   TEXT,
  session_id   TEXT,
  role_key     TEXT,
  actor        TEXT,
  evidence_json TEXT NOT NULL
);

-- CP-HI-08 — §40 explainability depends on the audit trail never being rewritten.
CREATE TRIGGER IF NOT EXISTS audit_events_append_only
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;

-- CP-HI-06 — the provenance every canonical turn cites, rewritable by an ordinary statement.
--
-- `audit_events` had append-only on UPDATE and no-delete on DELETE and nothing on INSERT, so an
-- external connection could `INSERT OR REPLACE` a row by its id: SQLite skips the implicit
-- delete's triggers when `recursive_triggers` is off, and a connection ACP did not open has it
-- off by default. Measured on this head — `ORIGINAL|{"v":1}` became `FORGED|{"v":2}` under the
-- same `event_id`, the canonical turn went on citing that id, and `foreign_key_check` reported
-- nothing, because every reference stayed valid while what it referenced changed underneath.
--
-- Found by a census after the same hole was closed on five ledger tables and missed here. The
-- lesson is in the census, not the trigger: guarding a table means covering INSERT, UPDATE and
-- DELETE, and REPLACE is an INSERT that deletes.
CREATE TRIGGER IF NOT EXISTS audit_events_no_replace
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE event_id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_NO_REPLACE');
END;

-- CP-HI-08 — erasing a denial or takeover destroys exactly what explainability needs.
-- Append-only means no deletes either: erasing a denial or a takeover record would
-- destroy exactly the evidence §40 requires for explainability.
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;

CREATE INDEX IF NOT EXISTS audit_run ON audit_events(run_id, at);
CREATE INDEX IF NOT EXISTS audit_kind ON audit_events(kind, at);

-- ---------------------------------------------------------------------------
-- baseline_records
--   Lifecycle: append-only structural observations used by offline baseline exports.
--   Integrity: the canonical record and its digest remain immutable, so an export can
--   reconcile derived claims with the durable facts from which they were built.
-- ---------------------------------------------------------------------------
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

-- CP-HI-06 — a baseline is the comparison point; editing it silently redefines what counts as regression.
CREATE TRIGGER IF NOT EXISTS baseline_records_immutable
BEFORE UPDATE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;

-- CP-HI-06 — a baseline is the comparison point; editing it silently redefines what counts as regression.
-- CP-HI-06 — same census, same hole: a baseline is verification provenance and REPLACE rewrote it.
CREATE TRIGGER IF NOT EXISTS baseline_records_no_replace
BEFORE INSERT ON baseline_records
WHEN EXISTS (
  SELECT 1 FROM baseline_records
   WHERE (record_id = NEW.record_id)
           OR (run_id = NEW.run_id AND record_kind = NEW.record_kind AND payload_digest = NEW.payload_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_NO_REPLACE');
END;

-- CP-HI-08 — a missing baseline must not read as a clean comparison.
CREATE TRIGGER IF NOT EXISTS baseline_records_no_delete
BEFORE DELETE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;

CREATE INDEX IF NOT EXISTS baseline_records_run_kind
  ON baseline_records(run_id, record_kind, recorded_at, record_id);

-- ---------------------------------------------------------------------------
-- telemetry_metrics  (PRD §31)
--   Lifecycle: normalized metrics have a long retention while raw bounded logs
--   have a short one (§31.5), so they cannot share a table with audit_events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_metrics (
  metric_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('run','task','quality','capacity','graph','continuity')),
  name        TEXT NOT NULL,
  run_id      TEXT,
  task_id     TEXT,
  value_num   REAL,
  value_text  TEXT,
  dims_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS telemetry_scope ON telemetry_metrics(scope, name, at);

-- ---------------------------------------------------------------------------
-- continuity_state — single-row runtime mode (PRD §29.5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS continuity_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  mode         TEXT NOT NULL CHECK (mode IN ('NORMAL','DEGRADED','SURVIVAL')),
  reason_code  TEXT,
  changed_at   TEXT NOT NULL,
  -- When coverage was last actually computed. A completion decision must not lean on a
  -- mode that was true an hour ago (§15.6): the stored mode is only as good as its age.
  evaluated_at TEXT
);


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
  ('OWNER_AFTER_TARGET_FENCE'),
  -- ACP observed a correlated terminal reply from the authenticated Hermes runtime: the peer was
  -- re-authenticated before dispatch, `createMessage` returned a correlated answer, and the
  -- runtime resolved only after the reply child exited zero. Strong enough to forbid a re-run,
  -- not strong enough to be called the target's own receipt — so it does not borrow that name.
  ('ACP_OBSERVED_HERMES_REPLY'),
  -- A person looked at a turn nothing could settle and chose the retry-safe direction. Not
  -- evidence about what the target did — the operator did not watch it — so this authority is
  -- restricted to ABORTED below and can never record a completion. It exists because the permit
  -- dies with the coordinator instance that issued it, so a turn held across a restart had no
  -- settler at all and no operator command could reach it: a wedge whose only exit was named in
  -- the doctor's output and implemented nowhere.
  ('OPERATOR_AFTER_REVIEW');

-- How the observations on a turn relate to each other. A separate axis from the lifecycle,
-- because they are separate facts: a turn can be settled and later contradicted, and by then the
-- actor may be holding a different turn — one partial-unique slot cannot express both.
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
  -- shape this replaces minted an `ev_<uuid>` string that identified no row at all.
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
        AND resolution_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',
                                     'OPERATOR_AFTER_REVIEW'))))
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
  -- Scoped to the issuing authority, across turns. Per-turn scoping let one authority's receipt
  -- id land on two turns, which with a caller-supplied authority is a wrong-turn completion
  -- laundering path; global scoping alone silently discarded a genuine receipt whose number
  -- collided. Both are wrong in the same place: the identity has to name the issuer *and* bind
  -- the turn, so exact redelivery is a no-op and anything else is a typed conflict.
  UNIQUE (observing_authority, receipt_id),
  -- The three fields are what make the row a record of something observed rather than a caller's
  -- assertion, and NOT NULL does not say that: all three were accepted empty and stored empty on
  -- the head that merged this table, so a settlement could say COMPLETED and cite nothing.
  -- `receipt_id` is the sharpest of the three because it is half of the identity above — the first
  -- blank settlement an authority makes takes that slot, and every later blank one is read as a
  -- redelivery of it or refused as a reuse conflict against evidence that never existed.
  CHECK (receipt_id <> '' AND evidence_digest <> '' AND reason_code <> ''),
  CHECK (
    (observed_outcome = 'NEVER_ADMITTED' AND observing_authority = 'ACP_PRE_DISPATCH')
    OR (observed_outcome = 'COMPLETED'
        AND observing_authority IN ('HERMES_TARGET', 'ACP_OBSERVED_HERMES_REPLY'))
    OR (observed_outcome = 'ABORTED'
        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',
                                    'OPERATOR_AFTER_REVIEW')))
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
  -- Including the first write. The guard this replaces fired only when the column was already
  -- non-null, so the one write that matters — setting it — went unguarded, and since nothing in
  -- production writes this column at all, every non-null value would have arrived that way.
  OR OLD.replacement_turn_request_id IS NOT NEW.replacement_turn_request_id
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
-- ordinary `UPDATE canonical_turns SET lifecycle_state='SETTLED', outcome_kind='ABORTED', …` on a
-- turn that had never been settled succeeded with **zero observations**, and the retry rule then
-- read that forged outcome and admitted attempt 2. Reproduced on the previous head.
--
-- `acp_turn_materialization_authorized` is a connection-local marker in the same shape as the
-- run-state and evidence guards: a raw SQL caller can invoke it and cannot make it answer true
-- outside the owning operation.
--
-- What it binds is the *turn*, not the tuple. The run-state marker carries (run, target state)
-- and can therefore refuse a transition it did not authorise; this one carries only the turn id,
-- because one materialization writes an observation, a turn row and sometimes an adjudication —
-- three tables with no common tuple to name. So the property is narrower than that one and worth
-- stating exactly: a materialization of turn X cannot be cover for a write to turn Y, and within
-- turn X the seven columns below are open for the duration of the closure. What keeps them right
-- is that the closure is the recompute itself, which reads the observations rather than a value
-- a caller supplied.
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

-- CP-HI-06 — REPLACE is refused by the schema, not by a connection setting.
--
-- SQLite performs REPLACE's implicit delete without firing DELETE triggers unless
-- `recursive_triggers` is on, and that pragma is **per connection** and defaults off. Setting it
-- on the daemon's connection protected the daemon and left the database unprotected: a review
-- opened a second default connection and replaced an immutable identity, a source digest, and an
-- observation. The pragma stays on as defence in depth; these triggers are the invariant.
--
-- Written as "this key is taken" rather than as a delete guard, because REPLACE begins as an
-- INSERT — refusing the insert is the one point both spellings pass through.

-- An adjudication is its own fact, not an observation wearing an authority's name.
--
-- The shape this replaces inserted a row into `canonical_turn_observations` carrying the current
-- outcome's authority and a receipt id of its own making — so resolving a dispute about what
-- HERMES_TARGET said produced a second row claiming HERMES_TARGET had said it again. An
-- adjudicator is not the target, and an audit id is not a receipt.
CREATE TABLE IF NOT EXISTS canonical_turn_adjudications (
  adjudication_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_request_id   TEXT NOT NULL REFERENCES canonical_turns(turn_request_id),
  -- What the conservative order had already produced. Recorded so a later reader can see what
  -- was being agreed to; an adjudication cannot choose it.
  resolved_outcome  TEXT NOT NULL REFERENCES turn_outcome_kinds(outcome_kind),
  reason_code       TEXT NOT NULL CHECK (length(reason_code) > 0),
  evidence_digest   TEXT NOT NULL CHECK (length(evidence_digest) > 0),
  adjudicated_at    TEXT NOT NULL,
  audit_event_id    INTEGER NOT NULL REFERENCES audit_events(event_id)
);

-- Which observations the adjudication read, as rows rather than as a number in a column.
--
-- The previous shape stored `max(observation_id)` and kept the real list in audit JSON, so the
-- durable relational record did not support the claim that every observation was cited.
CREATE TABLE IF NOT EXISTS canonical_turn_adjudication_citations (
  adjudication_id  INTEGER NOT NULL REFERENCES canonical_turn_adjudications(adjudication_id),
  observation_id   INTEGER NOT NULL REFERENCES canonical_turn_observations(observation_id),
  PRIMARY KEY (adjudication_id, observation_id)
);

CREATE INDEX IF NOT EXISTS canonical_turn_adjudications_by_turn
  ON canonical_turn_adjudications(turn_request_id, adjudication_id);

-- CP-HI-02 — an adjudication moves a conversation out of quarantine, so it needs the same
-- authority as the settlement it closes.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudications_write_authority
BEFORE INSERT ON canonical_turn_adjudications
WHEN acp_turn_materialization_authorized(NEW.turn_request_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_AUTHORITY_DENIED');
END;

-- CP-HI-06 — an adjudication is the reason a conversation left quarantine.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudications_no_replace
BEFORE INSERT ON canonical_turn_adjudications
WHEN EXISTS (SELECT 1 FROM canonical_turn_adjudications WHERE adjudication_id = NEW.adjudication_id)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_NO_REPLACE');
END;

-- CP-HI-06 — an adjudication is a record of a decision that was made. Editing one rewrites it.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudications_append_only
BEFORE UPDATE ON canonical_turn_adjudications
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_APPEND_ONLY');
END;

-- CP-HI-06 — removing an adjudication removes the reason a conversation was let out of quarantine.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudications_no_delete
BEFORE DELETE ON canonical_turn_adjudications
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_APPEND_ONLY');
END;

-- CP-HI-06 — a citation appended later lets an adjudication claim evidence it never read.
--
-- The adjudication row itself required the marker; its citations did not, and append-only plus
-- no-delete plus same-turn left INSERT wide open. Measured: after a genuine adjudication resolved
-- two observations, a third disagreeing observation re-opened the turn, a raw INSERT attached that
-- third observation to the *existing* adjudication, and the next agreeing observation restored
-- ADJUDICATED — the quarantine cleared with nobody having read the thing that caused it. The
-- citation is the whole difference between an adjudication and an assertion that the disagreement
-- is over, so it is authenticated exactly as the adjudication is.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudication_citations_write_authority
BEFORE INSERT ON canonical_turn_adjudication_citations
WHEN acp_turn_materialization_authorized(
       (SELECT turn_request_id FROM canonical_turn_adjudications
         WHERE adjudication_id = NEW.adjudication_id)) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_CITATION_AUTHORITY_DENIED');
END;

-- CP-HI-06 — the citation set is what makes an adjudication a reading rather than an assertion.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudication_citations_no_replace
BEFORE INSERT ON canonical_turn_adjudication_citations
WHEN EXISTS (SELECT 1 FROM canonical_turn_adjudication_citations
              WHERE adjudication_id = NEW.adjudication_id AND observation_id = NEW.observation_id)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_CITATION_NO_REPLACE');
END;

-- CP-HI-06 — a citation set that can be edited afterwards does not record what was read.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudication_citations_append_only
BEFORE UPDATE ON canonical_turn_adjudication_citations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY');
END;

-- CP-HI-06 — dropping a citation makes a partial reading look complete.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudication_citations_no_delete
BEFORE DELETE ON canonical_turn_adjudication_citations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY');
END;

-- CP-HI-08 — a citation must belong to the turn it is adjudicating. Without this an adjudication
-- of turn B could cite observations from turn A and mark B resolved without reading it.
CREATE TRIGGER IF NOT EXISTS canonical_turn_adjudication_citations_same_turn
BEFORE INSERT ON canonical_turn_adjudication_citations
WHEN (SELECT turn_request_id FROM canonical_turn_observations WHERE observation_id = NEW.observation_id)
     IS NOT (SELECT turn_request_id FROM canonical_turn_adjudications
              WHERE adjudication_id = NEW.adjudication_id)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_ADJUDICATION_CITATION_FOREIGN');
END;

-- CP-HI-06 — a turn's identity is exact evidence, and REPLACE rewrites it without firing an
-- update or delete guard on a connection that did not opt into recursive triggers.
CREATE TRIGGER IF NOT EXISTS canonical_turns_no_replace
BEFORE INSERT ON canonical_turns
WHEN EXISTS (
  SELECT 1 FROM canonical_turns
   WHERE (turn_request_id = NEW.turn_request_id)
           OR (target_actor_id = NEW.target_actor_id AND (lifecycle_state = 'IN_DOUBT') AND (NEW.lifecycle_state = 'IN_DOUBT'))
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_NO_REPLACE');
END;

-- CP-HI-06 — an observation is testimony. Replacing one rewrites what an authority reported.
CREATE TRIGGER IF NOT EXISTS canonical_turn_observations_no_replace
BEFORE INSERT ON canonical_turn_observations
WHEN EXISTS (
  SELECT 1 FROM canonical_turn_observations
   WHERE observation_id = NEW.observation_id
      OR (observing_authority = NEW.observing_authority AND receipt_id = NEW.receipt_id)
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_NO_REPLACE');
END;

-- CP-HI-08 — moving a source between turns by REPLACE makes a completed message look like it
-- belongs to a retry-safe turn, and the retry rule then admits it. Measured.
CREATE TRIGGER IF NOT EXISTS canonical_turn_sources_no_replace
BEFORE INSERT ON canonical_turn_sources
WHEN EXISTS (
  SELECT 1 FROM canonical_turn_sources
   WHERE (source_channel = NEW.source_channel AND source_nonce = NEW.source_nonce
          AND source_attempt = NEW.source_attempt)
      OR (turn_request_id = NEW.turn_request_id AND batch_ordinal = NEW.batch_ordinal)
      OR (turn_request_id = NEW.turn_request_id AND source_channel = NEW.source_channel
          AND source_nonce = NEW.source_nonce)
)
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SOURCE_NO_REPLACE');
END;

-- CP-HI-04 — replacing a binding is the alias arriving by a third spelling, after edit and
-- delete were both refused.
CREATE TRIGGER IF NOT EXISTS actor_target_bindings_no_replace
BEFORE INSERT ON actor_target_bindings
WHEN EXISTS (
  SELECT 1 FROM actor_target_bindings
   WHERE (target_binding_id = NEW.target_binding_id)
           OR (target_actor_id = NEW.target_actor_id)
           OR (executor_kind = NEW.executor_kind AND target_locator_digest = NEW.target_locator_digest)
           OR (target_binding_id = NEW.target_binding_id AND target_actor_id = NEW.target_actor_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_BINDING_NO_REPLACE');
END;

-- CP-HI-04 — replacing an attestation presents a stale generation as current, which is what
-- admission reads.
CREATE TRIGGER IF NOT EXISTS actor_target_attestations_no_replace
BEFORE INSERT ON actor_target_attestations
WHEN EXISTS (
  SELECT 1 FROM actor_target_attestations
   WHERE (target_attestation_id = NEW.target_attestation_id)
           OR (target_binding_id = NEW.target_binding_id AND attestation_digest = NEW.attestation_digest)
           OR (target_attestation_id = NEW.target_attestation_id AND target_binding_id = NEW.target_binding_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_ATTESTATION_NO_REPLACE');
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


INSERT OR IGNORE INTO continuity_state (id, mode, changed_at)
VALUES (1, 'NORMAL', '1970-01-01T00:00:00.000Z');
