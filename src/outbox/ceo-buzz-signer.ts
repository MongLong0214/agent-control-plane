import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import type { Db } from "../db/database.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { sha256 } from "../core/digest.ts";

/** Decode only the daemon credential formats supported by Buzz; never change the sending bytes. */
export const daemonBuzzSigner = (credential: string | undefined): string | null => {
  if (!credential) return null;
  try {
    const text = credential.trim();
    if (/^[a-f0-9]{64}$/i.test(text)) return getPublicKey(Buffer.from(text, "hex"));
    const decoded = decode(text);
    return decoded.type === "nsec" ? getPublicKey(decoded.data) : null;
  } catch { return null; }
};

/** Fixed failure categories emitted by the shared wrapper evaluator, never inferred from text. */
export type BuzzPolicyCause = "POLICY" | "ROSTER_STATE" | "CREDENTIAL" | "AUTHORITY" | "UNKNOWN";

/**
 * Public file identities only; never credentials, notification bodies or policy contents. A policy
 * file is named by `policyPathDigest` of its path, never by the path: the identity says whether the
 * configured and the evaluated file are one file, and a path is free text the audit would read whole.
 */
export interface BuzzPolicyIdentity {
  configured: { pathDigest: string | null; digest: string | null };
  reported: { pathDigest: string | null; digest: string | null };
}

/** The identifier a policy file path is recorded as: `sha256:` and the digest of the path string. */
export const policyPathDigest = (path: string): string => sha256(path);

/** Authority consulted by a blocked attempt; contains no copy of its rules. */
export interface BuzzPolicyBinding {
  routeDigest: string;
  signer: string | null;
  policyDigest: string | null;
  policyIdentity?: BuzzPolicyIdentity;
  policyCause?: BuzzPolicyCause;
}

/** A non-sending verdict from the wrapper's own evaluator, never inferred from a digest. */
export interface BuzzPolicyReadiness {
  verdict: "allowed" | "refused" | "undeterminable";
  policyDigest: string | null;
  signer: string | null;
  recipient: string | null;
  message?: string;
  cause?: BuzzPolicyCause;
  policyIdentity?: BuzzPolicyIdentity;
}

/** Only the evaluator's explicit roster-state cause may revalidate under unchanged policy.
 * An absent cause on an undecoded transport result means binding verification never completed;
 * decoded missing/unknown causes are normalized to UNKNOWN and keep the policy hold.
 */
export const buzzPolicyHoldReason = (check: Pick<BuzzPolicyReadiness, "verdict" | "cause">) => {
  if (check.cause === "ROSTER_STATE") return ReasonCode.BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED;
  if (check.verdict === "undeterminable" && check.cause === undefined) return ReasonCode.BUZZ_SEND_POLICY_BINDING_UNVERIFIED;
  return ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED;
};

/** Only this structured refusal proves this attempt was blocked by local send policy. */
export const isBuzzSignerRefusal = (message: string): boolean => {
  const prefix = "buzz send failed: ";
  if (!message.startsWith(prefix)) return false;
  try {
    const body = JSON.parse(message.slice(prefix.length));
    return body?.error === "mention_policy" && body?.message === "signer not registered for channel";
  } catch { return false; }
};

/** Only this explicit recipient refusal is limited to the receiving destination. */
export const isBuzzRecipientRefusal = (message: string): boolean => {
  const prefix = "buzz send failed: ";
  if (!message.startsWith(prefix)) return false;
  try {
    const body = JSON.parse(message.slice(prefix.length));
    return body?.error === "mention_policy" && body?.message === "recipient not registered for channel";
  } catch { return false; }
};

/** Counts never clear unknowns: every counted attempt must have pre-post evidence. The single
 * pre-fix Buzz attempt can be recovered from its exact last_error, because attempts never reset
 * and every possibly posted Buzz destination persists. No inference covers a second missing result.
 */
