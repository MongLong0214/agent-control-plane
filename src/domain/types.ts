/** Shared domain vocabulary. PRD §5, §29, §31.2. */

export const RunState = {
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
  BLOCKED: "BLOCKED",
  READY_FOR_CEO_REVIEW: "READY_FOR_CEO_REVIEW",
  REVISION_REQUIRED: "REVISION_REQUIRED",
  AWAITING_HUMAN: "AWAITING_HUMAN",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type RunState = (typeof RunState)[keyof typeof RunState];

export const SessionLifecycle = {
  STARTING: "STARTING",
  READY: "READY",
  DRAINING: "DRAINING",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
} as const;
export type SessionLifecycle = (typeof SessionLifecycle)[keyof typeof SessionLifecycle];

export const ContinuityMode = {
  NORMAL: "NORMAL",
  DEGRADED: "DEGRADED",
  SURVIVAL: "SURVIVAL",
} as const;
export type ContinuityMode = (typeof ContinuityMode)[keyof typeof ContinuityMode];

export const Role = {
  CEO: "CEO",
  BOOTSTRAP_CTO: "BOOTSTRAP_CTO",
  PRIMARY_CTO: "PRIMARY_CTO",
  BLIND_REVIEWER: "BLIND_REVIEWER",
  WORKER: "WORKER",
  OPTIONAL_ADVERSARIAL_REVIEWER: "OPTIONAL_ADVERSARIAL_REVIEWER",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** PRD §4 CP-HI-04 — the producer set a blind reviewer must not belong to. */
export const PRODUCER_ROLES: readonly Role[] = [
  Role.PRIMARY_CTO,
  Role.BOOTSTRAP_CTO,
  Role.WORKER,
];

export const ExecutionMode = {
  SIMPLE: "SIMPLE",
  STANDARD: "STANDARD",
  GUARDED: "GUARDED",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

export const RunPriority = {
  CRITICAL: "CRITICAL",
  NORMAL: "NORMAL",
  LOW: "LOW",
} as const;
export type RunPriority = (typeof RunPriority)[keyof typeof RunPriority];

export const RunKind = {
  STANDARD_WORK: "STANDARD_WORK",
  PROJECT_BOOTSTRAP: "PROJECT_BOOTSTRAP",
  CONTRACT_CHANGE: "CONTRACT_CHANGE",
} as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

export const TaskState = {
  PENDING: "PENDING",
  READY: "READY",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type TaskState = (typeof TaskState)[keyof typeof TaskState];

/** PRD §31.2 controlled vocabulary. */
export const TaskCategory = {
  mechanical: "mechanical",
  implementation: "implementation",
  investigation: "investigation",
  integration: "integration",
  test: "test",
  review: "review",
  docs: "docs",
  migration: "migration",
  benchmark: "benchmark",
  security: "security",
} as const;
export type TaskCategory = (typeof TaskCategory)[keyof typeof TaskCategory];

export const FailureClass = {
  transient: "transient",
  repairable: "repairable",
  contract: "contract",
  security: "security",
  policy: "policy",
  capacity: "capacity",
  infrastructure: "infrastructure",
  unknown_observed: "unknown_observed",
} as const;
export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

export const ReviewFindingCategory = {
  correctness: "correctness",
  regression: "regression",
  security: "security",
  scope: "scope",
  performance: "performance",
  maintainability: "maintainability",
  evidence: "evidence",
  freshness: "freshness",
  source: "source",
} as const;
export type ReviewFindingCategory =
  (typeof ReviewFindingCategory)[keyof typeof ReviewFindingCategory];

export const ReviewVerdict = {
  PASS: "PASS",
  REVISE: "REVISE",
  BLOCK: "BLOCK",
} as const;
export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict];

export const CeoDecision = {
  CONFIRM: "CONFIRM",
  FINAL_REVISE: "FINAL_REVISE",
  OWNER_DECISION_REQUIRED: "OWNER_DECISION_REQUIRED",
} as const;
export type CeoDecision = (typeof CeoDecision)[keyof typeof CeoDecision];

export const Availability = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;
export type Availability = (typeof Availability)[keyof typeof Availability];

/** PRD §5.1 — activity is derived, never stored. */
export const Activity = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type Activity = (typeof Activity)[keyof typeof Activity];

export const EvidenceMode = {
  LOCAL_COMMAND: "LOCAL_COMMAND",
  TRUSTED_CI: "TRUSTED_CI",
  BOTH_REQUIRED: "BOTH_REQUIRED",
} as const;
export type EvidenceMode = (typeof EvidenceMode)[keyof typeof EvidenceMode];

export const NetworkPolicy = { deny: "deny", allowlist: "allowlist", allow: "allow" } as const;
export type NetworkPolicy = (typeof NetworkPolicy)[keyof typeof NetworkPolicy];

export const ArtifactKind = {
  TASK_CONTRACT: "TASK_CONTRACT",
  PLAN: "PLAN",
  CANDIDATE_SNAPSHOT: "CANDIDATE_SNAPSHOT",
  VERIFICATION: "VERIFICATION",
  BLIND_REVIEW: "BLIND_REVIEW",
  PRODUCTION_READY_PACKET: "PRODUCTION_READY_PACKET",
  APPROVAL: "APPROVAL",
  HANDOFF: "HANDOFF",
  CONTINUITY_SUMMARY: "CONTINUITY_SUMMARY",
  REPO_FACTORY_RESULT: "REPO_FACTORY_RESULT",
  BOOTSTRAP_ACTIVATION_RESULT: "BOOTSTRAP_ACTIVATION_RESULT",
  ROLE_COVERAGE_PLAN: "ROLE_COVERAGE_PLAN",
  DOCTOR_REPORT: "DOCTOR_REPORT",
  REPAIR_RECEIPT: "REPAIR_RECEIPT",
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

/** PRD §29.3 — recorded as events only, never as run states. */
export const RunEventKind = {
  DISPATCHED: "DISPATCHED",
  PLAN_REJECTED: "PLAN_REJECTED",
  CEO_REVIEWING: "CEO_REVIEWING",
  PARTIAL_FAILURE: "PARTIAL_FAILURE",
  CTO_ESCALATION: "CTO_ESCALATION",
  CEO_DECISION: "CEO_DECISION",
  RECOVERY_TAKEOVER: "RECOVERY_TAKEOVER",
  CONTINUITY_ACTIVATED: "CONTINUITY_ACTIVATED",
} as const;
export type RunEventKind = (typeof RunEventKind)[keyof typeof RunEventKind];

export interface RoleBinding {
  assignmentId: string;
  roleKey: string;
  role: Role;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  sessionId: string;
  sessionIncarnation: string;
  bindingGeneration: number;
  mode: "PREFERRED" | "FALLBACK";
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
}

export interface RunRow {
  runId: string;
  projectId: string | null;
  kind: RunKind;
  executionMode: ExecutionMode;
  priority: RunPriority;
  state: RunState;
  goal: string;
  contractDigest: string;
  pinnedManifestDigest: string | null;
  ownerSessionId: string | null;
  ownerBindingGeneration: number | null;
  ownerSessionIncarnation: string | null;
  ownerRoleKey: string | null;
  humanGateRequired: boolean;
  revisionCount: number;
  createdAt: string;
  dispatchedAt: string | null;
  endedAt: string | null;
  stateReason: string | null;
}

export interface RoleScope {
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
}

/**
 * Role key encoding. Scope is part of the key, so "one active binding per role key" is
 * enforceable by a single database index. Keyed by role so a new role cannot be added
 * without deciding how it is scoped.
 */
const ROLE_KEY: Readonly<Record<Role, (scope: RoleScope) => string>> = {
  [Role.CEO]: () => "CEO",
  [Role.PRIMARY_CTO]: (s) => `PRIMARY_CTO:${required(s.projectId, "projectId")}`,
  [Role.BOOTSTRAP_CTO]: (s) => `BOOTSTRAP_CTO:${required(s.runId, "runId")}`,
  [Role.BLIND_REVIEWER]: (s) => `BLIND_REVIEWER:${required(s.runId, "runId")}`,
  [Role.OPTIONAL_ADVERSARIAL_REVIEWER]: (s) =>
    `OPTIONAL_ADVERSARIAL_REVIEWER:${required(s.runId, "runId")}`,
  [Role.WORKER]: (s) => `WORKER:${required(s.taskId, "taskId")}`,
};

export const roleKeyFor = (role: Role, scope: RoleScope = {}): string => ROLE_KEY[role](scope);

const required = (value: string | null | undefined, field: string): string => {
  if (!value) throw new Error(`roleKeyFor requires ${field}`);
  return value;
};
