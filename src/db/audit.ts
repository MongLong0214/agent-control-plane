import type { Clock } from "../core/clock.ts";
import { allow, deny, type Decision, type Evidence } from "../core/errors.ts";
import { ReasonCode, type ReasonCode as ReasonCodeValue } from "../core/reason-codes.ts";
import {
  credentialShapeMatch, hasCredentialShape, redactCredentialShapes, type AcpLocations, type CredentialShapeMatch, type WriteSite,
} from "../core/credential-shapes.ts";
import type { Db } from "./database.ts";
import { registryView } from "./registry-view.ts";

export interface AuditRecord {
  kind: string;
  reasonCode?: ReasonCodeValue | null;
  runId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  roleKey?: string | null;
  actor?: string | null;
  evidence?: Evidence;
}

/**
 * #1213 — refusal kinds (`_REFUSED`, the repository's naming for a record of a refusal) that src records
 * and whose record naming a task does not block the bootstrap task restore. Omission is safe: a refusal
 * kind missing from this list blocks the restore, which fails closed, so the list never has to be complete.
 * Add a kind only when a refusal that names a task should not block.
 */
export const RECORDED_REFUSAL_KINDS: ReadonlySet<string> = new Set([
  "BOOTSTRAP_CTO_RECOVERY_REFUSED", "BRANCH_PUBLISH_REFUSED", "BUZZ_MENTION_REFUSED", "BUZZ_PEER_REFUSED",
  "CANONICAL_CTO_RESTORE_REFUSED", "CANONICAL_SELF_CLAIM_REFUSED", "CEO_NOTIFICATION_BUZZ_REFUSED",
  "DAEMON_START_REFUSED", "HERMES_CEO_AUTO_ADOPTION_REFUSED", "INGRESS_REFUSED", "MERGE_REFUSED",
  "PRIMARY_CTO_RECOVERY_REFUSED", "REPAIR_REFUSED", "SESSION_BUZZ_ACTOR_BIND_REFUSED", "SESSION_TURN_REFUSED",
  "TASK_WORKER_TURN_LATE_RESULT_REFUSED",
]);

/**
 * Append-only authority log. Deliberately not a hash chain and not the state SSOT
 * (PRD §30.4) — it records who decided what, with the evidence, so a denial can be
 * explained after the fact.
 */
