import { digestOf } from "../core/digest.ts";
import { TaskClass, type TaskCategory, type TaskClass as TaskClassValue } from "../domain/types.ts";

/** Versioned, structural facts only. No prompt, transcript, or raw provider output belongs here. */
export const BASELINE_RECORD_SCHEMA_ID = "agent-control-plane.baseline-record.v1";
export const RUN_EVIDENCE_EXPORT_SCHEMA_ID = "agent-control-plane.run-evidence-export.v1";
export const BASELINE_EXPORT_SCHEMA_ID = "agent-control-plane.baseline-export.v1";
export const EXPERIMENT_ISOLATION_SCHEMA_ID = "agent-control-plane.experiment-isolation.v1";

export const UsageSource = {
  PROVIDER_REPORTED: "PROVIDER_REPORTED",
  CLI_REPORTED: "CLI_REPORTED",
  QUOTA_DELTA: "QUOTA_DELTA",
  ACP_ESTIMATED: "ACP_ESTIMATED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;
export type UsageSource = (typeof UsageSource)[keyof typeof UsageSource];

export const BaselineRecordKind = {
  HARNESS_PINNED: "HARNESS_PINNED",
  HARNESS_DISPATCH_CONTEXT: "HARNESS_DISPATCH_CONTEXT",
  ROLE_SESSION: "ROLE_SESSION",
  INVOCATION_STARTED: "INVOCATION_STARTED",
  INVOCATION_FINISHED: "INVOCATION_FINISHED",
  USAGE_RECORDED: "USAGE_RECORDED",
  GRAPH_SNAPSHOT: "GRAPH_SNAPSHOT",
  TASK_CLASSIFICATION: "TASK_CLASSIFICATION",
  QUALITY_OBSERVATION: "QUALITY_OBSERVATION",
  RUN_OUTCOME: "RUN_OUTCOME",
} as const;
export type BaselineRecordKind = (typeof BaselineRecordKind)[keyof typeof BaselineRecordKind];

/**
 * The harness is pinned as a fact about one run. `null` means unavailable, never a
 * guessed value; a later experiment can then exclude the run from a qualification set.
 */
export interface BaselineHarnessIdentity {
  /** Explicit provenance; an absent attestation is UNKNOWN rather than "real" by default. */
  evidenceSource: "PRODUCTION" | "TEST" | "UNKNOWN";
  acpBinaryVersion: string | null;
  acpBinaryCommit: string | null;
  schemaVersion: number | null;
  adapterVersion: string | null;
  promptRuleBundleDigest: string | null;
  projectManifestDigest: string | null;
  verificationContractDigest: string | null;
  reviewPolicyDigest: string | null;
  toolPolicyDigest: string | null;
}

export type BaselineHarnessInput = Partial<Omit<BaselineHarnessIdentity, "schemaVersion">> & {
  schemaVersion?: number | null;
};

export const normalizeHarnessIdentity = (
  input: BaselineHarnessInput | undefined,
  schemaVersion: number | null,
): BaselineHarnessIdentity => ({
  evidenceSource: input?.evidenceSource ?? "UNKNOWN",
  acpBinaryVersion: input?.acpBinaryVersion ?? null,
  acpBinaryCommit: input?.acpBinaryCommit ?? null,
  schemaVersion: input?.schemaVersion ?? schemaVersion,
  adapterVersion: input?.adapterVersion ?? null,
  promptRuleBundleDigest: input?.promptRuleBundleDigest ?? null,
  projectManifestDigest: input?.projectManifestDigest ?? null,
  verificationContractDigest: input?.verificationContractDigest ?? null,
  reviewPolicyDigest: input?.reviewPolicyDigest ?? null,
  toolPolicyDigest: input?.toolPolicyDigest ?? null,
});

export const harnessIdentityDigest = (identity: BaselineHarnessIdentity): string => digestOf(identity);

export interface UsageEvidenceInput {
  runId: string;
  executionId?: string | null;
  source: UsageSource;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  quotaBucketBefore?: number | null;
  quotaBucketAfter?: number | null;
  resetAt?: string | null;
  rawObservationDigest?: string | null;
  parserVersion?: string | null;
  collectorVersion?: string | null;
  confidence?: number | null;
  /** The versioned formula identifier only; no conversion is silently performed here. */
  costConversionVersion?: string | null;
  estimatedCost?: number | null;
  currency?: string | null;
}

export interface BaselineInvocationStart {
  executionId: string;
  taskId: string;
  logicalRole: "WORKER";
  provider: string;
  requestedModel: string;
  observedProvider: string | null;
  observedModel: string | null;
  observedModelVersion: string | null;
  reasoningEffort: string | null;
  sessionId: string;
  sessionIncarnation: string | null;
  providerSessionId: string | null;
  workerBindingGeneration: number | null;
  ownerBindingGeneration: number;
  harnessDigest: string | null;
  adapterVersion: string | null;
  toolPolicyDigest: string | null;
  contextPacketDigest: string | null;
  startedAt: string;
  providerDriftObserved: boolean | null;
  modelDriftObserved: boolean | null;
  qualificationEligible: boolean;
}

export interface BaselineInvocationFinish {
  executionId: string;
  endedAt: string;
  durationMs: number | null;
  outcome: "SUCCEEDED" | "FAILED" | "ABANDONED" | "TIMEOUT";
  failureClass: string | null;
  resultDigest: string | null;
}

export interface TaskClassificationRecord {
  taskId: string;
  classification: TaskClassValue;
  confidence: number | null;
  stage: "PROPOSED" | "FINAL";
  source: "TASK_GRAPH" | "OPERATOR";
  replacesPayloadDigest: string | null;
}

/**
 * Narrow, append-only observations for quality facts that can occur after the
 * normal candidate/review artifacts exist. This is a recording contract only;
 * it does not alter completion or merge authority.
 */
export interface QualityObservationInput {
  fact: "rollbackOrCompensation" | "defectEscape";
  status: "OBSERVED" | "NOT_OBSERVED" | "UNAVAILABLE";
  source: "GITHUB_RECEIPT" | "POST_MERGE_OBSERVER" | "OPERATOR";
  evidenceDigest?: string | null;
}

/**
 * A transparent mapping for legacy v1 operational categories. It is a default proposal,
 * not a classifier: ambiguous categories intentionally land in OTHER with no confidence.
 */
export const taskClassForCategory = (category: TaskCategory): TaskClassValue => {
  switch (category) {
    case "mechanical":
    case "docs":
      return TaskClass.MECHANICAL_CHANGE;
    case "implementation":
      return TaskClass.BOUNDED_FEATURE;
    case "test":
      return TaskClass.TEST_OR_FIXTURE;
    case "migration":
      return TaskClass.DEPENDENCY_OR_MIGRATION;
    case "integration":
      return TaskClass.MULTI_REPO_CHANGE;
    case "benchmark":
      return TaskClass.PERFORMANCE;
    case "security":
      return TaskClass.SECURITY;
    case "investigation":
    case "review":
      return TaskClass.OTHER;
  }
};

export const isTaskClass = (value: unknown): value is TaskClassValue =>
  typeof value === "string" && Object.values(TaskClass).includes(value as TaskClassValue);

export const isUsageSource = (value: unknown): value is UsageSource =>
  typeof value === "string" && Object.values(UsageSource).includes(value as UsageSource);

export const isFiniteNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
