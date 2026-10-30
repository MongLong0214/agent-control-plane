import { z } from "zod";

import { hasCredentialShape, REDACTED, redactCredentialShapes, type EvidenceField } from "../core/credential-shapes.ts";
import { digestOf } from "../core/digest.ts";
import type { Db } from "../db/database.ts";
import { screenPublicText } from "./genesis-bundle.ts";

const decisionSourceSchema = z.object({
  decisionEventId: z.number().int().positive(),
  messageId: z.string(),
  sessionId: z.string(),
  actorId: z.string(),
  assignmentId: z.string(),
  bindingGeneration: z.number().int().positive(),
  bindingEventId: z.number().int().positive(),
});

/**
 * Present only when `resolution` is not the CEO's text: which part ACP withheld and by which rule.
 * `resolutionDigest` and `source` still name the original.
 */
const withheldSchema = z.object({
  mode: z.enum(["REDACTED_SPANS", "WITHHELD_WHOLE"]),
  rule: z.enum(["ARTIFACT_CREDENTIAL_SHAPES", "PUBLIC_TEXT_SCREEN"]),
  statement: z.string(),
}).strict();
type Withheld = z.infer<typeof withheldSchema>;

/** A safe projection of ACP's admitted CEO decision, never an author-supplied authority claim. */
export const authenticatedCeoDecisionSchema = z.object({
  runId: z.string(),
  escalationId: z.number().int().positive().nullable(),
  resolution: z.string(),
  resolutionDigest: z.string(),
  withheld: withheldSchema.optional(),
  source: z.discriminatedUnion("kind", [
    decisionSourceSchema.extend({ kind: z.literal("ACP_CEO_ESCALATION_REPLY") }).strict(),
    decisionSourceSchema.extend({
      kind: z.literal("ACP_CEO_REVIEW_ENTRY_RELEASE"),
      payloadDigest: z.string(),
      contractDigest: z.string(),
      bootstrapPlanDigest: z.string(),
      attachmentDigest: z.string(),
    }).strict(),
  ]),
  digest: z.string(),
}).strict();
export type AuthenticatedCeoDecision = z.infer<typeof authenticatedCeoDecisionSchema>;

/** Where PLAN holds the text, as the artifact store checks it (db/audit.ts credentialBearingField). */
const STORED_AT: EvidenceField = { path: ["authenticatedCeoDecisions", "resolution"], store: "artifact" };
const WITHHELD_WHOLE_TEXT = "[withheld: credential-shaped content]";
const WITHHELD_SPAN = "[withheld: credential-shaped token]";
const ORIGINAL = "The original is the text of the CEO decision at source.decisionEventId; resolutionDigest is its digest.";
const STATEMENTS: Readonly<Record<Withheld["mode"], string>> = {
  REDACTED_SPANS: `resolution is a display copy ACP modified, not the CEO's original text: each ${WITHHELD_SPAN} replaced a span the artifact store refuses as credential-shaped. ${ORIGINAL} A marker stands only for removed text, never for an instruction or an approval.`,
  WITHHELD_WHOLE: `resolution is not the CEO's text: ACP withheld all of it as credential-shaped. ${ORIGINAL} This record states no instruction and no approval; no authority rests on its digest alone.`,
};

const publishable = (text: string): boolean => {
  try { screenPublicText(text); return true; } catch { return false; }
};
const storable = (text: string): boolean => publishable(text) && !hasCredentialShape(text, STORED_AT);

/**
 * The CEO's text as PLAN can hold it, with the digest of the original. Every plan_submit re-collects
 * every admitted decision, so a text the artifact store refuses would refuse every PLAN of the run;
 * projecting at collection covers decisions admitted before this existed. Only the spans the store's own rule (core/credential-shapes.ts)
 * flags are replaced, and the result is checked again by that rule. A text the publication screen
 * refuses, one that already holds the store's marker (its spans cannot be told apart), or one with
 * nothing left or still flagged after the spans are replaced, is withheld whole.
 */
