import type { Clock } from "../core/clock.ts";
import { canonicalJson, digestOf, isDigest } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { credentialBearingField, prohibitedDurableField, type AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import {
  BASELINE_RECORD_SCHEMA_ID,
  BaselineRecordKind,
  type BaselineHarnessIdentity,
  type BaselineInvocationFinish,
  type BaselineInvocationStart,
  type BaselineRecordKind as BaselineRecordKindValue,
  type QualityObservationInput,
  type TaskClassificationRecord,
  type UsageEvidenceInput,
  harnessIdentityDigest,
  isFiniteNullableNumber,
  isTaskClass,
  isUsageSource,
} from "./baseline-contract.ts";

export interface BaselineRecord<T = object> {
  schema: typeof BASELINE_RECORD_SCHEMA_ID;
  kind: BaselineRecordKindValue;
  runId: string;
  recordedAt: string;
  payload: T;
  payloadDigest: string;
}

export interface StoredBaselineRecord<T = object> extends BaselineRecord<T> {
  recordId: string;
}

interface RawBaselineLedgerRecord {
  record_id: number;
  run_id: string;
  record_kind: string;
  schema_id: string;
  recorded_at: string;
  payload_json: string;
  payload_digest: string;
}

interface RawAuditBaselineRecord {
  event_id: number;
  run_id: string;
  at: string;
  kind: string;
  evidence_json: string;
}

// `AuditLog` deliberately truncates an individual string at this limit. The fallback
// preserves the fact that a record was unavailable, rather than allowing the audit
// sanitizer to rewrite a large evidence payload and accidentally call it complete.
const MAX_AUDIT_FALLBACK_CANONICAL_RECORD_CHARS = 2000;

const auditKind = (kind: BaselineRecordKindValue): string => `BASELINE_${kind}`;

const recordDigest = (record: {
  schema: typeof BASELINE_RECORD_SCHEMA_ID;
  kind: BaselineRecordKindValue;
  runId: string;
  recordedAt: string;
  payload: object;
}): string => digestOf(record);

const isRecordKind = (value: unknown): value is BaselineRecordKindValue =>
  typeof value === "string" && Object.values(BaselineRecordKind).includes(value as BaselineRecordKindValue);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const recordIsValid = (value: unknown): value is BaselineRecord => {
  if (!isPlainRecord(value)) return false;
  if (
    value["schema"] !== BASELINE_RECORD_SCHEMA_ID ||
    !isRecordKind(value["kind"]) ||
    typeof value["runId"] !== "string" ||
    typeof value["recordedAt"] !== "string" ||
    !isPlainRecord(value["payload"]) ||
    typeof value["payloadDigest"] !== "string"
  ) {
    return false;
  }
  const { payloadDigest, ...unsigned } = value as unknown as BaselineRecord;
  return payloadDigest === recordDigest(unsigned);
};

/**
 * Immutable, structured baseline records. On state databases upgraded through v14 these
 * land in `baseline_records`; before that migration they use the existing append-only audit
 * ledger with exactly the same schema and digest. The fallback preserves evidence rather
 * than claiming a missing migration made a fact disappear.
 */
export class BaselineRecorder {
  #ledgerAvailable: boolean | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  record<T extends object>(
    runId: string,
    kind: BaselineRecordKindValue,
    payload: T,
  ): Decision<StoredBaselineRecord<T>> {
    if (!this.db.get<{ run_id: string }>(`SELECT run_id FROM runs WHERE run_id = ?`, [runId])) {
      return deny(ReasonCode.NOT_FOUND, "baseline evidence cannot name an unknown run", { runId, kind });
    }
    const safePayload = payload as Record<string, unknown>;
    const prohibited = prohibitedDurableField(safePayload);
    const credential = credentialBearingField(safePayload);
    if (prohibited || credential) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        "baseline evidence cannot contain a credential, prompt, transcript, or reasoning payload",
        { runId, kind, field: prohibited ?? credential },
      );
    }

    const unsigned = {
      schema: BASELINE_RECORD_SCHEMA_ID,
      kind,
      runId,
      recordedAt: this.clock.nowIso(),
      payload,
    } as const;
    const record: BaselineRecord<T> = { ...unsigned, payloadDigest: recordDigest(unsigned) };
    const existing = this.records(runId).find(
      (candidate) => candidate.kind === kind && candidate.payloadDigest === record.payloadDigest,
    ) as StoredBaselineRecord<T> | undefined;
    if (existing) return allow(ReasonCode.OK, existing);

    const canonicalRecord = canonicalJson(record);

    if (this.hasLedger()) {
      const inserted = this.db.run(
        `INSERT INTO baseline_records
           (run_id, record_kind, schema_id, recorded_at, payload_json, payload_digest)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          runId,
          kind,
          BASELINE_RECORD_SCHEMA_ID,
          record.recordedAt,
          canonicalRecord,
          record.payloadDigest,
        ],
      );
      return allow(ReasonCode.OK, { ...record, recordId: `baseline:${inserted.lastInsertRowid}` });
    }

    if (canonicalRecord.length > MAX_AUDIT_FALLBACK_CANONICAL_RECORD_CHARS) {
      // A recording contract must not make ordinary task admission fail merely because an
      // old database has no ledger. Preserve a bounded, explicit unavailable observation;
      // the original bytes remain unclaimed and the export will not treat this as complete
      // graph/runtime evidence.
      const fallbackPayload = {
        availability: "UNAVAILABLE",
        sourcePayloadDigest: digestOf(payload),
        canonicalLength: canonicalRecord.length,
        fallbackLimit: MAX_AUDIT_FALLBACK_CANONICAL_RECORD_CHARS,
        fallbackReason: "AUDIT_FALLBACK_CAPACITY",
      } as const;
      const fallbackUnsigned = { ...unsigned, payload: fallbackPayload } as const;
      const fallbackRecord: BaselineRecord<typeof fallbackPayload> = {
        ...fallbackUnsigned,
        payloadDigest: recordDigest(fallbackUnsigned),
      };
      const fallbackCanonical = canonicalJson(fallbackRecord);
      const written = this.audit.record({
        kind: auditKind(kind),
        runId,
        evidence: {
          detail: fallbackCanonical,
          payloadDigest: fallbackRecord.payloadDigest,
        },
      });
      if (!written.allowed) return written as Decision<StoredBaselineRecord<T>>;
      const event = this.db.get<{ event_id: number }>(
        `SELECT event_id FROM audit_events
          WHERE run_id = ? AND kind = ?
          ORDER BY event_id DESC LIMIT 1`,
        [runId, auditKind(kind)],
      );
      return allow(ReasonCode.OK, {
        ...fallbackRecord,
        recordId: `audit:${event?.event_id ?? "unknown"}`,
      } as StoredBaselineRecord<T>);
    }

    const written = this.audit.record({
      kind: auditKind(kind),
      runId,
      // The audit redactor deliberately treats `*Token*` as credential-bearing. A usage
      // receipt has innocent fields such as inputTokens, so store one pre-screened canonical
      // record string rather than letting a generic key-name rule rewrite evidence bytes.
      evidence: {
        // `detail` is an existing allowlisted audit string. The recorder has already
        // refused secrets/private bulk content, and a canonical string keeps innocent
        // usage names such as `inputTokens` out of the audit redactor's credential-key
        // matcher without changing any value inside the baseline record.
        detail: canonicalRecord,
        payloadDigest: record.payloadDigest,
      },
    });
    if (!written.allowed) return written as Decision<StoredBaselineRecord<T>>;
    const event = this.db.get<{ event_id: number }>(
      `SELECT event_id FROM audit_events
        WHERE run_id = ? AND kind = ?
        ORDER BY event_id DESC LIMIT 1`,
      [runId, auditKind(kind)],
    );
    return allow(ReasonCode.OK, { ...record, recordId: `audit:${event?.event_id ?? "unknown"}` });
  }

  records(runId: string): StoredBaselineRecord<Record<string, unknown>>[] {
    const records: StoredBaselineRecord<Record<string, unknown>>[] = [];
    if (this.hasLedger()) {
      const ledger = this.db.all<RawBaselineLedgerRecord>(
        `SELECT record_id, run_id, record_kind, schema_id, recorded_at, payload_json, payload_digest
           FROM baseline_records WHERE run_id = ? ORDER BY record_id`,
        [runId],
      );
      for (const row of ledger) {
        const parsed = safeParse(row.payload_json);
        if (!recordIsValid(parsed)) continue;
        if (
          parsed.runId !== row.run_id ||
          parsed.kind !== row.record_kind ||
          parsed.schema !== row.schema_id ||
          parsed.recordedAt !== row.recorded_at ||
          parsed.payloadDigest !== row.payload_digest
        ) {
          continue;
        }
        records.push({ ...parsed, payload: parsed.payload as Record<string, unknown>, recordId: `baseline:${row.record_id}` });
      }
    }

    const auditRows = this.db.all<RawAuditBaselineRecord>(
      `SELECT event_id, run_id, at, kind, evidence_json
         FROM audit_events WHERE run_id = ? AND kind LIKE 'BASELINE_%' ORDER BY event_id`,
      [runId],
    );
    for (const row of auditRows) {
      const wrapper = safeParse(row.evidence_json);
      const encoded = isPlainRecord(wrapper) ? wrapper["detail"] : null;
      const parsed = typeof encoded === "string" ? safeParse(encoded) : null;
      if (!recordIsValid(parsed) || parsed.runId !== row.run_id) continue;
      records.push({ ...parsed, payload: parsed.payload as Record<string, unknown>, recordId: `audit:${row.event_id}` });
    }
    return records;
  }

  /**
   * Export must never turn a malformed append-only source row into an absent fact. The
   * normal read accessor remains permissive for operational compatibility, while this
   * stricter check makes a portable evidence bundle fail closed.
   */
  assertIntegrity(runId: string): Decision<void> {
    if (this.hasLedger()) {
      const ledger = this.db.all<RawBaselineLedgerRecord>(
        `SELECT record_id, run_id, record_kind, schema_id, recorded_at, payload_json, payload_digest
           FROM baseline_records WHERE run_id = ? ORDER BY record_id`,
        [runId],
      );
      for (const row of ledger) {
        const parsed = safeParse(row.payload_json);
        if (
          !recordIsValid(parsed) ||
          parsed.runId !== row.run_id ||
          parsed.kind !== row.record_kind ||
          parsed.schema !== row.schema_id ||
          parsed.recordedAt !== row.recorded_at ||
          parsed.payloadDigest !== row.payload_digest
        ) {
          return deny(ReasonCode.EVIDENCE_MISSING, "baseline ledger record failed integrity validation", {
            runId,
            recordId: `baseline:${row.record_id}`,
          });
        }
      }
    }

    const auditRows = this.db.all<RawAuditBaselineRecord>(
      `SELECT event_id, run_id, at, kind, evidence_json
         FROM audit_events WHERE run_id = ? AND kind LIKE 'BASELINE_%' ORDER BY event_id`,
      [runId],
    );
    for (const row of auditRows) {
      const wrapper = safeParse(row.evidence_json);
      const encoded = isPlainRecord(wrapper) ? wrapper["detail"] : null;
      const parsed = typeof encoded === "string" ? safeParse(encoded) : null;
      if (
        !recordIsValid(parsed) ||
        parsed.runId !== row.run_id ||
        row.kind !== auditKind(parsed.kind) ||
        !isPlainRecord(wrapper) ||
        wrapper["payloadDigest"] !== parsed.payloadDigest
      ) {
        return deny(ReasonCode.EVIDENCE_MISSING, "audit-backed baseline record failed integrity validation", {
          runId,
          recordId: `audit:${row.event_id}`,
        });
      }
    }
    return allow(ReasonCode.OK, undefined);
  }

  pinHarness(
    runId: string,
    harness: BaselineHarnessIdentity,
  ): Decision<StoredBaselineRecord<Record<string, unknown>>> {
    const digest = harnessIdentityDigest(harness);
    const existing = this.records(runId).find((record) => record.kind === BaselineRecordKind.HARNESS_PINNED);
    if (existing) {
      const existingPayload = existing.payload as Record<string, unknown>;
      if (existingPayload["harnessDigest"] === digest) return allow(ReasonCode.OK, existing);
      return deny(ReasonCode.CONFLICT, "a run's baseline harness is immutable once pinned", {
        runId,
        pinnedHarnessDigest: existingPayload["harnessDigest"] ?? null,
        requestedHarnessDigest: digest,
      });
    }
    return this.record(runId, BaselineRecordKind.HARNESS_PINNED, {
      harness,
      harnessDigest: digest,
    });
  }

  harness(runId: string): { identity: BaselineHarnessIdentity; digest: string } | null {
    const record = this.records(runId).find((item) => item.kind === BaselineRecordKind.HARNESS_PINNED);
    if (!record || !isPlainRecord(record.payload)) return null;
    const identity = record.payload["harness"];
    const digest = record.payload["harnessDigest"];
    if (!isHarnessIdentity(identity) || typeof digest !== "string" || digest !== harnessIdentityDigest(identity)) {
      return null;
    }
    return { identity, digest };
  }

  recordInvocationStarted(
    runId: string,
    payload: BaselineInvocationStart,
  ): Decision<StoredBaselineRecord<BaselineInvocationStart>> {
    return this.record(runId, BaselineRecordKind.INVOCATION_STARTED, payload);
  }

  recordInvocationFinished(
    runId: string,
    payload: BaselineInvocationFinish,
  ): Decision<StoredBaselineRecord<BaselineInvocationFinish>> {
    return this.record(runId, BaselineRecordKind.INVOCATION_FINISHED, payload);
  }

  recordUsage(input: UsageEvidenceInput): Decision<StoredBaselineRecord<Record<string, unknown>>> {
    if (!isUsageSource(input.source)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "usage source is not part of the baseline contract", {
        runId: input.runId,
        source: input.source,
      });
    }
    const numericFields: Array<keyof UsageEvidenceInput> = [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "quotaBucketBefore",
      "quotaBucketAfter",
      "confidence",
      "estimatedCost",
    ];
    for (const field of numericFields) {
      const value = input[field];
      if (value !== undefined && !isFiniteNullableNumber(value)) {
        return deny(ReasonCode.INVALID_ARGUMENT, "usage numeric evidence must be finite or unavailable", {
          runId: input.runId,
          field,
        });
      }
      if (typeof value === "number" && value < 0) {
        return deny(ReasonCode.INVALID_ARGUMENT, "usage numeric evidence cannot be negative", {
          runId: input.runId,
          field,
        });
      }
    }
    if (input.confidence != null && (input.confidence < 0 || input.confidence > 1)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "usage confidence must be between zero and one", {
        runId: input.runId,
      });
    }

    const unavailable = input.source === "UNAVAILABLE";
    const tokens = {
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null,
    };
    if (unavailable && Object.values(tokens).some((value) => value !== null)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "UNAVAILABLE usage must not invent zero-valued tokens", {
        runId: input.runId,
      });
    }
    if (input.rawObservationDigest != null && !isDigest(input.rawObservationDigest)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "usage raw observation must be addressed by a sha256 digest", {
        runId: input.runId,
      });
    }

    return this.record(input.runId, BaselineRecordKind.USAGE_RECORDED, {
      executionId: input.executionId ?? null,
      source: input.source,
      ...tokens,
      quotaBucketBefore: input.quotaBucketBefore ?? null,
      quotaBucketAfter: input.quotaBucketAfter ?? null,
      resetAt: input.resetAt ?? null,
      rawObservationDigest: input.rawObservationDigest ?? null,
      parserVersion: input.parserVersion ?? null,
      collectorVersion: input.collectorVersion ?? null,
      confidence: input.confidence ?? null,
      costConversionVersion: input.costConversionVersion ?? null,
      estimatedCost: input.estimatedCost ?? null,
      currency: input.currency ?? null,
    });
  }

  recordTaskClassification(
    runId: string,
    payload: TaskClassificationRecord,
  ): Decision<StoredBaselineRecord<TaskClassificationRecord>> {
    if (!isTaskClass(payload.classification)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "task classification is outside the stable baseline vocabulary", {
        runId,
        classification: payload.classification,
      });
    }
    if (payload.confidence != null && (!Number.isFinite(payload.confidence) || payload.confidence < 0 || payload.confidence > 1)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "task-class confidence must be between zero and one", {
        runId,
        taskId: payload.taskId,
      });
    }
    return this.record(runId, BaselineRecordKind.TASK_CLASSIFICATION, payload);
  }

  recordQualityObservation(
    runId: string,
    payload: QualityObservationInput,
  ): Decision<StoredBaselineRecord<QualityObservationInput>> {
    if (
      !["rollbackOrCompensation", "defectEscape"].includes(payload.fact) ||
      !["OBSERVED", "NOT_OBSERVED", "UNAVAILABLE"].includes(payload.status) ||
      !["GITHUB_RECEIPT", "POST_MERGE_OBSERVER", "OPERATOR"].includes(payload.source)
    ) {
      return deny(ReasonCode.INVALID_ARGUMENT, "quality observation is outside the baseline contract", {
        runId,
        fact: payload.fact,
        status: payload.status,
        source: payload.source,
      });
    }
    if (payload.status === "UNAVAILABLE" && payload.evidenceDigest != null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "unavailable quality observations cannot claim evidence", {
        runId,
        fact: payload.fact,
      });
    }
    if (payload.evidenceDigest != null && !isDigest(payload.evidenceDigest)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "quality observation evidence must be addressed by a sha256 digest", {
        runId,
        fact: payload.fact,
      });
    }
    return this.record(runId, BaselineRecordKind.QUALITY_OBSERVATION, {
      fact: payload.fact,
      status: payload.status,
      source: payload.source,
      evidenceDigest: payload.evidenceDigest ?? null,
    });
  }

  private hasLedger(): boolean {
    if (this.#ledgerAvailable !== null) return this.#ledgerAvailable;
    this.#ledgerAvailable = Boolean(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'baseline_records'`,
      )?.n,
    );
    return this.#ledgerAvailable;
  }
}

const safeParse = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

const isHarnessIdentity = (value: unknown): value is BaselineHarnessIdentity => {
  if (!isPlainRecord(value)) return false;
  const strings = [
    "acpBinaryVersion",
    "acpBinaryCommit",
    "adapterVersion",
    "promptRuleBundleDigest",
    "projectManifestDigest",
    "verificationContractDigest",
    "reviewPolicyDigest",
    "toolPolicyDigest",
  ];
  return (
    (value["evidenceSource"] === "PRODUCTION" || value["evidenceSource"] === "TEST" || value["evidenceSource"] === "UNKNOWN") &&
    strings.every((field) => value[field] === null || typeof value[field] === "string") &&
    (value["schemaVersion"] === null || (typeof value["schemaVersion"] === "number" && Number.isInteger(value["schemaVersion"])))
  );
};
