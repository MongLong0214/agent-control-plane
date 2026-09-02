-- The deployment's own v25 schema, as it actually exists (#762).
--
-- Provenance: `sqlite3 .schema` of the pre-migration backup taken from the live daemon's
-- `state.sqlite` on 2026-09-02, before any reconciliation touched it. DDL only — no rows, and
-- nothing here carries a value: the `session_secret_hash` and `claim_token` matches a scan turns
-- up are column names, which is what a schema is made of.
--
-- This is a *lineage* fixture and that is the whole point. The live database was bootstrapped at
-- `bootstrap-v20` and migrated to 25 by the build of the day; it never ran
-- `v12-migration-ledger-and-invariant-replay`, whose replay of the current `schema.sql` is what
-- gave every other fixture the tables later migrations own. Measured against it: 40 tables to the
-- current schema's 41, 58 triggers, and zero mentions of `canonical_turn_dispatches` — the v29
-- table whose absence made `v26` fail and the whole chain roll back.
--
-- Do not regenerate this by bootstrapping a current database and deleting objects from it. That
-- produces a v36 file wearing a v25 version number, which proves nothing about what a real v25
-- contains; it was tried, and reviewing it is how this file came to exist.
CREATE TABLE manifests (
  digest        TEXT PRIMARY KEY,
  schema_id     TEXT NOT NULL,
  content_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (digest LIKE 'sha256:%')
);
CREATE TABLE projects (
  project_id             TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  active_manifest_digest TEXT REFERENCES manifests(digest),
  availability           TEXT NOT NULL DEFAULT 'HEALTHY'
                           CHECK (availability IN ('HEALTHY','DEGRADED','UNAVAILABLE')),
  suspended              INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  created_at             TEXT NOT NULL
);
CREATE TABLE repositories (
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
CREATE TABLE sessions (
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
CREATE TABLE conversational_actors (
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
CREATE TABLE conversational_actor_registry_state (
  registry_id             INTEGER PRIMARY KEY CHECK (registry_id = 1),
  registry_set_generation INTEGER NOT NULL CHECK (registry_set_generation >= 0)
);
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
CREATE TABLE assignments (
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
CREATE TABLE runs (
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
CREATE TABLE candidate_pipeline_attempts (
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
CREATE TABLE finalization_attempts (
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
CREATE TABLE run_repositories (
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
CREATE TABLE tasks (
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
CREATE TABLE task_dependencies (
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  depends_on   TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);
CREATE TABLE task_executions (
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
CREATE TABLE run_artifacts (
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
CREATE TABLE handoffs (
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
CREATE TABLE verification_results (
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
CREATE TABLE verification_worktrees (
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
CREATE TABLE capacity_snapshots (
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
CREATE TABLE resource_claims (
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
CREATE TABLE outbox (
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
CREATE TABLE inbound_messages (
  channel     TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  received_at TEXT NOT NULL,
  result_json TEXT, payload_digest TEXT,
  PRIMARY KEY (channel, nonce)
);
CREATE TABLE telegram_owner_prompts (
  chat_id                    TEXT NOT NULL,
  message_id                 INTEGER NOT NULL CHECK (message_id > 0),
  correlation_id             TEXT NOT NULL,
  run_id                     TEXT NOT NULL,
  candidate_snapshot_digest  TEXT NOT NULL CHECK (candidate_snapshot_digest LIKE 'sha256:%'),
  created_at                 TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE github_receipts (
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
CREATE TABLE audit_events (
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
CREATE TABLE baseline_records (
  record_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  record_kind    TEXT NOT NULL,
  schema_id      TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest LIKE 'sha256:%'),
  UNIQUE (run_id, record_kind, payload_digest)
);
CREATE TABLE telemetry_metrics (
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
CREATE TABLE continuity_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  mode         TEXT NOT NULL CHECK (mode IN ('NORMAL','DEGRADED','SURVIVAL')),
  reason_code  TEXT,
  changed_at   TEXT NOT NULL,
  -- When coverage was last actually computed. A completion decision must not lean on a
  -- mode that was true an hour ago (§15.6): the stored mode is only as good as its age.
  evaluated_at TEXT
);
CREATE TABLE schema_migrations (
      version         INTEGER PRIMARY KEY CHECK (version > 0),
      migration_id    TEXT NOT NULL UNIQUE,
      checksum        TEXT NOT NULL CHECK (checksum LIKE 'sha256:%'),
      backup_file     TEXT,
      backup_checksum TEXT,
      applied_at      TEXT NOT NULL,
      CHECK ((backup_file IS NULL) = (backup_checksum IS NULL))
    );
CREATE TABLE executor_kinds (
  executor_kind TEXT PRIMARY KEY
);
CREATE TABLE actor_target_bindings (
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
CREATE TABLE actor_target_attestations (
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
CREATE TABLE turn_outcome_kinds (
  outcome_kind TEXT PRIMARY KEY
);
CREATE TABLE turn_resolution_authorities (
  resolution_authority TEXT PRIMARY KEY
);
CREATE TABLE turn_observation_consistency (
  observation_consistency TEXT PRIMARY KEY
);
CREATE TABLE canonical_turns (
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
        AND resolution_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE'))))
);
CREATE TABLE canonical_turn_observations (
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
CREATE TABLE canonical_turn_sources (
  turn_request_id              TEXT NOT NULL REFERENCES canonical_turns(turn_request_id),
  source_channel               TEXT NOT NULL,
  source_nonce                 TEXT NOT NULL,
  source_attempt               INTEGER NOT NULL CHECK (source_attempt > 0),
  batch_ordinal                INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  source_digest                TEXT NOT NULL,
  predecessor_turn_request_id  TEXT REFERENCES canonical_turns(turn_request_id),
  admission_audit_event_id     INTEGER NOT NULL REFERENCES audit_events(event_id),
  PRIMARY KEY (source_channel, source_nonce, source_attempt),
  UNIQUE (turn_request_id, batch_ordinal),
  UNIQUE (turn_request_id, source_channel, source_nonce),
  CHECK ((source_attempt = 1) = (predecessor_turn_request_id IS NULL)),
  -- The row this source is about. Without it a source could name a channel and nonce nobody
  -- admitted, and the ledger would record a turn as having consumed a message that does not
  -- exist.
  FOREIGN KEY (source_channel, source_nonce) REFERENCES inbound_messages(channel, nonce)
);
CREATE INDEX repositories_project ON repositories(project_id);
CREATE UNIQUE INDEX repositories_checkout_path ON repositories(checkout_path);
CREATE UNIQUE INDEX sessions_buzz_actor
  ON sessions(buzz_actor_id)
  WHERE buzz_actor_id IS NOT NULL AND lifecycle IN ('STARTING','READY','DRAINING');
CREATE INDEX conversational_actors_session
  ON conversational_actors(current_session_id);
CREATE UNIQUE INDEX conversational_actor_registrations_active_actor
  ON conversational_actor_registrations(actor_id)
  WHERE registration_state = 'REGISTERED';
CREATE UNIQUE INDEX assignments_active_role_key
  ON assignments(role_key) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX assignments_active_primary_cto
  ON assignments(project_id) WHERE role = 'PRIMARY_CTO' AND status = 'ACTIVE';
CREATE UNIQUE INDEX assignments_owner_tuple
  ON assignments(role_key, binding_generation, session_id, session_incarnation);
CREATE INDEX assignments_session ON assignments(session_id, status);
CREATE INDEX assignments_run ON assignments(run_id);
CREATE INDEX assignments_actor ON assignments(actor_id, status);
CREATE INDEX runs_state ON runs(state);
CREATE INDEX runs_owner ON runs(owner_session_id, state);
CREATE INDEX runs_project ON runs(project_id, state);
CREATE INDEX candidate_pipeline_attempts_running_deadline
  ON candidate_pipeline_attempts(state, deadline_at);
CREATE INDEX finalization_attempts_running_deadline
  ON finalization_attempts(state, deadline_at);
CREATE INDEX tasks_run ON tasks(run_id, state);
CREATE INDEX task_executions_open ON task_executions(status, started_at);
CREATE INDEX run_artifacts_run_kind ON run_artifacts(run_id, kind, created_at);
CREATE INDEX run_artifacts_snapshot ON run_artifacts(candidate_snapshot_digest);
CREATE INDEX handoffs_project ON handoffs(project_id, status);
CREATE INDEX verification_worktrees_live
  ON verification_worktrees(repository_identity, state, worktree_id);
CREATE INDEX capacity_recent ON capacity_snapshots(provider, observed_at DESC);
CREATE UNIQUE INDEX claims_unique_worktree
  ON resource_claims(repository_identity, worktree_id)
  WHERE status = 'HELD' AND worktree_id IS NOT NULL;
CREATE UNIQUE INDEX claims_unique_branch
  ON resource_claims(repository_identity, branch)
  WHERE status = 'HELD' AND branch IS NOT NULL;
CREATE UNIQUE INDEX claims_unique_path
  ON resource_claims(repository_identity, declared_path)
  WHERE status = 'HELD' AND declared_path IS NOT NULL;
CREATE INDEX claims_expiry ON resource_claims(status, expires_at);
CREATE UNIQUE INDEX outbox_idempotency ON outbox(idempotency_key);
CREATE INDEX outbox_pending ON outbox(status, created_at);
CREATE INDEX outbox_role ON outbox(role_key, binding_generation, status);
CREATE INDEX outbox_retry_ready ON outbox(next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX inbound_received ON inbound_messages(received_at);
CREATE INDEX telegram_owner_prompts_run
  ON telegram_owner_prompts(run_id, created_at);
CREATE INDEX github_receipts_run ON github_receipts(run_id, operation);
CREATE INDEX audit_run ON audit_events(run_id, at);
CREATE INDEX audit_kind ON audit_events(kind, at);
CREATE INDEX baseline_records_run_kind
  ON baseline_records(run_id, record_kind, recorded_at, record_id);
CREATE INDEX telemetry_scope ON telemetry_metrics(scope, name, at);
CREATE UNIQUE INDEX canonical_turns_one_unresolved
  ON canonical_turns(target_actor_id) WHERE lifecycle_state = 'IN_DOUBT';
CREATE INDEX canonical_turn_observations_by_turn
  ON canonical_turn_observations(turn_request_id, observation_id);
CREATE TRIGGER manifests_immutable
BEFORE UPDATE ON manifests
BEGIN
  SELECT RAISE(ABORT, 'MANIFEST_IMMUTABLE');
END;
CREATE TRIGGER sessions_incarnation_immutable
BEFORE UPDATE OF incarnation ON sessions
WHEN NEW.incarnation <> OLD.incarnation
BEGIN
  SELECT RAISE(ABORT, 'SESSION_INCARNATION_IMMUTABLE');
END;
CREATE TRIGGER sessions_secret_hash_immutable
BEFORE UPDATE OF session_secret_hash ON sessions
WHEN OLD.session_secret_hash IS NOT NULL
  AND (NEW.session_secret_hash IS NULL OR NEW.session_secret_hash <> OLD.session_secret_hash)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_SECRET_HASH_IMMUTABLE');
END;
CREATE TRIGGER sessions_buzz_actor_immutable
BEFORE UPDATE OF buzz_actor_id ON sessions
WHEN OLD.buzz_actor_id IS NOT NULL
  AND (NEW.buzz_actor_id IS NULL OR NEW.buzz_actor_id <> OLD.buzz_actor_id)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_BUZZ_ACTOR_IMMUTABLE');
END;
CREATE TRIGGER sessions_workdir_immutable
BEFORE UPDATE OF workdir ON sessions
WHEN OLD.workdir IS NOT NULL
  AND (NEW.workdir IS NULL OR NEW.workdir <> OLD.workdir)
BEGIN
  SELECT RAISE(ABORT, 'SESSION_WORKDIR_IMMUTABLE');
END;
CREATE TRIGGER conversational_actors_runtime_ready
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
CREATE TRIGGER conversational_actors_retirement_terminal
BEFORE UPDATE ON conversational_actors
WHEN OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_RETIREMENT_TERMINAL');
END;
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
CREATE TRIGGER assignments_generation_monotonic
BEFORE INSERT ON assignments
WHEN NEW.binding_generation <= COALESCE(
  (SELECT MAX(binding_generation) FROM assignments WHERE role_key = NEW.role_key), 0)
BEGIN
  SELECT RAISE(ABORT, 'BINDING_GENERATION_NOT_MONOTONIC');
END;
CREATE TRIGGER assignments_generation_immutable
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
CREATE TRIGGER assignments_revocation_terminal
BEFORE UPDATE OF status ON assignments
WHEN OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED'
BEGIN
  SELECT RAISE(ABORT, 'BINDING_REVOKED_TERMINAL');
END;
CREATE TRIGGER assignments_active_generation_current
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
CREATE TRIGGER assignments_active_generation_insert_guard
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
CREATE TRIGGER runs_state_transition_guard
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
CREATE TRIGGER runs_state_transition_authority_guard
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
CREATE TRIGGER runs_pinned_manifest_immutable
BEFORE UPDATE OF pinned_manifest_digest ON runs
WHEN NEW.pinned_manifest_digest IS NOT OLD.pinned_manifest_digest
 AND NOT (OLD.pinned_manifest_digest IS NULL AND NEW.pinned_manifest_digest IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PINNED_MANIFEST_IMMUTABLE');
END;
CREATE TRIGGER runs_pinned_run_scoped_commands_immutable
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
CREATE TRIGGER tasks_run_work_sealed
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
CREATE TRIGGER task_executions_worker_binding_required
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
CREATE TRIGGER task_executions_worker_identity_immutable
BEFORE UPDATE OF run_id, task_id, worker_session_id ON task_executions
WHEN NEW.run_id <> OLD.run_id
  OR NEW.task_id <> OLD.task_id
  OR NEW.worker_session_id <> OLD.worker_session_id
BEGIN
  SELECT RAISE(ABORT, 'TASK_EXECUTION_WORKER_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER run_artifacts_evidence_candidate_guard
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
CREATE TRIGGER run_artifacts_evidence_authority_guard
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
CREATE TRIGGER run_artifacts_content_immutable
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
CREATE TRIGGER run_artifacts_no_delete
BEFORE DELETE ON run_artifacts
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;
CREATE TRIGGER outbox_request_fingerprint_immutable
BEFORE UPDATE OF request_fingerprint ON outbox
WHEN NEW.request_fingerprint <> OLD.request_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_REQUEST_FINGERPRINT_IMMUTABLE');
END;
CREATE TRIGGER telegram_owner_prompts_immutable
BEFORE UPDATE ON telegram_owner_prompts
BEGIN
  SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
END;
CREATE TRIGGER telegram_owner_prompts_no_delete
BEFORE DELETE ON telegram_owner_prompts
BEGIN
  SELECT RAISE(ABORT, 'TELEGRAM_PROMPT_IMMUTABLE');
END;
CREATE TRIGGER github_receipts_immutable
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
CREATE TRIGGER github_receipts_applied_requires_reservation
BEFORE INSERT ON github_receipts
WHEN NEW.status = 'APPLIED'
 AND (
   NEW.operation IN ('gate_publish','merge_execute','release_tag','issue_project')
   OR (NEW.operation = 'pr_prepare' AND NEW.preexisting = 0)
 )
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_PROTOCOL_VIOLATION');
END;
CREATE TRIGGER github_receipts_pending_completion
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
CREATE TRIGGER github_receipts_no_delete
BEFORE DELETE ON github_receipts
WHEN NOT (OLD.status = 'PENDING' AND OLD.verified = 0 AND OLD.after_state_digest IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'GITHUB_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY');
END;
CREATE TRIGGER baseline_records_immutable
BEFORE UPDATE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;
CREATE TRIGGER baseline_records_no_delete
BEFORE DELETE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;
CREATE TRIGGER schema_migrations_insert_authority
    BEFORE INSERT ON schema_migrations
    WHEN acp_schema_migration_authorized() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_AUTHORITY_DENIED');
    END;
CREATE TRIGGER schema_migrations_immutable
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;
CREATE TRIGGER schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;
CREATE TRIGGER canonical_turns_identity_immutable
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
CREATE TRIGGER canonical_turns_lifecycle_monotone
BEFORE UPDATE ON canonical_turns
WHEN OLD.lifecycle_state = 'SETTLED' AND NEW.lifecycle_state = 'IN_DOUBT'
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_LIFECYCLE_NOT_MONOTONE');
END;
CREATE TRIGGER canonical_turns_outcome_never_weakens
BEFORE UPDATE OF outcome_kind ON canonical_turns
WHEN OLD.outcome_kind IS NOT NULL
  AND (NEW.outcome_kind IS NULL
       OR (OLD.outcome_kind = 'COMPLETED' AND NEW.outcome_kind <> 'COMPLETED')
       OR (OLD.outcome_kind = 'ABORTED' AND NEW.outcome_kind = 'NEVER_ADMITTED'))
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OUTCOME_WEAKENED');
END;
CREATE TRIGGER canonical_turns_born_in_doubt
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
CREATE TRIGGER canonical_turns_settlement_authority
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
CREATE TRIGGER canonical_turns_settlement_provenance_immutable
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
CREATE TRIGGER canonical_turns_consistency_monotone
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
CREATE TRIGGER canonical_turns_no_delete
BEFORE DELETE ON canonical_turns
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_NO_DELETE');
END;
CREATE TRIGGER canonical_turn_observations_write_authority
BEFORE INSERT ON canonical_turn_observations
WHEN acp_turn_materialization_authorized(NEW.turn_request_id) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_AUTHORITY_DENIED');
END;
CREATE TRIGGER canonical_turn_observations_append_only
BEFORE UPDATE ON canonical_turn_observations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_APPEND_ONLY');
END;
CREATE TRIGGER canonical_turn_observations_no_delete
BEFORE DELETE ON canonical_turn_observations
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_OBSERVATION_APPEND_ONLY');
END;
CREATE TRIGGER actor_target_attestations_append_only
BEFORE UPDATE ON actor_target_attestations
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_ATTESTATION_APPEND_ONLY');
END;
CREATE TRIGGER actor_target_attestations_no_delete
BEFORE DELETE ON actor_target_attestations
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_ATTESTATION_APPEND_ONLY');
END;
CREATE TRIGGER actor_target_bindings_immutable
BEFORE UPDATE ON actor_target_bindings
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_BINDING_IMMUTABLE');
END;
CREATE TRIGGER actor_target_bindings_no_delete
BEFORE DELETE ON actor_target_bindings
BEGIN
  SELECT RAISE(ABORT, 'ACTOR_TARGET_BINDING_IMMUTABLE');
END;
CREATE TRIGGER inbound_messages_payload_digest_immutable
BEFORE UPDATE OF payload_digest ON inbound_messages
WHEN OLD.payload_digest IS NOT NULL AND OLD.payload_digest IS NOT NEW.payload_digest
BEGIN
  SELECT RAISE(ABORT, 'INBOUND_PAYLOAD_DIGEST_IMMUTABLE');
END;
CREATE TRIGGER canonical_turn_sources_immutable
BEFORE UPDATE ON canonical_turn_sources
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SOURCE_IMMUTABLE');
END;
CREATE TRIGGER canonical_turn_sources_no_delete
BEFORE DELETE ON canonical_turn_sources
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_SOURCE_IMMUTABLE');
END;
CREATE TRIGGER inbound_messages_referenced_by_turn
BEFORE DELETE ON inbound_messages
WHEN EXISTS (
  SELECT 1 FROM canonical_turn_sources
   WHERE source_channel = OLD.channel AND source_nonce = OLD.nonce
)
BEGIN
  SELECT RAISE(ABORT, 'INBOUND_MESSAGE_REFERENCED_BY_TURN');
END;