const projectResolution = (text: string): { resolution: string; resolutionDigest: string; withheld?: Withheld } => {
  const resolutionDigest = digestOf(text);
  if (storable(text)) return { resolution: text, resolutionDigest };
  const withheld = (mode: Withheld["mode"], rule: Withheld["rule"], resolution: string) =>
    ({ resolution, resolutionDigest, withheld: { mode, rule, statement: STATEMENTS[mode] } });
  if (!publishable(text)) return withheld("WITHHELD_WHOLE", "PUBLIC_TEXT_SCREEN", WITHHELD_WHOLE_TEXT);
  const redacted = text.includes(REDACTED) ? REDACTED : redactCredentialShapes(text, STORED_AT);
  const copy = redacted.split(REDACTED).join(WITHHELD_SPAN);
  return redacted !== REDACTED && storable(copy)
    ? withheld("REDACTED_SPANS", "ARTIFACT_CREDENTIAL_SHAPES", copy)
    : withheld("WITHHELD_WHOLE", "ARTIFACT_CREDENTIAL_SHAPES", WITHHELD_WHOLE_TEXT);
};

/**
 * Read the CEO identity at each decision from ACP's binding history (event order, not wall time),
 * and join the decision to its run's escalation reply or digest-bound RESUME_REVIEW payload. The
 * safe projection is frozen into PLAN on submission; review and activation never re-collect it.
 */
