/**
 * Stable reason codes.
 *
 * PRD §40 Explainability: every denial and every state transition returns a stable
 * reason code plus the core evidence that produced it. These strings are part of the
 * external contract (MCP callers, CLI, audit records) and MUST NOT be renamed once
 * published — add a new code instead.
 */
export const ReasonCode = {
  // --- generic -------------------------------------------------------------
  OK: "OK",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_FOUND: "NOT_FOUND",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  CONFLICT: "CONFLICT",
  /** A daemon-state path is missing, permissive, wrongly owned, or symlinked. */
  STATE_PATH_INSECURE: "STATE_PATH_INSECURE",

  // --- CP-HI-01 Managed Write Guard ---------------------------------------
  WRITE_REQUIRES_MANAGED_RUN: "WRITE_REQUIRES_MANAGED_RUN",
  WRITE_RUN_NOT_ACTIVE: "WRITE_RUN_NOT_ACTIVE",
  WRITE_BINDING_GENERATION_STALE: "WRITE_BINDING_GENERATION_STALE",
  WRITE_TARGET_OUTSIDE_RUN_SCOPE: "WRITE_TARGET_OUTSIDE_RUN_SCOPE",
  WRITE_PATH_NOT_CLAIMED: "WRITE_PATH_NOT_CLAIMED",
  WRITE_ALLOWED: "WRITE_ALLOWED",
  DIRECT_READ_ONLY_ALLOWED: "DIRECT_READ_ONLY_ALLOWED",
  DIRECT_MUTATION_DENIED: "DIRECT_MUTATION_DENIED",
  DIRECT_WRITE_ROOT_REQUIRED: "DIRECT_WRITE_ROOT_REQUIRED",
  WRITE_TARGET_RESOURCE_MISMATCH: "WRITE_TARGET_RESOURCE_MISMATCH",
  WRITE_EFFECT_FENCE_LOST: "WRITE_EFFECT_FENCE_LOST",
  // Source-read leases deny in three distinguishable ways: the caller holds no usable
  // lease (_REQUIRED), no lease can be taken because a managed write over the same source
  // is already authorised (_HELD), or a source mutation collided with a live lease
  // (_CONFLICT). A fourth spelling that nothing emitted was removed rather than kept as a
  // denial the runtime never returns.
  SOURCE_READ_LEASE_REQUIRED: "SOURCE_READ_LEASE_REQUIRED",
  SOURCE_READ_LEASE_HELD: "SOURCE_READ_LEASE_HELD",
  SOURCE_READ_LEASE_CONFLICT: "SOURCE_READ_LEASE_CONFLICT",

  // --- CP-HI-02 Single Runtime Authority ----------------------------------
  COMPLETION_AUTHORITY_DENIED: "COMPLETION_AUTHORITY_DENIED",
  GATE_AUTHORITY_DENIED: "GATE_AUTHORITY_DENIED",
  MERGE_AUTHORITY_DENIED: "MERGE_AUTHORITY_DENIED",
  RUN_STATE_TRANSITION_AUTHORITY_DENIED: "RUN_STATE_TRANSITION_AUTHORITY_DENIED",

  // --- CP-HI-03 Candidate Contract Pinning --------------------------------
  CONTRACT_DIGEST_MISMATCH: "CONTRACT_DIGEST_MISMATCH",
  CANDIDATE_CANNOT_WEAKEN_CONTRACT: "CANDIDATE_CANNOT_WEAKEN_CONTRACT",
  CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN: "CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN",
  REPOSITORY_IDENTITY_MISMATCH: "REPOSITORY_IDENTITY_MISMATCH",

  // --- CP-HI-04 Independent Quality Role ----------------------------------
  REVIEWER_NOT_INDEPENDENT: "REVIEWER_NOT_INDEPENDENT",
  REVIEWER_SESSION_IS_PRODUCER: "REVIEWER_SESSION_IS_PRODUCER",
  FINAL_CEO_SESSION_NOT_INDEPENDENT: "FINAL_CEO_SESSION_NOT_INDEPENDENT",

  // --- CP-HI-05 Trusted GitHub Credential ---------------------------------
  TRUSTED_CREDENTIAL_UNAVAILABLE: "TRUSTED_CREDENTIAL_UNAVAILABLE",
  TRUSTED_CREDENTIAL_LEAK_BLOCKED: "TRUSTED_CREDENTIAL_LEAK_BLOCKED",
  GITHUB_APP_ENV_FILE_MISSING: "GITHUB_APP_ENV_FILE_MISSING",
  GITHUB_APP_ENV_FILE_UNREADABLE: "GITHUB_APP_ENV_FILE_UNREADABLE",
  GITHUB_APP_ENV_FILE_INSECURE: "GITHUB_APP_ENV_FILE_INSECURE",
  GITHUB_APP_PRIVATE_KEY_MISSING: "GITHUB_APP_PRIVATE_KEY_MISSING",
  GITHUB_APP_PRIVATE_KEY_UNREADABLE: "GITHUB_APP_PRIVATE_KEY_UNREADABLE",
  GITHUB_APP_PRIVATE_KEY_INSECURE: "GITHUB_APP_PRIVATE_KEY_INSECURE",
  GITHUB_APP_CONFIGURATION_INVALID: "GITHUB_APP_CONFIGURATION_INVALID",
  GITHUB_APP_JWT_SIGNING_FAILED: "GITHUB_APP_JWT_SIGNING_FAILED",
  GITHUB_APP_IDENTITY_UNVERIFIED: "GITHUB_APP_IDENTITY_UNVERIFIED",
  GITHUB_APP_PERMISSION_DENIED: "GITHUB_APP_PERMISSION_DENIED",
  GITHUB_APP_TOKEN_EXCHANGE_FAILED: "GITHUB_APP_TOKEN_EXCHANGE_FAILED",
  GATE_CREATOR_UNTRUSTED: "GATE_CREATOR_UNTRUSTED",
  GATE_PAYLOAD_PROVENANCE_INVALID: "GATE_PAYLOAD_PROVENANCE_INVALID",

  // --- CP-HI-06 Exact Evidence --------------------------------------------
  SNAPSHOT_STALE: "SNAPSHOT_STALE",
  SNAPSHOT_DIGEST_MISMATCH: "SNAPSHOT_DIGEST_MISMATCH",
  EVIDENCE_STALE: "EVIDENCE_STALE",
  HEAD_MOVED: "HEAD_MOVED",

  // --- CP-HI-07 Human Role ------------------------------------------------
  OWNER_AUTHORITY_NOT_DELEGABLE: "OWNER_AUTHORITY_NOT_DELEGABLE",
  HUMAN_GATE_REQUIRED: "HUMAN_GATE_REQUIRED",
  HUMAN_GATE_UNSATISFIED: "HUMAN_GATE_UNSATISFIED",

  // --- CP-HI-08 No Silent Degradation -------------------------------------
  EVIDENCE_MISSING: "EVIDENCE_MISSING",
  COVERAGE_INCOMPLETE: "COVERAGE_INCOMPLETE",
  PROBE_FAILED: "PROBE_FAILED",
  ISOLATION_LOST: "ISOLATION_LOST",
  VERIFICATION_GAP: "VERIFICATION_GAP",

  // --- run lifecycle -------------------------------------------------------
  RUN_TRANSITION_ILLEGAL: "RUN_TRANSITION_ILLEGAL",
  RUN_ALREADY_TERMINAL: "RUN_ALREADY_TERMINAL",
  RUN_OWNER_NOT_PINNED: "RUN_OWNER_NOT_PINNED",
  RUN_OWNER_REVOKED: "RUN_OWNER_REVOKED",
  RUN_DISPATCH_BLOCKED_CTO_DRAINING: "RUN_DISPATCH_BLOCKED_CTO_DRAINING",
  RUN_QUEUED_AWAITING_CTO: "RUN_QUEUED_AWAITING_CTO",
  RUN_CANCELLED: "RUN_CANCELLED",

  // --- task ----------------------------------------------------------------
  TASK_DEPENDENCY_UNSATISFIED: "TASK_DEPENDENCY_UNSATISFIED",
  TASK_DEPENDENCY_CYCLE: "TASK_DEPENDENCY_CYCLE",
  TASK_RECEIPT_MISSING: "TASK_RECEIPT_MISSING",
  TASK_RESULT_COUNT_MISMATCH: "TASK_RESULT_COUNT_MISMATCH",

  // --- session / binding ---------------------------------------------------
  SESSION_NOT_READY: "SESSION_NOT_READY",
  SESSION_INCARNATION_IMMUTABLE: "SESSION_INCARNATION_IMMUTABLE",
  BINDING_GENERATION_STALE: "BINDING_GENERATION_STALE",
  BINDING_REVOKED: "BINDING_REVOKED",
  BINDING_ALREADY_ACTIVE: "BINDING_ALREADY_ACTIVE",
  WORKER_BINDING_REQUIRED: "WORKER_BINDING_REQUIRED",
  PRIMARY_CTO_ALREADY_BOUND: "PRIMARY_CTO_ALREADY_BOUND",
  SWITCHOVER_BLOCKED_ACTIVE_RUNS: "SWITCHOVER_BLOCKED_ACTIVE_RUNS",
  REVOCATION_BLOCKED_ACTIVE_RUNS: "REVOCATION_BLOCKED_ACTIVE_RUNS",
  /** #692 — resumeProject refuses a DRAINING session whose cause was not suspendProject. */
  RESUME_BLOCKED_NON_SUSPEND_DRAINING: "RESUME_BLOCKED_NON_SUSPEND_DRAINING",
  /**
   * #692 round 3 — resumeProject refuses a SUSPEND-caused DRAINING session while
   * suspendProject's own stopSession() is still in flight (the daemon process that
   * stamped the fence is still alive). Distinct from RESUME_BLOCKED_NON_SUSPEND_DRAINING,
   * which refuses a different *cause* altogether; this refuses the same cause while its
   * operation has not yet finished.
   */
  RESUME_BLOCKED_SUSPEND_IN_FLIGHT: "RESUME_BLOCKED_SUSPEND_IN_FLIGHT",
  /** #692 — requestReplacement refuses to drain a session out from under an owner suspend. */
  REPLACEMENT_BLOCKED_PROJECT_SUSPENDED: "REPLACEMENT_BLOCKED_PROJECT_SUSPENDED",
  PRODUCER_HISTORY_UNAVAILABLE: "PRODUCER_HISTORY_UNAVAILABLE",
  SESSION_SECRET_STORAGE_UNAVAILABLE: "SESSION_SECRET_STORAGE_UNAVAILABLE",
  SESSION_SECRET_INVALID: "SESSION_SECRET_INVALID",
  SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED: "SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED",
  SESSION_BUZZ_ACTOR_ALREADY_BOUND: "SESSION_BUZZ_ACTOR_ALREADY_BOUND",
  SESSION_BUZZ_ACTOR_IMMUTABLE: "SESSION_BUZZ_ACTOR_IMMUTABLE",
  HANDOFF_ACK_REQUIRED: "HANDOFF_ACK_REQUIRED",
  HANDOFF_ACK_AUTHENTICATION_FAILED: "HANDOFF_ACK_AUTHENTICATION_FAILED",
  HANDOFF_PACKAGE_INCOMPLETE: "HANDOFF_PACKAGE_INCOMPLETE",
  RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER:
    "RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER",
  SESSION_STOP_FAILED: "SESSION_STOP_FAILED",
  // A run reactivated (e.g. via a concurrent escalation resolution) between the
  // provider stop and the binding revoke that was meant to follow it (#692). The
  // provider stop is not reversible, so the STOPPED write stands and the binding
  // outlives its own session instead of the two rolling back together.
  SESSION_STOPPED_BINDING_REVOKE_FAILED: "SESSION_STOPPED_BINDING_REVOKE_FAILED",

  // --- registries ----------------------------------------------------------
  MANIFEST_ACTIVATION_EVIDENCE_MISSING: "MANIFEST_ACTIVATION_EVIDENCE_MISSING",
  MANIFEST_ACTIVATION_GRANT_CONSUMED: "MANIFEST_ACTIVATION_GRANT_CONSUMED",
  REPOSITORY_CHECKOUT_ALREADY_REGISTERED: "REPOSITORY_CHECKOUT_ALREADY_REGISTERED",
  REPOSITORY_BINDING_CHANGE_REQUIRES_ACTIVATION:
    "REPOSITORY_BINDING_CHANGE_REQUIRES_ACTIVATION",
  TEMPORARY_REPOSITORY_SCOPE_VIOLATION: "TEMPORARY_REPOSITORY_SCOPE_VIOLATION",
  REGISTERED_SET_GENERATION_MISMATCH: "REGISTERED_SET_GENERATION_MISMATCH",

  // --- resource claim ------------------------------------------------------
  CLAIM_WORKTREE_CONFLICT: "CLAIM_WORKTREE_CONFLICT",
  CLAIM_BRANCH_CONFLICT: "CLAIM_BRANCH_CONFLICT",
  CLAIM_PATH_CONFLICT: "CLAIM_PATH_CONFLICT",
  CLAIM_OWNER_GENERATION_REVOKED: "CLAIM_OWNER_GENERATION_REVOKED",
  CLAIM_EXPIRED: "CLAIM_EXPIRED",
  CLAIM_NOT_HELD: "CLAIM_NOT_HELD",
  SEMANTIC_CONFLICT_ADVISORY: "SEMANTIC_CONFLICT_ADVISORY",

  // --- verification --------------------------------------------------------
  VERIFICATION_COMMAND_FAILED: "VERIFICATION_COMMAND_FAILED",
  VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT",
  VERIFICATION_INCOMPLETE: "VERIFICATION_INCOMPLETE",
  VERIFICATION_CI_HEAD_MISMATCH: "VERIFICATION_CI_HEAD_MISMATCH",
  VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH:
    "VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH",
  VERIFICATION_CI_WORKFLOW_NOT_APPROVED:
    "VERIFICATION_CI_WORKFLOW_NOT_APPROVED",
  VERIFICATION_OUTPUT_TRUNCATED: "VERIFICATION_OUTPUT_TRUNCATED",
  SANDBOX_NETWORK_DENIED: "SANDBOX_NETWORK_DENIED",
  SANDBOX_SECRET_STRIPPED: "SANDBOX_SECRET_STRIPPED",
  SANDBOX_PATH_OUTSIDE_WORKTREE: "SANDBOX_PATH_OUTSIDE_WORKTREE",
  SANDBOX_CHILD_CLEANUP_FAILED: "SANDBOX_CHILD_CLEANUP_FAILED",
  SANDBOX_RESOURCE_LIMIT_UNAVAILABLE: "SANDBOX_RESOURCE_LIMIT_UNAVAILABLE",
  SANDBOX_RESOURCE_LIMIT_EXCEEDED: "SANDBOX_RESOURCE_LIMIT_EXCEEDED",
  VERIFICATION_REPOSITORY_UNTRUSTED: "VERIFICATION_REPOSITORY_UNTRUSTED",

  // --- blind review --------------------------------------------------------
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  REVIEW_PASS: "REVIEW_PASS",
  REVIEW_REVISE: "REVIEW_REVISE",
  REVIEW_BLOCK: "REVIEW_BLOCK",
  REVIEW_OMITTED_ITEMS_PRESENT: "REVIEW_OMITTED_ITEMS_PRESENT",
  REVIEW_INPUT_CONTAMINATED: "REVIEW_INPUT_CONTAMINATED",
  REVIEW_MANUAL_INVOCATION_DENIED: "REVIEW_MANUAL_INVOCATION_DENIED",

  // --- github kernel -------------------------------------------------------
  PR_BRANCH_CONTRACT_VIOLATION: "PR_BRANCH_CONTRACT_VIOLATION",
  PR_LINKAGE_MISSING: "PR_LINKAGE_MISSING",
  MERGE_GATE_MISSING: "MERGE_GATE_MISSING",
  MERGE_BASE_STALE: "MERGE_BASE_STALE",
  MERGE_HEAD_STALE: "MERGE_HEAD_STALE",
  MERGE_IDEMPOTENT_REPLAY: "MERGE_IDEMPOTENT_REPLAY",
  GITHUB_RECEIPT_PROTOCOL_VIOLATION: "GITHUB_RECEIPT_PROTOCOL_VIOLATION",
  MERGE_BRANCH_PROFILE_UNSATISFIED: "MERGE_BRANCH_PROFILE_UNSATISFIED",
  MERGE_CLAIM_INVALID: "MERGE_CLAIM_INVALID",
  MERGE_ORDER_VIOLATION: "MERGE_ORDER_VIOLATION",
  GATE_EVIDENCE_NOT_BACKED: "GATE_EVIDENCE_NOT_BACKED",
  POST_MERGE_CHECKS_NOT_DECLARED: "POST_MERGE_CHECKS_NOT_DECLARED",
  POST_MERGE_VERIFICATION_FAILED: "POST_MERGE_VERIFICATION_FAILED",
  DEPENDENT_MERGE_BLOCKED: "DEPENDENT_MERGE_BLOCKED",
  RELEASE_TAG_SEMVER_MISMATCH: "RELEASE_TAG_SEMVER_MISMATCH",
  RELEASE_TAG_COMMIT_NOT_ACCEPTED: "RELEASE_TAG_COMMIT_NOT_ACCEPTED",
  RELEASE_TAG_DUPLICATE: "RELEASE_TAG_DUPLICATE",
  ISSUE_PROJECTION_UNVERIFIED: "ISSUE_PROJECTION_UNVERIFIED",
  HOTFIX_PROPAGATION_INCOMPLETE: "HOTFIX_PROPAGATION_INCOMPLETE",

  // --- capacity ------------------------------------------------------------
  CAPACITY_PROBE_STALE: "CAPACITY_PROBE_STALE",
  CAPACITY_SENSOR_FILE_MISSING: "CAPACITY_SENSOR_FILE_MISSING",
  CAPACITY_SENSOR_FILE_STALE: "CAPACITY_SENSOR_FILE_STALE",
  CAPACITY_SENSOR_FILE_INVALID: "CAPACITY_SENSOR_FILE_INVALID",
  CAPACITY_ADMISSION_SUSPENDED: "CAPACITY_ADMISSION_SUSPENDED",
  CAPACITY_ADMISSION_CONSERVE: "CAPACITY_ADMISSION_CONSERVE",
  CAPACITY_BUCKET_EXHAUSTED: "CAPACITY_BUCKET_EXHAUSTED",
  CAPACITY_UNKNOWN_NOT_ROUTABLE: "CAPACITY_UNKNOWN_NOT_ROUTABLE",
  CAPACITY_OBSERVATION_PROVENANCE_REQUIRED: "CAPACITY_OBSERVATION_PROVENANCE_REQUIRED",

  // --- continuity ----------------------------------------------------------
  COVERAGE_FULL: "COVERAGE_FULL",
  COVERAGE_PARTIAL: "COVERAGE_PARTIAL",
  COVERAGE_NONE: "COVERAGE_NONE",
  CONTINUITY_SURVIVAL_NO_COMPLETION: "CONTINUITY_SURVIVAL_NO_COMPLETION",
  RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER: "RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER",

  // --- ingress -------------------------------------------------------------
  INGRESS_ACTOR_NOT_ALLOWLISTED: "INGRESS_ACTOR_NOT_ALLOWLISTED",
  INGRESS_CHAT_NOT_ALLOWLISTED: "INGRESS_CHAT_NOT_ALLOWLISTED",
  INGRESS_SIGNATURE_INVALID: "INGRESS_SIGNATURE_INVALID",
  INGRESS_REPLAY_IGNORED: "INGRESS_REPLAY_IGNORED",
  /**
   * A message whose handler was claimed and whose outcome was never recorded.
   *
   * Deliberately not folded into `INGRESS_REPLAY_IGNORED`. That code means the work was already
   * done and this copy is redundant; this one means nobody knows whether it was done. The two
   * need different responses — the second is a person's to resolve — and one code for both would
   * hide every occurrence of the second inside the first.
   */
  INGRESS_TURN_OUTCOME_UNKNOWN: "INGRESS_TURN_OUTCOME_UNKNOWN",
  /**
   * A fresh message (its own nonce, its own turn id) arrived for a conversation that already has
   * a claimed turn nobody has recorded an outcome for.
   *
   * Distinct from `INGRESS_TURN_OUTCOME_UNKNOWN`: that code is about *this same message* coming
   * back. This one is about a different message — a resend in the owner's own words, or an
   * unrelated new one — landing while the conversation's previous turn is still open. The turn id
   * cannot tell those apart (#641); this code is what a resend gets instead of a second, silently
   * duplicated CEO turn. The message is parked, not dropped: `/again` claims it anyway.
   */
  INGRESS_TURN_UNRESOLVED_CONVERSATION: "INGRESS_TURN_UNRESOLVED_CONVERSATION",
  INGRESS_NONCE_EXPIRED: "INGRESS_NONCE_EXPIRED",
  UNTRUSTED_CONTENT_IS_DATA: "UNTRUSTED_CONTENT_IS_DATA",
  MCP_PEER_UNAUTHENTICATED: "MCP_PEER_UNAUTHENTICATED",
  OPERATOR_UNAUTHENTICATED: "OPERATOR_UNAUTHENTICATED",
  OPERATOR_METHOD_NOT_ALLOWED: "OPERATOR_METHOD_NOT_ALLOWED",
  /** An authenticated operator method outlived its execution budget. Not an authentication fact. */
  OPERATOR_REQUEST_TIMEOUT: "OPERATOR_REQUEST_TIMEOUT",
  /** Ordinary conversation arrived while no CEO peer held an authenticated socket. */
  CEO_CONVERSATION_UNAVAILABLE: "CEO_CONVERSATION_UNAVAILABLE",
  /** The connected CEO peer did not declare the `sampling` capability at handshake. */
  CEO_CONVERSATION_UNSUPPORTED: "CEO_CONVERSATION_UNSUPPORTED",
  /** The CEO peer accepted the turn but did not answer within the conversation budget. */
  CEO_CONVERSATION_TIMEOUT: "CEO_CONVERSATION_TIMEOUT",
  /**
   * The turn never completed a round trip — the socket closed mid-request, or was already gone
   * when it was sent — rather than the daemon's own budget expiring.
   *
   * Distinguished from `CEO_CONVERSATION_TIMEOUT` because a timeout is this daemon giving up on
   * its own clock; this is the transport itself failing, which is a different repair (reconnect)
   * from a different owner (whoever runs the peer process). Folding both into one code was
   * #633: every `createMessage` rejection reported as "did not answer in time" even when the
   * peer was never reachable at all.
   */
  CEO_CONVERSATION_TRANSPORT_FAILED: "CEO_CONVERSATION_TRANSPORT_FAILED",
  /**
   * The turn reached the peer and the peer rejected it with a JSON-RPC error, rather than
   * timing out or the transport failing.
   *
   * The peer's own error code travels as evidence; its message does not — the same reason the
   * timeout path never repeated one (it is written by the CEO runtime and may quote whatever it
   * was handling when it failed).
   */
  CEO_CONVERSATION_PEER_FAILED: "CEO_CONVERSATION_PEER_FAILED",
  /** The CEO peer answered with content this text-only seam cannot deliver. */
  CEO_CONVERSATION_NOT_TEXT: "CEO_CONVERSATION_NOT_TEXT",
  /** The connected peer no longer holds the CEO role its socket was admitted under. */
  CEO_CONVERSATION_STALE: "CEO_CONVERSATION_STALE",
  /**
   * A turn was already open on the CEO's canonical session, so this one was not started.
   *
   * The reply command resumes one conversation by id. Two turns against it interleave in a
   * transcript that is then carried forward as context, and that cannot be unwound.
   */
  CEO_CONVERSATION_BUSY: "CEO_CONVERSATION_BUSY",

  // --- canonical turns -----------------------------------------------------
  /**
   * No verified target binding exists for this actor, so no turn can be claimed for it.
   *
   * This is the activation embargo arriving as an ordinary refusal rather than as a rule someone
   * follows: until an authenticated preflight bind records which conversation an actor owns,
   * there is nothing to serialise against and no honest way to say where an answer would land.
   */
  CONVERSATION_TARGET_UNVERIFIED: "CONVERSATION_TARGET_UNVERIFIED",
  /**
   * The actor's target has a binding but no runtime ever attested it.
   *
   * A binding says which conversation; an attestation says a named runtime generation verified
   * that claim. Admitting on the binding alone trusts an assertion nothing has rechecked since.
   */
  CONVERSATION_TARGET_UNATTESTED: "CONVERSATION_TARGET_UNATTESTED",
  /**
   * An attestation exists for this binding, but none names the actor's current generation.
   *
   * A binding is a lifetime relation; an attestation is scoped to a runtime generation. The most
   * recent attestation by time is not necessarily the current one: the actor may have retired, its
   * runtime session and incarnation may have moved, or the role's active binding generation may
   * have advanced past the one this attestation named. Admitting on the latest timestamp alone
   * trusts a generation nothing has confirmed is still in force.
   */
  CONVERSATION_TARGET_ATTESTATION_STALE: "CONVERSATION_TARGET_ATTESTATION_STALE",
  /**
   * An attestation's own `binding_generation` disagrees with the assignment it names (#666
   * round 5). The two are supposed to always agree — an honest writer reads both off the same
   * `assignments` row — so this is `attestation_generation_matches_assignment` refusing the
   * write, not `claim()` refusing a read: a database-level contradiction caught before it
   * becomes a durable, self-inconsistent record.
   */
  ATTESTATION_GENERATION_MISMATCH: "ATTESTATION_GENERATION_MISMATCH",
  /**
   * `conversational_actors.current_session_incarnation` disagrees with `sessions.incarnation`
   * for the session `current_session_id` names (#666 round 7). The actor's column is a copy;
   * `sessions.incarnation` is the immutable authority. A write that moves one without the other —
   * an insert or an update — is refused by
   * `conversational_actors_incarnation_matches_session_on_insert` /
   * `_on_update` before the copy can drift from what it claims to mirror.
   */
  ACTOR_SESSION_INCARNATION_MISMATCH: "ACTOR_SESSION_INCARNATION_MISMATCH",
  /**
   * A source names a channel and nonce that ingress never admitted.
   *
   * `claim()` used to write whatever channel/nonce a caller supplied straight into
   * `canonical_turn_sources`, with nothing checking it against `inbound_messages`. So a source
   * could name a message nobody admitted, and the retry chain would then reason about attempts of
   * a message with no admission record.
   */
  CONVERSATION_TURN_SOURCE_UNADMITTED: "CONVERSATION_TURN_SOURCE_UNADMITTED",
  /**
   * A source names a channel and nonce ingress admitted, but the payload it carries is not the
   * one `INGRESS_ADMITTED` recorded for that (channel, nonce).
   *
   * The existence check above stops at "did ingress admit *something* under this nonce" — it
   * never compared *what*. So a caller could have ingress admit `{text:"A"}` for a nonce, then
   * claim that same nonce with `{text:"B"}`, and the existence check alone would pass: the row is
   * there, whatever payload names it. `canonical_turn_sources.source_digest` would then record
   * B's digest as what the nonce carried — permanently, since the table is append-only. Read
   * from `INGRESS_ADMITTED`'s own evidence, the one place a payload digest is recorded at
   * admission time, rather than trusting the caller's payload for both "did this happen" and
   * "what happened".
   */
  CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH: "CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH",
  /** This conversation already holds a turn whose outcome nobody established. */
  CONVERSATION_TURN_IN_DOUBT: "CONVERSATION_TURN_IN_DOUBT",
  /** A retry numbered past its predecessor, which does not exist — nothing says the earlier
   *  attempt ended. */
  CONVERSATION_TURN_ATTEMPT_UNCHAINED: "CONVERSATION_TURN_ATTEMPT_UNCHAINED",
  /**
   * The previous attempt at this message did not end in a way that makes a retry safe.
   *
   * Only two outcomes qualify: nothing ran, or the target proved the old execution can no longer
   * write. A completed one must never run again; one still in doubt must not be raced.
   */
  CONVERSATION_TURN_ATTEMPT_UNSAFE: "CONVERSATION_TURN_ATTEMPT_UNSAFE",
  /**
   * A permit offered to settle a turn was not issued by the coordinator being asked.
   *
   * `TurnPermit` is a structural type, so the shape alone proves nothing; the signature is what
   * separates a permit from an object that looks like one.
   */
  CONVERSATION_TURN_PERMIT_UNISSUED: "CONVERSATION_TURN_PERMIT_UNISSUED",
  /** A genuinely issued permit whose contents disagree with the turn row it names. */
  CONVERSATION_TURN_PERMIT_MISMATCH: "CONVERSATION_TURN_PERMIT_MISMATCH",
  /**
   * An earlier turn on this conversation has observations that disagree, so no new turn starts.
   *
   * The disagreement is about whether that turn ran. Admitting a fresh one against a conversation
   * whose last outcome is disputed turns one dispute into two, and the second is harder to read
   * because the transcript now has both.
   */
  CONVERSATION_ACTOR_QUARANTINED: "CONVERSATION_ACTOR_QUARANTINED",
  /**
   * A receipt id already carries different evidence on this turn.
   *
   * Redelivery of the same receipt is a no-op; the same identity over different content is two
   * claims wearing one name. Accepting it silently returned the first as a confirmation of the
   * second, so a genuine observation could be discarded and reported as landed.
   */
  CONVERSATION_TURN_RECEIPT_REUSED: "CONVERSATION_TURN_RECEIPT_REUSED",
  /**
   * An observation arrived with no receipt id, no evidence digest, or no reason code.
   *
   * The three fields are what make the row a record of something observed rather than a caller's
   * assertion, and an empty one was accepted and stored empty — measured on the merged head. The
   * receipt id is worse than cosmetic: it is half of `(observing_authority, receipt_id)`, so the
   * first blank settlement an authority makes takes that slot and turns every later blank one into
   * a redelivery of it, or into a reuse conflict against evidence that was never produced.
   */
  CONVERSATION_TURN_OBSERVATION_UNEVIDENCED: "CONVERSATION_TURN_OBSERVATION_UNEVIDENCED",
  /**
   * A resolution would record a fence that nothing established.
   *
   * `ABORTED` means the execution can no longer write. An operator resolving a turn whose executor
   * incarnation is still the current one is asserting that without evidence, and the cost lands as
   * a duplicate: attempt 2 is admitted while attempt 1 may still deliver. Refused unless the
   * operator says explicitly that they established it, which the ledger then records as `ASSERTED`
   * rather than `VERIFIED`.
   */
  CONVERSATION_TURN_FENCE_UNPROVEN: "CONVERSATION_TURN_FENCE_UNPROVEN",
  /**
   * A settlement claims a phase the ledger's dispatch record contradicts.
   *
   * `ACP_PRE_DISPATCH` says nothing ran, and a turn with a dispatch row did. The target and
   * owner-fence authorities are the other direction: they report what happened to an execution, and
   * a turn that was never dispatched has none. What makes an authority truthful is when it can be
   * reached, and this is that made checkable — the phase is a row, the outcome is a caller's word.
   */
  CONVERSATION_TURN_PHASE_MISMATCH: "CONVERSATION_TURN_PHASE_MISMATCH",
  /** A turn was dispatched twice, which is the owner's message delivered twice. */
  CONVERSATION_TURN_ALREADY_DISPATCHED: "CONVERSATION_TURN_ALREADY_DISPATCHED",
  /** An adjudication cited only part of the disagreement, or something outside it. */
  CONVERSATION_ADJUDICATION_INCOMPLETE: "CONVERSATION_ADJUDICATION_INCOMPLETE",
  /**
   * A reconciler's receipt names the right turn under the wrong CEO generation.
   *
   * `bindingGeneration` is why a receipt cannot be matched by id alone (#639): a turn claimed
   * under generation N and a receipt minted under N+1 describe two different CEOs' work, even
   * when every other field agrees. Left `IN_DOUBT`, not `CONTRADICTED` — nothing this turn's own
   * observations say disagrees with anything; the receipt is simply not about this claim.
   */
  CONVERSATION_TURN_RECEIPT_WRONG_GENERATION: "CONVERSATION_TURN_RECEIPT_WRONG_GENERATION",
  /**
   * A reconciler's receipt attests to a different turn than the one the sweep asked about.
   *
   * `turnRequestId` is the fourth of contract 1's four fields, and a review found it was the one
   * still taken from the sweep's own query rather than from the receipt's answer: a port that
   * confused two turns sharing the same actor, prompt and generation could otherwise settle the
   * wrong one on a receipt that was never about it. Left `IN_DOUBT`, for the same reason a wrong
   * generation is: the receipt is simply not evidence about this claim, not a contradiction of it.
   */
  CONVERSATION_TURN_RECEIPT_WRONG_TURN: "CONVERSATION_TURN_RECEIPT_WRONG_TURN",
  /**
   * A reconciled receipt says `COMPLETED`, and this build has no way to discharge the reply
   * obligation that transition carries alongside it.
   *
   * #639's contract: a matched receipt must move the turn to `TURN_COMPLETED` and insert one
   * reply-outbox item atomically, in the same transaction — not as two facts that could disagree.
   * A review found the reconciler only did the first: `canonical_turns` moved, nothing else did,
   * and `COMPLETED` cannot be walked back through the ordinary API once recorded. There is no
   * reply-outbox mechanism wired to this ledger to insert into — `src/outbox/outbox.ts` exists,
   * but its `MessageKind`s are role-to-role task dispatch, not a reply to the owner who asked — so
   * recording `COMPLETED` today would be exactly the false positive contract 6 exists to prevent.
   * `ABORTED` carries no such obligation and is unaffected.
   */
  CONVERSATION_TURN_RECEIPT_REPLY_OBLIGATION_UNDISCHARGEABLE:
    "CONVERSATION_TURN_RECEIPT_REPLY_OBLIGATION_UNDISCHARGEABLE",
  /**
   * A reconciled receipt names a different target binding than the one this turn was claimed
   * against. Kept apart from the generation/runtime checks because it is a distinct fact: which
   * Hermes conversation this turn belongs to, not which execution of it.
   */
  CONVERSATION_TURN_RECEIPT_WRONG_BINDING: "CONVERSATION_TURN_RECEIPT_WRONG_BINDING",
  /**
   * A reconciled receipt names a different attestation than the one that verified this turn's
   * target at claim time. A stale or replaced attestation is not evidence about a turn claimed
   * under a different one, even when the binding and generation both still agree.
   */
  CONVERSATION_TURN_RECEIPT_WRONG_ATTESTATION: "CONVERSATION_TURN_RECEIPT_WRONG_ATTESTATION",
  /**
   * A reconciled receipt names a different executor session or incarnation than the one this
   * turn was claimed under — the gap `bindingGeneration` alone cannot close.
   *
   * `BindingRegistry.switchTo`'s `SURVIVED` failover moves an actor's live runtime to a new
   * session while deliberately keeping the same `bindingGeneration` ("the binding is not
   * rewritten, which is why `binding_generation` cannot advance here"). So a turn claimed under
   * one runtime can have its actor's session move to another while the turn is still `IN_DOUBT`,
   * and a receipt describing the *new* runtime's work would pass turn, actor, prompt and
   * generation checks alike while being evidence about an execution this turn was never
   * dispatched under. Left `IN_DOUBT`, for the same reason every other identity mismatch is: the
   * receipt is not evidence about this claim, not a contradiction of it.
   */
  CONVERSATION_TURN_RECEIPT_WRONG_RUNTIME: "CONVERSATION_TURN_RECEIPT_WRONG_RUNTIME",
  // --- disposable acceptance realm ------------------------------------------
  /**
   * A path the acceptance realm would use resolves inside production, or outside its own state
   * directory.
   *
   * Both are the same failure seen from two sides: the first means the realm is production, the
   * second means cleanup could not account for what the realm created.
   */
  ACCEPTANCE_REALM_NOT_ISOLATED: "ACCEPTANCE_REALM_NOT_ISOLATED",
  /** The probe would address the canonical root, which is the one thing the realm exists to avoid. */
  ACCEPTANCE_PROBE_TARGET_IS_CANONICAL: "ACCEPTANCE_PROBE_TARGET_IS_CANONICAL",
  /** Production is not the set of facts it was before the run. */
  ACCEPTANCE_PRODUCTION_CHANGED: "ACCEPTANCE_PRODUCTION_CHANGED",
  /** The realm left files behind, so "disposable" was not observed. */
  ACCEPTANCE_REALM_RESIDUE: "ACCEPTANCE_REALM_RESIDUE",
  /**
   * A realm path could not be resolved for a reason other than not existing yet.
   *
   * A symlink cycle, an unreadable directory, a component that is not a directory. Distinct from
   * `ACCEPTANCE_REALM_NOT_ISOLATED` on purpose: that one says where the path goes, this one says
   * nobody can tell. Both refuse, and an operator's next move differs.
   */
  ACCEPTANCE_REALM_UNRESOLVABLE: "ACCEPTANCE_REALM_UNRESOLVABLE",
  /**
   * The production census could not be taken.
   *
   * A failure to look is not an observation that there is nothing there — and recording it as
   * absence makes two unreadable censuses compare equal, which reports an unchanged production
   * database that was never read.
   */
  ACCEPTANCE_CENSUS_UNOBSERVABLE: "ACCEPTANCE_CENSUS_UNOBSERVABLE",

  // --- outbox --------------------------------------------------------------
  OUTBOX_STALE_GENERATION_REJECTED: "OUTBOX_STALE_GENERATION_REJECTED",
  OUTBOX_RETARGETED: "OUTBOX_RETARGETED",
  OUTBOX_EXPIRED: "OUTBOX_EXPIRED",
  OUTBOX_DUPLICATE_SUPPRESSED: "OUTBOX_DUPLICATE_SUPPRESSED",
  OUTBOX_PAYLOAD_DIGEST_MISMATCH: "OUTBOX_PAYLOAD_DIGEST_MISMATCH",
  OUTBOX_TARGET_NOT_CURRENT: "OUTBOX_TARGET_NOT_CURRENT",
  OUTBOX_DELIVERY_REJECTED: "OUTBOX_DELIVERY_REJECTED",
  OUTBOX_RETRY_POLICY_UNAVAILABLE: "OUTBOX_RETRY_POLICY_UNAVAILABLE",

  // --- claim admission -----------------------------------------------------
  CLAIM_OWNER_NOT_RUN_OWNER: "CLAIM_OWNER_NOT_RUN_OWNER",

  // --- doctor / repair -----------------------------------------------------
  DOCTOR_HEALTHY: "DOCTOR_HEALTHY",
  DOCTOR_DEGRADED: "DOCTOR_DEGRADED",
  DOCTOR_BLOCKED: "DOCTOR_BLOCKED",
  DOCTOR_ERROR: "DOCTOR_ERROR",
  CANDIDATE_PIPELINE_ATTEMPT_STALE: "CANDIDATE_PIPELINE_ATTEMPT_STALE",
  REPAIR_NOT_ALLOWLISTED: "REPAIR_NOT_ALLOWLISTED",
  REPAIR_PRECONDITION_UNMET: "REPAIR_PRECONDITION_UNMET",
  REPAIR_REQUIRES_OWNER: "REPAIR_REQUIRES_OWNER",

  // --- bootstrap -----------------------------------------------------------
  BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT: "BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT",
  BOOTSTRAP_ACTIVATION_INCOMPLETE: "BOOTSTRAP_ACTIVATION_INCOMPLETE",
  BOOTSTRAP_MANIFEST_ABSOLUTE_PATH: "BOOTSTRAP_MANIFEST_ABSOLUTE_PATH",
  BOOTSTRAP_CTO_INELIGIBLE_FOR_PROMOTION: "BOOTSTRAP_CTO_INELIGIBLE_FOR_PROMOTION",
  BOOTSTRAP_CONTRACT_DRIFT: "BOOTSTRAP_CONTRACT_DRIFT",
  BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION: "BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION",
  HERMES_BOOTSTRAP_ALREADY_INITIALIZED: "HERMES_BOOTSTRAP_ALREADY_INITIALIZED",
  HERMES_BOOTSTRAP_PROOF_INVALID: "HERMES_BOOTSTRAP_PROOF_INVALID",
  HERMES_BOOTSTRAP_RUNTIME_FAILED: "HERMES_BOOTSTRAP_RUNTIME_FAILED",
  RESOURCE_COLLISION: "RESOURCE_COLLISION",
  MANIFEST_NOT_PORTABLE: "MANIFEST_NOT_PORTABLE",

  // --- daemon --------------------------------------------------------------
  DAEMON_ALREADY_RUNNING: "DAEMON_ALREADY_RUNNING",
  DAEMON_LOCK_LOST: "DAEMON_LOCK_LOST",
  DAEMON_BACKOFF_ACTIVE: "DAEMON_BACKOFF_ACTIVE",
  DAEMON_STARTUP_FAILED: "DAEMON_STARTUP_FAILED",
  DAEMON_BOOTSTRAP_MODE: "DAEMON_BOOTSTRAP_MODE",
  DAEMON_TIMER_FAILED: "DAEMON_TIMER_FAILED",
  FINALIZATION_ATTEMPT_STALE: "FINALIZATION_ATTEMPT_STALE",
  FINALIZATION_COMPENSATION_REQUIRED: "FINALIZATION_COMPENSATION_REQUIRED",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

const ALL: ReadonlySet<string> = new Set(Object.values(ReasonCode));

export const isReasonCode = (value: string): value is ReasonCode => ALL.has(value);

/**
 * Reason codes that report a *staleness* verdict rather than a failure.
 *
 * The distinction is the point, not the label. A failure means the thing under test is wrong
 * and should be fixed. A staleness verdict means the two sides of a comparison came from
 * different generations, so nothing was established either way — the answer is re-derived, not
 * repaired.
 *
 * Folding the two costs real time in both directions, and both happened here. A stale trust
 * receipt reported as INVALID sent someone auditing a receipt that was fine. Stale evidence
 * reported as nothing at all let a wrong number read as current. See #448 for the eleven
 * observed cases and `docs/TERMINOLOGY.md` §6 for the rename that blinded a monitor.
 *
 * This is a classification over existing codes, not a new set. Widening `Decision<T>` to carry
 * a third state was measured and rejected: `.allowed` is read 1557 times, 356 of those as
 * `if (!x.allowed)`, so a third state would compile everywhere and silently fold at every one
 * of them — the exact defect the rule exists to prevent, with the compiler unable to help.
 * Asking the question of a code is cheap and changes no call site that does not want it.
 */
export const STALENESS_REASON_CODES: ReadonlySet<ReasonCode> = new Set([
  ReasonCode.BINDING_GENERATION_STALE,
  ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
  ReasonCode.CAPACITY_PROBE_STALE,
  ReasonCode.CAPACITY_SENSOR_FILE_STALE,
  ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE,
  ReasonCode.EVIDENCE_STALE,
  ReasonCode.FINALIZATION_ATTEMPT_STALE,
  ReasonCode.MERGE_BASE_STALE,
  ReasonCode.MERGE_HEAD_STALE,
  ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
  ReasonCode.REGISTERED_SET_GENERATION_MISMATCH,
  ReasonCode.SNAPSHOT_STALE,
  ReasonCode.WRITE_BINDING_GENERATION_STALE,
]);

/**
 * Whether a denial reports staleness. A caller that acts on this must re-derive rather than
 * repair; a caller that ignores it behaves exactly as before.
 */
export const isStalenessReasonCode = (code: ReasonCode): boolean =>
  STALENESS_REASON_CODES.has(code);
