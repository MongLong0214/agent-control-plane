import type { Clock } from "../core/clock.ts";
import { sha256 } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import type { HermesAdmittedTurn } from "../mcp/hermes-provenance.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import { MessageKind } from "./envelope.ts";

type Source = { db: Db; clock: Clock; audit: AuditLog; bindings: BindingRegistry };
export interface CeoNotificationAckInput { idempotencyKey: string; messageId: string }
interface Notification {
  message_id: string;
  kind: string;
  role_key: string;
  target_session_id: string;
  binding_generation: number;
  run_id: string | null;
  status: string;
  expires_at: string;
  acked_at: string | null;
}
type AckResult = { messageId: string };

/** Rechecked before MCP replay and inside the ACK transaction; the caller supplies no binding. */
export const ceoNotificationAckAccess = (
  source: Source, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, messageId: string,
): Decision<{ row: Notification; ceo: RoleBinding; turn: HermesAdmittedTurn }> => {
  const ceo = source.bindings.active(roleKeyFor(Role.CEO));
  if (!peer.sessionId || !peer.sessionIncarnation || !ceo || ceo.sessionId !== peer.sessionId
      || ceo.sessionIncarnation !== peer.sessionIncarnation || (turn?.principal !== "owner" && turn?.principal !== "peer")) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "notification ACK requires the current CEO's authenticated Hermes owner or peer turn");
  }
  const row = source.db.get<Notification>("SELECT * FROM outbox WHERE message_id = ?", [messageId]);
  if (!row) return deny(ReasonCode.NOT_FOUND, "unknown notification", { messageId });
  if (row.kind !== MessageKind.CEO_NOTIFICATION) return deny(ReasonCode.INVALID_ARGUMENT, "only CEO_NOTIFICATION can be acknowledged here");
  if (row.role_key !== ceo.roleKey || row.target_session_id !== ceo.sessionId || row.binding_generation !== ceo.bindingGeneration) {
    return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "notification is not addressed to the current CEO binding");
  }
  if (row.status === "ACKED") {
    // An ACKED row alone is not proof that this holder made this receipt decision.
    const receipt = row.acked_at && source.db.get(`SELECT 1 FROM audit_events
      WHERE kind = 'CEO_NOTIFICATION_ACKED' AND session_id = ? AND role_key = ? AND run_id IS ?
        AND json_extract(evidence_json, '$.messageId') = ?
        AND json_extract(evidence_json, '$.sessionId') = ?
        AND json_extract(evidence_json, '$.bindingGeneration') = ?
        AND json_extract(evidence_json, '$.ackedAt') = ?`,
    [ceo.sessionId, ceo.roleKey, row.run_id, messageId, ceo.sessionId, ceo.bindingGeneration, row.acked_at]);
    if (!receipt) return deny(ReasonCode.CONFLICT, "notification has no matching CEO acknowledgement receipt");
  } else {
    if (row.status === "EXPIRED" || row.expires_at <= source.clock.nowIso()) {
      return deny(ReasonCode.OUTBOX_EXPIRED, "notification has expired");
    }
    if (row.status === "REJECTED") return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "notification was rejected");
    if (row.status !== "SENT") return deny(ReasonCode.INVALID_ARGUMENT, "notification must be SENT before acknowledgement");
  }
  return allow(ReasonCode.OK, { row, ceo, turn });
};

/** Recover a lost MCP response only from this holder's committed domain receipt. */
export const replayCeoNotificationAck = (
  source: Source, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: CeoNotificationAckInput,
  mcpFingerprint: string, reservationVerified = false,
): Decision<AckResult> | null => {
  const access = ceoNotificationAckAccess(source, peer, turn, input.messageId);
  if (!access.allowed) return access;
  const receipt = source.db.get<{ messageId: string; fingerprint: string }>(`SELECT
      json_extract(evidence_json, '$.messageId') AS messageId,
      json_extract(evidence_json, '$.mcpFingerprint') AS fingerprint FROM audit_events
    WHERE kind = 'CEO_NOTIFICATION_ACKED' AND session_id = ?
      AND json_extract(evidence_json, '$.idempotencyKeyDigest') = ?`, [peer.sessionId, sha256(input.idempotencyKey)]);
  // A fresh repeat key must go through MCP reservation, even when the row is already ACKED.
  if (!receipt) {
    // A repeat key has no ACK audit of its own. Its verified MCP reservation binds the
    // request/principal; access above proves this exact holder's existing ACK receipt.
    return reservationVerified && access.value.row.status === "ACKED"
      ? allow(ReasonCode.OK, { messageId: input.messageId }) : null;
  }
  return receipt.messageId === input.messageId && receipt.fingerprint === mcpFingerprint && access.value.row.status === "ACKED"
    ? allow(ReasonCode.OK, { messageId: input.messageId })
    : deny(ReasonCode.CONFLICT, "notification ACK key belongs to another request or principal");
};

/** Receipt only: no owner decision, escalation resolution or execution authority is changed. */
export const acknowledgeCeoNotification = (
  source: Source, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: CeoNotificationAckInput,
  mcpFingerprint: string,
): Decision<AckResult> => source.db.txDecision(() => {
  const access = ceoNotificationAckAccess(source, peer, turn, input.messageId);
  if (!access.allowed) return access;
  const replay = replayCeoNotificationAck(source, peer, turn, input, mcpFingerprint);
  if (replay) return replay;
  const { row, ceo, turn: admitted } = access.value;
  if (row.status === "ACKED") return allow(ReasonCode.OK, { messageId: input.messageId });
  const ackedAt = source.clock.nowIso();
  const changed = source.db.run(`UPDATE outbox SET status = 'ACKED', acked_at = ?
    WHERE message_id = ? AND kind = 'CEO_NOTIFICATION' AND role_key = ?
      AND target_session_id = ? AND binding_generation = ? AND status = 'SENT' AND expires_at > ?`,
  [ackedAt, input.messageId, ceo.roleKey, ceo.sessionId, ceo.bindingGeneration, ackedAt]);
  if (changed.changes !== 1) return deny(ReasonCode.CONFLICT, "notification changed before acknowledgement");
  const audit = source.audit.record({ kind: "CEO_NOTIFICATION_ACKED", runId: row.run_id,
    sessionId: ceo.sessionId, roleKey: ceo.roleKey, evidence: { messageId: input.messageId, sessionId: ceo.sessionId,
      bindingGeneration: ceo.bindingGeneration, ackedAt, idempotencyKeyDigest: sha256(input.idempotencyKey), mcpFingerprint,
      hermesPrincipal: admitted.principal, hermesPeerGrant: admitted.peerGrant } });
  if (!audit.allowed) return audit;
  return allow(ReasonCode.OK, { messageId: input.messageId });
});
