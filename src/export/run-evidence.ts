import type { Clock } from "../core/clock.ts";
import { canonicalJson, digestOf, isDigest } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { AuditLog, credentialBearingField, prohibitedDurableField } from "../db/audit.ts";
import {
  ArtifactStore,
  artifactDigestMatches,
  digestArtifactContent,
  type StoredArtifact,
} from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import type { ArtifactKind } from "../domain/types.ts";
import {
  BASELINE_EXPORT_SCHEMA_ID,
  BASELINE_RECORD_SCHEMA_ID,
  BaselineRecordKind,
  RUN_EVIDENCE_EXPORT_SCHEMA_ID,
  UsageSource,
} from "./baseline-contract.ts";
import { BaselineRecorder, type StoredBaselineRecord } from "./baseline-recorder.ts";

export interface ExportedArtifact {
  artifactId: string;
  kind: ArtifactKind;
  digest: string;
  candidateSnapshotDigest: string | null;
  producedBy: string;
  createdAt: string;
  superseded: boolean;
  /** Present only when the original whole artifact content is safe to publish verbatim. */
  content?: unknown;
}

export interface OmittedExportField {
  subject: "artifact" | "baseline-record";
  subjectId: string;
  field: "content" | "payload";
  reason:
    | "CREDENTIAL_BEARING"
    | "PRIVATE_BULK_CONTENT"
    | "RAW_ENV_OR_HEADER_COLLECTION"
    | "SOURCE_CODE_OR_PATCH_CONTENT"
    | "NOT_REQUIRED_FOR_OFFLINE_BASELINE";
  sourceDigest: string;
}

export interface ExportedBaselineRecord {
  recordId: string;
  kind: string;
  recordedAt: string;
  payloadDigest: string;
  payload?: Record<string, unknown>;
}

export interface RunEvidenceExport {
  schema: typeof RUN_EVIDENCE_EXPORT_SCHEMA_ID;
  run: {
    runId: string;
    projectId: string | null;
    kind: string;
    executionMode: string;
    priority: string;
    state: string;
    contractDigest: string;
    pinnedManifestDigest: string | null;
    currentCandidateDigest: string | null;
    revisionCount: number;
    createdAt: string;
    dispatchedAt: string | null;
    endedAt: string | null;
  };
  artifactManifest: {
    artifacts: ExportedArtifact[];
    omittedFields: OmittedExportField[];
  };
  baseline: {
    harness: Record<string, unknown>;
    runtime: Record<string, unknown>;
    usage: Record<string, unknown>;
    graph: Record<string, unknown>;
    taskClassifications: Record<string, unknown>;
    capacity: Record<string, unknown>;
    /** Independent projection inputs used by offline verification to reconcile quality. */
    qualitySource: Record<string, unknown>;
    quality: Record<string, unknown>;
  };
  baselineRecords: ExportedBaselineRecord[];
  exportedAt: string;
  integrity: {
    algorithm: "sha256";
    checksumScope: "canonical JSON with integrity.checksum omitted";
    checksum: string;
  };
}

export interface BaselineEvidenceExport {
  schema: typeof BASELINE_EXPORT_SCHEMA_ID;
  window: { from: string; to: string };
  runs: RunEvidenceExport[];
  gateAAssessment: BaselineMinimumAssessment;
  exportedAt: string;
  integrity: {
    algorithm: "sha256";
    checksumScope: "canonical JSON with integrity.checksum omitted";
    checksum: string;
  };
}

export interface BaselineMinimumAssessment {
  required: {
    realRuns: 30;
    realProjects: 1;
    taskClasses: 3;
    qualityCoverage: 1;
    modelIdentityCoverage: 1;
    durationCoverage: 1;
    falseCompletions: 0;
    unauthorizedMerges: 0;
  };
  observed: {
    completedRuns: number;
    productionAttestedRuns: number;
    productionAttestedProjects: number;
    representedTaskClasses: string[];
    qualityCoverage: number | null;
    modelIdentityCoverage: number | null;
    durationCoverage: number | null;
    usageEvidence: { runsWithAvailableUsage: number; runsWithUnavailableUsage: number };
    falseCompletions: number | null;
    unauthorizedMerges: number | null;
  };
  eligibleForGateA: false | true;
  gaps: string[];
}

interface RawRun {
  run_id: string;
  project_id: string | null;
  kind: string;
  execution_mode: string;
  priority: string;
  state: string;
  contract_digest: string;
  pinned_manifest_digest: string | null;
  current_candidate_digest: string | null;
  revision_count: number;
  created_at: string;
  dispatched_at: string | null;
  ended_at: string | null;
}

interface RawTask {
  task_id: string;
  category: string;
  state: string;
  attempt_count: number;
}

interface RawDependency {
  task_id: string;
  depends_on: string;
}

interface RawExecution {
  execution_id: string;
  task_id: string;
  attempt: number;
  provider: string;
  model: string;
  worker_session_id: string;
  owner_binding_generation: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  failure_class: string | null;
  result_digest: string | null;
}

interface RawCapacity {
  provider: string;
  bucket_id: string;
  remaining_percent: number | null;
  reset_at: string | null;
  sensor_health: string;
  runtime_health: string;
  allocation_admission: string;
  observed_at: string;
  source: string;
}

interface RawReceipt {
  receipt_id: string;
  operation: string;
  repository_identity: string;
  resource_identity: string;
  request_digest: string;
  before_state_digest: string | null;
  after_state_digest: string | null;
  reread_at: string | null;
  verified: number;
  status: string;
  created_at: string;
}

interface RawAuditDecision {
  event_id: number;
  at: string;
  kind: string;
  evidence_json: string;
}

interface QualitySource extends Record<string, unknown> {
  verificationArtifactId: string | null;
  blindReviewArtifactId: string | null;
  productionPacketArtifactId: string | null;
  receipts: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
}

const NON_EXPORTABLE_ARTIFACT_CONTENT: ReadonlySet<string> = new Set([
  "HANDOFF",
  "CONTINUITY_SUMMARY",
  "DOCTOR_REPORT",
  "REPAIR_RECEIPT",
]);

const sourceBearingField = (value: unknown, depth = 0): string | null => {
  if (depth > 12 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sourceBearingField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    // `source` alone is deliberately not a match: usage evidence legitimately has a
    // source enum. Patch/diff/source-code bodies, however, are never needed here.
    if (/(?:sourcecode|filecontents?|patch(?:text|content)?|diff(?:text|content)?|rawsource)$/.test(normalized)) {
      return key;
    }
    const found = sourceBearingField(nested, depth + 1);
    if (found) return found;
  }
  return null;
};

const privateCollectionField = (value: unknown, depth = 0): string | null => {
  if (depth > 12 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = privateCollectionField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (/(env|environment|headers|cookies|credentials)$/.test(normalized)) return key;
    const found = privateCollectionField(nested, depth + 1);
    if (found) return found;
  }
  return null;
};

