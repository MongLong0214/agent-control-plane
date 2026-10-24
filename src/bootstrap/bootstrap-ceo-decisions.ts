import { z } from "zod";

import { digestOf } from "../core/digest.ts";
import type { Db } from "../db/database.ts";
import { screenPublicText } from "./genesis-bundle.ts";

/** A safe projection of ACP's admitted escalation reply, never an author-supplied authority claim. */
export const authenticatedCeoDecisionSchema = z.object({
  runId: z.string(),
  escalationId: z.number().int().positive().nullable(),
  resolution: z.string(),
  resolutionDigest: z.string(),
  source: z.object({
    kind: z.literal("ACP_CEO_ESCALATION_REPLY"),
    decisionEventId: z.number().int().positive(),
    messageId: z.string(),
    sessionId: z.string(),
    actorId: z.string(),
    assignmentId: z.string(),
    bindingGeneration: z.number().int().positive(),
    bindingEventId: z.number().int().positive(),
  }).strict(),
  digest: z.string(),
}).strict();
export type AuthenticatedCeoDecision = z.infer<typeof authenticatedCeoDecisionSchema>;

/**
 * Read the CEO identity at each decision from ACP's binding history (event order, not wall time),
 * and join the decision's digest to its run's actual escalation and immutable reply payload. The
 * safe projection is frozen into PLAN on submission; review and activation never re-collect it.
 */
export function collectBootstrapCeoDecisions(db: Db, runId: string): AuthenticatedCeoDecision[] {
  const decisions = db.all<{event_id:number;session_id:string|null;evidence_json:string}>(
    `SELECT event_id, session_id, evidence_json FROM audit_events
     WHERE run_id = ? AND kind = 'CEO_DECISION' AND reason_code IS NULL
       AND json_extract(evidence_json, '$.escalation') = 1 ORDER BY event_id`, [runId]);
  const records: AuthenticatedCeoDecision[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const evidence = JSON.parse(decision.evidence_json) as Record<string,unknown>;
    const escalationId = evidence["escalationId"];
    const messageId = evidence["messageId"];
    if ((typeof escalationId !== "number" && escalationId !== null) || typeof messageId !== "string" || !decision.session_id) continue;
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
    const reply = db.get<{payload_json:string;payload_digest:string}>(
      `SELECT payload_json, payload_digest FROM outbox WHERE message_id = ? AND run_id = ? AND kind = 'ESCALATION_REPLY'`, [messageId,runId]);
    if (!reply) continue;
    const payload = JSON.parse(reply.payload_json) as {runId?:unknown;escalationId?:unknown;resolution?:unknown};
    if (digestOf(payload) !== reply.payload_digest || payload.runId !== runId || (payload.escalationId ?? null) !== escalationId || typeof payload.resolution !== "string" ||
        digestOf(payload.resolution) !== evidence["resolutionDigest"] || payload.resolution.length !== evidence["resolutionLength"]) continue;
    let resolution = payload.resolution;
    try { screenPublicText(resolution); } catch { resolution = "[withheld: credential-shaped content]"; }
    const record = {runId,escalationId,resolution,resolutionDigest:digestOf(payload.resolution),source:{kind:"ACP_CEO_ESCALATION_REPLY" as const,
      decisionEventId:decision.event_id,messageId,sessionId:decision.session_id,actorId:assignment.actor_id,assignmentId:assignment.assignment_id,
      bindingGeneration:generation,bindingEventId:binding.event_id}};
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
