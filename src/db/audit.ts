import type { Clock } from "../core/clock.ts";
import type { Evidence } from "../core/errors.ts";
import type { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "./database.ts";

export interface AuditRecord {
  kind: string;
  reasonCode?: ReasonCode | null;
  runId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  roleKey?: string | null;
  actor?: string | null;
  evidence?: Evidence;
}

/**
 * Append-only authority log. Deliberately not a hash chain and not the state SSOT
 * (PRD §30.4) — it records who decided what, with the evidence, so a denial can be
 * explained after the fact.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(entry: AuditRecord): void {
    this.db.run(
      `INSERT INTO audit_events (at, kind, reason_code, run_id, project_id, session_id, role_key, actor, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.clock.nowIso(),
        entry.kind,
        entry.reasonCode ?? null,
        entry.runId ?? null,
        entry.projectId ?? null,
        entry.sessionId ?? null,
        entry.roleKey ?? null,
        entry.actor ?? null,
        JSON.stringify(redact(entry.evidence ?? {})),
      ],
    );
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
  /(token|secret|password|passwd|credential|api[-_]?key|authorization|auth|private[-_]?key|nsec|session[-_]?key|cookie|signature)/i;

/** Collections whose values are credentials often enough that per-key rules miss them. */
const SECRET_COLLECTION_KEY = /^(env|environment|headers|http_?headers|secrets|credentials)$/i;

/** Content §31.5 forbids storing at all, whatever the surrounding key is called. */
const BULK_KEY =
  /^(prompt|prompts|system_?prompt|transcript|chat_?transcript|chain_?of_?thought|reasoning|messages|conversation|raw_?output|full_?output)$/i;

/** Credential shapes recognisable in a value regardless of its key. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bnsec1[a-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  // KEY=VALUE where the key looks secret, as it appears in an env dump.
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/,
];

const MAX_STRING = 2000;

const scrubValue = (text: string): string => {
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, `g${pattern.flags.replace("g", "")}`), "[redacted]");
  }
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
};

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return scrubValue(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = "[redacted]";
      else if (SECRET_COLLECTION_KEY.test(k)) out[k] = "[redacted-collection]";
      else if (BULK_KEY.test(k)) out[k] = "[not-stored]";
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
};