const exclusionReason = (
  value: unknown,
  options: { required: boolean },
): OmittedExportField["reason"] | null => {
  if (credentialBearingField(value)) return "CREDENTIAL_BEARING";
  if (prohibitedDurableField(value)) return "PRIVATE_BULK_CONTENT";
  if (privateCollectionField(value)) return "RAW_ENV_OR_HEADER_COLLECTION";
  if (sourceBearingField(value)) return "SOURCE_CODE_OR_PATCH_CONTENT";
  return options.required ? null : "NOT_REQUIRED_FOR_OFFLINE_BASELINE";
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const safeJson = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

/**
 * Builds a read-only, canonical baseline bundle. It never writes the source database and
 * never edits an artifact: an unsafe field is omitted as a whole and named in the manifest.
 */
export class RunEvidenceExporter {
  readonly #baseline: BaselineRecorder;

  constructor(
    private readonly db: Db,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    audit: AuditLog,
  ) {
    this.#baseline = new BaselineRecorder(db, clock, audit);
  }

  exportRun(runId: string): Decision<RunEvidenceExport> {
    const rawRun = this.db.get<RawRun>(`SELECT * FROM runs WHERE run_id = ?`, [runId]);
    if (!rawRun) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

    const baselineIntegrity = this.#baseline.assertIntegrity(runId);
    if (!baselineIntegrity.allowed) return baselineIntegrity as Decision<RunEvidenceExport>;

    const artifacts = this.artifacts.list(runId);
    for (const artifact of artifacts) {
      if (!artifactDigestMatches(artifact)) {
        return deny(ReasonCode.EVIDENCE_MISSING, "an artifact digest does not corroborate its stored content", {
          runId,
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          digest: artifact.digest,
        });
      }
    }

    const artifactManifest = exportArtifacts(artifacts);
    const records = this.#baseline.records(runId);
    const baselineRecords = exportBaselineRecords(records, artifactManifest.omittedFields);
    const tasks = this.db.all<RawTask>(
      `SELECT task_id, category, state, attempt_count FROM tasks WHERE run_id = ? ORDER BY created_at, rowid`,
      [runId],
    );
    const dependencies = this.db.all<RawDependency>(
      `SELECT d.task_id, d.depends_on
         FROM task_dependencies d JOIN tasks t ON t.task_id = d.task_id
        WHERE t.run_id = ? ORDER BY d.task_id, d.depends_on`,
      [runId],
    );
    const executions = this.db.all<RawExecution>(
      `SELECT execution_id, task_id, attempt, provider, model, worker_session_id,
              owner_binding_generation, started_at, ended_at, status, failure_class, result_digest
         FROM task_executions WHERE run_id = ? ORDER BY started_at, execution_id`,
      [runId],
    );

    const run = {
      runId: rawRun.run_id,
      projectId: rawRun.project_id,
      kind: rawRun.kind,
      executionMode: rawRun.execution_mode,
      priority: rawRun.priority,
      state: rawRun.state,
      contractDigest: rawRun.contract_digest,
      pinnedManifestDigest: rawRun.pinned_manifest_digest,
      currentCandidateDigest: rawRun.current_candidate_digest,
      revisionCount: rawRun.revision_count,
      createdAt: rawRun.created_at,
      dispatchedAt: rawRun.dispatched_at,
      endedAt: rawRun.ended_at,
    };
    const qualitySource = this.qualitySource(rawRun, artifactManifest);
    const unsigned = {
      schema: RUN_EVIDENCE_EXPORT_SCHEMA_ID as typeof RUN_EVIDENCE_EXPORT_SCHEMA_ID,
      run,
      artifactManifest,
      baseline: {
        harness: this.harness(records),
        runtime: this.runtime(records, executions),
        usage: this.usage(records),
        graph: this.graph(runId, records, tasks, dependencies, executions),
        taskClassifications: this.taskClassifications(records, tasks),
        capacity: this.capacity(rawRun, executions),
        // This is an independent projection input. Keeping it beside (rather than inside)
        // `quality` lets an offline verifier reconcile the claim after an outer reseal.
        qualitySource,
        quality: this.quality(rawRun, records, artifactManifest, qualitySource),
      },
      baselineRecords,
      exportedAt: this.clock.nowIso(),
    };
    return allow(ReasonCode.OK, sealRunEvidenceExport(unsigned));
  }

  exportBaseline(window: { from: string; to: string }): Decision<BaselineEvidenceExport> {
    if (!isValidDate(window.from) || !isValidDate(window.to) || window.from > window.to) {
      return deny(ReasonCode.INVALID_ARGUMENT, "baseline export requires an ordered ISO-8601 window", window);
    }
    const runIds = this.db.all<{ run_id: string }>(
      `SELECT run_id FROM runs
        WHERE state = 'COMPLETED' AND ended_at IS NOT NULL AND ended_at >= ? AND ended_at <= ?
        ORDER BY ended_at, run_id`,
      [window.from, window.to],
    );
    const runs: RunEvidenceExport[] = [];
    for (const row of runIds) {
      const exported = this.exportRun(row.run_id);
      if (!exported.allowed) return exported as Decision<BaselineEvidenceExport>;
      runs.push(exported.value);
    }
    const unsigned = {
      schema: BASELINE_EXPORT_SCHEMA_ID as typeof BASELINE_EXPORT_SCHEMA_ID,
      window: { from: window.from, to: window.to },
      runs,
      gateAAssessment: assessBaselineMinimum(runs),
      exportedAt: this.clock.nowIso(),
    };
    return allow(ReasonCode.OK, sealBaselineEvidenceExport(unsigned));
  }

  private harness(records: readonly StoredBaselineRecord<Record<string, unknown>>[]): Record<string, unknown> {
    return projectHarness(records);
  }

  private runtime(
    records: readonly StoredBaselineRecord<Record<string, unknown>>[],
    executions: readonly RawExecution[],
  ): Record<string, unknown> {
    const starts = new Map<string, Record<string, unknown>>();
    const finishes = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const payload = record.payload;
      const executionId = typeof payload["executionId"] === "string" ? payload["executionId"] : null;
      if (!executionId) continue;
      if (record.kind === BaselineRecordKind.INVOCATION_STARTED) starts.set(executionId, payload);
      if (record.kind === BaselineRecordKind.INVOCATION_FINISHED) finishes.set(executionId, payload);
    }
    const invocations: Array<Record<string, unknown>> = executions.map((execution) => {
      const started = starts.get(execution.execution_id);
      const finished = finishes.get(execution.execution_id);
      if (!started) {
        return {
          executionId: execution.execution_id,
          taskId: execution.task_id,
          provider: execution.provider,
          requestedModel: execution.model,
          observedProvider: null,
          observedModel: null,
          observedModelVersion: null,
          sessionId: execution.worker_session_id,
          ownerBindingGeneration: execution.owner_binding_generation,
          startedAt: execution.started_at,
          endedAt: execution.ended_at,
          durationMs: durationMs(execution.started_at, execution.ended_at),
          outcome: execution.status,
          failureClass: execution.failure_class,
          resultDigest: execution.result_digest,
          availability: "UNAVAILABLE",
          qualificationEligible: false,
        };
      }
      return {
        ...started,
        ...(finished ?? {
          endedAt: execution.ended_at,
          durationMs: durationMs(execution.started_at, execution.ended_at),
          outcome: execution.status,
          failureClass: execution.failure_class,
          resultDigest: execution.result_digest,
        }),
        availability: "PRESENT",
      };
    });
    const observed = invocations.filter((item) => item["observedModel"] != null);
    const drift = invocations.filter((item) => item["modelDriftObserved"] === true);
    const providerDrift = invocations.filter((item) => item["providerDriftObserved"] === true);
    const roleSessions = records
      .filter((record) => record.kind === BaselineRecordKind.ROLE_SESSION)
      .map((record) => ({ recordedAt: record.recordedAt, payloadDigest: record.payloadDigest, ...record.payload }));
    return {
      invocations,
      roleSessions,
      modelIdentityCoverage: invocations.length === 0 ? null : observed.length / invocations.length,
      observedModelDriftCount: drift.length,
      observedProviderDriftCount: providerDrift.length,
      qualificationEligibleInvocationCount: invocations.filter((item) => item["qualificationEligible"] === true).length,
    };
  }

  private usage(records: readonly StoredBaselineRecord<Record<string, unknown>>[]): Record<string, unknown> {
    const usage: Array<Record<string, unknown>> = records
      .filter((record) => record.kind === BaselineRecordKind.USAGE_RECORDED)
      .map((record) => ({ recordedAt: record.recordedAt, payloadDigest: record.payloadDigest, ...record.payload }));
    if (usage.length === 0) {
      return {
        availability: "UNAVAILABLE",
        records: [],
        unavailable: {
          source: UsageSource.UNAVAILABLE,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
      };
    }
    return {
      availability: "PRESENT",
      records: usage,
      sourceCounts: Object.fromEntries(
        Object.values(UsageSource).map((source) => [
          source,
          usage.filter((record) => record["source"] === source).length,
        ]),
      ),
    };
  }

  private graph(
    runId: string,
    records: readonly StoredBaselineRecord<Record<string, unknown>>[],
    tasks: readonly RawTask[],
    dependencies: readonly RawDependency[],
    executions: readonly RawExecution[],
  ): Record<string, unknown> {
    const dependsOn = new Map(tasks.map((task) => [task.task_id, [] as string[]]));
    for (const dependency of dependencies) dependsOn.get(dependency.task_id)?.push(dependency.depends_on);
    const durationByTask = taskDurations(executions);
    const criticalMemo = new Map<string, number>();
    const critical = (taskId: string): number | null => {
      const cached = criticalMemo.get(taskId);
      if (cached !== undefined) return cached;
      const own = durationByTask.get(taskId);
      if (own === undefined) return null;
      const parent = (dependsOn.get(taskId) ?? []).map(critical);
      if (parent.some((value) => value === null)) return null;
      const value = own + Math.max(0, ...(parent as number[]));
      criticalMemo.set(taskId, value);
      return value;
    };
    const criticalValues = tasks.map((task) => critical(task.task_id));
    const criticalPathDurationMs = criticalValues.some((value) => value === null)
      ? null
      : Math.max(0, ...(criticalValues as number[]));
    const graphSnapshots = records.filter((record) => record.kind === BaselineRecordKind.GRAPH_SNAPSHOT);
    const recomputedPlanRevisionCount = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`,
      [runId],
    )?.n ?? 0;
    const recomputedMaxStructuralReadyWidth = maximumStructuralReadyWidth(tasks, dependencies);
    const latestSnapshot = graphSnapshots.at(-1)?.payload ?? null;
    const graphDepth = typeof latestSnapshot?.["graphDepth"] === "number" ? latestSnapshot["graphDepth"] : null;
    const maxStructuralReadyWidth =
      typeof latestSnapshot?.["maxStructuralReadyWidth"] === "number"
        ? latestSnapshot["maxStructuralReadyWidth"]
        : null;
    const planRevisionCount =
      typeof latestSnapshot?.["planRevisionCount"] === "number"
        ? latestSnapshot["planRevisionCount"]
        : recomputedPlanRevisionCount;
    return {
      nodes: tasks.map((task) => ({
        taskId: task.task_id,
        category: task.category,
        state: task.state,
        attemptCount: task.attempt_count,
      })),
      edges: dependencies.map((dependency) => ({ taskId: dependency.task_id, dependsOn: dependency.depends_on })),
      nodeCount: tasks.length,
      edgeCount: dependencies.length,
      graphDepth,
      maxStructuralReadyWidth,
      maxObservedParallelWidth: maximumObservedWidth(executions),
      criticalPathDurationMs,
      planRevisionCount,
      graphRevisionCount: graphSnapshots.length,
      claimConflictCount: { value: null, availability: "UNAVAILABLE" },
      serializedVsParallelDecision:
        typeof latestSnapshot?.["serializedVsParallelDecision"] === "string"
          ? latestSnapshot["serializedVsParallelDecision"]
          : recomputedMaxStructuralReadyWidth === null
            ? "UNAVAILABLE"
            : recomputedMaxStructuralReadyWidth > 1
              ? "PARALLEL_ELIGIBLE"
              : "SERIALIZED_BY_DEPENDENCIES",
      graphSnapshots: graphSnapshots.map((record) => ({
        recordId: record.recordId,
        recordedAt: record.recordedAt,
        payloadDigest: record.payloadDigest,
        ...record.payload,
      })),
    };
  }

  private taskClassifications(
    records: readonly StoredBaselineRecord<Record<string, unknown>>[],
    tasks: readonly RawTask[],
  ): Record<string, unknown> {
    const byTask = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      if (record.kind !== BaselineRecordKind.TASK_CLASSIFICATION) continue;
      const taskId = record.payload["taskId"];
      if (typeof taskId !== "string") continue;
      const history = byTask.get(taskId) ?? [];
      history.push({ recordedAt: record.recordedAt, payloadDigest: record.payloadDigest, ...record.payload });
      byTask.set(taskId, history);
    }
    const classifications = tasks.map((task) => {
      const history = byTask.get(task.task_id) ?? [];
      const final = [...history].reverse().find((entry) => entry["stage"] === "FINAL") ?? null;
      return {
        taskId: task.task_id,
        availability: final ? "PRESENT" : "UNAVAILABLE",
        final,
        history,
      };
    });
    return {
      vocabulary: "V1-BR-05",
      classifications,
      finalCoverage: tasks.length === 0 ? null : classifications.filter((item) => item.final).length / tasks.length,
    };
  }

  private capacity(
    run: RawRun,
    executions: readonly RawExecution[],
  ): Record<string, unknown> {
    const providers = [...new Set(executions.map((execution) => execution.provider))];
    if (providers.length === 0) return { availability: "UNAVAILABLE", snapshots: [] };
    const marks = providers.map(() => "?").join(", ");
    const snapshots = this.db.all<RawCapacity>(
      `SELECT provider, bucket_id, remaining_percent, reset_at, sensor_health, runtime_health,
              allocation_admission, observed_at, source
         FROM capacity_snapshots
        WHERE provider IN (${marks})
          AND observed_at >= ?
          AND observed_at <= ?
        ORDER BY observed_at, provider, bucket_id`,
      [...providers, run.created_at, run.ended_at ?? this.clock.nowIso()],
    );
    return {
      availability: snapshots.length > 0 ? "PRESENT" : "UNAVAILABLE",
      snapshots: snapshots.map((snapshot) => ({
        provider: snapshot.provider,
        bucketId: snapshot.bucket_id,
        remainingPercent: snapshot.remaining_percent,
        resetAt: snapshot.reset_at,
        sensorHealth: snapshot.sensor_health,
        runtimeHealth: snapshot.runtime_health,
        allocationAdmission: snapshot.allocation_admission,
        observedAt: snapshot.observed_at,
        source: snapshot.source,
      })),
    };
  }

  private qualitySource(
    run: RawRun,
    artifactManifest: RunEvidenceExport["artifactManifest"],
  ): QualitySource {
    const candidate = run.current_candidate_digest;
    const verification = candidate
      ? this.artifacts.latestForSnapshot<Record<string, unknown>>(run.run_id, "VERIFICATION", candidate)
      : this.artifacts.latest<Record<string, unknown>>(run.run_id, "VERIFICATION");
    const review = candidate
      ? this.artifacts.latestForSnapshot<Record<string, unknown>>(run.run_id, "BLIND_REVIEW", candidate)
      : this.artifacts.latest<Record<string, unknown>>(run.run_id, "BLIND_REVIEW");
    const packet = candidate
      ? this.artifacts.latestForSnapshot<Record<string, unknown>>(run.run_id, "PRODUCTION_READY_PACKET", candidate)
      : this.artifacts.latest<Record<string, unknown>>(run.run_id, "PRODUCTION_READY_PACKET");
    const artifactId = (artifact: StoredArtifact | null): string | null => {
      if (!artifact) return null;
      return artifactManifest.artifacts.some((candidateArtifact) => candidateArtifact.artifactId === artifact.artifactId)
        ? artifact.artifactId
        : null;
    };
    const receipts = this.db.all<RawReceipt>(
      `SELECT receipt_id, operation, repository_identity, resource_identity, request_digest,
              before_state_digest, after_state_digest, reread_at, verified, status, created_at
         FROM github_receipts WHERE run_id = ? ORDER BY created_at, receipt_id`,
      [run.run_id],
    );
    const audit = this.db.all<RawAuditDecision>(
      `SELECT event_id, at, kind, evidence_json FROM audit_events
        WHERE run_id = ? AND kind IN ('CEO_DECISION', 'OWNER_DECISION') ORDER BY event_id`,
      [run.run_id],
    );
    const decisions = audit.map((row) => {
      const evidence = safeJson(row.evidence_json);
      return {
        eventId: row.event_id,
        at: row.at,
        kind: row.kind,
        decision: evidence?.["decision"] ?? null,
        candidateSnapshotDigest: evidence?.["candidateSnapshotDigest"] ?? null,
        item: evidence?.["item"] ?? null,
      };
    });
    return {
      verificationArtifactId: artifactId(verification),
      blindReviewArtifactId: artifactId(review),
      productionPacketArtifactId: artifactId(packet),
      receipts: receipts.map((receipt) => ({
        receiptId: receipt.receipt_id,
        operation: receipt.operation,
        repositoryIdentity: receipt.repository_identity,
        resourceIdentity: receipt.resource_identity,
        requestDigest: receipt.request_digest,
        beforeStateDigest: receipt.before_state_digest,
        afterStateDigest: receipt.after_state_digest,
        rereadAt: receipt.reread_at,
        verified: receipt.verified === 1,
        status: receipt.status,
        createdAt: receipt.created_at,
      })).map((receipt) => ({ ...receipt, sourceDigest: digestOf(receipt) })),
      decisions: decisions.map((decision) => ({ ...decision, sourceDigest: digestOf(decision) })),
    };
  }

  private quality(
    run: RawRun,
    records: readonly StoredBaselineRecord<Record<string, unknown>>[],
    artifactManifest: RunEvidenceExport["artifactManifest"],
    source: QualitySource,
  ): Record<string, unknown> {
    return projectQuality(run, records, artifactManifest, source);
  }

}

const exportArtifacts = (artifacts: readonly StoredArtifact[]): RunEvidenceExport["artifactManifest"] => {
  const omittedFields: OmittedExportField[] = [];
  const exported = artifacts.map((artifact) => {
    const descriptor: ExportedArtifact = {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      digest: artifact.digest,
      candidateSnapshotDigest: artifact.candidateSnapshotDigest,
      producedBy: artifact.producedBy,
      createdAt: artifact.createdAt,
      superseded: artifact.superseded,
    };
    const reason = exclusionReason(artifact.content, {
      required: !NON_EXPORTABLE_ARTIFACT_CONTENT.has(artifact.kind),
    });
    if (reason) {
      omittedFields.push({
        subject: "artifact",
        subjectId: artifact.artifactId,
        field: "content",
        reason,
        sourceDigest: artifact.digest,
      });
    } else {
      // Do not transform or scrub this object: its source digest addresses this exact value.
      descriptor.content = artifact.content;
    }
    return descriptor;
  });
  return { artifacts: exported, omittedFields };
};

const exportBaselineRecords = (
  records: readonly StoredBaselineRecord<Record<string, unknown>>[],
  omittedFields: OmittedExportField[],
): ExportedBaselineRecord[] =>
  records.map((record) => {
    const descriptor: ExportedBaselineRecord = {
      recordId: record.recordId,
      kind: record.kind,
      recordedAt: record.recordedAt,
      payloadDigest: record.payloadDigest,
    };
    const reason = exclusionReason(record.payload, { required: true });
    if (reason) {
      omittedFields.push({
        subject: "baseline-record",
        subjectId: record.recordId,
        field: "payload",
        reason,
        sourceDigest: record.payloadDigest,
      });
    } else {
      descriptor.payload = record.payload;
    }
    return descriptor;
  });

const projectHarness = (
  records: readonly StoredBaselineRecord<Record<string, unknown>>[],
): Record<string, unknown> => {
  const pinned = records.find((record) => record.kind === BaselineRecordKind.HARNESS_PINNED);
  const dispatchContexts = records
    .filter((record) => record.kind === BaselineRecordKind.HARNESS_DISPATCH_CONTEXT)
    .map((record) => ({ recordedAt: record.recordedAt, payloadDigest: record.payloadDigest, ...record.payload }));
  if (!pinned) return { availability: "UNAVAILABLE", identity: null, dispatchContexts };
  return {
    availability: "PRESENT",
    payloadDigest: pinned.payloadDigest,
    ...pinned.payload,
    dispatchContexts,
  };
};

const parseQualitySource = (value: unknown): QualitySource | null => {
  const source = asRecord(value);
  if (!source) return null;
  const id = (candidate: unknown): string | null => candidate === null ? null : typeof candidate === "string" ? candidate : null;
  const receipts = source["receipts"];
  const decisions = source["decisions"];
  if (!Array.isArray(receipts) || !Array.isArray(decisions)) return null;
  const receiptRecords = receipts.map(asRecord);
  const decisionRecords = decisions.map(asRecord);
  if (receiptRecords.some((record) => record === null) || decisionRecords.some((record) => record === null)) return null;
  const sourceDigestMatches = (record: Record<string, unknown>): boolean => {
    const sourceDigest = record["sourceDigest"];
    if (!isDigest(sourceDigest)) return false;
    const { sourceDigest: _discarded, ...unsigned } = record;
    return sourceDigest === digestOf(unsigned);
  };
  if (
    receiptRecords.some((record) => !sourceDigestMatches(record!)) ||
    decisionRecords.some((record) => !sourceDigestMatches(record!))
  ) return null;
  return {
    verificationArtifactId: id(source["verificationArtifactId"]),
    blindReviewArtifactId: id(source["blindReviewArtifactId"]),
    productionPacketArtifactId: id(source["productionPacketArtifactId"]),
    receipts: receiptRecords as Array<Record<string, unknown>>,
    decisions: decisionRecords as Array<Record<string, unknown>>,
  };
};

const projectQuality = (
  run: RawRun | RunEvidenceExport["run"],
  records: readonly StoredBaselineRecord<Record<string, unknown>>[],
  artifactManifest: RunEvidenceExport["artifactManifest"],
  source: QualitySource,
): Record<string, unknown> => {
  const artifactById = (artifactId: string | null): ExportedArtifact | null =>
    artifactId === null
      ? null
      : artifactManifest.artifacts.find((artifact) => artifact.artifactId === artifactId) ?? null;
  const verification = artifactById(source.verificationArtifactId);
  const review = artifactById(source.blindReviewArtifactId);
  const packet = artifactById(source.productionPacketArtifactId);
  const revisionCount = "revisionCount" in run ? run.revisionCount : run.revision_count;
  const verificationContent = asRecord(verification?.content) ?? {};
  const reviewContent = asRecord(review?.content) ?? {};
  const qualityObservations: Array<Record<string, unknown>> = records
    .filter((record) => record.kind === BaselineRecordKind.QUALITY_OBSERVATION)
    .map((record) => ({ recordedAt: record.recordedAt, payloadDigest: record.payloadDigest, ...record.payload }));
  const receipts = source.receipts.map(({ sourceDigest: _sourceDigest, ...receipt }) => receipt);
  const decisions = source.decisions.map(({ sourceDigest: _sourceDigest, ...decision }) => decision);
  const mergeReceipts = receipts.filter((receipt) => receipt["operation"] === "merge_execute");
  const postMerge = receipts.filter((receipt) => receipt["operation"] === "post_merge_verify");
  const rollbackPreparation = receipts.filter((receipt) => receipt["operation"] === "rollback_prepare");
  const finalOutcomeRecord = [...records]
    .reverse()
    .find(
      (record) =>
        record.kind === BaselineRecordKind.RUN_OUTCOME &&
        record.payload["terminal"] === true &&
        record.payload["state"] === run.state,
    );
  const latestObservation = (fact: "rollbackOrCompensation" | "defectEscape"): Record<string, unknown> | null =>
    [...qualityObservations].reverse().find((observation) => observation["fact"] === fact) ?? null;
  const observationCoversFact = (observation: Record<string, unknown> | null): boolean =>
    observation?.["status"] === "OBSERVED" || observation?.["status"] === "NOT_OBSERVED";
  const rollbackObservation = latestObservation("rollbackOrCompensation");
  const defectEscapeObservation = latestObservation("defectEscape");
  const facts = [
    { name: "deterministicVerification", present: Boolean(verification) },
    { name: "blindReview", present: Boolean(review) },
    { name: "ceoDecision", present: decisions.some((decision) => decision["kind"] === "CEO_DECISION") },
    {
      name: "mergeReceipt",
      present: mergeReceipts.some((receipt) => receipt["status"] === "APPLIED" && receipt["verified"] === true),
    },
    {
      name: "postMergeVerification",
      present: postMerge.some((receipt) => receipt["status"] === "APPLIED" && receipt["verified"] === true),
    },
    { name: "rollbackOrCompensation", present: observationCoversFact(rollbackObservation) },
    { name: "defectEscape", present: observationCoversFact(defectEscapeObservation) },
    // A state string is not a final-outcome receipt. In particular, a manually or
    // prematurely completed-looking row must not satisfy this evidence fact.
    { name: "finalOutcome", present: Boolean(finalOutcomeRecord) },
  ];
  return {
    deterministicVerification: verification
      ? {
          availability: "PRESENT",
          digest: verification.digest,
          status: verificationContent["status"] ?? null,
          expectedInputs: verificationContent["expectedInputs"] ?? null,
          observedInputs: verificationContent["observedInputs"] ?? null,
        }
      : { availability: "UNAVAILABLE" },
    blindReview: review
      ? {
          availability: "PRESENT",
          digest: review.digest,
          verdict: reviewContent["verdict"] ?? null,
          findingCategories: reviewFindingCategories(reviewContent),
        }
      : { availability: "UNAVAILABLE" },
    productionPacketDigest: packet?.digest ?? null,
    revisionCount,
    ceoDecisions: decisions.filter((decision) => decision["kind"] === "CEO_DECISION"),
    ownerInterventionCount: decisions.filter((decision) => decision["kind"] === "OWNER_DECISION").length,
    mergeReceipts: receipts,
    postMergeVerification: postMerge.some(
      (receipt) => receipt["status"] === "APPLIED" && receipt["verified"] === true,
    )
      ? "PRESENT"
      : "UNAVAILABLE",
    rollbackPreparationReceipts: rollbackPreparation.map((receipt) => ({
      receiptId: receipt["receiptId"],
      status: receipt["status"],
      verified: receipt["verified"],
    })),
    rollbackOrCompensation: {
      status: rollbackObservation?.["status"] ?? "UNAVAILABLE",
      observation: rollbackObservation,
    },
    defectEscapeObservedLater: {
      status: defectEscapeObservation?.["status"] ?? "UNAVAILABLE",
      observation: defectEscapeObservation,
    },
    finalOutcome: finalOutcomeRecord
      ? {
          availability: "PRESENT",
          state: finalOutcomeRecord.payload["state"],
          recordedAt: finalOutcomeRecord.recordedAt,
          payloadDigest: finalOutcomeRecord.payloadDigest,
        }
      : { availability: "UNAVAILABLE", state: null },
    facts,
    requiredFactCoverage: facts.filter((fact) => fact.present).length / facts.length,
    complete: facts.every((fact) => fact.present),
  };
};

const durationMs = (startedAt: string, endedAt: string | null): number | null => {
  if (!endedAt) return null;
  const value = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const taskDurations = (executions: readonly RawExecution[]): Map<string, number> => {
  const durations = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const execution of executions) {
    const duration = durationMs(execution.started_at, execution.ended_at);
    if (duration === null) {
      incomplete.add(execution.task_id);
      continue;
    }
    durations.set(execution.task_id, (durations.get(execution.task_id) ?? 0) + duration);
  }
  for (const taskId of incomplete) durations.delete(taskId);
  return durations;
};

const maximumObservedWidth = (executions: readonly RawExecution[]): number | null => {
  if (executions.length === 0) return 0;
  const edges: Array<{ at: number; delta: -1 | 1 }> = [];
  for (const execution of executions) {
    const started = new Date(execution.started_at).getTime();
    const ended = execution.ended_at ? new Date(execution.ended_at).getTime() : Number.NaN;
    if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
    edges.push({ at: started, delta: 1 }, { at: ended, delta: -1 });
  }
  edges.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let width = 0;
  let maximum = 0;
  for (const edge of edges) {
    width += edge.delta;
    maximum = Math.max(maximum, width);
  }
  return maximum;
};

/** Structural ready width, not an optimizer decision and not a claim about actual worker use. */
const maximumStructuralReadyWidth = (
  tasks: readonly RawTask[],
  dependencies: readonly RawDependency[],
): number | null => {
  const children = new Map(tasks.map((task) => [task.task_id, [] as string[]]));
  const indegree = new Map(tasks.map((task) => [task.task_id, 0]));
  for (const dependency of dependencies) {
    if (!children.has(dependency.depends_on) || !indegree.has(dependency.task_id)) return null;
    children.get(dependency.depends_on)!.push(dependency.task_id);
    indegree.set(dependency.task_id, (indegree.get(dependency.task_id) ?? 0) + 1);
  }
  let frontier = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([taskId]) => taskId)
    .sort();
  let maximum = frontier.length;
  let consumed = 0;
  while (frontier.length > 0) {
    consumed += frontier.length;
    const next = new Set<string>();
    for (const taskId of frontier) {
      for (const child of children.get(taskId) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.add(child);
      }
    }
    frontier = [...next].sort();
    maximum = Math.max(maximum, frontier.length);
  }
  return consumed === tasks.length ? maximum : null;
};

const reviewFindingCategories = (content: Record<string, unknown>): string[] => {
  const findings = content["findings"];
  if (!Array.isArray(findings)) return [];
  return [...new Set(findings.flatMap((finding) => {
    const object = asRecord(finding);
    return typeof object?.["category"] === "string" ? [object["category"]] : [];
  }))].sort();
};

const isValidDate = (value: string): boolean =>
  Number.isFinite(new Date(value).getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(value);

type UnsignedRunEvidenceExport = Omit<RunEvidenceExport, "integrity">;
type UnsignedBaselineEvidenceExport = Omit<BaselineEvidenceExport, "integrity">;

export const sealRunEvidenceExport = (unsigned: UnsignedRunEvidenceExport): RunEvidenceExport => {
  const integrity = {
    algorithm: "sha256" as const,
    checksumScope: "canonical JSON with integrity.checksum omitted" as const,
  };
  return { ...unsigned, integrity: { ...integrity, checksum: digestOf({ ...unsigned, integrity }) } };
};

export const sealBaselineEvidenceExport = (
  unsigned: UnsignedBaselineEvidenceExport,
): BaselineEvidenceExport => {
  const integrity = {
    algorithm: "sha256" as const,
    checksumScope: "canonical JSON with integrity.checksum omitted" as const,
  };
  return { ...unsigned, integrity: { ...integrity, checksum: digestOf({ ...unsigned, integrity }) } };
};

/** Verifies both the bundle envelope and every included artifact's own source digest. */
/**
 * Checks what a portable reader can reproduce from the bundle itself. This is deliberately
 * not authoritative: the bundle's records and public formulas are all editable by its
 * holder, so a successful reproduction is not proof that the source host produced it.
 */
export const reproduceRunEvidenceExport = (value: unknown): boolean => {
  const exportValue = asRecord(value);
  if (!exportValue || exportValue["schema"] !== RUN_EVIDENCE_EXPORT_SCHEMA_ID) return false;
  const integrity = asRecord(exportValue["integrity"]);
  if (
    !integrity ||
    integrity["algorithm"] !== "sha256" ||
    integrity["checksumScope"] !== "canonical JSON with integrity.checksum omitted" ||
    typeof integrity["checksum"] !== "string"
  ) return false;
  const { checksum, ...unsignedIntegrity } = integrity;
  const { integrity: _discarded, ...unsigned } = exportValue;
  if (checksum !== digestOf({ ...unsigned, integrity: unsignedIntegrity })) return false;

  const manifest = asRecord(exportValue["artifactManifest"]);
  const artifacts = manifest?.["artifacts"];
  const omitted = manifest?.["omittedFields"];
  if (!Array.isArray(artifacts) || !Array.isArray(omitted)) return false;
  const run = asRecord(exportValue["run"]);
  if (!run || typeof run["runId"] !== "string") return false;
  const omittedContent = new Set(
    omitted
      .filter((entry) => asRecord(entry)?.["subject"] === "artifact" && asRecord(entry)?.["field"] === "content")
      .map((entry) => String(asRecord(entry)?.["subjectId"])),
  );
  for (const rawArtifact of artifacts) {
    const artifact = asRecord(rawArtifact);
    if (
      !artifact ||
      typeof artifact["artifactId"] !== "string" ||
      typeof artifact["kind"] !== "string" ||
      typeof artifact["digest"] !== "string"
    ) return false;
    const hasContent = Object.hasOwn(artifact, "content");
    if (!hasContent && !omittedContent.has(artifact["artifactId"])) return false;
    if (hasContent) {
      if (
        credentialBearingField(artifact["content"]) ||
        prohibitedDurableField(artifact["content"]) ||
        privateCollectionField(artifact["content"]) ||
        sourceBearingField(artifact["content"])
      ) {
        return false;
      }
      const digest = artifactDigestForExport(
        artifact["kind"],
        artifact["content"],
        artifact["candidateSnapshotDigest"] ?? null,
      );
      if (digest !== artifact["digest"]) return false;
    }
  }
  for (const entry of omitted) {
    const item = asRecord(entry);
    if (!item || typeof item["subjectId"] !== "string" || typeof item["sourceDigest"] !== "string") return false;
    if (item["subject"] === "artifact" && item["field"] === "content") {
      const artifact = artifacts.find((candidate) => asRecord(candidate)?.["artifactId"] === item["subjectId"]);
      if (!artifact) return false;
      const descriptor = asRecord(artifact)!;
      if (Object.hasOwn(descriptor, "content") || descriptor["digest"] !== item["sourceDigest"]) return false;
      continue;
    }
    if (item["subject"] !== "baseline-record" || item["field"] !== "payload") return false;
  }

  const baselineRecords = exportValue["baselineRecords"];
  if (!Array.isArray(baselineRecords)) return false;
  const parsedBaselineRecords: StoredBaselineRecord<Record<string, unknown>>[] = [];
  const omittedPayload = new Set(
    omitted
      .filter((entry) => asRecord(entry)?.["subject"] === "baseline-record" && asRecord(entry)?.["field"] === "payload")
      .map((entry) => String(asRecord(entry)?.["subjectId"])),
  );
  for (const rawRecord of baselineRecords) {
    const record = asRecord(rawRecord);
    if (
      !record ||
      typeof record["recordId"] !== "string" ||
      typeof record["kind"] !== "string" ||
      !Object.values(BaselineRecordKind).includes(
        record["kind"] as (typeof BaselineRecordKind)[keyof typeof BaselineRecordKind],
      ) ||
      typeof record["recordedAt"] !== "string" ||
      typeof record["payloadDigest"] !== "string"
    ) return false;
    const hasPayload = Object.hasOwn(record, "payload");
    if (!hasPayload && !omittedPayload.has(record["recordId"])) return false;
    // Derived sections are only verifiable when their immutable source payload is
    // present. A redacted baseline record is therefore fail-closed for this portable
    // verifier instead of silently allowing a claim that cannot be reconciled.
    if (!hasPayload) return false;
    const payload = asRecord(record["payload"]);
    if (
      !payload ||
      credentialBearingField(payload) ||
      prohibitedDurableField(payload) ||
      privateCollectionField(payload) ||
      sourceBearingField(payload)
    ) return false;
    parsedBaselineRecords.push({
      recordId: record["recordId"],
      schema: BASELINE_RECORD_SCHEMA_ID,
      kind: record["kind"] as (typeof BaselineRecordKind)[keyof typeof BaselineRecordKind],
      runId: run["runId"],
      recordedAt: record["recordedAt"],
      payload,
      payloadDigest: record["payloadDigest"],
    });
    if (
      record["payloadDigest"] !==
      digestOf({
        schema: BASELINE_RECORD_SCHEMA_ID,
        kind: record["kind"],
        runId: run["runId"],
        recordedAt: record["recordedAt"],
        payload,
      })
    ) return false;
  }
  for (const entry of omitted) {
    const item = asRecord(entry);
    if (item?.["subject"] !== "baseline-record" || item["field"] !== "payload") continue;
    const record = baselineRecords.find((candidate) => asRecord(candidate)?.["recordId"] === item["subjectId"]);
    if (!record) return false;
    const descriptor = asRecord(record)!;
    if (Object.hasOwn(descriptor, "payload") || descriptor["payloadDigest"] !== item["sourceDigest"]) return false;
  }

  const baseline = asRecord(exportValue["baseline"]);
  if (!baseline) return false;
  if (canonicalJson(baseline["harness"]) !== canonicalJson(projectHarness(parsedBaselineRecords))) return false;

  const qualitySource = parseQualitySource(baseline["qualitySource"]);
  if (!qualitySource) return false;
  const expectedQuality = projectQuality(
    {
      state: run["state"],
      revisionCount: run["revisionCount"],
    } as unknown as RunEvidenceExport["run"],
    parsedBaselineRecords,
    manifest as unknown as RunEvidenceExport["artifactManifest"],
    qualitySource,
  );
  if (canonicalJson(baseline["quality"]) !== canonicalJson(expectedQuality)) return false;

  const graph = asRecord(baseline["graph"]);
  if (!graph) return false;
  const snapshotRecords = parsedBaselineRecords.filter((record) => record.kind === BaselineRecordKind.GRAPH_SNAPSHOT);
  const exportedSnapshots = graph["graphSnapshots"];
  if (!Array.isArray(exportedSnapshots) || graph["graphRevisionCount"] !== snapshotRecords.length) return false;
  if (exportedSnapshots.length !== snapshotRecords.length) return false;
  for (let index = 0; index < snapshotRecords.length; index += 1) {
    const record = snapshotRecords[index]!;
    const snapshot = asRecord(exportedSnapshots[index]);
    if (
      !snapshot ||
      snapshot["recordId"] !== record.recordId ||
      snapshot["recordedAt"] !== record.recordedAt ||
      snapshot["payloadDigest"] !== record.payloadDigest ||
      canonicalJson({ ...snapshot, recordId: undefined, recordedAt: undefined, payloadDigest: undefined }) !==
        canonicalJson(record.payload)
    ) return false;
  }
  const latestSnapshot = snapshotRecords.at(-1)?.payload;
  if (latestSnapshot) {
    for (const field of ["graphDepth", "maxStructuralReadyWidth", "planRevisionCount", "serializedVsParallelDecision"]) {
      if (graph[field] !== latestSnapshot[field]) return false;
    }
  } else if (graph["graphDepth"] !== null || graph["maxStructuralReadyWidth"] !== null) {
    return false;
  }
  return true;
};

export const reproduceBaselineEvidenceExport = (value: unknown): boolean => {
  const exportValue = asRecord(value);
  if (!exportValue || exportValue["schema"] !== BASELINE_EXPORT_SCHEMA_ID) return false;
  const integrity = asRecord(exportValue["integrity"]);
  if (!integrity || typeof integrity["checksum"] !== "string") return false;
  const { checksum, ...unsignedIntegrity } = integrity;
  const { integrity: _discarded, ...unsigned } = exportValue;
  if (checksum !== digestOf({ ...unsigned, integrity: unsignedIntegrity })) return false;
  const runs = exportValue["runs"];
  if (!Array.isArray(runs) || !runs.every((run) => reproduceRunEvidenceExport(run))) return false;
  const assessment = exportValue["gateAAssessment"];
  return canonicalJson(assessment) === canonicalJson(assessBaselineMinimum(runs as RunEvidenceExport[]));
};

const sourceClock = (exportedAt: string): Clock => ({
  now: () => new Date(exportedAt),
  nowIso: () => exportedAt,
});

const withoutIntegrity = (value: Record<string, unknown>): Record<string, unknown> => {
  const { integrity: _integrity, ...unsigned } = value;
  return unsigned;
};

/**
 * Authoritative v1 verification. A source database is mandatory because the portable
 * bundle is a transport/inspection format, not a self-proving immutable object. The
 * expected export is rebuilt from the host's immutable artifacts, baseline ledger, task
 * graph, executions, receipts, and audit decisions, then compared field-for-field. This
 * reconciles harness, runtime, quality, graph facts, and every Gate A input at their source.
 */
export const verifyRunEvidenceExport = (value: unknown, sourceDb: Db): boolean => {
  if (!reproduceRunEvidenceExport(value)) return false;
  const bundle = value as RunEvidenceExport;
  if (!isValidDate(bundle.exportedAt)) return false;
  const clock = sourceClock(bundle.exportedAt);
  const source = new RunEvidenceExporter(
    sourceDb,
    new ArtifactStore(sourceDb, clock),
    clock,
    new AuditLog(sourceDb, clock),
  );
  const expected = source.exportRun(bundle.run.runId);
  if (!expected.allowed) return false;
  return canonicalJson(withoutIntegrity(bundle as unknown as Record<string, unknown>)) ===
    canonicalJson(withoutIntegrity(expected.value as unknown as Record<string, unknown>));
};

/**
 * Authoritative baseline verification against the producing host. Nested runs are checked
 * against that host first; run membership and Gate A assessment are then rebuilt from the
 * same durable window so a resealed bundle cannot add, remove, or upgrade a run.
 */
export const verifyBaselineEvidenceExport = (value: unknown, sourceDb: Db): boolean => {
  if (!reproduceBaselineEvidenceExport(value)) return false;
  const bundle = value as BaselineEvidenceExport;
  if (!isValidDate(bundle.exportedAt)) return false;
  const clock = sourceClock(bundle.exportedAt);
  const source = new RunEvidenceExporter(
    sourceDb,
    new ArtifactStore(sourceDb, clock),
    clock,
    new AuditLog(sourceDb, clock),
  );
  const expected = source.exportBaseline(bundle.window);
  if (!expected.allowed) return false;
  const expectedRunIds = expected.value.runs.map((run) => run.run.runId);
  const actualRunIds = bundle.runs.map((run) => run.run.runId);
  if (canonicalJson(actualRunIds) !== canonicalJson(expectedRunIds)) return false;
  if (canonicalJson(bundle.gateAAssessment) !== canonicalJson(expected.value.gateAAssessment)) return false;
  return bundle.runs.every((run) => verifyRunEvidenceExport(run, sourceDb));
};

const artifactDigestForExport = (
  kind: unknown,
  content: unknown,
  candidateSnapshotDigest: unknown,
): string | null => {
  if (
    typeof kind !== "string" ||
    (candidateSnapshotDigest !== null && typeof candidateSnapshotDigest !== "string")
  ) return null;
  return digestArtifactContent(kind as ArtifactKind, content, candidateSnapshotDigest);
};

/** A mechanical Gate A report; it never upgrades an unobserved fact to a pass. */
export const assessBaselineMinimum = (runs: readonly RunEvidenceExport[]): BaselineMinimumAssessment => {
  const productionRuns = runs.filter((run) => {
    const identity = asRecord(asRecord(run.baseline["harness"])?.["harness"]);
    return identity?.["evidenceSource"] === "PRODUCTION";
  });
  const classes = new Set<string>();
  const projects = new Set<string>();
  let qualityPresent = 0;
  let modelTotal = 0;
  let modelObserved = 0;
  let durationTotal = 0;
  let durationObserved = 0;
  let usageAvailable = 0;
  let usageUnavailable = 0;
  let falseCompletions = 0;
  // A numeric zero is reserved for a real count observation. No source record means
  // unknown, including when the window contains no production runs.
  let unauthorizedMerges = 0;
  let unauthorizedMergeCountsObserved = productionRuns.length > 0;

  for (const run of productionRuns) {
    if (run.run.projectId) projects.add(run.run.projectId);
    const classification = asRecord(run.baseline["taskClassifications"]);
    const entries = classification?.["classifications"];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const final = asRecord(asRecord(entry)?.["final"]);
        if (typeof final?.["classification"] === "string") classes.add(final["classification"]);
      }
    }
    const quality = asRecord(run.baseline["quality"]);
    if (quality?.["complete"] === true) qualityPresent += 1;
    else if (run.run.state === "COMPLETED") falseCompletions += 1;

    const runtime = asRecord(run.baseline["runtime"]);
    const invocations = runtime?.["invocations"];
    if (Array.isArray(invocations)) {
      for (const invocation of invocations) {
        const item = asRecord(invocation);
        // A requested model/duration is not qualification evidence unless the invocation
        // carried the pinned harness attestation and passed the runtime identity checks.
        if (item?.["qualificationEligible"] !== true) continue;
        modelTotal += 1;
        durationTotal += 1;
        if (item?.["observedModel"] != null) modelObserved += 1;
        if (typeof item?.["durationMs"] === "number") durationObserved += 1;
      }
    }
    const usage = asRecord(run.baseline["usage"]);
    if (usage?.["availability"] === "PRESENT") usageAvailable += 1;
    else usageUnavailable += 1;

    const reportedUnauthorizedMerges = quality?.["unauthorizedMerges"];
    if (
      unauthorizedMergeCountsObserved &&
      typeof reportedUnauthorizedMerges === "number" &&
      Number.isInteger(reportedUnauthorizedMerges) &&
      reportedUnauthorizedMerges >= 0
    ) {
      unauthorizedMerges += reportedUnauthorizedMerges;
    } else {
      unauthorizedMergeCountsObserved = false;
    }
  }

  const observedUnauthorizedMerges = unauthorizedMergeCountsObserved ? unauthorizedMerges : null;

  const qualityCoverage = productionRuns.length === 0 ? null : qualityPresent / productionRuns.length;
  const modelIdentityCoverage = modelTotal === 0 ? null : modelObserved / modelTotal;
  const durationCoverage = durationTotal === 0 ? null : durationObserved / durationTotal;
  const gaps: string[] = [];
  if (productionRuns.length < 30) gaps.push(`production-attested runs: ${productionRuns.length}/30`);
  if (projects.size < 1) gaps.push(`production-attested projects: ${projects.size}/1`);
  if (classes.size < 3) gaps.push(`represented task classes: ${classes.size}/3`);
  if (qualityCoverage !== 1) gaps.push("required quality facts are not 100% covered");
  if (modelIdentityCoverage !== 1) gaps.push("observed model identity is not 100% covered");
  if (durationCoverage !== 1) gaps.push("duration is not 100% covered");
  if (falseCompletions !== 0) gaps.push(`completed runs missing quality baseline: ${falseCompletions}`);
  if (observedUnauthorizedMerges === null) gaps.push("unauthorized merge count is not separately recorded");
  else if (observedUnauthorizedMerges !== 0) {
    gaps.push(`unauthorized merges observed: ${observedUnauthorizedMerges}`);
  }

  return {
    required: {
      realRuns: 30,
      realProjects: 1,
      taskClasses: 3,
      qualityCoverage: 1,
      modelIdentityCoverage: 1,
      durationCoverage: 1,
      falseCompletions: 0,
      unauthorizedMerges: 0,
    },
    observed: {
      completedRuns: runs.length,
      productionAttestedRuns: productionRuns.length,
      productionAttestedProjects: projects.size,
      representedTaskClasses: [...classes].sort(),
      qualityCoverage,
      modelIdentityCoverage,
      durationCoverage,
      usageEvidence: { runsWithAvailableUsage: usageAvailable, runsWithUnavailableUsage: usageUnavailable },
      falseCompletions,
      unauthorizedMerges: observedUnauthorizedMerges,
    },
    eligibleForGateA: gaps.length === 0,
    gaps,
  };
};

/** Emits the exact canonical bytes promised by the export schema. */
export const canonicalRunEvidenceJson = (value: RunEvidenceExport): string => canonicalJson(value);
export const canonicalBaselineEvidenceJson = (value: BaselineEvidenceExport): string => canonicalJson(value);