export function collectBootstrapCeoDecisions(db: Db, runId: string): AuthenticatedCeoDecision[] {
  const decisions = db.all<{event_id:number;role_key:string|null;session_id:string|null;evidence_json:string}>(
    `SELECT event_id, role_key, session_id, evidence_json FROM audit_events
     WHERE run_id = ? AND kind = 'CEO_DECISION' AND reason_code IS NULL
       AND (json_extract(evidence_json, '$.escalation') = 1
         OR json_extract(evidence_json, '$.instruction') = 'RESUME_REVIEW') ORDER BY event_id`, [runId]);
  const records: AuthenticatedCeoDecision[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const evidence = JSON.parse(decision.evidence_json) as Record<string,unknown>;
    const messageId = evidence["messageId"];
    if (typeof messageId !== "string" || !decision.session_id) continue;
    const binding = db.get<{event_id:number;kind:string;session_id:string;evidence_json:string}>(
      `SELECT event_id, kind, session_id, evidence_json FROM audit_events WHERE role_key = 'CEO'
       AND kind IN ('BINDING_CREATED','BINDING_SWITCHED','BINDING_RENEWED','BINDING_RUNTIME_MOVED','BINDING_REVOKED')
       AND event_id < ? ORDER BY event_id DESC LIMIT 1`, [decision.event_id]);
    if (!binding || binding.kind === "BINDING_REVOKED" || binding.session_id !== decision.session_id) continue;
    const bound = JSON.parse(binding.evidence_json) as {generation?:number;toGeneration?:number};
    const generation = bound.toGeneration ?? bound.generation;
    const assignment = db.get<{assignment_id:string;actor_id:string}>(
      `SELECT assignment_id, actor_id FROM assignments WHERE role_key = 'CEO' AND binding_generation = ?`, [generation ?? -1]);
    if (!assignment || !generation) continue;
    const source = { decisionEventId: decision.event_id, messageId, sessionId: decision.session_id,
      actorId: assignment.actor_id, assignmentId: assignment.assignment_id,
      bindingGeneration: generation, bindingEventId: binding.event_id };
    if (evidence["instruction"] === "RESUME_REVIEW") {
      const key = `resume:${messageId}`;
      if (seen.has(key) || decision.role_key !== "CEO" || evidence["bindingGeneration"] !== generation) continue;
      const row = db.get<{payload_json:string;payload_digest:string}>(
        `SELECT payload_json, payload_digest FROM outbox WHERE message_id = ? AND run_id = ? AND kind = 'RESUME_REVIEW'`, [messageId,runId]);
      if (!row) continue;
      const payload = JSON.parse(row.payload_json) as Record<string,unknown>;
      if (digestOf(payload) !== row.payload_digest || payload["intent"] !== "RESUME_REVIEW" || payload["runId"] !== runId
          || typeof payload["directive"] !== "string" || typeof payload["contractDigest"] !== "string"
          || typeof payload["bootstrapPlanDigest"] !== "string" || typeof payload["attachmentDigest"] !== "string"
          || payload["contractDigest"] !== evidence["contractDigest"] || payload["bootstrapPlanDigest"] !== evidence["payloadDigest"]
          || payload["attachmentDigest"] !== evidence["digest"]) continue;
      const run = db.get<{contract_digest:string}>(`SELECT contract_digest FROM runs WHERE run_id = ?`, [runId]);
      if (run?.contract_digest !== payload["contractDigest"]) continue;
      const record = { runId, escalationId: null, ...projectResolution(payload["directive"]),
        source: { ...source, kind: "ACP_CEO_REVIEW_ENTRY_RELEASE" as const, payloadDigest: row.payload_digest,
          contractDigest: payload["contractDigest"], bootstrapPlanDigest: payload["bootstrapPlanDigest"], attachmentDigest: payload["attachmentDigest"] } };
      records.push({ ...record, digest: digestOf(record) });
      seen.add(key);
      continue;
    }
    const escalationId = evidence["escalationId"];
    if (typeof escalationId !== "number" && escalationId !== null) continue;
    // The retained compatibility API records no target id and omits it from the reply. Keep that
    // fact in the projection; prove run membership from the escalation history and reply instead.
    const key = escalationId === null ? `reply:${messageId}` : `escalation:${escalationId}`;
    if (seen.has(key)) continue;
    const opened = escalationId === null
      ? db.get<{event_id:number}>(`SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION'
          AND event_id < ? LIMIT 1`, [runId,decision.event_id])
      : db.get<{event_id:number}>(`SELECT event_id FROM audit_events WHERE event_id = ? AND run_id = ?
          AND kind = 'CTO_ESCALATION' AND event_id < ? AND json_extract(evidence_json, '$.blocksCriticalPath') = 1`, [escalationId,runId,decision.event_id]);
    if (!opened) continue;
    const reply = db.get<{payload_json:string;payload_digest:string}>(
      `SELECT payload_json, payload_digest FROM outbox WHERE message_id = ? AND run_id = ? AND kind = 'ESCALATION_REPLY'`, [messageId,runId]);
    if (!reply) continue;
    const payload = JSON.parse(reply.payload_json) as {runId?:unknown;escalationId?:unknown;resolution?:unknown};
    if (digestOf(payload) !== reply.payload_digest || payload.runId !== runId || (payload.escalationId ?? null) !== escalationId || typeof payload.resolution !== "string" ||
        digestOf(payload.resolution) !== evidence["resolutionDigest"] || payload.resolution.length !== evidence["resolutionLength"]) continue;
    const record = {runId,escalationId,...projectResolution(payload.resolution),source:{...source,kind:"ACP_CEO_ESCALATION_REPLY" as const}};
    records.push({...record,digest:digestOf(record)});
    seen.add(key);
  }
  return records;
}

/** Only the ACP-written PLAN field is consumed; submission always removes the producer's field. */
export function frozenBootstrapCeoDecisions(content: unknown): AuthenticatedCeoDecision[] {
  const field = (content as Record<string,unknown> | null)?.["authenticatedCeoDecisions"];
  if (field === undefined) return [];
  const records = z.array(authenticatedCeoDecisionSchema).parse(field);
  for (const {digest,...record} of records) {
    if (digestOf(record) !== digest) throw new Error("frozen CEO decision digest mismatch");
  }
  return records;
}
