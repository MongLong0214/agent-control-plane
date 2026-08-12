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

CREATE TRIGGER IF NOT EXISTS manifests_immutable
BEFORE UPDATE ON manifests
BEGIN
  SELECT RAISE(ABORT, 'MANIFEST_IMMUTABLE');
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
  -- Never retain the session secret itself. The digest is enough to bind a local
  -- handshake while keeping credentials out of durable state (§31.5).
  session_secret_digest TEXT,
  os_pid         INTEGER,
  workdir        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  stopped_at     TEXT
);

-- §30.2 #3 — session incarnation is immutable for the life of the session row.
CREATE TRIGGER IF NOT EXISTS sessions_incarnation_immutable
BEFORE UPDATE OF incarnation ON sessions
WHEN NEW.incarnation <> OLD.incarnation
BEGIN
  SELECT RAISE(ABORT, 'SESSION_INCARNATION_IMMUTABLE');
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

-- §30.2 #4 — binding generation is monotonic per role key.
CREATE TRIGGER IF NOT EXISTS assignments_generation_monotonic
BEFORE INSERT ON assignments
WHEN NEW.binding_generation <= COALESCE(
  (SELECT MAX(binding_generation) FROM assignments WHERE role_key = NEW.role_key), 0)
BEGIN
  SELECT RAISE(ABORT, 'BINDING_GENERATION_NOT_MONOTONIC');
END;

-- INSERT-only monotonicity is not enough: lowering binding_generation, or moving a low
-- generation into another role's history via role_key, would reactivate stale authority.
CREATE TRIGGER IF NOT EXISTS assignments_generation_immutable
BEFORE UPDATE OF binding_generation, role_key, session_id, session_incarnation,
                 role, project_id, run_id, task_id ON assignments
WHEN NEW.binding_generation <> OLD.binding_generation
  OR NEW.role_key <> OLD.role_key
  OR NEW.session_id <> OLD.session_id
  OR NEW.session_incarnation <> OLD.session_incarnation
  OR NEW.role <> OLD.role
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.task_id IS NOT OLD.task_id
BEGIN
  SELECT RAISE(ABORT, 'BINDING_IDENTITY_IMMUTABLE');
END;

-- Revocation advances a fencing generation. Re-activating an old row would make stale
-- authority current again after every newer generation has been revoked.
CREATE TRIGGER IF NOT EXISTS assignments_revocation_terminal
BEFORE UPDATE OF status ON assignments
WHEN OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED'
BEGIN
  SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
END;

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
                                               'REVISION_REQUIRED','AWAITING_HUMAN','COMPLETED',
                                               'FAILED','CANCELLED')),
  goal                      TEXT NOT NULL,
  contract_digest           TEXT NOT NULL,
  pinned_manifest_digest    TEXT REFERENCES manifests(digest),
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
  FOREIGN KEY (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation)
    REFERENCES assignments(role_key, binding_generation, session_id, session_incarnation)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner_session_id, state);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, state);

-- §29 is a persisted state machine. The service owns authority/evidence/outbox work,
-- while this guard rejects topology bypasses even from a raw SQLite caller.
CREATE TRIGGER IF NOT EXISTS runs_state_transition_guard
BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
 AND NOT (
   (OLD.state = 'QUEUED' AND NEW.state IN ('ACTIVE','CANCELLED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('BLOCKED','READY_FOR_CEO_REVIEW','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'BLOCKED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'READY_FOR_CEO_REVIEW' AND NEW.state IN ('COMPLETED','REVISION_REQUIRED','AWAITING_HUMAN')) OR
   (OLD.state = 'REVISION_REQUIRED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED')) OR
   (OLD.state = 'AWAITING_HUMAN' AND NEW.state IN ('ACTIVE','CANCELLED','FAILED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'RUN_STATE_TRANSITION_ILLEGAL');
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
  worker_session_id        TEXT REFERENCES sessions(session_id),
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
  request_fingerprint TEXT,
  retry_max_attempts  INTEGER NOT NULL DEFAULT 5 CHECK (retry_max_attempts >= 0),
  retry_backoff_ms    INTEGER NOT NULL DEFAULT 1000 CHECK (retry_backoff_ms >= 0),
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL
                       CHECK (status IN ('PENDING','IN_FLIGHT','SENT','ACKED','REJECTED',
                                         'EXPIRED','RETARGETED')),
  -- §34.1 — a delivery loop *claims* a message rather than merely selecting it, so two
  -- overlapping loops cannot both send the same envelope.
  claim_token        TEXT,
  claimed_at         TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  sent_at            TEXT,
  acked_at           TEXT,
  reason_code        TEXT
);

-- §30.2 #5
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idempotency ON outbox(idempotency_key);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS outbox_role ON outbox(role_key, binding_generation, status);

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
  status              TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('PENDING','APPLIED'))
);

CREATE INDEX IF NOT EXISTS github_receipts_run ON github_receipts(run_id, operation);

-- An external-write receipt is the replay marker. Rewriting or deleting it would turn a
-- completed side effect into an apparently new operation.
CREATE TRIGGER IF NOT EXISTS github_receipts_immutable
BEFORE UPDATE ON github_receipts
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS github_receipts_no_delete
BEFORE DELETE ON github_receipts
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

CREATE TRIGGER IF NOT EXISTS audit_events_append_only
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;

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

INSERT OR IGNORE INTO continuity_state (id, mode, changed_at)
VALUES (1, 'NORMAL', '1970-01-01T00:00:00.000Z');