export const ceoBuzzHistoryIsPrePost = (db: Db, row: {
  message_id: string; attempts: number; last_error?: string | null; failure_class?: string | null;
  sent_at?: string | null;
}): boolean => {
  if (row.sent_at || db.get("SELECT 1 FROM outbox_sent_destinations WHERE message_id = ?", [row.message_id])) return false;
  const history = db.all<{ kind: string; evidence_json: string }>(`SELECT kind, evidence_json FROM audit_events
    WHERE kind IN ('CEO_NOTIFICATION_CANONICAL_ATTEMPT','CEO_NOTIFICATION_CANONICAL_RESULT',
      'CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN','CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY','CEO_NOTIFICATION_BUZZ_REFUSED')
      AND json_extract(evidence_json, '$.messageId') = ? ORDER BY rowid`, [row.message_id]);
  if (history.some(e => e.kind === "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")) return false;
  const attempts = history.filter(e => e.kind === "CEO_NOTIFICATION_CANONICAL_ATTEMPT").map(e => JSON.parse(e.evidence_json));
  const results = history.filter(e => e.kind === "CEO_NOTIFICATION_CANONICAL_RESULT").map(e => JSON.parse(e.evidence_json));
  if (results.length !== attempts.length || new Set(attempts.map(a => a.attemptId)).size !== attempts.length) return false;
  if (attempts.some(a => a.legacyUnknown || results.filter(r => r.attemptId === a.attemptId).length !== 1 ||
    !results.some(r => r.attemptId === a.attemptId && (r.outcome === "REFUSED" || r.outcome === "NOT_SENT")))) return false;
  const pauses = history.filter(e => e.kind === "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY").map(e => JSON.parse(e.evidence_json));
  if (pauses.some(p => !Number.isSafeInteger(p.attemptNumber) || p.attemptNumber < 1 || p.attemptNumber > row.attempts ||
    !(p.source === "READBACK" || (p.code === "mention_policy" && p.message === "signer not registered for channel")))) return false;
  const refusals = history.filter(e => e.kind === "CEO_NOTIFICATION_BUZZ_REFUSED").map(e => JSON.parse(e.evidence_json));
  if (refusals.some(r => r.scope !== "DESTINATION" || !isBuzzRecipientRefusal(r.error) ||
    !Number.isSafeInteger(r.attemptNumber) || r.attemptNumber < 1 || r.attemptNumber > row.attempts)) return false;
  const accounted = attempts.length + new Set([...pauses, ...refusals].map(p => p.attemptNumber)).size;
  return row.attempts === accounted || (row.failure_class === "contract" && row.attempts === accounted + 1 &&
    isBuzzSignerRefusal(row.last_error ?? ""));
};

/** Read-only authority for the one systemic membership target. No notification/caller room input. */
export interface CanonicalCeoBuzzRoute {
  assignmentId: string; bindingGeneration: number; actorId: string; sessionId: string;
  incarnation: string; targetBindingId: string; roomId: string; recipient: string;
}
export const currentCanonicalCeoBuzzRoute = (db: Pick<Db, "all">): CanonicalCeoBuzzRoute | null => {
  const rows = db.all<CanonicalCeoBuzzRoute>(`SELECT DISTINCT a.assignment_id AS assignmentId,
    a.binding_generation AS bindingGeneration, c.actor_id AS actorId, c.current_session_id AS sessionId,
    c.current_session_incarnation AS incarnation, b.target_binding_id AS targetBindingId,
    s.buzz_address AS roomId, s.buzz_actor_id AS recipient
    FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
    JOIN sessions s ON s.session_id = c.current_session_id AND s.incarnation = c.current_session_incarnation
    JOIN actor_target_bindings b ON b.target_actor_id = c.actor_id AND b.executor_kind = 'hermes'
    JOIN actor_target_attestations t ON t.target_binding_id = b.target_binding_id
      AND t.assignment_id = a.assignment_id AND t.binding_generation = a.binding_generation
      AND t.executor_session_id = c.current_session_id AND t.executor_session_incarnation = c.current_session_incarnation
    WHERE a.role_key = 'CEO' AND a.role = 'CEO' AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')
      AND t.target_bind_receipt_json IS NOT NULL AND t.target_bind_executor_runtime_identity IS NOT NULL
      AND COALESCE(s.buzz_address, '') <> '' AND COALESCE(s.buzz_actor_id, '') <> ''`);
  return rows.length === 1 ? rows[0]! : null;
};