export class AuditLog {
  /** `locations` are the ones the composition root computed: a verified location is checked against them. */
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly locations: AcpLocations = {},
  ) {}

  /**
   * Records an event, and answers with the row's own identity.
   *
   * The identity is returned because a caller that wants to *cite* this record needs the real
   * primary key. The alternative already tried and rejected: minting a `ev_<uuid>` string
   * alongside the insert and storing that. It satisfies a NOT NULL column and identifies
   * nothing — an operator following it finds no audit row, because the row's identity is this
   * autoincrement integer and always was.
   */
  record(entry: AuditRecord): Decision<number> {
    const site: WriteSite = { writer: entry.kind, runId: entry.runId ?? null, locations: this.locations,
      registry: registryView(this.db), record: entry.evidence ?? {} };
    if (!isAllowlistedAuditEvidence(entry.evidence ?? {}, 0, [], site)) {
      // Keep the decision itself visible without retaining the rejected payload. An audit
      // record that might contain a private payload is less useful than a privacy breach.
      this.insert(entry, ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, { auditEvidenceRejected: true });
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        "audit evidence contains an unallowlisted field or value shape",
        { kind: entry.kind },
      );
    }
    const eventId = this.insert(entry, entry.reasonCode ?? null, redact(entry.evidence ?? {}, 0, [], site) as Evidence);
    return allow(ReasonCode.OK, eventId);
  }

  private insert(entry: AuditRecord, reasonCode: ReasonCodeValue | null, evidence: Evidence): number {
    const written = this.db.run(
      `INSERT INTO audit_events (at, kind, reason_code, run_id, project_id, session_id, role_key, actor, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.clock.nowIso(),
        entry.kind,
        reasonCode,
        entry.runId ?? null,
        entry.projectId ?? null,
        entry.sessionId ?? null,
        entry.roleKey ?? null,
        entry.actor ?? null,
        JSON.stringify(evidence),
      ],
    );
    return Number(written.lastInsertRowid);
  }

  forRun(runId: string): AuditRow[] {
    return this.db
      .all<RawAuditRow>(`SELECT * FROM audit_events WHERE run_id = ? ORDER BY event_id`, [runId])
      .map(hydrate);
  }

  byKind(kind: string): AuditRow[] {
    return this.db
      .all<RawAuditRow>(`SELECT * FROM audit_events WHERE kind = ? ORDER BY event_id`, [kind])
      .map(hydrate);
  }

  all(): AuditRow[] {
    return this.db
      .all<RawAuditRow>(`SELECT * FROM audit_events ORDER BY event_id`)
      .map(hydrate);
  }
}

export interface AuditRow {
  eventId: number;
  at: string;
  kind: string;
  reasonCode: string | null;
  runId: string | null;
  projectId: string | null;
  sessionId: string | null;
  roleKey: string | null;
  actor: string | null;
  evidence: Evidence;
}

interface RawAuditRow {
  event_id: number;
  at: string;
  kind: string;
  reason_code: string | null;
  run_id: string | null;
  project_id: string | null;
  session_id: string | null;
  role_key: string | null;
  actor: string | null;
  evidence_json: string;
}

const hydrate = (row: RawAuditRow): AuditRow => ({
  eventId: row.event_id,
  at: row.at,
  kind: row.kind,
  reasonCode: row.reason_code,
  runId: row.run_id,
  projectId: row.project_id,
  sessionId: row.session_id,
  roleKey: row.role_key,
  actor: row.actor,
  evidence: JSON.parse(row.evidence_json) as Evidence,
});

/**
 * PRD §31.5 / §40 Privacy — secrets and private payloads are redacted before they reach
 * durable storage, and full prompts/transcripts are never stored at all.
 *
 * Key-name matching alone is not enough: a credential arrives just as often inside a
 * value (`"GITHUB_TOKEN=ghp_…"`, `"Bearer …"`) or under a name nobody enumerated. So the
 * pass below redacts by key name *and* by value shape, case-insensitively, and treats
 * environment/header collections as secret-bearing wholesale.
 */
const SECRET_KEY =
  /(token|secret|password|passwd|credential|api[-_]?key|authorization|auth|private[-_]?key|nsec|session[-_]?key|cookie|signature|access[-_]?key|service[-_]?key|client[-_]?key|signing[-_]?key|key$)/i;

/** Collections whose values are credentials often enough that per-key rules miss them. */
const SECRET_COLLECTION_KEY =
  /(?:^|[_-])(env|environment|headers|http_?headers|request_?headers|response_?headers|cookies|secrets|credentials)(?:$|[_-])/i;

/** Content §31.5 forbids storing at all, whatever the surrounding key is called. */
const BULK_KEY =
  /(?:^|[_-])(prompt|prompts|system_?prompt|transcript|chat_?transcript|chain_?of_?thought|reasoning|messages|conversation|raw_?output|full_?output)(?:$|[_-])/i;

const MAX_STRING = 2000;

/**
 * The audit log is a decision summary, not a generic payload store. New evidence fields
 * need a deliberate review here before they can cross the durable boundary; otherwise a
 * new API response shape could quietly become a secret-bearing collection.
 */
const AUDIT_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "ackGeneration", "action", "activationGrantDigest", "activeManifestDigest", "activeRuns",
  "activeSession", "address", "allowed", "approved", "at", "attempt", "attemptedStatus",
  "approvedBy", "availability", "backoffSeconds", "bindingRemoved", "blocking", "blocksCriticalPath", "branch",
  "candidateSnapshotDigest", "changes", "channel", "checkRunId", "checkoutPath", "chunked", "clean", "code",
  "claimId", "claimedClassification", "conclusion", "contractDigest", "conversation", "coveredFiles",
  "creator", "creatorIdentity", "currentGeneration", "currentSession", "decision", "deferred",
  "delivered", "dependencyCount", "detail", "digest", "doctorStatus", "effort", "error", "evidence",
  "escalation", "exactHead", "executionGeneration", "executionId", "executionMode", "executions",
  "expected", "expectedBase", "expectedGeneration", "expectedInputs", "expectedSession", "expiresAt",
  "consecutiveFailures", "failed", "failureClass", "failures", "findings", "firstAt", "firstSeen",
  "fixCommitSha", "found", "from",
  "fromGeneration", "fromSession", "gaps", "generation", "goal", "gotGeneration", "grantId",
  "handoffId", "head", "humanGate", "humanGateDigest", "idempotencyKey", "idempotent", "identity",
  "incomingSessionId", "incomplete", "item", "kind", "knownDigests", "mergeCommitSha", "messageId",
  "method", "missing", "mode", "model", "name", "nested", "nonce", "notification",
  "observedCheckRunId", "observedDigest", "observedHead", "observedInputs", "omittedItems", "operation",
  "operationId", "options", "outcome", "overdue", "ownerApproved", "ownerBindingGeneration", "paths",
  "payloadDigest", "payloadHead", "phase", "pid", "pinnedManifestDigest", "preconditions", "present",
  "precondition", "previousCandidateSnapshotDigest", "primaryCtoGeneration", "priority", "probeError",
  "promotedFromBootstrap", "provider",
  "pullNumber", "purpose", "question", "rationale", "reason", "recommendation", "reconcile",
  "recordedCheckRunId", "recoveredAfterFailures", "rejected", "released", "repositories",
  "repositoryIdentity", "resolution", "resolvedPath", "restored", "resultDigest", "results", "retargeted",
  "retryNotBefore", "risk", "role", "runsRepointed", "runtimeHealth", "scope", "sensorHealth", "severity",
  "source", "satisfied", "lastError",
  "startedAt", "status", "statuses", "takeover", "target", "targetBranch", "targetPath", "targetWorktreeId",
  "taskCount", "taskId", "taskReceiptId", "assignedWorktreeId", "claimedPath", "overlap", "candidates", "liveWorktreeIds", "liveWorktreeIdsByRepository", "worktreePath", "threshold", "timer", "to", "toGeneration", "toSessionId", "trigger",
  "triggeredScopes", "uncovered", "verdict", "viaRunKind", "worktreeId", "ok",
  // #1271 — an upstream dogfood finding's public text, built from scrubbed fields before it is recorded
  // (quality/upstream-dogfood.ts); `expected` and `evidence` are above.
  "actual", "impact", "problem", "reproduction", "workaround",
]);

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Unknown fields are rejected before redaction so only explicitly reviewed shapes persist. */
const isAllowlistedAuditEvidence = (value: unknown, depth = 0, path: readonly string[] = [], site?: WriteSite): boolean => {
  if (depth > 8) return true; // redact() replaces deeper material with a fixed marker.
  if (value == null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.slice(0, 200).every((item) => isAllowlistedAuditEvidence(item, depth + 1, path, site));
  if (!value || typeof value !== "object" || !isPlainRecord(value)) return false;

  return Object.entries(value).every(([key, nested]) => {
    // These names are explicitly safe only because redact() replaces their values before
    // serialization. They stay outside the general allowlist on purpose.
    if (isSecretKey(key) || isSecretCollectionKey(key) || isBulkContentKey(key)) return true;
    if (AUDIT_EVIDENCE_KEYS.has(key)) return isAllowlistedAuditEvidence(nested, depth + 1, [...path, key], site);
    // A name-only allowlist made every new audit field a refusal — it rejected the real
    // CANDIDATE_FROZEN record and stopped a run from ever reaching review. What §31.5 is
    // actually protecting against is a *payload*: a prompt, a transcript, a credential. So an
    // unknown name is admitted for values that cannot be one — numbers, booleans, and short
    // identifier-shaped strings — and refused for free-form text, which is what a private
    // payload looks like.
    return isIdentifierLikeAuditValue(nested, depth, [...path, key], site, value);
  });
};

/** The value shapes an unknown audit field may carry; see `isAllowlistedAuditEvidence`. */
const MAX_UNKNOWN_AUDIT_STRING = 200;

const isIdentifierLikeAuditValue = (
  value: unknown, depth: number, path: readonly string[], site?: WriteSite, holder?: unknown,
): boolean => {
  if (value == null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  if (typeof value === "string") {
    if (value.length > MAX_UNKNOWN_AUDIT_STRING) return false;
    return !hasCredentialShape(value, { path, store: "audit", ...(site ? { site } : {}), holder });
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).every((item) => isIdentifierLikeAuditValue(item, depth + 1, path, site, holder));
  }
  if (isPlainRecord(value)) return isAllowlistedAuditEvidence(value, depth + 1, path, site);
  return false;
};

// Credential shapes come from the one shared list (core/credential-shapes.ts); the field's path lets a
// value ACP generates (an exact digest or id, a staged body, a listed audit token) skip the
// long-base64 shape, and only it.
const scrubValue = (text: string, path: readonly string[], site?: WriteSite, holder?: unknown): string => {
  const out = redactCredentialShapes(text, { path, store: "audit", ...(site ? { site } : {}), holder });
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
};

/** `site` is where the evidence is being written; `holder` is the object `value` sits in. */
export const redact = (value: unknown, depth = 0, path: readonly string[] = [], site?: WriteSite, holder?: unknown): unknown => {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return scrubValue(value, path, site, holder);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1, path, site, holder));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) out[k] = "[redacted]";
      else if (isSecretCollectionKey(k)) out[k] = "[redacted-collection]";
      else if (isBulkContentKey(k)) out[k] = "[not-stored]";
      else out[k] = redact(v, depth + 1, [...path, k], site, value);
    }
    return out;
  }
  return value;
};

/** Field-name checks share one normal form so `requestHeaders` cannot evade `headers`. */
const normalizedKey = (key: string): string => key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

const isSecretKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return SECRET_KEY.test(key) || /(token|secret|password|credential|authorization|apikey|accesskey|servicekey|clientkey|signingkey|privatekey|sessionkey|cookie|signature|key)$/.test(normalized);
};

const isSecretCollectionKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return SECRET_COLLECTION_KEY.test(key) || /(env|environment|headers|cookies|secrets|credentials)$/.test(normalized);
};

const isBulkContentKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return BULK_KEY.test(key) || /(?:prompt|transcript|chainofthought|reasoning|messages|conversation|rawoutput|fulloutput)$/.test(normalized);
};

/**
 * Names that are a credential in any context. Deliberately narrower than `SECRET_KEY`,
 * which also matches every `*Key` suffix — `roleKey` and `idempotencyKey` are identifiers
 * a report has to be able to state.
 */
const CREDENTIAL_NAME =
  /(^|_)(token|secret|password|passwd|credential|credentials|apikey|authorization|privatekey|accesskey|signingkey|servicekey|sessionsecret|cookie|nsec)$|(token|secret|password|credential|apikey|privatekey|accesskey)$/i;

/**
 * Identifiers evidence has to be able to state, which the suffix rule above would otherwise
 * read as credentials. Narrow and explicit: adding a name here is a decision to store it, so
 * the list is short and each entry is an identifier by construction, never a secret.
 */
const NOT_A_CREDENTIAL: ReadonlySet<string> = new Set([
  "rolekey", "idempotencykey", "sortkey", "cachekey", "operationkey", "claimkey",
]);

/**
 * Depth beyond which content is refused rather than examined, by every durable-content scan
 * (`credentialBearingField`, `prohibitedDurableField`, and export/run-evidence.ts's): one bound,
 * so no scan stops where another still reads, and none treats what it did not read as clean.
 */
export const MAX_CREDENTIAL_SCAN_DEPTH = 24;

/** What a scan names for content it did not examine: a subtree deeper than `MAX_CREDENTIAL_SCAN_DEPTH`. */
export const UNEXAMINABLE_DEPTH = "<unexaminable-depth>";

/** What `credentialBearingField` names for a key that holds a credential shape, in place of the key. */
const CREDENTIAL_SHAPED_KEY = "<credential-shaped-key>";

/**
 * A credential inside content that is about to become *evidence*.
 *
 * Evidence cannot be rewritten on its way to storage: its digest is what a later gate
 * corroborates, and CP-HI-06 makes the stored bytes the authority. An artifact that would
 * need redaction is therefore refused rather than altered — the producer must not put a
 * credential in evidence at all. Audit records keep using `redact`, where rewriting is the
 * right answer because nothing corroborates an audit row against a produced copy.
 */
/**
 * #1307 — what `credentialBearingField` refuses, with the rule that matched and the class of the match
 * (`CredentialShapeMatch`) so a refusal can say why without the text: `credential_named_key` for a key
 * whose name is a credential's, `unexaminable_depth` for content deeper than the scan goes.
 */
export interface CredentialRefusal extends CredentialShapeMatch {
  readonly field: string;
}

const NAMED_KEY = { rule: "credential_named_key", form: "other", inPacket: false } as const;
const TOO_DEEP = { rule: "unexaminable_depth", form: "other", inPacket: false } as const;

/** `site` is where the content is being stored (`WriteSite`); `holder` is the object `value` sits in. */
export const credentialRefusal = (
  value: unknown, depth = 0, path: readonly string[] = [], site?: WriteSite, holder?: unknown,
): CredentialRefusal | null => {
  // Deeper than the scan goes is not "clean": an unexamined subtree must not become evidence.
  if (depth > MAX_CREDENTIAL_SCAN_DEPTH) return { field: UNEXAMINABLE_DEPTH, ...TOO_DEEP };
  if (typeof value === "string") {
    const match = credentialShapeMatch(value, { path, store: "artifact", ...(site ? { site } : {}), holder });
    return match === null ? null : { field: "<value>", ...match };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = credentialRefusal(item, depth + 1, path, site, holder);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      // #1279 G4-1 — a key is stored text as much as a value is: read by the rules a value at its path
      // gets, and named by a marker, never by itself, so the refusal does not repeat the credential.
      const keyMatch = credentialShapeMatch(key, { path: [...path, key], store: "artifact", ...(site ? { site } : {}), holder: value });
      if (keyMatch !== null) return { field: CREDENTIAL_SHAPED_KEY, ...keyMatch };
      const normalized = normalizedKey(key);
      if (
        !NOT_A_CREDENTIAL.has(normalized) &&
        CREDENTIAL_NAME.test(normalized) &&
        nested != null &&
        nested !== ""
      ) {
        return { field: key, ...NAMED_KEY };
      }
      const found = credentialRefusal(nested, depth + 1, [...path, key], site, value);
      if (found) return found.field === "<value>" ? { ...found, field: key } : found;
    }
  }
  return null;
};

/** The field `credentialRefusal` names, or null: a key, `<value>`, or a marker that stands in for one. */
export const credentialBearingField = (
  value: unknown, depth = 0, path: readonly string[] = [], site?: WriteSite, holder?: unknown,
): string | null => credentialRefusal(value, depth, path, site, holder)?.field ?? null;

/**
 * Full prompts, transcripts, and reasoning must be rejected at any durable boundary;
 * replacing them with a marker is suitable for audit explainability, not an artifact
 * whose digest would otherwise purport to address the original private payload.
 */
export const prohibitedDurableField = (value: unknown, depth = 0): string | null => {
  if (!value || typeof value !== "object") return null;
  // #1279 G4-2 — an object deeper than the scan goes is not "clean": it may hold a transcript.
  if (depth > MAX_CREDENTIAL_SCAN_DEPTH) return UNEXAMINABLE_DEPTH;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = prohibitedDurableField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isBulkContentKey(key)) return key;
    const found = prohibitedDurableField(nested, depth + 1);
    if (found) return found;
  }
  return null;
};
