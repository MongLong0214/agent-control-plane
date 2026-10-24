import { ceoBuzzHistoryIsPrePost, isBuzzSignerRefusal, type BuzzPolicyBinding } from "./ceo-buzz-signer.ts";
import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny, fail, isAcpError } from "../core/errors.ts";
import { randomUUID } from "node:crypto";

import { digestOf } from "../core/digest.ts";

import { newMessageId } from "../core/ids.ts";
import { CeoNoticeRoute, ceoBuzzGrantSql, recordCeoNoticeReceiptSupport, type CeoNoticeAttempt, type CeoNoticeOutcome } from "./ceo-notification-route.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { isTerminal } from "../domain/run-state.ts";
import { FailureClass as FailureClassCode, type FailureClass, type RunState } from "../domain/types.ts";
import { ownerMessagePointerOf } from "../ingress/buzz-message.ts";
import { IngressGuard } from "../ingress/ingress-guard.ts";
import {
  type PeerMessageCarryAuthority,
  type PeerMessageSuccession,
  adoptedCanonicalRuntimeSql,
  peerMessageCarrySuccessionOf,
} from "../registry/canonical-self-claim.ts";
import {
  type DrivenMode,
  type DrivenSpawnRecord,
  drivenModeOf,
  drivenModeSql,
  drivenSpawnRecordOf,
} from "../runtime/provisioned-session-runtime.ts";
import {
  type FencedEnvelope,
  HOLDER_CLAIMED_KINDS,
  IDENTITY_BOUND_KINDS,
  MessageKind,
  RETARGETABLE_KINDS,
  payloadDigestOf,
} from "./envelope.ts";

export interface EnqueueInput {
  idempotencyKey: string;
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  runId?: string | null;
  kind: MessageKind;
  payload: unknown;
  ttlMs?: number;
}

export interface OutboxMessage extends FencedEnvelope {
  kind: MessageKind;
  payload: unknown;
  status: "PENDING" | "IN_FLIGHT" | "SENT" | "ACKED" | "REJECTED" | "EXPIRED";
  idempotencyKey: string;
  /** Immutable identity of the original enqueue request, retained across retargeting. */
  requestFingerprint: string;
  attempts: number;
  /** Durable classification of the last failed delivery attempt (§34.1). */
  failureClass: FailureClass | null;
  /** Whether the recorded failure admits another attempt. */
  retryEligible: boolean;
  /** Earliest instant a deferred retry may be claimed; null when nothing is deferred. */
  nextAttemptAt: string | null;
  createdAt: string;
}

/** A readback, never a new durable state. unknown_observed suppresses automatic resend;
 * it proves neither delivery nor completion. Only an authenticated ACK confirms completion.
 * delivered=false alone also covers queued/refused rows; OUTCOME_UNKNOWN and automaticResendHeld
 * distinguish uncertainty. None of those unknown-state fields proves that nothing was posted. */
export const outboxDeliveryReadback = (message: Pick<OutboxMessage, "status" | "failureClass">) => {
  const held = (message.status === "SENT" || message.status === "PENDING") && message.failureClass === "unknown_observed";
  return {
    status: held ? "OUTCOME_UNKNOWN" as const : message.status,
    delivery: held ? "outcome unknown / delivery unconfirmed / automatic resend held" : message.status,
    automaticResendHeld: held,
    delivered: !held && (message.status === "SENT" || message.status === "ACKED"),
    completed: message.status === "ACKED",
  };
};

/**
 * Who is claiming — every field read from the authenticated connection, none from the row.
 *
 * `sessionIncarnation` is the field that makes this an identity rather than an address. The other
 * three are already on the outbox row, so a predicate built from them alone can be satisfied by
 * any runtime that happens to occupy the same binding; the incarnation is what a respawn changes.
 */
export interface HolderIdentity {
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  sessionIncarnation: string;
}

/**
 * A message handed over to a previous holder whose outcome was never recorded.
 *
 * **There is deliberately no `payload` field.** "Never the payload twice" is enforced by this type
 * having nowhere to put one, rather than by every call site remembering not to. A successor sees
 * that something was taken and not acknowledged, which is what it needs to reconcile, and learns
 * nothing about what it said.
 */
export interface UnresolvedOwnerMessage {
  messageId: string;
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  kind: MessageKind;
  payloadDigest: string;
  sentAt: string | null;
  attempts: number;
  createdAt: string;
}

export interface HolderClaimResult {
  /**
   * The row this call moved `PENDING -> SENT`, and the only thing here that carries a payload.
   *
   * At most one, and an array rather than a nullable single because the caller's shape should not
   * have to change if a future kind is drained differently.
   */
  claimed: OutboxMessage[];
  /** Rows already `SENT` and never acknowledged. Metadata only. */
  unresolved: UnresolvedOwnerMessage[];
  /**
   * `PENDING` rows this holder is addressed by and may not be handed, because the caller's
   * `admits` refused them or their stored payload is not readable (#1044). Metadata only, and
   * nothing was written for them: the holder may reject one, by id, through `rejectForHolder`,
   * which is the one write that retires it.
   */
  withheld: UnresolvedOwnerMessage[];
  /**
   * Whether a claimable message remains that this call did not hand over.
   *
   * This is how the holder drains a backlog: it wakes again rather than asking for a batch. It is
   * also true while `unresolved` is blocking the queue, which is the honest answer — there is work
   * waiting, and settling the unknown outcome is what releases it.
   */
  hasMore: boolean;
}

export interface DeliveryFailure {
  failureClass: FailureClass;
  retryable: boolean;
  error: string;
  /**
   * Set only by a refusal made before anything was sent because the target had no route (no Buzz
   * room, or no bound channel identity). The cause is recorded where it is known, never inferred from
   * the target's route after an attempt: a route that disappears while a send is in flight does not
   * turn the relay's refusal into a route-absent one.
   */
  routeAbsent?: true;
  /** Readiness was verified before this CEO Buzz attempt; delivery still needs its own receipt. */
  buzzSignerReady?: true;
  /** Only an explicit recipient refusal may be left behind for a genuinely different receiver. */
  ceoRefusal?: { scope: "DESTINATION" | "SENDER"; targetSessionId: string; bindingGeneration: number; attemptNumber: number };
  /** Exact daemon-signer membership evidence, distinct from a missing receiving route. */
  signerNotRegistered?: { signer: string | null; source: "SEND_REFUSAL" | "READBACK"; policyBinding?: BuzzPolicyBinding;
    reasonCode?: typeof ReasonCode.BUZZ_SIGNER_NOT_REGISTERED | typeof ReasonCode.BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED | typeof ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED };
  /**
   * FCR-08 — the exact room and recipient key the attempt addressed, set by a transport that sent.
   * Recorded only for an outcome that may have landed (`unknown_observed`), in `outbox_sent_destinations`.
   */
  destination?: SentDestination;
}

/** FCR-08 — where a Buzz send was addressed: its room and its recipient's channel identity key. */
export interface SentDestination {
  room: string;
  recipient: string;
}

/**
 * FCR-08, FCR-14 — what is known about a send of an outbox row to one exact destination:
 * PENDING_SEND while the transport call is in flight (written before it), then ACCEPTED (the relay
 * took it there) or UNKNOWN (its outcome is unknown: it may be there). An attempt the relay refused
 * outright removes its own PENDING_SEND. A PENDING_SEND older than `SEND_LEASE_MS` — a send that never
 * settled, such as one a crash interrupted — counts as UNKNOWN.
 */
type SentOutcome = "ACCEPTED" | "UNKNOWN" | "PENDING_SEND";

/** How long a claim, and an in-flight send under it, may stay unsettled before it is presumed dead. */
const SEND_LEASE_MS = 5 * 60 * 1000;

/**
 * FCR-08 — records what is known about a send of `messageId` to `destination`. Knowledge only grows:
 * an in-flight send settles to UNKNOWN or ACCEPTED, an unknown one may become ACCEPTED, and nothing
 * moves back.
 */
const recordSentDestination = (
  db: Pick<Db, "run">,
  messageId: string,
  destination: SentDestination,
  outcome: SentOutcome,
  at: string,
): void => {
  db.run(
    `INSERT INTO outbox_sent_destinations (message_id, room, recipient, outcome, sent_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (message_id, room, recipient) DO UPDATE SET outcome = excluded.outcome, sent_at = excluded.sent_at
        WHERE (excluded.outcome = 'ACCEPTED' AND outbox_sent_destinations.outcome <> 'ACCEPTED')
           OR (excluded.outcome = 'UNKNOWN' AND outbox_sent_destinations.outcome = 'PENDING_SEND')`,
    [messageId, destination.room, destination.recipient, outcome, at],
  );
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** The append-only record that an ESCALATION_REPLY followed a takeover, a renewal or an in-band handover; one per carry. */
const ESCALATION_REPLY_CARRIED = "ESCALATION_REPLY_CARRIED";
/** The append-only record that a revocation held an ESCALATION_REPLY for its owner's renewal. */
const ESCALATION_REPLY_HELD = "ESCALATION_REPLY_HELD";
/** The append-only record that a held ESCALATION_REPLY could no longer be carried and was rejected. */
const ESCALATION_REPLY_HOLD_REJECTED = "ESCALATION_REPLY_HOLD_REJECTED";

/**
 * The rows a revocation held for an owner's renewal that nothing has carried or settled: PENDING,
 * unclaimed, a hold record for their own generation, no carry record. Which of them stay held is
 * decided in TypeScript by `Outbox.#stillHeld`, against continuity's own recovery admission.
 */
const heldEscalationReplyCandidatesSql = (alias: string): string => `(
  ${alias}.kind = '${MessageKind.ESCALATION_REPLY}' AND ${alias}.status = 'PENDING' AND ${alias}.claim_token IS NULL
  AND EXISTS (SELECT 1 FROM audit_events held WHERE held.kind = '${ESCALATION_REPLY_HELD}'
               AND json_extract(held.evidence_json, '$.messageId') = ${alias}.message_id
               AND json_extract(held.evidence_json, '$.fromGeneration') = ${alias}.binding_generation)
  AND NOT EXISTS (SELECT 1 FROM audit_events carried WHERE carried.kind = '${ESCALATION_REPLY_CARRIED}'
               AND json_extract(carried.evidence_json, '$.messageId') = ${alias}.message_id))`;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const RETRYABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "transient",
  "capacity",
  "infrastructure",
]);
const KNOWN_FAILURE_CLASSES: ReadonlySet<string> = new Set(Object.values(FailureClassCode));

/**
 * The ordinary recipient must still hold the exact active binding. The only exception is
 * the §10.1 handoff package: its recipient is deliberately unbound until that recipient
 * presents the delivered envelope and the binding generation switches. Keep the exception
 * in the delivery predicates as well as enqueue admission; otherwise a valid package can
 * be persisted but can never be claimed or marked SENT.
 */
/**
 * The literal list the generic sweep excludes, built from `HOLDER_CLAIMED_KINDS`.
 *
 * Derived from the set rather than written out here, so the exclusion cannot drift away from the
 * set that defines it. Kind strings are module constants, never caller input, so inlining them is
 * not an injection surface — but the `'` guard is kept because a kind that ever did come from
 * outside would otherwise turn this into one silently.
 */
export const HOLDER_CLAIMED_KIND_SQL = [...HOLDER_CLAIMED_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/**
 * The holder-claimed row `alias` names has never left `PENDING` (review finding 01, schema v40).
 *
 * `PENDING` with no attempts, no `sent_at` and no `claim_token` does not mean never claimed: those
 * are ordinary columns any statement can put back, and a claimed, acknowledged or rejected row put
 * back that way reads exactly like one nobody was handed. `outbox_holder_message_departs` records
 * the first departure from `PENDING` of every row, whatever its kind and whoever writes it — the
 * kind is just as rewritable — and nothing removes a departure. So every path that hands a
 * holder-claimed row to someone — the holder's claim, a takeover's retarget, a runtime move, a
 * restart's carry — asserts this, in the statement that moves the row as well as in the read that
 * chose it. Product code never moves a holder-claimed row back to `PENDING`. Nothing else reads the
 * departures: the generic sweep, its retry and the lease reclaim move a generic row out of and back
 * into `PENDING` without consulting them.
 */
const neverDepartedSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM holder_message_departures departed WHERE departed.message_id = ${alias}.message_id)`;

/**
 * The daemon has the notice `alias` names (an OWED row of `peer_message_refusal_notices`) in hand:
 * its delivery is in doubt or settled, and not failed (acp-daemon-notice/v1, amendment 1). Such a
 * notice is the daemon's to tell; a holder is neither shown it nor allowed to report it.
 */
const daemonHoldsNoticeSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM peer_message_notice_deliveries held
     WHERE held.kind = 'NOTICE' AND held.entry = 'IN_DOUBT' AND held.message_id = ${alias}.message_id
       AND held.role_key = ${alias}.role_key AND held.reason = ${alias}.reason
       AND NOT EXISTS (SELECT 1 FROM peer_message_notice_deliveries ended
                        WHERE ended.event_id = held.event_id AND ended.entry = 'FAILED'))`;

/** Why an admitted event is spent, as `holder_message_source_departures` records it. */
export type SourceSpentReason = "MESSAGE_DEPARTED" | "TURN_TERMINAL";

/**
 * The admitted event the row `alias` points at was never spent for any of `reasons` (review finding
 * 01, round 2). A departure keyed by the message id does not see the same event queued again under a
 * new id — a claimed row deleted and its pointer re-inserted, or the pointer copied beside the
 * original — so every path that checks `neverDepartedSql` checks this too, keyed by the event itself.
 * The pointer is read as `outbox_holder_message_source_departs` reads it; a row with no Buzz pointer
 * names no event and is not held back by this. The reasons are module constants, never caller input.
 */
export const sourceNeverSpentSql = (alias: string, reasons: readonly SourceSpentReason[]): string =>
  `NOT EXISTS (SELECT 1 FROM holder_message_source_departures spent
    WHERE spent.source_channel = 'buzz'
      AND spent.reason IN (${reasons.map((reason) => `'${reason.replace(/'/g, "''")}'`).join(", ")})
      AND spent.source_nonce = (CASE WHEN json_valid(${alias}.payload_json) = 1
        THEN CASE WHEN json_extract(${alias}.payload_json, '$.sourceChannel') = 'buzz'
                  THEN json_extract(${alias}.payload_json, '$.sourceNonce') END END))`;

/**
 * SQLite reads the payload of the row `alias` names, and reads it one way (review finding 01, narrow
 * reviews 1 and 2): `json_valid` accepts it, and no object in it repeats a key at any depth. SQLite's
 * `json_extract` reads the first of two duplicate keys and `JSON.parse` the last, so a duplicated
 * `sourceNonce` let the predicate check one event while the consumer delivered another; without
 * duplicates the two read the same value. The same `json_tree` test the v38 claim guards use.
 *
 * A payload SQLite cannot parse is refused, not taken to name no event: `sourceNeverSpentSql` reads
 * no pointer from it, so it could refuse no spent one, while `JSON.parse` may still read one — JSON
 * nested deeper than SQLite's parser goes is valid to JavaScript and not to `json_valid`. `CASE`
 * keeps such a payload off `json_tree`, which raises on it rather than answering.
 */
const payloadUnambiguousSql = (alias: string): string =>
  `(CASE WHEN json_valid(${alias}.payload_json) = 1
     THEN NOT EXISTS (SELECT 1 FROM json_tree(${alias}.payload_json) WHERE typeof(key) = 'text'
                       GROUP BY parent, key HAVING COUNT(*) > 1)
     ELSE 0 END)`;

/** UnACKed IDs may replay; terminal IDs and another message's spent source may not. */
export const handOverEligibleSql = (alias: string): string =>
  `(${payloadUnambiguousSql(alias)}
    AND NOT EXISTS (SELECT 1 FROM holder_message_terminals terminal WHERE terminal.message_id = ${alias}.message_id)
    AND (${neverDepartedSql(alias)} OR (${alias}.status = 'SENT' AND EXISTS (
      SELECT 1 FROM holder_message_departures departed
       WHERE departed.message_id = ${alias}.message_id AND departed.to_status = 'SENT')))
    AND NOT EXISTS (SELECT 1 FROM holder_message_source_departures spent
      WHERE spent.source_channel = 'buzz'
        AND spent.source_nonce = (CASE WHEN json_valid(${alias}.payload_json) THEN json_extract(${alias}.payload_json, '$.sourceNonce') END)
        AND (spent.reason = 'TURN_TERMINAL' OR spent.message_id <> ${alias}.message_id)))`;


/**
 * The outward, role-level kinds an adopted canonical CTO receives in band rather than over Buzz.
 *
 * A canonical CTO is an interactive runtime no provider launched (`adoptedCanonicalRuntimeSql`). A
 * Buzz send to its room is signed with the daemon's outbound key, and the room's own sender admits
 * only the room's registered CEO and CTO — so the send is refused, non-retryably, and the row goes
 * REJECTED before the CTO can acknowledge it. These kinds are therefore withheld from
 * `claimDeliverable` when, and only when, the target is such a runtime: the row stays PENDING, the
 * role is woken, and the CTO reads it with `pendingInBandFor` and settles it with `acknowledge`,
 * both over its own authenticated connection.
 *
 * Every outward kind that can be addressed to a PRIMARY_CTO's bound session is here, so no message
 * to a canonical CTO depends on that send: `RUN_DISPATCH` (run engine, owner-decision resume),
 * `REVISION_REQUEST` (candidate pipeline, candidate invalidation), `ESCALATION_REPLY` (the CEO's
 * resolution), `DRAIN_REQUEST` (replacement) and `CANCEL_REQUEST`. All are settled by `run_ack`,
 * the only generic acknowledgement there is. A `HANDOFF_PACKAGE` is also in band when addressed
 * to its role's current holder (bootstrap); a switchover's unbound recipient keeps its Buzz route.
 * It is settled by `handoff_ack`. Left out: `CEO_NOTIFICATION`,
 * addressed to the CEO; and `TASK_ASSIGN`, `REVIEW_REQUEST` and `RECOVERY_PACKAGE`, which nothing
 * enqueues. Disjoint from `HOLDER_CLAIMED_KINDS`, which never reach the sweep at all.
 */
export const IN_BAND_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  MessageKind.RUN_DISPATCH,
  MessageKind.CANCEL_REQUEST,
  MessageKind.REVISION_REQUEST,
  MessageKind.ESCALATION_REPLY,
  MessageKind.DRAIN_REQUEST,
]);

/** The literal list for `IN_BAND_KINDS`, built the way `HOLDER_CLAIMED_KIND_SQL` is. */
export const IN_BAND_KIND_SQL = [...IN_BAND_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/**
 * ACP-R1-01, ACP-R2-01 — the outward kinds whose message is never ended by a delivery window or a
 * failed delivery attempt, only by an ACK or a recorded supersession: every actionable instruction
 * (`IN_BAND_KINDS`), whatever its route, and a CEO notification. Their TTL is not a lifetime: the
 * sweep does not expire them, delivery does not skip them for it, and ACK does not refuse them for it.
 */
const RETAINED_KIND_SQL = `${IN_BAND_KIND_SQL}, 'CEO_NOTIFICATION'`;
const isRetainedKind = (kind: string): boolean =>
  IN_BAND_KINDS.has(kind as MessageKind) || kind === MessageKind.CEO_NOTIFICATION;

/** The class a retained delivery's failure is recorded under when its route was absent (re-armable). */
const ROUTE_ABSENT_FAILURE_CLASS = "repairable";

/**
 * Handing a retained row to a new receiver (a takeover, an adoption, a runtime move, a new CEO
 * target): it is queued for that receiver; a send the previous receiver was handed (SENT, accepted or
 * of unknown outcome) is a first delivery to the new one; a route-absent failure is re-armed. An
 * authority refusal or wrong-target refusal, and a deferral on its backoff, keep what they were.
 * A SENT row whose receiver does not really change (`sameReceiverSql`) is not handed over at all.
 */
const HANDED_TO_NEW_RECEIVER_SQL = `status = 'PENDING', claim_token = NULL, claimed_at = NULL,
  failure_class = CASE WHEN status = 'SENT' OR (kind = 'CEO_NOTIFICATION' AND failure_class = 'unknown_observed') OR (failure_class = '${ROUTE_ABSENT_FAILURE_CLASS}' AND COALESCE(reason_code, '') NOT IN ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED')) THEN NULL ELSE failure_class END`;

/**
 * Whether handing a SENT row to `next` would send it to a receiver it was already sent to. Two
 * parameters: the new target session id, twice.
 *
 * FCR-08: judged only from where the row was actually sent (`outbox_sent_destinations`, the room and
 * recipient key each send that may have landed addressed), never from any session's current, mutable
 * address or identity. A row with that record is the same receiver's exactly when the new target's
 * route — where it would be sent now — is one of the recorded destinations. A row without it has no
 * evidence of where it went: one whose outcome is unknown is never treated as a new receiver's (it is
 * not sent again on a holder change), and one handed over in band or written before v51 is the same
 * receiver's only when it stays with the same session (a session's incarnation never changes).
 */
const sameReceiverSql = (alias: string): string =>
  `(CASE
     WHEN EXISTS (SELECT 1 FROM outbox_sent_destinations sent WHERE sent.message_id = ${alias}.message_id)
       THEN EXISTS (SELECT 1 FROM outbox_sent_destinations sent JOIN sessions next ON next.session_id = ?
              WHERE sent.message_id = ${alias}.message_id
                AND sent.room = next.buzz_address AND sent.recipient = next.buzz_actor_id)
     WHEN ${alias}.failure_class = 'unknown_observed' THEN 1
     ELSE ${alias}.target_session_id = ?
   END)`;

/**
 * ACP-R1-01, ACP-R2-01 — the one re-arm policy, within the CEO's boundaries (9b15c462).
 *
 * Re-armed: only a retained delivery (an instruction or a CEO notification) whose retry was disabled
 * solely because its route was absent — the attempt found its target with no Buzz room or no bound
 * channel identity, so nothing was sent (`markAttemptFailed` records it as `repairable`). On every
 * authenticated route change of the holder it is addressed to — an address set or restored, a channel
 * identity bound, a takeover, an adoption or rebind, a runtime move, a new CEO target — it becomes
 * deliverable again with the same message id. The outbox CHECKs allow `retry_eligible = 1` only with a
 * deferral time and a self-clearing class, so "deliverable again" for a retained kind is: no failure
 * class (`claimDeliverable` takes such a row whatever its attempt count).
 *
 * A signer-membership refusal uses the same policy, but a receiving route change cannot clear it:
 * only a positive readback of the transport's sending signer in that exact room may do so, after
 * verifying the whole row's attempt history is pre-post (`resumeCeoBuzzSigner`). A local send-policy
 * refusal also binds that hold to the route, actual signer and opaque policy-file digest: unchanged
 * authority cannot be re-armed by roster membership alone.
 *
 * Not re-armed by a route change: an authority refusal or a wrong target (a contract or security
 * refusal from the relay, kept on record and unsent), a deferral already on its own backoff, an
 * outcome-unknown send (flagged; see `markAttemptFailed`), and every terminal row. Only rows
 * addressed to exactly the holder the change concerns are touched, so nothing widens an item's
 * authority or recipient scope, and a stale holder's ACK is still refused.
 */
export const rearmRetainedDeliveries = (
  db: Pick<Db, "run">,
  scope: { sessionId: string; roleKey?: string; bindingGeneration?: number; signerReadyMessageId?: string },
): number =>
  db.run(
    `UPDATE outbox SET failure_class = NULL, reason_code = NULL
      WHERE status = 'PENDING' AND kind IN (${IN_BAND_KIND_SQL}, 'CEO_NOTIFICATION')
        AND failure_class = '${ROUTE_ABSENT_FAILURE_CLASS}' AND retry_eligible = 0
        AND (COALESCE(reason_code, '') NOT IN ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED') OR message_id = ?)
        AND (? IS NULL OR message_id = ?)
        AND target_session_id = ?
        AND (? IS NULL OR role_key = ?) AND (? IS NULL OR binding_generation = ?)`,
    [scope.signerReadyMessageId ?? null, scope.signerReadyMessageId ?? null, scope.signerReadyMessageId ?? null, scope.sessionId, scope.roleKey ?? null, scope.roleKey ?? null, scope.bindingGeneration ?? null, scope.bindingGeneration ?? null],
  ).changes;

/**
 * #246 C4 — the kinds a provisioned (driven) runtime receives in band: every `IN_BAND_KINDS` kind,
 * and `HANDOFF_PACKAGE`. An activation's handoff is addressed to the PRIMARY_CTO it has already
 * bound (`bootstrap-handoff:<id>`), so unlike a switchover's its recipient *is* the role's holder; a
 * driven session has no process between turns for a Buzz send to reach, so the row stays PENDING,
 * the wake runs a turn, and that turn reads it and settles it over its authenticated connection.
 * The outbox key keeps a re-delivery to one row and the row's own status keeps it to one effect.
 */
export const PROVISIONED_IN_BAND_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  ...IN_BAND_KINDS,
  MessageKind.HANDOFF_PACKAGE,
]);

const PROVISIONED_IN_BAND_KIND_SQL = [...PROVISIONED_IN_BAND_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/** A pending in-band row is woken for at most once per this window, per row. */
export const IN_BAND_REWAKE_MS = 5 * 60 * 1000;

/**
 * Knocks on a role's registered wake endpoint; carries nothing (`RoleConversationPort.wake`). The
 * rows it is woken for are named so a provisioned runtime can refuse a wake it already ran a turn
 * for (#246 C1b); a canonical CTO's wake port ignores them.
 */
export type InBandWake = (roleKey: string, messageIds?: readonly string[]) => Promise<Decision<void>>;

/** What an adopted canonical CTO is shown of a row addressed to it in band. */
export interface InBandDispatch {
  messageId: string;
  bindingGeneration: number;
  payloadDigest: string;
  kind: MessageKind;
  runId: string | null;
  createdAt: string;
  expiresAt: string;
  payload: unknown;
}

/**
 * An in-band row in the generic sweep's terms: the kind is in band and the target is an adopted
 * canonical runtime. `claimDeliverable` excludes it, and every in-band read below selects it.
 */
export const inBandRow = (outboxAlias: "o" | "outbox"): string =>
  `(((${outboxAlias}.kind IN (${IN_BAND_KIND_SQL})
       OR (${outboxAlias}.kind = 'HANDOFF_PACKAGE' AND ${currentRoleDeliveryTarget(outboxAlias)}))
     AND ${adoptedCanonicalRuntimeSql(`${outboxAlias}.target_session_id`)})
    OR (${outboxAlias}.kind IN (${PROVISIONED_IN_BAND_KIND_SQL})
     AND ${provisionedRuntimeSql(`${outboxAlias}.target_session_id`)}))`;

/**
 * #246 C1b — a provisioned session on the headless runtime: the current holder of an ACTIVE
 * BOOTSTRAP_CTO binding, or (#246 C4) of an ACTIVE PRIMARY_CTO binding whose session's spawn record
 * makes it `DRIVEN` — never a PRIMARY_CTO by its role alone, and never on a missing or contradicted
 * record. Like an adopted canonical CTO it has
 * nothing a Buzz send could reach — it has no live process at all between turns — so its in-band
 * kinds stay PENDING, the wake starts a turn of its own conversation, and that turn reads and
 * settles them over its authenticated connection exactly as a canonical CTO does.
 */
const provisionedRuntimeSql = (sessionExpr: string): string => `EXISTS (
  SELECT 1 FROM assignments prov_a
    LEFT JOIN conversational_actors prov_c ON prov_c.actor_id = prov_a.actor_id
   WHERE prov_a.status = 'ACTIVE'
     AND COALESCE(prov_c.current_session_id, prov_a.session_id) = ${sessionExpr}
     AND (prov_a.role = 'BOOTSTRAP_CTO'
       OR (prov_a.role = 'PRIMARY_CTO'
         AND ${drivenModeSql("COALESCE(prov_c.current_session_id, prov_a.session_id)")} = 'DRIVEN'))
)`;

/**
 * #246 C4 — a target whose driven-spawn record is contradicted (or names a session not yet bound) is
 * neither in band nor sent: the delivery sweep withholds its rows exactly as it withholds an in-band
 * row, so a record that does not add up fails closed rather than falling back to a Buzz send.
 */
const withheldFromSweep = (outboxAlias: "o" | "outbox"): string =>
  `(${inBandRow(outboxAlias)}
    OR ${drivenModeSql(`${outboxAlias}.target_session_id`)} NOT IN ('NONE', 'DRIVEN'))`;

/**
 * ACP-R1-03 — the session is the current runtime of an actor whose conversation target is a Hermes
 * one: an adopted Hermes CEO, whose route is the canonical notice transport. The executor kind is a
 * module constant, inlined for the reason `HOLDER_CLAIMED_KIND_SQL` gives.
 */
const HERMES_EXECUTOR_KIND = "hermes";
export const hermesCanonicalRuntimeSql = (sessionExpr: string): string => `EXISTS (
  SELECT 1 FROM conversational_actors hermes_c
    JOIN actor_target_bindings hermes_tb ON hermes_tb.target_actor_id = hermes_c.actor_id
   WHERE hermes_tb.executor_kind = '${HERMES_EXECUTOR_KIND}'
     AND hermes_c.current_session_id = ${sessionExpr}
)`;

/**
 * One route partition: a Hermes row stays canonical until its durable per-row Buzz grant. Only
 * unsent rows or rows whose EVERY attempt is known not to have delivered receive that grant.
 * The sweep still requires the live holder's bound Buzz room and identity. Removing transport
 * configuration cannot remove a recorded unknown-outcome fence.
 */
const ceoCanonicalRouteSql = (alias: "o" | "outbox", canonicalAttached: boolean): string =>
  canonicalAttached ? `(${hermesCanonicalRuntimeSql(`${alias}.target_session_id`)} AND NOT ${ceoBuzzGrantSql(alias)})` : "0";
const ceoBuzzSessionSql = (alias: "o" | "outbox"): string =>
  `EXISTS (SELECT 1 FROM sessions ceo_s WHERE ceo_s.session_id = ${alias}.target_session_id
             AND COALESCE(ceo_s.buzz_address, '') <> '' AND COALESCE(ceo_s.buzz_actor_id, '') <> '')`;
const ceoBuzzRouteSql = (alias: "o" | "outbox", canonicalAttached: boolean): string =>
  `(NOT ${ceoCanonicalRouteSql(alias, canonicalAttached)} AND ${ceoBuzzSessionSql(alias)}
    AND (${ceoBuzzGrantSql(alias)} OR NOT EXISTS (
      SELECT 1 FROM audit_events ceo_history
       WHERE ceo_history.kind IN ('CEO_NOTIFICATION_CANONICAL_ATTEMPT', 'CEO_NOTIFICATION_DELIVERY_FAILED',
                                  'CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN')
         AND json_extract(ceo_history.evidence_json, '$.messageId') = ${alias}.message_id)))`;

/** The TS callers evaluate the same row predicate as the sweep, read and ACK. */
const deliveredInBand = (
  db: Pick<Db, "get">, kind: string, sessionId: string, roleKey: string, generation: number,
): boolean => db.get<{ held: number }>(
  `SELECT ${inBandRow("o")} AS held
     FROM (SELECT ? AS kind, ? AS target_session_id, ? AS role_key, ? AS binding_generation) o`,
  [kind, sessionId, roleKey, generation],
)?.held === 1;

/**
 * Which runtime holds a role *right now* — one notion of it, shared by every predicate below.
 *
 * `assignments.session_id` is the runtime the binding was created against, and it does not move.
 * `BindingRegistry.switchTo` with `conversation: "SURVIVED"` moves only
 * `conversational_actors.current_session_id`: the counterpart is the same conversation and its
 * process is not, so the binding is deliberately not rewritten and the assignment row goes on
 * naming a runtime that is gone. Two predicates that disagree about which of those is "the holder"
 * is how an owner's message ends up addressed to a session no connection can present — the row is
 * unclaimable by the runtime that now holds the role, and a fresh admission for the same role is
 * refused `OUTBOX_TARGET_NOT_CURRENT` because `activeRoleTarget` answers with the actor's session
 * while admission checked the assignment's.
 *
 * `BindingRegistry.hydrate` already answers the question one way — the actor's pointer, falling
 * back to the binding's own value for an actor that has not been given a runtime yet — and this is
 * that same expression rather than a second one. Anything narrower would be a *third* notion of
 * current holder standing beside the two this reconciles, and the fallback is what keeps every
 * ordinary binding, whose actor names exactly the assignment's session, answering as it did.
 *
 * Moving the pointer is only half of it: the rows already addressed to the outgoing runtime have to
 * move in the same transaction, which is `carryHolderMessagesToRuntime` below.
 */
const HOLDER_ACTOR_JOIN = "LEFT JOIN conversational_actors actor ON actor.actor_id = a.actor_id";
const CURRENT_HOLDER_SESSION = "COALESCE(actor.current_session_id, a.session_id)";
const CURRENT_HOLDER_INCARNATION =
  "COALESCE(actor.current_session_incarnation, a.session_incarnation)";

/**
 * The exact holder, down to the incarnation — the predicate the owner-message lifecycle uses.
 *
 * `liveDeliveryTarget` below asks whether *a* live session holds this role generation. That is the
 * right question for an outward delivery and the wrong one here: a session that was replaced by a
 * respawn keeps its `session_id` and its generation while becoming a different runtime, and the
 * conversation an owner's message was addressed to did not survive that. The current holder's
 * incarnation is the value that tells the two apart, and it is supplied by the caller from the
 * authenticated connection rather than read back from the row being claimed — a predicate that
 * sourced it from the row would compare the database against itself and match always.
 *
 * Where the first three values come from is a parameter, and the predicate itself is written once.
 * `"o"` / `"outbox"` correlate on the outbox row in the statement; `"bound"` takes all four from
 * the caller, for the replay read-back where there is no outbox row in the statement to correlate
 * with. A second hand-written spelling of this predicate is how the lifecycle clause went missing
 * from the replay path in the first place — the two copies drifted, and the drift was invisible
 * until it was a STOPPED session being told its settle succeeded.
 */
const exactHolderTarget = (source: "o" | "outbox" | "bound"): string => {
  const from = (column: string): string => (source === "bound" ? "?" : `${source}.${column}`);
  return `EXISTS (
  SELECT 1 FROM assignments a
    ${HOLDER_ACTOR_JOIN}
    JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
   WHERE a.role_key = ${from("role_key")}
     AND a.binding_generation = ${from("binding_generation")}
     AND ${CURRENT_HOLDER_SESSION} = ${from("target_session_id")}
     AND ${CURRENT_HOLDER_INCARNATION} = ?
     AND a.status = 'ACTIVE'
     AND s.lifecycle IN ('READY','DRAINING')
)`;
};

const currentRoleDeliveryTarget = (outboxAlias: "o" | "outbox"): string => `EXISTS (
    SELECT 1 FROM assignments a
      ${HOLDER_ACTOR_JOIN}
      JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
     WHERE a.role_key = ${outboxAlias}.role_key
       AND a.binding_generation = ${outboxAlias}.binding_generation
       AND ${CURRENT_HOLDER_SESSION} = ${outboxAlias}.target_session_id
       AND a.status = 'ACTIVE'
       AND s.lifecycle IN ('READY','DRAINING')
  )`;

export const liveDeliveryTarget = (outboxAlias: "o" | "outbox"): string => `(
  ${currentRoleDeliveryTarget(outboxAlias)}
  OR EXISTS (
    SELECT 1 FROM handoffs h
      JOIN sessions recipient ON recipient.session_id = h.to_session_id
      JOIN sessions outgoing ON outgoing.session_id = h.from_session_id
      JOIN assignments a ON a.role_key = ${outboxAlias}.role_key
                         AND a.binding_generation = ${outboxAlias}.binding_generation
                         AND a.session_id = h.from_session_id
                         AND a.status = 'ACTIVE'
     WHERE ${outboxAlias}.kind = 'HANDOFF_PACKAGE'
       AND h.kind = 'HANDOFF'
       AND h.to_session_id = ${outboxAlias}.target_session_id
       AND h.from_generation = ${outboxAlias}.binding_generation
       AND h.status = 'PENDING'
       AND ${outboxAlias}.idempotency_key = 'handoff:' || h.handoff_id
       AND recipient.lifecycle = 'READY'
       AND outgoing.lifecycle IN ('READY','DRAINING')
  )
)`;

/**
 * ACP-R1-01 — the rows the one handover policy decides: an actionable instruction (`IN_BAND_KINDS`),
 * whatever its route, that nobody has ACKed — queued, claimed for delivery, or sent over Buzz and
 * awaiting its ACK (at-least-once: a replaced holder may have lost it, so it is delivered again under
 * the same message id). Never a reply a revocation held for a
 * provisioned owner's renewal and nothing has carried since, whatever else was done to it:
 * `carryHeldEscalationReplies` and the fences decide that one.
 */
export const handoverInstructionRowSql = (alias: "o" | "outbox"): string =>
  `(${alias}.kind IN (${IN_BAND_KIND_SQL}) AND ${alias}.status IN ('PENDING','IN_FLIGHT','SENT')
    AND NOT (${alias}.kind = '${MessageKind.ESCALATION_REPLY}'
      AND EXISTS (SELECT 1 FROM audit_events held WHERE held.kind = '${ESCALATION_REPLY_HELD}'
                   AND json_extract(held.evidence_json, '$.messageId') = ${alias}.message_id
                   AND json_extract(held.evidence_json, '$.fromGeneration') = ${alias}.binding_generation)
      AND NOT EXISTS (SELECT 1 FROM audit_events carried WHERE carried.kind = '${ESCALATION_REPLY_CARRIED}'
                   AND json_extract(carried.evidence_json, '$.messageId') = ${alias}.message_id)))`;

/**
 * ACP-R1-01 — the one handover policy for an actionable instruction, asked by every path that moves
 * a role's holder or loses it: a surviving runtime move (`carryHolderMessagesToRuntime`), a takeover
 * and a revoke (`retargetOrReject`), the authenticated binding that follows a revoke
 * (`adoptHolderMessages`, from `bind`, `renewSameSession` and a `switchTo` with no active binding),
 * and the fences that find a target nobody holds (`SessionRegistry`'s stop fence,
 * `fenceUndeliverable`). `to` is the successor, or null when there is none yet. Only reads.
 *
 * The instruction is never discarded for want of a holder or a delivery window. It is carried to the
 * successor with its message id (`CARRY`), kept queued for the next authenticated holder (`KEEP`), or
 * superseded, explicitly and with its reason, when it no longer addresses anything live
 * (`SUPERSEDE`): its run has ended, is gone or is no longer the role's; the escalation a reply
 * answers is no longer the run's open one; a drain request's replacement has happened. There is no
 * once-only budget: the same instruction follows every authenticated recovery until it is ACKed.
 */
const instructionHandoverOf = (
  db: Pick<Db, "get" | "all">,
  row: RawOutbox,
  to: { generation: number; sessionId: string } | null,
): InstructionHandover => {
  if (!IN_BAND_KINDS.has(row.kind as MessageKind) ||
      (row.status !== "PENDING" && row.status !== "IN_FLIGHT" && row.status !== "SENT")) {
    return { kind: "OUT_OF_SCOPE" };
  }
  const live = to === null ? { kind: "KEEP" as const } : { kind: "CARRY" as const };
  if (row.kind === MessageKind.DRAIN_REQUEST) {
    // A drain request asks one conversation to make way for a replacement: the same conversation on
    // another runtime still owes it, a different one is the replacement it asked for.
    if (to === null) return live;
    const actors = db.all<{ binding_generation: number; actor_id: string }>(
      `SELECT binding_generation, actor_id FROM assignments WHERE role_key = ? AND binding_generation IN (?, ?)`,
      [row.role_key, row.binding_generation, to.generation],
    );
    const from = actors.find((a) => a.binding_generation === row.binding_generation)?.actor_id;
    const next = actors.find((a) => a.binding_generation === to.generation)?.actor_id;
    return from !== undefined && from === next ? live : { kind: "SUPERSEDE", reason: "ROLE_REPLACED", runState: null };
  }
  // Every other instruction kind addresses a run; one that names none addresses nothing live.
  if (row.run_id === null) return { kind: "SUPERSEDE", reason: "RUN_MISSING", runState: null };
  const run = db.get<{ state: RunState; project_id: string | null; owner_role_key: string | null }>(
    `SELECT state, project_id, owner_role_key FROM runs WHERE run_id = ?`,
    [row.run_id],
  );
  if (!run) return { kind: "SUPERSEDE", reason: "RUN_MISSING", runState: null };
  if (isTerminal(run.state)) return { kind: "SUPERSEDE", reason: "RUN_TERMINAL", runState: run.state };
  if (run.owner_role_key !== null && run.owner_role_key !== row.role_key) {
    return { kind: "SUPERSEDE", reason: "RUN_OWNED_ELSEWHERE", runState: run.state };
  }
  if (row.kind === MessageKind.ESCALATION_REPLY && !escalationReplyStillAnswers(db, row, run.project_id, to)) {
    return { kind: "SUPERSEDE", reason: "ESCALATION_SUPERSEDED", runState: run.state };
  }
  return live;
};

/**
 * Whether an ESCALATION_REPLY still answers its run: the CEO_DECISION that enqueued it is on record
 * for the run's project, no blocking escalation was opened after the one it answers (for a reply
 * naming one, that escalation is still the run's latest), and a successor's assignment has the
 * project scope of the generation the reply was addressed to. Only reads.
 */
const escalationReplyStillAnswers = (
  db: Pick<Db, "get" | "all">,
  row: RawOutbox,
  projectId: string | null,
  to: { generation: number } | null,
): boolean => {
  let escalationId: unknown;
  try {
    escalationId = (JSON.parse(row.payload_json) as { escalationId?: unknown }).escalationId;
  } catch {
    return false;
  }
  const decision = db.get<{ event_id: number; project_id: string | null; escalation_id: unknown }>(
    `SELECT event_id, project_id, json_extract(evidence_json, '$.escalationId') AS escalation_id FROM audit_events
      WHERE run_id = ? AND kind = 'CEO_DECISION' AND json_extract(evidence_json, '$.messageId') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [row.run_id, row.message_id],
  );
  if (!decision || decision.project_id !== projectId) return false;
  const latest = db.get<{ event_id: number | null }>(
    `SELECT MAX(event_id) AS event_id FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION'
        AND json_extract(evidence_json, '$.blocksCriticalPath') = 1`,
    [row.run_id],
  )?.event_id ?? null;
  if (typeof escalationId === "number") {
    if (decision.escalation_id !== escalationId || latest !== escalationId) return false;
  } else if (escalationId !== undefined || (latest !== null && latest > decision.event_id)) {
    return false;
  }
  if (to === null) return true;
  const scopes = db.all<{ binding_generation: number; project_id: string | null }>(
    `SELECT binding_generation, project_id FROM assignments WHERE role_key = ? AND binding_generation IN (?, ?)`,
    [row.role_key, row.binding_generation, to.generation],
  );
  const from = scopes.find((scope) => scope.binding_generation === row.binding_generation);
  const next = scopes.find((scope) => scope.binding_generation === to.generation);
  return from !== undefined && next !== undefined && from.project_id === next.project_id;
};

/**
 * A kept instruction is left exactly as it is for the role's next authenticated holder: queued, or
 * claimed or sent to a receiver that is gone. Nothing re-sends it to the same receiver (an outcome
 * there may already have landed); the handover to a new receiver does (`HANDED_TO_NEW_RECEIVER_SQL`).
 */
const keepInstruction = (_db: Pick<Db, "run">, _row: RawOutbox): void => undefined;

/**
 * A supersession: the row REJECTED and an `OUTBOX_INSTRUCTION_SUPERSEDED` record of why, written in
 * the caller's transaction so neither exists without the other.
 */
const supersedeInstruction = (
  db: Pick<Db, "run">,
  audit: AuditLog,
  row: RawOutbox,
  decision: { reason: InstructionSupersession; runState: RunState | null },
  to: { generation: number } | null,
  path: InstructionHandoverPath,
): boolean => {
  const reasonCode = decision.reason === "RUN_TERMINAL" ? ReasonCode.RUN_ALREADY_TERMINAL : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED;
  const changed = db.run(
    `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                       retry_eligible = 0, next_attempt_at = NULL
      WHERE message_id = ? AND status IN ('PENDING','IN_FLIGHT','SENT')`,
    [reasonCode, row.message_id],
  ).changes;
  if (changed !== 1) return false;
  audit.record({
    kind: "OUTBOX_INSTRUCTION_SUPERSEDED",
    reasonCode,
    runId: row.run_id,
    roleKey: row.role_key,
    sessionId: row.target_session_id,
    evidence: {
      messageId: row.message_id, kind: row.kind, reason: decision.reason, runState: decision.runState, path,
      fromGeneration: row.binding_generation, toGeneration: to?.generation ?? null,
    },
  });
  return true;
};

/** The no-successor half of the policy, for rows whose target nobody holds: keep or supersede. */
const settleUnheldInstructions = (
  db: Pick<Db, "get" | "all" | "run">,
  audit: AuditLog,
  rows: readonly RawOutbox[],
  path: InstructionHandoverPath,
): { kept: string[]; superseded: string[] } => {
  const kept: string[] = [];
  const superseded: string[] = [];
  for (const row of rows) {
    const decision = instructionHandoverOf(db, row, null);
    if (decision.kind === "KEEP") {
      keepInstruction(db, row);
      kept.push(row.message_id);
    } else if (decision.kind === "SUPERSEDE" && supersedeInstruction(db, audit, row, decision, null, path)) {
      superseded.push(row.message_id);
    }
  }
  return { kept, superseded };
};

/**
 * ACP-R1-01 — `SessionRegistry`'s stop fence for the instructions addressed to a session that just
 * stopped or failed, inside its transaction: each is kept for the role's next authenticated holder or
 * superseded with its reason (`instructionHandoverOf`), whatever its route, instead of being
 * rejected because this runtime is gone. Every other kind is still the stop fence's to reject.
 */
export const settleStoppedSessionInstructions = (
  db: Pick<Db, "get" | "all" | "run">,
  audit: AuditLog,
  sessionId: string,
): { kept: string[]; superseded: string[] } =>
  settleUnheldInstructions(
    db,
    audit,
    db.all<RawOutbox>(
      `SELECT o.* FROM outbox o WHERE o.target_session_id = ? AND ${handoverInstructionRowSql("o")}
        ORDER BY o.created_at, o.rowid`,
      [sessionId],
    ),
    "SESSION_STOPPED",
  );

/**
 * Every unsettled CEO notification follows the current holder with its sealed content and id.
 * Restore delivery from only the selected room/recipient's ledger, independently of the previous
 * row state. Acceptance proves SENT, never ACKED; UNKNOWN stays held. An eligible new receiver
 * with no entry starts queued; refusal history and sender holds are preserved independently.
 * Legacy unknown history is a separate hold, and an outstanding claim is never taken over here.
 */
const readdressCeoNotifications = (db: Pick<Db, "run">, generation: number, sessionId: string): void => {
  const notCurrent = `kind = 'CEO_NOTIFICATION' AND role_key = 'CEO' AND (binding_generation <> ? OR target_session_id <> ?)`;
  // Legacy unknowns, unscoped older authority refusals and signer re-arm requirements are
  // separate safety holds. Move only their holder tuple, preserving every delivery field.
  db.run(`UPDATE outbox SET binding_generation = ?, target_session_id = ? WHERE ${notCurrent}
      AND status IN ('PENDING','SENT') AND (
        reason_code IN ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED')
        OR (failure_class IN ('contract','security') AND NOT EXISTS (
          SELECT 1 FROM audit_events refused WHERE refused.kind = 'CEO_NOTIFICATION_BUZZ_REFUSED'
            AND json_extract(refused.evidence_json, '$.messageId') = outbox.message_id
            AND json_extract(refused.evidence_json, '$.error') = outbox.last_error))
        OR EXISTS (SELECT 1 FROM audit_events legacy WHERE legacy.kind = 'CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN'
          AND json_extract(legacy.evidence_json, '$.messageId') = outbox.message_id)
        OR (failure_class = 'unknown_observed' AND NOT EXISTS (
          SELECT 1 FROM outbox_sent_destinations sent WHERE sent.message_id = outbox.message_id)))`,
  [generation, sessionId, generation, sessionId]);
  const outcome = `(SELECT outcome FROM destination WHERE message_id = outbox.message_id)`;
  db.run(`WITH destination AS (
      SELECT sent.message_id, sent.outcome, sent.sent_at FROM outbox_sent_destinations sent
        JOIN sessions next ON next.session_id = ? AND next.buzz_address = sent.room AND next.buzz_actor_id = sent.recipient
      UNION
      -- A changed address/key on a surviving holder, or another room for the same key,
      -- is no verified replacement recipient.
      -- With no exact-room evidence, hold rather than invent acceptance at the new address.
      SELECT sent.message_id, 'UNKNOWN', NULL FROM outbox_sent_destinations sent
        JOIN sessions next ON next.session_id = ?
        JOIN outbox held ON held.message_id = sent.message_id
        WHERE (next.buzz_actor_id = sent.recipient OR held.binding_generation = ?) AND NOT EXISTS (SELECT 1 FROM outbox_sent_destinations exact
          WHERE exact.message_id = sent.message_id AND exact.room = next.buzz_address AND exact.recipient = next.buzz_actor_id)
    ), refusal AS (
      SELECT json_extract(e.evidence_json, '$.messageId') AS message_id,
        json_extract(e.evidence_json, '$.failureClass') AS failure_class,
        json_extract(e.evidence_json, '$.error') AS error,
        ROW_NUMBER() OVER (PARTITION BY json_extract(e.evidence_json, '$.messageId') ORDER BY CASE json_extract(e.evidence_json, '$.scope') WHEN 'SENDER' THEN 0 ELSE 1 END, e.event_id DESC) AS latest
      FROM audit_events e JOIN sessions next ON next.session_id = ?
      WHERE e.kind = 'CEO_NOTIFICATION_BUZZ_REFUSED' AND (
        json_extract(e.evidence_json, '$.scope') = 'SENDER' OR
        json_extract(e.evidence_json, '$.recipient') = next.buzz_actor_id OR
        json_extract(e.evidence_json, '$.targetSessionId') = next.session_id OR
        EXISTS (SELECT 1 FROM assignments a WHERE a.role_key = 'CEO' AND a.status = 'ACTIVE'
          AND a.actor_id = json_extract(e.evidence_json, '$.actorId')))
    ) UPDATE outbox SET binding_generation = ?, target_session_id = ?,
      status = CASE ${outcome} WHEN 'ACCEPTED' THEN 'SENT' ELSE 'PENDING' END,
      failure_class = CASE ${outcome} WHEN 'ACCEPTED' THEN NULL WHEN 'UNKNOWN' THEN 'unknown_observed'
        ELSE (SELECT failure_class FROM refusal WHERE message_id = outbox.message_id AND latest = 1) END,
      sent_at = CASE ${outcome} WHEN 'ACCEPTED' THEN (SELECT sent_at FROM destination WHERE message_id = outbox.message_id) ELSE NULL END,
      claim_token = NULL, claimed_at = NULL, retry_eligible = 0, next_attempt_at = NULL, reason_code = NULL,
      last_error = CASE ${outcome} WHEN 'ACCEPTED' THEN NULL
        WHEN 'UNKNOWN' THEN 'delivery unconfirmed, automatic resend held; awaiting its ACK'
        ELSE (SELECT error FROM refusal WHERE message_id = outbox.message_id AND latest = 1) END
      WHERE ${notCurrent} AND status IN ('PENDING','SENT')`,
  [sessionId, sessionId, generation, sessionId, generation, sessionId, generation, sessionId]);
};

/**
 * Durable, fenced message queue (PRD §15.7, §27.5, §34.1).
 *
 * Enqueue happens inside the same transaction as the state change that justified the
 * message (§30.3), so a crash can never leave a dispatched run without its dispatch
 * message or vice versa.
 */
export class Outbox {
  /**
   * The ingress no-reply transition, as a caller rather than as a second definition of it.
   *
   * An `OWNER_MESSAGE` is the durable half of an ingress turn: the row in `inbound_messages` holds
   * that turn's claim open, and `IngressGuard.prune` deliberately never deletes a claim carrying
   * none of `repliedAt`/`noReplyAt`/`settledAt`. So every transition that takes such a row out of
   * `PENDING`/`SENT` without handing it to a successor has to settle the claim, in the same
   * transaction — otherwise the `(buzz, nonce)` slot is held forever by an outbox row that is
   * terminal and gone, and `doctor` reports a turn nothing will ever finish.
   *
   * Built here rather than injected, because every caller of this class would otherwise have to
   * remember to wire it and a composition that forgot would lose the coupling silently. Carrying
   * **no channel policy at all** is what keeps it from becoming a second admission authority: with
   * an empty policy map it can admit nothing, sign nothing and refuse nothing. The only method used
   * is `completeNoReplyAndResolveTurn`, which reads the database and the clock and nothing else.
   *
   * Never `resolveTurn`: that writes `repliedAt`, the narrow claim that a reply transport accepted
   * bytes. Nothing on this path hands a reply to any transport.
   */
  private readonly settlement: IngressGuard;

  /** The CTO role's wake port, once the daemon's listeners exist; null wakes nothing. */
  #inBandWake: InBandWake | null = null;
  /**
   * Continuity's answer to "can recovery still renew this role's `generation`?" —
   * `BootstrapCtoStaffing.renewalPossible`, attached by the composition root. Until it is attached
   * nothing is held: an ESCALATION_REPLY is held for a renewal only while recovery says one can come.
   */
  #renewalPossible: ((roleKey: string, generation: number) => boolean) | null = null;
  /**
   * When each pending in-band row was last woken for, by message id (clock milliseconds).
   *
   * Memory only, deliberately: it bounds wakes to one per row per `IN_BAND_REWAKE_MS`, which is a
   * storm guard rather than a delivery record. A restart forgets it and wakes each row once more,
   * which is harmless — the wake carries nothing, and the row is settled only by its ack.
   */
  readonly #inBandWokenAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {
    this.settlement = new IngressGuard(db, clock, audit, {});
  }

  /**
   * Settles the ingress claim one holder-claimed row is holding open.
   *
   * The claim is found by `turn_claim_json.turnRequestId`, which **is** the outbox message id
   * (`admitBuzzMessage` mints it from the enqueue's own result), and deliberately *not* by reading
   * the pointer off the row's payload. Two of the transitions that must settle are refusals of a
   * row whose payload is unreadable or no longer resolves to the source it was enqueued for — a
   * settlement that trusted that payload would follow it to the wrong turn on exactly the paths it
   * exists for, or find nothing to follow at all.
   *
   * A row with no claim answers `OK`: an owner-message enqueued outside the ingress path is holding
   * nothing open, which is the same thing `completeNoReplyAndResolveTurn` says for a message that
   * claimed no turn.
   */
  private settleHolderClaim(messageId: string, by: "HOLDER" | "FENCE" = "HOLDER"): Decision<void> {
    const claim = this.db.get<{ channel: string; nonce: string }>(
      `SELECT channel, nonce FROM inbound_messages
        WHERE turn_claim_json IS NOT NULL
          AND json_valid(turn_claim_json) = 1
          AND json_extract(turn_claim_json, '$.turnRequestId') = ?`,
      [messageId],
    );
    if (!claim) return allow(ReasonCode.OK, undefined);
    // A fence does not decide the turn (ACP-RESTART-03), and a turn whose first terminal fact is on
    // record is decided, however its claim JSON reads now (review finding 01, round 2): the fence
    // takes the row out of the queue and writes nothing beside that record.
    if (by === "FENCE" && this.#sourceSpent(claim.channel, claim.nonce, ["TURN_TERMINAL"])) {
      return allow(ReasonCode.OK, undefined);
    }
    return this.settlement.completeNoReplyAndResolveTurn(claim.channel, claim.nonce, {
      keepSettled: by === "FENCE",
    });
  }

  /**
   * The same coupling for a sweep, which has no `Decision` to hand a refusal back through.
   *
   * `fenceUndeliverable`, `retargetOrReject`, `carryHolderMessagesToRuntime` and
   * `carryPeerMessagesToSameActorSuccessor` return counts and id lists, and all run inside a
   * caller's transaction (a delivery loop, a binding switch, a restart's claim). A refused settlement
   * there cannot be reported as a denial, and committing the outbox half alone is the split state
   * this whole slice exists to remove — so it throws, and the caller's `db.tx` rolls the whole thing
   * back. Loud and whole beats quiet and half.
   *
   * A fence is not the holder deciding the turn, though: it only takes the row out of the queue. So
   * a turn that already has a terminal outcome keeps it (ACP-RESTART-03) — a receipt that settled it
   * (`settledAt`, e.g. `REPLY_OUTBOX`) stands, exactly as a `repliedAt` or `noReplyAt` already did,
   * and the row is rejected beside it. Before this, that receipt made the no-reply settlement refuse
   * with `RESOURCE_COLLISION`, the throw below rolled the whole fence back, and a canonical restart
   * with one such queued message could never complete.
   */
  private settleHolderClaimOrThrow(messageId: string): void {
    const settled = this.settleHolderClaim(messageId, "FENCE");
    if (settled.allowed) return;
    throw new Error(
      `owner-message ${messageId} could not be taken out of the queue: its ingress claim refused ` +
        `to settle (${settled.reasonCode}), and committing the outbox side alone would strand it`,
    );
  }

  /**
   * Idempotent by key. A repeated enqueue returns the existing message instead of
   * producing a duplicate dispatch (§34.1).
   */
  enqueue(input: EnqueueInput): Decision<OutboxMessage> {
    try {
      return this.db.tx(() => this.enqueueInTx(input));
    } catch (err) {
      if (isAcpError(err) && err.reasonCode === ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED) {
        const raced = this.byIdempotencyKey(input.idempotencyKey);
        if (raced) return this.replayDecision(raced, input);
      }
      throw err;
    }
  }

  #ceoDelivery: ((message: OutboxMessage, attempt: CeoNoticeAttempt) => Promise<Decision<void>>) | null = null;
  #ceoDelivering: Promise<void> | null = null;
  #ceoPending = false;

  /**
   * Installs the canonical notice transport. Its configuration alone does not prove receiver
   * support: the per-row journal decides whether a verified Buzz route may take over. Startup,
   * enqueue, binding adoption and authenticated CEO traffic are delivery events.
   */
  attachCeoNotificationDelivery(send: (message: OutboxMessage, attempt: CeoNoticeAttempt) => Promise<Decision<void>>): void {
    this.db.tx(() => {
      if (this.db.get("SELECT 1 FROM audit_events WHERE kind = 'CEO_NOTIFICATION_ATTEMPT_JOURNAL_STARTED'")) return;
      // A pre-upgrade crash could have dispatched without incrementing attempts. Absence of an
      // old failure count is not proof that an already queued Hermes row was never sent.
      const legacy = this.db.all<{ message_id: string; target_session_id: string }>(`SELECT message_id, target_session_id
        FROM outbox WHERE kind = 'CEO_NOTIFICATION' AND status = 'PENDING'
          AND ${hermesCanonicalRuntimeSql("outbox.target_session_id")} ORDER BY created_at, rowid`);
      for (const row of legacy) {
        const recorded = this.audit.record({ kind: "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN",
          reasonCode: ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED, sessionId: row.target_session_id,
          evidence: { messageId: row.message_id, basis: "PREDATES_ATTEMPT_JOURNAL" } });
        if (!recorded.allowed) throw new Error("CEO legacy outcome evidence was not recorded");
      }
      const started = this.audit.record({ kind: "CEO_NOTIFICATION_ATTEMPT_JOURNAL_STARTED", reasonCode: ReasonCode.OK });
      if (!started.allowed) throw new Error("CEO attempt journal boundary was not recorded");
    });
    this.#ceoDelivery = send;
    void this.deliverCeoNotifications();
  }

  /**
   * A CEO notification is role mail: every unACKed one follows the role's current holder, whichever
   * path moved the role (a bind or adoption, a takeover, a surviving runtime move, a revoke and
   * rebind, or a stopped runtime replaced), so a route the current CEO has is the route every
   * unsettled notification has. One the Buzz transport accepted for a holder that has since gone
   * (SENT, never ACKed) goes back to deliverable with its message id and is delivered to the new
   * holder — at-least-once, deduplicated by the id (ACP-R2-01).
   */
  #readdressCeoNotifications(): void {
    const current = this.db.get<{ generation: number; session: string }>(`SELECT a.binding_generation AS generation,
      ${CURRENT_HOLDER_SESSION} AS session FROM assignments a ${HOLDER_ACTOR_JOIN}
      WHERE a.role_key = 'CEO' AND a.status = 'ACTIVE'`);
    // A new target is a new route: a failure recorded against the previous one no longer holds it.
    if (current) readdressCeoNotifications(this.db, current.generation, current.session);
  }

  /**
   * ACP-R1-03 — a notification withheld because its live CEO has no route is never withheld
   * silently: one `CEO_NOTIFICATION_ROUTE_UNAVAILABLE` record per message and target says so, and
   * why — the CEO is an adopted Hermes runtime and the canonical notice transport is not attached
   * (it signs every notice with the ACP-Hermes lane secret), or the CEO has neither that nor a Buzz
   * room and channel identity. The row stays PENDING; the next route delivers it.
   */
  #recordUnroutableCeoNotifications(): void {
    const attached = this.#ceoDelivery !== null;
    const rows = this.db.all<{ message_id: string; target_session_id: string; role_key: string; run_id: string | null; hermes: number }>(
      `SELECT o.message_id, o.target_session_id, o.role_key, o.run_id,
              ${hermesCanonicalRuntimeSql("o.target_session_id")} AS hermes
         FROM outbox o
        WHERE o.kind = 'CEO_NOTIFICATION' AND o.status = 'PENDING' AND ${liveDeliveryTarget("o")}
          AND NOT ${ceoCanonicalRouteSql("o", attached)} AND NOT ${ceoBuzzSessionSql("o")}
          AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.kind = 'CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN'
                            AND json_extract(e.evidence_json, '$.messageId') = o.message_id)
          AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.kind = 'CEO_NOTIFICATION_ROUTE_UNAVAILABLE'
                            AND json_extract(e.evidence_json, '$.messageId') = o.message_id
                            AND json_extract(e.evidence_json, '$.targetSessionId') = o.target_session_id)
        ORDER BY o.created_at, o.rowid`,
    );
    for (const row of rows) {
      this.#recordWithheldCeoNotification({
        messageId: row.message_id, targetSessionId: row.target_session_id, roleKey: row.role_key, runId: row.run_id,
      }, row.hermes === 1 && !attached ? "CANONICAL_TRANSPORT_NOT_ATTACHED" : "NO_BUZZ_ROUTE");
    }
  }

  /** Route discovery can also withhold an attached canonical transport before it sends. */
  #recordWithheldCeoNotification(
    message: Pick<OutboxMessage, "messageId" | "targetSessionId" | "roleKey" | "runId">,
    reason: string,
  ): void {
    if (this.db.get(`SELECT 1 FROM audit_events WHERE kind = 'CEO_NOTIFICATION_ROUTE_UNAVAILABLE'
      AND json_extract(evidence_json, '$.messageId') = ?
      AND json_extract(evidence_json, '$.targetSessionId') = ?`, [message.messageId, message.targetSessionId])) return;
    this.audit.record({
      kind: "CEO_NOTIFICATION_ROUTE_UNAVAILABLE",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      roleKey: message.roleKey,
      sessionId: message.targetSessionId,
      runId: message.runId,
      evidence: {
        messageId: message.messageId,
        targetSessionId: message.targetSessionId,
        reason,
      },
    });
  }

  deliverCeoNotifications(): Promise<void> {
    this.#ceoPending = true;
    if (this.#ceoDelivering) return this.#ceoDelivering;
    if (!this.#ceoDelivery) {
      // No canonical transport: the Buzz sweep owns every routable row; record the unroutable ones.
      try {
        this.#readdressCeoNotifications();
        this.#recordUnroutableCeoNotifications();
      } catch {
        // A closed database records nothing; the next delivery pass records it.
      }
      return Promise.resolve();
    }
    const send = this.#ceoDelivery;
    const run = (async () => {
      do {
        this.#ceoPending = false;
        this.#readdressCeoNotifications();
        this.#recordUnroutableCeoNotifications();
        // Only the rows whose route is this transport; a Buzz-backed CEO's are the sweep's.
        const rows = this.db.all<RawOutbox>(`SELECT o.* FROM outbox o
          WHERE o.kind = 'CEO_NOTIFICATION' AND o.status = 'PENDING' AND ${liveDeliveryTarget("o")}
            AND ${ceoCanonicalRouteSql("o", true)}
          ORDER BY o.created_at, o.rowid`);
        for (const row of rows) {
          let accepted = false;
          let unavailable = false;
          let reasonCode: ReasonCode = ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED;
          let outcome: CeoNoticeOutcome = "UNKNOWN";
          const attempt = new CeoNoticeRoute(this.db, this.audit, hydrate(row));
          if (attempt.withholdBeforeSend()) continue;
          try {
            const result = await send(hydrate(row), attempt);
            unavailable = !result.allowed && result.reasonCode === ReasonCode.CEO_CONVERSATION_UNAVAILABLE;
            accepted = result.allowed;
            reasonCode = result.reasonCode;
            outcome = (result.evidence["noticeOutcome"] as CeoNoticeOutcome | undefined) ?? (accepted ? "SETTLED" : "UNKNOWN");
          } catch { /* retained below */ }
          if (attempt.route !== "CANONICAL") continue;
          if (unavailable) {
            // No target was found, so no transport attempt took place. Retain PENDING and
            // record withholding once per message/target, just like the unattached route.
            this.#recordWithheldCeoNotification(hydrate(row), "CANONICAL_TARGET_UNAVAILABLE");
            continue;
          }
          this.db.tx(() => {
            attempt.finish(outcome);
            const updated = this.db.run(`UPDATE outbox SET status = ?, attempts = attempts + 1, acked_at = ?
            WHERE message_id = ? AND status = 'PENDING' AND binding_generation = ? AND target_session_id = ?
              AND ${liveDeliveryTarget("outbox")}`,
            [accepted ? "ACKED" : "PENDING", accepted ? this.clock.nowIso() : null,
              row.message_id, row.binding_generation, row.target_session_id]);
            if (updated.changes !== 1) return;
            this.audit.record({ kind: accepted ? "CEO_NOTIFICATION_ACCEPTED" : "CEO_NOTIFICATION_DELIVERY_FAILED",
            reasonCode,
            roleKey: row.role_key, sessionId: row.target_session_id, runId: row.run_id,
            evidence: { messageId: row.message_id } });
          });
        }
      } while (this.#ceoPending);
    })();
    // A delivery event that arrived after the loop's last look (one joined the run in flight) is
    // served by a follow-up pass that the returned promise includes, so whoever awaits a delivery it
    // triggered sees that delivery finished, not just the pass it happened to join.
    const settle = (): Promise<void> => {
      this.#ceoDelivering = null;
      return this.#ceoPending ? this.deliverCeoNotifications() : Promise.resolve();
    };
    this.#ceoDelivering = run.then(settle, settle);
    return this.#ceoDelivering;
  }

  private enqueueInTx(input: EnqueueInput): Decision<OutboxMessage> {
    const existing = this.byIdempotencyKey(input.idempotencyKey);
    if (existing) return this.replayDecision(existing, input);

    if (!this.isCurrentTarget(
      input.roleKey,
      input.bindingGeneration,
      input.targetSessionId,
      input.kind,
      input.idempotencyKey,
    )) {
      return deny(
        ReasonCode.OUTBOX_TARGET_NOT_CURRENT,
        "outbox target is not the ready session holding the requested role generation",
        {
          roleKey: input.roleKey,
          bindingGeneration: input.bindingGeneration,
          targetSessionId: input.targetSessionId,
        },
      );
    }

    const now = this.clock.nowIso();
    const requestFingerprint = requestFingerprintOf(input);
    const message: OutboxMessage = {
      messageId: newMessageId(),
      idempotencyKey: input.idempotencyKey,
      roleKey: input.roleKey,
      bindingGeneration: input.bindingGeneration,
      targetSessionId: input.targetSessionId,
      runId: input.runId ?? null,
      kind: input.kind,
      payload: input.payload,
      payloadDigest: payloadDigestOf(input.payload),
      requestFingerprint,
      expiresAt: isoPlus(now, input.ttlMs ?? DEFAULT_TTL_MS),
      status: "PENDING",
      attempts: 0,
      failureClass: null,
      retryEligible: false,
      nextAttemptAt: null,
      createdAt: now,
    };
    this.db.run(
      `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
                           target_session_id, run_id, kind, payload_json, payload_digest,
                           request_fingerprint, expires_at, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        message.messageId,
        message.idempotencyKey,
        message.roleKey,
        message.bindingGeneration,
        message.targetSessionId,
        message.runId,
        message.kind,
        JSON.stringify(message.payload),
        message.payloadDigest,
        requestFingerprint,
        message.expiresAt,
        message.createdAt,
      ],
    );
    if (message.kind === MessageKind.CEO_NOTIFICATION) {
      this.db.afterCommit(() => { void this.deliverCeoNotifications(); });
    }
    // An in-band row is never transmitted, so the role is told it has something to read — after
    // the enclosing transaction commits, so a wake cannot reach the CTO before the row it points
    // at is visible, and a rollback discards it.
    if (deliveredInBand(this.db, message.kind, message.targetSessionId, message.roleKey, message.bindingGeneration)) {
      this.db.afterCommit(() => {
        void this.#wakeInBand([{ messageId: message.messageId, roleKey: message.roleKey }], "enqueue");
      });
    }
    return allow(ReasonCode.OK, message);
  }

  private replayDecision(existing: OutboxMessage, input: EnqueueInput): Decision<OutboxMessage> {
    const matches = existing.requestFingerprint === requestFingerprintOf(input);
    if (matches) {
      return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, existing, {
        idempotencyKey: input.idempotencyKey,
      });
    }
    return deny(
      ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
      "idempotency key belongs to a different enqueue request",
      { idempotencyKey: input.idempotencyKey, messageId: existing.messageId },
    );
  }

  /**
   * Atomically claims deliverable messages (§34.1).
   *
   * A read-only SELECT would let two overlapping delivery loops pick the same envelope and
   * both send it. Claiming stamps a token and moves the row to IN_FLIGHT inside one
   * transaction, so a second loop sees nothing to take.
   */
  claimDeliverable(limit = 50): Array<OutboxMessage & { claimToken: string }> {
    return this.db.tx(() => {
      const now = this.clock.nowIso();
      this.expireOverdue();
      this.reclaimStaleLeases();
      this.#readdressCeoNotifications();
      this.#recordUnroutableCeoNotifications();
      const canonicalCeo = this.#ceoDelivery !== null;

      const rows = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE o.status = 'PENDING'
            -- Holder-claimed kinds are invisible to this sweep. BuzzAdapter.deliverPending
            -- transmits whatever comes back from here to the target's Buzz address, so a row that
            -- appeared in this result would have its payload sent over a channel that never
            -- authenticated the holder — the exact disclosure the separate claim path exists to
            -- prevent. The holder takes these through claimForHolder instead.
            AND o.kind NOT IN (${HOLDER_CLAIMED_KIND_SQL})
            -- A CEO notification is this sweep's only when its route is Buzz (ACP-R1-03): an
            -- adopted Hermes CEO's goes through the canonical transport, and one with no route is
            -- withheld PENDING rather than handed to a send that would reject it.
            AND (o.kind <> 'CEO_NOTIFICATION' OR ${ceoBuzzRouteSql("o", canonicalCeo)})
            -- So is an in-band row: a role-level kind addressed to an adopted canonical CTO. A
            -- Buzz send to it would be signed with the daemon's key, which the room's sender
            -- refuses — the row would go REJECTED before the CTO could acknowledge it — and the
            -- CTO already holds an authenticated connection to this daemon. It stays PENDING and
            -- the CTO reads it in band (pendingInBandFor), for the same reason as the line above:
            -- nothing here may transmit what only its exact target may read.
            AND NOT ${withheldFromSweep("o")}
            -- An instruction or a CEO notification has no delivery TTL to miss: it is never expired
            -- (expireOverdue) and is delivered whenever its target can be reached.
            AND (o.expires_at > ? OR o.kind IN (${RETAINED_KIND_SQL}))
            -- A deferred retry is not deliverable until its window opens; the deferral is
            -- durable, so a restarted loop honours it instead of retrying immediately.
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            -- An already-attempted row is deliverable again only while its recorded failure
            -- is retry-eligible. A queued row that carries attempts but no eligibility was
            -- never judged retryable, so it is not picked up.
            -- A retained kind (an instruction or a CEO notification) is also deliverable again once a
            -- handover or a new CEO target re-armed it (no outstanding failure class): its failures
            -- never end it (markAttemptFailed), so this is how a route change resumes it.
            AND (o.attempts = 0 OR o.retry_eligible = 1 OR (o.kind IN (${RETAINED_KIND_SQL}) AND o.failure_class IS NULL))
            AND ${liveDeliveryTarget("o")}
          ORDER BY o.created_at, o.rowid
          LIMIT ?`,
        [now, now, limit],
      );

      const claimed: Array<OutboxMessage & { claimToken: string }> = [];
      for (const row of rows) {
        const token = `clm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const updated = this.db.run(
          `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = ?, claimed_at = ?
            WHERE message_id = ? AND status = 'PENDING'
              AND NOT ${withheldFromSweep("outbox")}
              AND (kind <> 'CEO_NOTIFICATION' OR ${ceoBuzzRouteSql("outbox", canonicalCeo)})
              AND ${liveDeliveryTarget("outbox")}`,
          [token, now, row.message_id],
        );
        // Compare-and-set: another loop may have taken it between the select and here.
        if (updated.changes === 1) claimed.push({ ...hydrate(row), claimToken: token });
      }
      return claimed;
    });
  }

  /**
   * At most one oldest message for the authenticated current holder. An unACKed SENT row is
   * redelivered with the same message ID; ACKed/rejected IDs and spent source aliases cannot
   * replay. A crash before ACK therefore retains work instead of terminally disposing of it.
   */
  claimForHolder(
    holder: HolderIdentity,
    admits: (candidate: OutboxMessage) => boolean = withholdsIdentityBound,
  ): HolderClaimResult {
    return this.db.tx(() => {
      const now = this.clock.nowIso();
      const tuple = [
        holder.roleKey,
        holder.bindingGeneration,
        holder.targetSessionId,
        holder.sessionIncarnation,
      ];

      // Only unreadable or terminally deduped SENT rows are reported without their payload.
      const unresolved = this.db
        .all<RawOutbox>(
          `SELECT o.* FROM outbox o
            WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
              AND o.status = 'SENT'
              AND NOT ${handOverEligibleSql("o")}
              AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
              AND ${exactHolderTarget("o")}
            ORDER BY o.created_at, o.message_id`,
          tuple,
        )
        .map(unresolvedOwnerMessage);


      // Read all candidates in arrival order; one withheld row must not block readable mail.
      const queued = this.db.all<RawOutbox & { never_departed: number }>(
        `SELECT o.*, ${handOverEligibleSql("o")} AS never_departed
           FROM outbox o
          WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND o.status IN ('PENDING','SENT')
            AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${exactHolderTarget("o")}
          ORDER BY o.created_at, o.rowid`,
        tuple,
      );
      const admitted: RawOutbox[] = [];
      const withheld: UnresolvedOwnerMessage[] = [];
      for (const { never_departed: neverDeparted, ...row } of queued) {
        const message = neverDeparted === 1 && this.#payloadHandOverEligible(row.payload_json, row.message_id)
          ? readableMessage(row)
          : null;
        if (message !== null && admits(message)) admitted.push(row);
        else withheld.push(unresolvedOwnerMessage(row));
      }

      // The block. An outstanding unknown outcome is exactly the state in which handing out more
      // work is wrong, so the holder is told what is unsettled and that work is waiting, and is
      // given neither payload until it settles the first.
      if (unresolved.length > 0) {
        return { claimed: [], unresolved, withheld, hasMore: admitted.length > 0 };
      }

      const candidate = admitted[0];
      if (!candidate) return { claimed: [], unresolved, withheld, hasMore: false };

      // Compare-and-set, asserting the full caller tuple rather than the row id and a status.
      // `role_key`, `binding_generation` and `target_session_id` are the caller's values, not the
      // candidate's, so a row that stopped being this caller's between the read above and this
      // write changes nothing. Without them the `EXISTS` correlates on the row's own columns and
      // resolves the *row's* assignment, checking it against the caller's incarnation string —
      // which matches whenever two runtimes happen to share one, and incarnation strings are
      // unique only within a session.
      const moved = this.db.run(
        `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                           claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND status IN ('PENDING','SENT')
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}
            AND ${handOverEligibleSql("outbox")}`,
        [
          now,
          candidate.message_id,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (moved !== 1) return { claimed: [], unresolved, withheld, hasMore: admitted.length > 0 };

      // Re-read rather than patching the candidate: the payload handed over is the one on the row
      // this statement actually moved, and so are the attempts and the hand-over instant.
      const handed = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [
        candidate.message_id,
      ]);
      return {
        claimed: handed ? [hydrate(handed)] : [],
        unresolved,
        withheld,
        hasMore: admitted.length > 1,
      };
    });
  }

  /**
   * The holder records that it took one of its own owner-messages: `SENT -> ACKED`.
   *
   * Idempotent on an exact repeat, because the acknowledgement can be lost on the way back and a
   * holder that retries it is doing the right thing — but only for the same holder. `ACKED` is
   * re-reported as success; every other terminal state is a collision, because moving `REJECTED`
   * or `EXPIRED` to `ACKED` would rewrite a decision something else already recorded.
   */
  completeForHolder(messageId: string, holder: HolderIdentity): Decision<void> {
    // `txDecision`, not `tx`: this body writes and can then decide against itself, because the
    // settlement below is the second half of one transition. A denial there has to take the
    // `ACKED` with it — an outbox row settled beside an ingress claim still reading unresolved is
    // exactly the split state this whole path exists to remove. Nested inside the ledger's own
    // decision frame it hands the denial straight back, and the outermost frame does the rollback.
    return this.db.txDecision(() => {
      const changes = this.db.run(
        `UPDATE outbox SET status = 'ACKED', acked_at = ?
          WHERE message_id = ? AND status = 'SENT'
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}`,
        [
          this.clock.nowIso(),
          messageId,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (changes !== 1) return this.holderTerminalReplay(messageId, holder, "ACKED");
      const settled = this.settleHolderClaim(messageId);
      if (!settled.allowed) return settled;
      return allow(ReasonCode.OK, undefined);
    });
  }

  /**
   * The holder refuses one of its own owner-messages: terminal, and exact-holder like the claim.
   *
   * Reachable from `SENT` and from `PENDING`: a holder may decline a message it has taken, and the
   * failover path below may decline one that was never taken. Both end `REJECTED`, which no other
   * transition here moves out of.
   */
  rejectForHolder(messageId: string, holder: HolderIdentity): Decision<void> {
    // `txDecision` for the same reason as `completeForHolder`: the rejection and the settlement of
    // the ingress claim it closes are one transition, and half of it is worse than none of it.
    return this.db.txDecision(() => {
      const changes = this.db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                           claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND status IN ('PENDING','SENT')
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}`,
        [
          ReasonCode.OUTBOX_DELIVERY_REJECTED,
          messageId,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (changes !== 1) return this.holderTerminalReplay(messageId, holder, "REJECTED");
      const settled = this.settleHolderClaim(messageId);
      if (!settled.allowed) return settled;
      const rejected = this.db.get<RawOutbox>("SELECT * FROM outbox WHERE message_id = ?", [messageId]);
      if (rejected?.kind === MessageKind.PEER_MESSAGE) this.#owePeerMessageNotice(rejected, PeerMessageNoticeReason.REVOKED);
      return allow(ReasonCode.OK, undefined);
    });
  }

  /**
   * Why an exact-holder transition changed no row — an idempotent repeat, or a refusal.
   *
   * The distinction is the whole point: a holder retrying a lost acknowledgement and a stranger
   * trying to settle somebody else's message both produce zero changed rows, and answering both
   * the same way would either turn an ordinary retry into an error or let the stranger's call
   * report success. So the row is re-read and the holder is checked against it explicitly.
   *
   * "The same holder" here is the *same* predicate the claim, complete and reject writes assert —
   * `exactHolderTarget`, lifecycle join included — and not a second hand-written subquery that
   * happens to name the same four columns. An assignment-only match is not a live holder: a
   * `STOPPED` session keeps its `ACTIVE` assignment row, so a predicate that stopped at
   * `assignments` would hand a settled-successfully verdict to a runtime that is gone, on the one
   * path that never touches the write it is standing in for.
   */
  private holderTerminalReplay(
    messageId: string,
    holder: HolderIdentity,
    want: "ACKED" | "REJECTED",
  ): Decision<void> {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });
    const sameHolder =
      row.role_key === holder.roleKey &&
      row.binding_generation === holder.bindingGeneration &&
      row.target_session_id === holder.targetSessionId &&
      Boolean(
        this.db.get(`SELECT 1 WHERE ${exactHolderTarget("bound")}`, [
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ]),
      );
    if (!sameHolder) {
      return deny(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "this holder does not own the message it tried to settle",
        { messageId, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) },
      );
    }
    if (row.status === want) {
      return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, undefined, { messageId, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) });
    }
    return deny(
      ReasonCode.RESOURCE_COLLISION,
      `message is ${outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }).status} and cannot move to ${want}`,
      { messageId, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) },
    );
  }

  /** A claim whose holder died must return to PENDING rather than stay stuck IN_FLIGHT. */
  reclaimStaleLeases(leaseMs = SEND_LEASE_MS): number {
    this.fenceUndeliverable();
    // A CEO notification is never fenced, so a stale claim on one returns to PENDING whatever its
    // target now is, and follows the role's current holder from there (ACP-R1-03).
    return this.db.run(
      `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL
        WHERE status = 'IN_FLIGHT' AND claimed_at <= ?
          AND (${liveDeliveryTarget("outbox")} OR kind = 'CEO_NOTIFICATION')`,
      [new Date(new Date(this.clock.nowIso()).getTime() - leaseMs).toISOString()],
    ).changes;
  }

  /** Only the holder of the current claim may complete a delivery. */
  markSent(messageId: string, claimToken: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                         claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL,
                         -- A retained kind's transport accepted it: no failure is outstanding.
                         failure_class = CASE WHEN kind IN (${RETAINED_KIND_SQL}) THEN NULL ELSE failure_class END
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND ${liveDeliveryTarget("outbox")}`,
      [this.clock.nowIso(), messageId, claimToken],
    ).changes;
    if (changes !== 1) {
      return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer held", {
        messageId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * FCR-08 — records that the relay accepted a send of this row at exactly `destination`. Written by
   * the transport as soon as the send returns, before the claim is completed: whether or not that claim
   * is still held, that is where the row may be now, and a later attempt reads it (`sentTo`).
   */
  recordAcceptedSend(messageId: string, destination: SentDestination): void {
    recordSentDestination(this.db, messageId, destination, "ACCEPTED", this.clock.nowIso());
  }

  /**
   * FCR-14 — records, before the transport is called, that a send of this row to exactly `destination`
   * is in flight. Until it settles, no other attempt sends there (`sentTo` answers IN_FLIGHT), whoever
   * holds the row by then: a handover during the send does not open that destination again.
   */
  recordSendInFlight(messageId: string, destination: SentDestination): void {
    recordSentDestination(this.db, messageId, destination, "PENDING_SEND", this.clock.nowIso());
  }

  /**
   * FCR-08, FCR-14 — whether a send of this row may already be at exactly `destination`, or is on its
   * way there: ACCEPTED, UNKNOWN, IN_FLIGHT (a send there has not settled yet), or null (nothing was
   * sent there). The transport asks before sending, and sends nothing to a destination that is not
   * null. An in-flight send older than the claim lease never settled and counts as UNKNOWN.
   */
  sentTo(messageId: string, destination: SentDestination): "ACCEPTED" | "UNKNOWN" | "IN_FLIGHT" | null {
    const row = this.db.get<{ outcome: SentOutcome; sent_at: string }>(
      `SELECT outcome, sent_at FROM outbox_sent_destinations WHERE message_id = ? AND room = ? AND recipient = ?`,
      [messageId, destination.room, destination.recipient],
    );
    if (!row) return null;
    if (row.outcome !== "PENDING_SEND") return row.outcome;
    return Date.parse(this.clock.nowIso()) - Date.parse(row.sent_at) >= SEND_LEASE_MS ? "UNKNOWN" : "IN_FLIGHT";
  }

  /**
   * FCR-14 — gives a claim back untouched because a send of this row to the same destination is still
   * in flight: the row returns to PENDING with no attempt counted and nothing transmitted, and is
   * judged again once that send settles (`sentTo`). Only the holder of the current claim may do this.
   */
  awaitSendInFlight(messageId: string, claimToken: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?`,
      [messageId, claimToken],
    ).changes;
    if (changes !== 1) return this.staleClaim(messageId);
    return allow(ReasonCode.OK, undefined, { messageId, awaiting: "IN_FLIGHT_SEND" });
  }

  /**
   * FCR-08 — settles a claim without sending, because the row may already be at the destination it
   * would be sent to (`sentTo`): it is SENT again, awaiting that receiver's ACK, flagged
   * `unknown_observed` unless the relay accepted it there. Nothing is transmitted and no attempt is
   * counted. Only the holder of the current claim may do this.
   */
  markAlreadySent(
    messageId: string,
    claimToken: string,
    outcome: "ACCEPTED" | "UNKNOWN",
    destination: SentDestination,
  ): Decision<void> {
    return this.db.tx(() => {
      const reason = outcome === "ACCEPTED"
        ? "withheld: the relay already accepted this message at this room and recipient; awaiting its ACK"
        : "withheld: a send of this message to this room and recipient has an unknown outcome and may be there; " +
          "awaiting its ACK, or a holder at another destination";
      // PENDING with unknown_observed means delivery unconfirmed, not proof that nothing posted.
      // Preserve old SENT records; neither representation proves completion.
      const status = outcome === "UNKNOWN" && this.db.get(`SELECT 1 FROM outbox
        WHERE message_id = ? AND kind = 'CEO_NOTIFICATION' AND sent_at IS NULL`, [messageId]) ? "PENDING" : "SENT";
      const changes = this.db.run(
        `UPDATE outbox SET status = ?, sent_at = CASE WHEN ? = 'SENT' THEN COALESCE(sent_at, ?) ELSE sent_at END, claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL, last_error = ?,
                           failure_class = ?
          WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
            AND ${liveDeliveryTarget("outbox")}`,
        [status, status, this.clock.nowIso(), reason, outcome === "ACCEPTED" ? null : "unknown_observed", messageId, claimToken],
      ).changes;
      if (changes !== 1) return this.staleClaim(messageId);
      // A send that never settled (`sentTo` answered UNKNOWN for a stale in-flight record) is settled
      // as UNKNOWN on record, with its real destination; never as accepted.
      recordSentDestination(this.db, messageId, destination, outcome, this.clock.nowIso());
      // Never silent: the withheld row stays flagged, and why is on record.
      const row = this.db.get<{ role_key: string; run_id: string | null; target_session_id: string }>(
        "SELECT role_key, run_id, target_session_id FROM outbox WHERE message_id = ?", [messageId]);
      this.audit.record({
        kind: "OUTBOX_SEND_WITHHELD",
        roleKey: row?.role_key ?? null,
        runId: row?.run_id ?? null,
        sessionId: row?.target_session_id ?? null,
        evidence: { messageId, room: destination.room, recipient: destination.recipient, outcome, reason },
      });
      return allow(ReasonCode.OK, undefined, { messageId, alreadySent: outcome,
        ...outboxDeliveryReadback({ status, failureClass: outcome === "UNKNOWN" ? "unknown_observed" : null }) });
    });
  }

  /** Read-only candidates; a roster response must still match the target when it returns. */
  pendingCeoBuzzSignerRoutes(): OutboxMessage[] {
    return this.db.all<RawOutbox>(`SELECT o.* FROM outbox o WHERE o.kind = 'CEO_NOTIFICATION'
      AND o.status = 'PENDING' AND ${liveDeliveryTarget("o")} AND ${ceoBuzzRouteSql("o", this.#ceoDelivery !== null)}
      AND (o.reason_code IN ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED') OR o.failure_class = 'contract')
      ORDER BY o.created_at, o.rowid`).filter(row => (row.reason_code === ReasonCode.BUZZ_SIGNER_NOT_REGISTERED || row.reason_code === ReasonCode.BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED || row.reason_code === ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED ||
        isBuzzSignerRefusal(row.last_error ?? "")) && ceoBuzzHistoryIsPrePost(this.db, row)).map(hydrate);
  }

  /** Existing resume boundary. False means the local-policy hold has no relevant change to validate.
   * Positive roster readback can release membership holds; policy holds also need changed authority.
   */
  resumeCeoBuzzSigner(message: OutboxMessage, destination: SentDestination, registered: boolean, policyBinding?: BuzzPolicyBinding): boolean {
    return this.db.tx(() => {
      const row = this.db.get<RawOutbox>(`SELECT o.* FROM outbox o JOIN sessions s ON s.session_id = o.target_session_id
        WHERE o.message_id = ? AND o.status = 'PENDING' AND o.target_session_id = ? AND o.binding_generation = ?
          AND o.payload_digest = ? AND s.buzz_address = ? AND s.buzz_actor_id = ? AND ${liveDeliveryTarget("o")}
          AND (o.reason_code IN ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED') OR o.failure_class = 'contract')`,
      [message.messageId, message.targetSessionId, message.bindingGeneration, message.payloadDigest, destination.room, destination.recipient]);
      if (!row || !ceoBuzzHistoryIsPrePost(this.db, row)) return false;
      if (row.failure_class === "contract") {
        if (!isBuzzSignerRefusal(row.last_error ?? "")) return false;
        this.#recordSignerNotReady(hydrate(row), destination, null, "LEGACY_SEND_REFUSAL", row.attempts);
        this.db.run("UPDATE outbox SET failure_class = 'repairable', reason_code = ? WHERE message_id = ?",
          [ReasonCode.BUZZ_SIGNER_NOT_REGISTERED, message.messageId]);
      }
      // Upgrade either historical representation of the exact local-policy refusal without sending.
      if (row.reason_code === ReasonCode.BUZZ_SIGNER_NOT_REGISTERED && policyBinding) {
        const previous = this.db.get<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events
          WHERE kind = 'CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY'
            AND json_extract(evidence_json, '$.messageId') = ? ORDER BY rowid DESC LIMIT 1`, [message.messageId]);
        if (previous && ["SEND_REFUSAL", "LEGACY_SEND_REFUSAL"].includes(JSON.parse(previous.evidence_json).source)) {
          this.#recordSignerNotReady(message, destination, policyBinding.signer, "SEND_REFUSAL", row.attempts,
            ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED, policyBinding);
          this.db.run("UPDATE outbox SET reason_code = ? WHERE message_id = ?", [ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED, message.messageId]);
          return false;
        }
      }
      if (row.reason_code === ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED) {
        const held = this.db.get<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events
          WHERE kind = 'CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY' AND reason_code = 'BUZZ_LOCAL_SEND_POLICY_REFUSED'
            AND json_extract(evidence_json, '$.messageId') = ? ORDER BY rowid DESC LIMIT 1`, [message.messageId]);
        const previous = held ? JSON.parse(held.evidence_json).policyBinding as BuzzPolicyBinding | undefined : undefined;
        if (!previous || !policyBinding || !policyBinding.signer) return false;
        const changed = previous.routeDigest !== policyBinding.routeDigest || previous.signer !== policyBinding.signer ||
          (typeof previous.policyDigest === "string" && typeof policyBinding.policyDigest === "string" &&
            previous.policyDigest !== policyBinding.policyDigest);
        if (!changed) return false;
      }
      if (!registered) return true;
      rearmRetainedDeliveries(this.db, { sessionId: message.targetSessionId, roleKey: message.roleKey,
        bindingGeneration: message.bindingGeneration, signerReadyMessageId: message.messageId });
      return true;
    });
  }

  #recordSignerNotReady(message: Pick<OutboxMessage, "messageId" | "targetSessionId" | "bindingGeneration" | "roleKey" | "runId">,
    destination: SentDestination, signer: string | null, source: string, attemptNumber: number,
    reasonCode: ReasonCode = ReasonCode.BUZZ_SIGNER_NOT_REGISTERED, policyBinding?: BuzzPolicyBinding): void {
    const recorded = this.audit.record({ kind: "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY",
      reasonCode, roleKey: message.roleKey,
      sessionId: message.targetSessionId, runId: message.runId,
      evidence: { messageId: message.messageId, targetSessionId: message.targetSessionId,
        bindingGeneration: message.bindingGeneration, ...destination, signer, source, attemptNumber, ...(policyBinding ? { policyBinding } : {}),
        ...(source === "READBACK" ? { registered: reasonCode === ReasonCode.BUZZ_SIGNER_NOT_REGISTERED ? false : null } :
          { code: "mention_policy", message: "signer not registered for channel" }) } });
    if (!recorded.allowed) throw new Error("Buzz signer refusal evidence was not recorded");
  }

  #markSignerNotReady(messageId: string, claimToken: string, failure: DeliveryFailure): Decision<void> {
    const result = this.db.tx(() => {
      // A precise pre-post refusal settles its destination even if a handover took the claim.
      if (failure.destination) this.db.run(`DELETE FROM outbox_sent_destinations
        WHERE message_id = ? AND room = ? AND recipient = ? AND outcome = 'PENDING_SEND'`,
      [messageId, failure.destination.room, failure.destination.recipient]);
      const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ? AND kind = 'CEO_NOTIFICATION'
        AND status = 'IN_FLIGHT' AND claim_token = ? AND ${liveDeliveryTarget("outbox")}`, [messageId, claimToken]);
      if (!row || !failure.destination || !failure.signerNotRegistered) return null;
      this.db.run(`UPDATE outbox SET status = 'PENDING', attempts = attempts + 1, last_error = ?,
        failure_class = 'repairable', reason_code = ?, retry_eligible = 0, next_attempt_at = NULL,
        claim_token = NULL, claimed_at = NULL WHERE message_id = ?`,
      [failure.error.slice(0, 500), failure.signerNotRegistered.reasonCode ?? ReasonCode.BUZZ_SIGNER_NOT_REGISTERED, messageId]);
      this.#recordSignerNotReady(hydrate(row), failure.destination, failure.signerNotRegistered.signer,
        failure.signerNotRegistered.source, row.attempts + 1, failure.signerNotRegistered.reasonCode, failure.signerNotRegistered.policyBinding);
      return allow(failure.signerNotRegistered.reasonCode ?? ReasonCode.BUZZ_SIGNER_NOT_REGISTERED, undefined,
        { messageId, failureClass: "repairable", attempts: row.attempts + 1, retained: true });
    });
    return result ?? this.staleClaim(messageId);
  }

  /**
   * Records a failed delivery attempt against the durable retry policy (§34.1).
   *
   * A failure is either *deferred* or terminal — never immediately re-queued. The row
   * returns to PENDING only together with a future `next_attempt_at`, and only when the
   * recorded failure class is one whose cause can clear on its own and the attempt budget
   * is not spent. Everything else is REJECTED, so a contract or security failure cannot be
   * retried into an infinite send loop.
   */
  markAttemptFailed(
    messageId: string,
    claimToken: string,
    failure: DeliveryFailure | string,
  ): Decision<void> {
    if (typeof failure === "object" && failure.signerNotRegistered &&
      (failure.signerNotRegistered.source === "READBACK" || isBuzzSignerRefusal(failure.error))) {
      return this.#markSignerNotReady(messageId, claimToken, failure);
    }
    const classified = normalizeFailure(failure);
    if (typeof failure === "object" && failure.ceoRefusal && failure.destination &&
      !failure.routeAbsent && (classified.failureClass === "contract" || classified.failureClass === "security")) {
      const actor = this.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = 'CEO' AND binding_generation = ?",
        [failure.ceoRefusal.bindingGeneration]);
      const recorded = this.audit.record({ kind: "CEO_NOTIFICATION_BUZZ_REFUSED", sessionId: failure.ceoRefusal.targetSessionId,
        evidence: { messageId, ...failure.destination, ...failure.ceoRefusal, actorId: actor?.actor_id ?? null,
          failureClass: classified.failureClass, error: classified.error.slice(0, 500) } });
      if (!recorded.allowed) throw new Error("Buzz refusal history was not recorded");
    }

    // FCR-10, FCR-14: the in-flight send this attempt recorded settles here, whether or not this claim
    // is still held (a handover may have taken the row while the send was pending): an unknown outcome
    // stays on record as UNKNOWN, as an accepted send's ACCEPTED does (`recordAcceptedSend`), so no
    // later attempt sends to the same room and recipient again; a send the relay refused outright did
    // not land, and its in-flight record is removed so the row can be tried there again.
    if (typeof failure === "object" && failure.destination) {
      if (classified.failureClass === "unknown_observed") {
        recordSentDestination(this.db, messageId, failure.destination, "UNKNOWN", this.clock.nowIso());
      } else {
        this.db.run(
          `DELETE FROM outbox_sent_destinations WHERE message_id = ? AND room = ? AND recipient = ? AND outcome = 'PENDING_SEND'`,
          [messageId, failure.destination.room, failure.destination.recipient],
        );
      }
    }
    const row = this.db.get<{
      attempts: number;
      retry_max_attempts: number;
      retry_backoff_ms: number;
      kind: string;
    }>(
      `SELECT attempts, retry_max_attempts, retry_backoff_ms, kind
         FROM outbox WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?`,
      [messageId, claimToken],
    );
    if (!row) return this.staleClaim(messageId);
    const attempts = row.attempts + 1;
    // ACP-R1-01, ACP-R2-01 — a failed attempt never ends an actionable instruction or a CEO
    // notification: whatever the failure class and however many attempts, it goes back to PENDING.
    // Only an ACK or a recorded supersession ends it.
    if (isRetainedKind(row.kind)) {
      // An unknown outcome (#451: a timed-out send may already be at the far end) is not put back in
      // the queue and is never re-sent to the same receiver on a timer: Buzz has no same-id dedupe
      // and no receipt lookup. A CEO send after verified readiness stays PENDING; older send paths
      // retain SENT. Both are flagged `unknown_observed`, awaiting the holder's ACK. Only a handover
      // to a new receiver delivers it again (`HANDED_TO_NEW_RECEIVER_SQL`).
      if (classified.failureClass === "unknown_observed") {
        const status = row.kind === MessageKind.CEO_NOTIFICATION && typeof failure === "object" && failure.buzzSignerReady
          ? "PENDING" : "SENT";
        const sent = this.db.run(
          `UPDATE outbox SET status = ?, sent_at = CASE WHEN ? = 'SENT' THEN ? ELSE sent_at END, attempts = ?, last_error = ?, failure_class = ?,
                             retry_eligible = 0, next_attempt_at = NULL, reason_code = NULL,
                             claim_token = NULL, claimed_at = NULL
            WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
              AND ${liveDeliveryTarget("outbox")}`,
          [status, status, this.clock.nowIso(), attempts, classified.error.slice(0, 500), classified.failureClass, messageId, claimToken],
        ).changes;
        if (sent !== 1) return this.staleClaim(messageId);
        return allow(ReasonCode.OK, undefined, { messageId, failureClass: classified.failureClass, attempts, retained: true,
          ...outboxDeliveryReadback({ status, failureClass: classified.failureClass }) });
      }
      // An attempt refused before sending because its target had no route (no Buzz room or no channel
      // identity — `DeliveryFailure.routeAbsent`, set at that refusal) sent nothing: it is recorded as
      // route-absent, and the route's return re-arms it (`rearmRetainedDeliveries`). A failure whose
      // cause can clear on its own is deferred on the backoff schedule, with no attempt budget. An
      // authority refusal or a wrong target (a contract or security refusal from the relay) is kept
      // PENDING with its failure on record, unsent, and no route change reactivates it — whatever
      // the target's route is by the time the refusal is recorded.
      const routeAbsent = typeof failure === "object" && failure.routeAbsent === true;
      const failureClass = routeAbsent ? ROUTE_ABSENT_FAILURE_CLASS : classified.failureClass;
      const deferrable = !routeAbsent && RETRYABLE_FAILURE_CLASSES.has(classified.failureClass);
      const base = Number.isSafeInteger(row.retry_backoff_ms) && row.retry_backoff_ms > 0 ? row.retry_backoff_ms : 1000;
      const retainedNext = deferrable ? isoPlus(this.clock.nowIso(), retryDelayMs(attempts, base)) : null;
      const kept = this.db.run(
        `UPDATE outbox SET status = 'PENDING', attempts = ?, last_error = ?, failure_class = ?,
                           retry_eligible = ?, next_attempt_at = ?, reason_code = NULL,
                           claim_token = NULL, claimed_at = NULL
          WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
            AND ${liveDeliveryTarget("outbox")}`,
        [attempts, classified.error.slice(0, 500), failureClass, deferrable ? 1 : 0, retainedNext,
          messageId, claimToken],
      ).changes;
      if (kept !== 1) return this.staleClaim(messageId);
      return allow(ReasonCode.OK, undefined, {
        messageId,
        failureClass,
        attempts,
        nextAttemptAt: retainedNext,
        retained: true,
      });
    }
    const retryPolicyIsValid =
      Number.isSafeInteger(row.retry_max_attempts) &&
      row.retry_max_attempts >= 0 &&
      Number.isSafeInteger(row.retry_backoff_ms) &&
      // A zero-delay retry would recreate the immediate retry loop that §34.1 forbids.
      row.retry_backoff_ms > 0;
    const retryable =
      retryPolicyIsValid &&
      classified.retryable &&
      RETRYABLE_FAILURE_CLASSES.has(classified.failureClass) &&
      attempts < row.retry_max_attempts;
    const nextAttemptAt = retryable
      ? isoPlus(this.clock.nowIso(), retryDelayMs(attempts, row.retry_backoff_ms))
      : null;
    // A defective stored policy is a different denial from "this failure earns no retry":
    // the row carries no usable schedule at all, so nothing about the failure class can
    // rescue it. Naming that separately keeps an operator from reading a policy defect as a
    // verdict on the transport.
    const terminalReason = retryPolicyIsValid
      ? ReasonCode.OUTBOX_DELIVERY_REJECTED
      : ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE;
    const changes = this.db.run(
      `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, failure_class = ?,
                         retry_eligible = ?, next_attempt_at = ?, reason_code = ?,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND ${liveDeliveryTarget("outbox")}`,
      [
        retryable ? "PENDING" : "REJECTED",
        attempts,
        classified.error.slice(0, 500),
        classified.failureClass,
        retryable ? 1 : 0,
        nextAttemptAt,
        retryable ? null : terminalReason,
        messageId,
        claimToken,
      ],
    ).changes;
    if (changes !== 1) {
      return this.staleClaim(messageId);
    }
    if (!retryable) {
      return deny(
        terminalReason,
        retryPolicyIsValid
          ? "delivery failure is not eligible for another attempt"
          : "stored retry policy is unusable, so the delivery cannot be deferred",
        {
          messageId,
          failureClass: classified.failureClass,
          attempts,
          retryMaxAttempts: row.retry_max_attempts,
          retryPolicyIsValid,
        },
      );
    }
    return allow(ReasonCode.OK, undefined, {
      messageId,
      failureClass: classified.failureClass,
      attempts,
      nextAttemptAt,
    });
  }

  /**
   * ACK from a runtime session. An ACK carrying a revoked or superseded generation is
   * audit-only and does not change state (§15.7, §34.4).
   */
  acknowledge(
    messageId: string,
    fromSessionId: string,
    generation: number,
    sessionIncarnation?: string,
  ): Decision<void> {
    return this.db.tx(() => this.acknowledgeInTx(messageId, fromSessionId, generation, sessionIncarnation));
  }

  private acknowledgeInTx(
    messageId: string,
    fromSessionId: string,
    generation: number,
    sessionIncarnation: string | undefined,
  ): Decision<void> {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });

    // A pending in-band row has one acknowledgement authority, the one `role_dispatch_ack` uses, so
    // the run-scoped route and the runless one cannot disagree about who may settle it. `run_ack`
    // has already fenced the caller to a run it owns; the row's own role generation decides the
    // rest. A holder-claimed kind is never in band, so the refusal below still covers it.
    if (row.status === "PENDING" && this.#isInBand(row)) {
      return this.#acknowledgeInBandInTx(row, fromSessionId, sessionIncarnation ?? null);
    }

    // This route is scoped by a *tuple*, not by a message. The `messageId` is whatever the caller
    // supplied, and everything below checks that the caller holds the row's role generation — so a
    // caller presenting its own perfectly valid `run_ack` tuple plus an arbitrary id could drive a
    // holder-claimed row straight to `ACKED`: terminal, and past `completeForHolder`, which is the
    // only place an owner-message's ingress claim is settled.
    //
    // Fail closed on the kind. A holder-claimed message is settled over its holder's own
    // authenticated connection or not at all, which is the same boundary `claimDeliverable`'s
    // exclusion draws on the way out — this is that boundary on the way back in.
    if (HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind)) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: { messageId, kind: row.kind, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }), ackGeneration: generation },
      });
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "this message is settled over its holder's own connection, not through the generic ack",
        { messageId, kind: row.kind },
      );
    }

    // §15.7 / §34.4 — matching the stored envelope is not enough. A late ACK from a
    // generation that has since been revoked is audit-only, as is an ACK for a message
    // that has expired or was already rejected.
    // The role's current holder is its actor's runtime (`CURRENT_HOLDER_SESSION`), the one delivery
    // addresses: after a surviving runtime move the binding's own session is gone.
    const current = this.db.get<{ binding_generation: number; session_id: string }>(
      `SELECT a.binding_generation, ${CURRENT_HOLDER_SESSION} AS session_id FROM assignments a
        ${HOLDER_ACTOR_JOIN}
        JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
        WHERE a.role_key = ? AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')`,
      [row.role_key],
    );
    const staleGeneration =
      !current ||
      current.binding_generation !== generation ||
      current.session_id !== fromSessionId;
    // Delivery and ACK agree on lifetime: a kind delivery never skips for its TTL is acknowledged past
    // it too (ACP-R2-01).
    const expired = row.status === "EXPIRED" || (!isRetainedKind(row.kind) && row.expires_at <= this.clock.nowIso());
    const ineligible =
      row.status === "REJECTED" ||
      expired ||
      row.status === "ACKED";
    const rejectionCode = expired
      ? ReasonCode.OUTBOX_EXPIRED
      : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED;

    if (staleGeneration || ineligible) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: rejectionCode,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: {
          messageId,
          ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }),
          ackGeneration: generation,
          currentGeneration: current?.binding_generation ?? null,
          currentSession: current?.session_id ?? null,
        },
      });
      return deny(
        rejectionCode,
        staleGeneration
          ? "ack came from a generation that is no longer active"
          : `message is ${outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }).status} and cannot be acknowledged`,
        { messageId, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }), ackGeneration: generation },
      );
    }

    const active = current!;

    if (
      row.target_session_id !== fromSessionId ||
      row.binding_generation !== generation ||
      active.session_id !== row.target_session_id
    ) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: {
          messageId,
          expectedSession: row.target_session_id,
          expectedGeneration: row.binding_generation,
          gotGeneration: generation,
          activeSession: active.session_id,
        },
      });
      return deny(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "ack came from a session/generation that does not own this message",
        { messageId, expectedGeneration: row.binding_generation, gotGeneration: generation },
      );
    }

    this.db.run(`UPDATE outbox SET status = 'ACKED', acked_at = ? WHERE message_id = ?`, [
      this.clock.nowIso(),
      messageId,
    ]);
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * Acknowledges one in-band row, runless: the authority is the addressed row and the caller's own
   * authenticated session, never a run (`role_dispatch_ack`). A `DRAIN_REQUEST` carries no run, and
   * a canonical CTO that owns none still has to be able to settle it.
   */
  acknowledgeInBand(messageId: string, sessionId: string, sessionIncarnation: string): Decision<void> {
    return this.db.tx(() => {
      const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });
      return this.#acknowledgeInBandInTx(row, sessionId, sessionIncarnation);
    });
  }

  /** Called by the handoff service after its package checks, in the same transaction. */
  acknowledgeHandoffInBand(messageId: string, sessionId: string, sessionIncarnation: string): Decision<void> {
    return this.db.tx(() => {
      const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });
      if (row.kind !== MessageKind.HANDOFF_PACKAGE) return deny(ReasonCode.INVALID_ARGUMENT, "message is not a handoff package");
      return this.#acknowledgeInBandInTx(row, sessionId, sessionIncarnation, true);
    });
  }

  /**
   * #246 C4 — the `DrivenMode` of a session, by the one predicate the in-band routing above reads, so
   * the runtime that drives a session and the outbox that routes to it never disagree about it.
   */
  drivenModeOf(sessionId: string): DrivenMode {
    return drivenModeOf(this.db, sessionId);
  }

  /** #246 C4 — what a session's one driven-spawn record names (`drivenSpawnRecordOf`). */
  drivenSpawnRecordOf(sessionId: string): DrivenSpawnRecord | null {
    return drivenSpawnRecordOf(this.db, sessionId);
  }

  /** In-band, in `claimDeliverable`'s terms: an in-band kind addressed to a canonical or provisioned runtime. */
  #isInBand(row: RawOutbox): boolean {
    return deliveredInBand(this.db, row.kind, row.target_session_id, row.role_key, row.binding_generation);
  }

  /**
   * The one in-band acknowledgement authority, for `run_ack` and `role_dispatch_ack` alike.
   *
   * The caller must be the row's exact target and, through `exactHolderTarget` with the row's own
   * role key and generation, that generation's ACTIVE holder at the incarnation its connection
   * presented — the predicate `pendingInBandFor` lists by, so a session can settle exactly what it
   * can see. A holder-claimed kind, a row that is not in band, and a row that is expired, rejected or
   * already settled are refused. Only `PENDING -> ACKED` is written, as a compare-and-set.
   */
  #acknowledgeInBandInTx(row: RawOutbox, sessionId: string, sessionIncarnation: string | null, handoff = false): Decision<void> {
    const messageId = row.message_id;
    const refuse = (reasonCode: ReasonCode, message: string): Decision<void> => {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode,
        runId: row.run_id,
        sessionId,
        roleKey: row.role_key,
        evidence: { messageId, kind: row.kind, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }), inBand: true },
      });
      return deny(reasonCode, message, { messageId, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) });
    };
    if (HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind)) {
      return refuse(
        ReasonCode.INVALID_ARGUMENT,
        "this message is settled over its holder's own connection, not through the generic ack",
      );
    }
    if (!this.#isInBand(row)) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "this message is not delivered in band; acknowledge it with run_ack");
    }
    if (row.kind === MessageKind.HANDOFF_PACKAGE && !handoff) {
      return refuse(ReasonCode.HANDOFF_ACK_REQUIRED, "a handoff package is settled with handoff_ack");
    }
    if (row.status === "EXPIRED") {
      return refuse(ReasonCode.OUTBOX_EXPIRED, `message is ${outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }).status} and cannot be acknowledged`);
    }
    if (row.status !== "PENDING") {
      return refuse(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, `message is ${outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }).status} and cannot be acknowledged`);
    }
    const holder =
      sessionIncarnation !== null &&
      row.target_session_id === sessionId &&
      this.db.get<{ held: number }>(
        `SELECT ${exactHolderTarget("bound")} AS held`,
        [row.role_key, row.binding_generation, row.target_session_id, sessionIncarnation],
      )?.held === 1;
    if (!holder) {
      return refuse(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "ack came from a session, generation or incarnation that does not hold this message",
      );
    }
    const now = this.clock.nowIso();
    const changed = this.db.run(
      `UPDATE outbox SET status = 'ACKED', acked_at = ? WHERE message_id = ? AND status = 'PENDING'`,
      [now, messageId],
    ).changes;
    if (changed !== 1) {
      return refuse(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "message left PENDING before it could be acknowledged");
    }
    this.audit.record({
      kind: "OUTBOX_ACKED_IN_BAND",
      reasonCode: ReasonCode.OK,
      runId: row.run_id,
      sessionId,
      roleKey: row.role_key,
      evidence: { messageId, kind: row.kind, bindingGeneration: row.binding_generation },
    });
    this.db.afterCommit(() => this.#inBandWokenAt.delete(messageId));
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The pending in-band rows addressed to one exact runtime, oldest first: read-only.
   *
   * `sessionIncarnation` comes from the caller's authenticated connection, and the row must be
   * addressed to the current holder of its own role generation down to that incarnation
   * (`exactHolderTarget`) — so a session sees nothing addressed to another session, to a
   * generation it no longer holds, or to a runtime it replaced. Delivery-attempt timestamps do
   * not dispose of actionable instructions.
   */
  pendingInBandFor(sessionId: string, sessionIncarnation: string): InBandDispatch[] {
    const rows = this.db.all<RawOutbox>(
      `SELECT o.* FROM outbox o
        WHERE o.status = 'PENDING'
          AND o.target_session_id = ?
          AND ${inBandRow("o")}
          AND ${exactHolderTarget("o")}
        ORDER BY o.created_at, o.rowid`,
      [sessionId, sessionIncarnation],
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      bindingGeneration: row.binding_generation,
      payloadDigest: row.payload_digest,
      kind: row.kind as MessageKind,
      runId: row.run_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      payload: readPayload(row.payload_json),
    }));
  }

  /**
   * Whether this exact holder has anything a wake would send it to read: a row `pendingInBandFor`
   * lists, an owner or peer message `claimForHolder` would hand over, report unresolved or report
   * withheld, or a refusal notice it is owed. Only reads.
   *
   * The registration wake asks this (FIX-ROLE-WAKE): a registration wake with no confirmed work is
   * skipped, and a relay registers again on every daemon start. It errs toward true: a withheld row
   * counts, because the claim still shows it to the holder.
   */
  hasWorkForHolder(holder: HolderIdentity): boolean {
    if (this.pendingInBandFor(holder.targetSessionId, holder.sessionIncarnation).length > 0) return true;
    if (this.hasHolderMessagesFor(holder)) return true;
    return this.peerMessageRefusalNoticesFor(holder).length > 0;
  }

  /** Whether this exact authenticated holder has owner/peer mail to drain. */
  hasHolderMessagesFor(holder: HolderIdentity): boolean {
    const queued = this.db.get<{ queued: number }>(
      `SELECT EXISTS (
         SELECT 1 FROM outbox o
          WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND o.status IN ('PENDING','SENT')
            AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${exactHolderTarget("o")}
       ) AS queued`,
      [holder.roleKey, holder.bindingGeneration, holder.targetSessionId, holder.sessionIncarnation],
    );
    return queued?.queued === 1;
  }

  /**
   * Installs the CTO role's wake port. Rows enqueued before this are not woken by it; the next
   * `wakeInBandPending` finds them, which is why the composition root runs one right after.
   */
  attachInBandWake(wake: InBandWake): void {
    this.#inBandWake = wake;
  }

  /**
   * Wakes the role of every pending in-band row not woken for within `IN_BAND_REWAKE_MS`.
   *
   * Run when the wake port is attached at startup. Delivery recovery otherwise follows work,
   * registration and transport-availability events. A row whose target no longer holds its role
   * generation is skipped; a wake to a former holder is the mistake `RoleConversationPort.wake` exists to refuse.
   * A wake that fails is audited by `#wakeInBand`. Global calls respect the re-wake window;
   * recovery may retry one exact run/owner immediately after restoring its credential.
   */
  async wakeInBandPending(owner?: HolderIdentity & { runId: string }): Promise<void> {
    if (!this.#inBandWake) return;
    const now = this.clock.nowIso();
    const rows = this.db.all<{ message_id: string; role_key: string }>(
      `SELECT o.message_id, o.role_key FROM outbox o
        WHERE o.status = 'PENDING'
          AND ${inBandRow("o")}
          AND ${liveDeliveryTarget("o")}
          ${owner ? `AND o.run_id = ? AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${exactHolderTarget("o")}` : ""}
        ORDER BY o.created_at, o.rowid`,
      owner ? [owner.runId, owner.roleKey, owner.bindingGeneration, owner.targetSessionId, owner.sessionIncarnation] : [],
    );
    // The memory follows the queue: a row that left PENDING is forgotten, so it cannot grow.
    const pending = new Set(rows.map((row) => row.message_id));
    if (!owner) {
      for (const messageId of [...this.#inBandWokenAt.keys()]) {
        if (!pending.has(messageId)) this.#inBandWokenAt.delete(messageId);
      }
    }
    const nowMs = Date.parse(now);
    const due = rows
      .filter((row) => {
        const last = this.#inBandWokenAt.get(row.message_id);
        // Recovery has just restored this exact owner's credential. Its earlier handover wake
        // failed before adoption, so retry those rows immediately without changing other throttles.
        return owner !== undefined || last === undefined || nowMs - last >= IN_BAND_REWAKE_MS;
      })
      .map((row) => ({ messageId: row.message_id, roleKey: row.role_key }));
    await this.#wakeInBand(due, "rewake");
  }

  /**
   * One wake per role for these rows, fire-and-forget for the caller that does not await it.
   *
   * The rows are marked woken before the wake is sent, so a tick that runs while a wake is still in
   * flight does not send a second. Nothing is marked while no port is attached: no wake was tried.
   * The returned promise never rejects — a refused or thrown wake becomes one
   * `OUTBOX_IN_BAND_WAKE_FAILED` audit row carrying the decision's reason code and never the
   * thrown error's text, which for a socket error names the endpoint's private path.
   */
  #wakeInBand(
    rows: ReadonlyArray<{ messageId: string; roleKey: string }>,
    trigger: "enqueue" | "rewake" | "handover",
  ): Promise<void> {
    const wake = this.#inBandWake;
    if (!wake || rows.length === 0) return Promise.resolve();
    const nowMs = Date.parse(this.clock.nowIso());
    const byRole = new Map<string, string[]>();
    for (const row of rows) {
      this.#inBandWokenAt.set(row.messageId, nowMs);
      byRole.set(row.roleKey, [...(byRole.get(row.roleKey) ?? []), row.messageId]);
    }
    return Promise.all(
      [...byRole].map(async ([roleKey, messageIds]) => {
        let refused: ReasonCode | null = null;
        let threw = false;
        try {
          const woke = await wake(roleKey, messageIds);
          if (!woke.allowed) refused = woke.reasonCode;
        } catch {
          refused = ReasonCode.ROLE_PEER_FAILED;
          threw = true;
        }
        if (refused === null) return;
        try {
          this.audit.record({
            kind: "OUTBOX_IN_BAND_WAKE_FAILED",
            reasonCode: refused,
            roleKey,
            evidence: { trigger, messageIds, threw },
          });
        } catch {
          // A closed database cannot take the row; the wake is retried after the window anyway.
        }
      }),
    ).then(() => undefined);
  }

  /**
   * Rebind durable role mail inside the authenticated adoption transaction. Completion still
   * requires the exact current holder; a crash before ACK preserves the original message ID.
   */
  adoptHolderMessages(roleKey: string, generation: number, sessionId: string, deferCanonicalPeers = false): void {
    // A CEO notification SENT to the previous holder and never ACKed is delivered again to this one.
    if (roleKey === "CEO") readdressCeoNotifications(this.db, generation, sessionId);
    this.db.run(`UPDATE outbox SET binding_generation = ?, target_session_id = ?,
      reason_code = CASE WHEN kind = 'CEO_NOTIFICATION' AND reason_code IN
        ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED') THEN reason_code ELSE ? END
      WHERE role_key = ? AND kind IN (${HOLDER_CLAIMED_KIND_SQL}, 'CEO_NOTIFICATION') AND status IN ('PENDING','SENT')
        AND (? = 0 OR kind <> 'PEER_MESSAGE')`,
      [generation, sessionId, ReasonCode.OUTBOX_RETARGETED, roleKey, deferCanonicalPeers ? 1 : 0]);
    // ACP-R1-01: the instructions a revoke or a stopped holder kept for this role are handed to the
    // new holder under the one handover policy. A reply held for a provisioned owner's renewal stays
    // the renewal's (`carryHeldEscalationReplies`).
    const to = { generation, sessionId };
    const kept = this.db.all<RawOutbox>(
      `SELECT o.* FROM outbox o
        WHERE o.role_key = ? AND o.binding_generation < ? AND ${handoverInstructionRowSql("o")}
        ORDER BY o.created_at, o.rowid`,
      [roleKey, generation],
    );
    const carried: string[] = [];
    const superseded: string[] = [];
    for (const row of kept) {
      const handover = this.#instructionHandover(row, to);
      if (!this.#applyInstructionHandover(row, handover, to, "ADOPTION")) continue;
      (handover.kind === "CARRY" ? carried : superseded).push(row.message_id);
    }
    if (carried.length > 0 || superseded.length > 0) {
      this.audit.record({
        kind: "OUTBOX_INSTRUCTIONS_HANDED_OVER",
        reasonCode: ReasonCode.OUTBOX_RETARGETED,
        roleKey,
        evidence: { path: "ADOPTION", toGeneration: generation, toSessionId: sessionId, retargeted: carried, rejected: superseded },
      });
    }
    // An adoption or rebind is a route change for everything the new holder now holds.
    rearmRetainedDeliveries(this.db, { sessionId, roleKey, bindingGeneration: generation });
    if (roleKey === "CEO") this.db.afterCommit(() => { void this.deliverCeoNotifications(); });
  }

  retargetOrReject(
    roleKey: string,
    fromGeneration: number,
    toGeneration: number,
    toSessionId: string,
    options: {
      /**
       * Revoke shape only (`fromGeneration === toGeneration`), and only from
       * `BindingRegistry.revoke`'s `holdPeerMessagesForSameActorSuccessor`: a `PENDING`
       * `IDENTITY_BOUND_KINDS` row addressed to exactly `sessionId` and never carried before is
       * left untouched — neither retargeted nor rejected — and listed under `held`, for
       * `carryPeerMessagesToSameActorSuccessor` to carry or reject in the same transaction. Such a
       * row that *was* carried before is rejected as it would be without this option, and its id
       * is added to `alreadyCarried`. Every other row is decided exactly as it is without it.
       */
      holdPeerMessagesAddressedTo?: { sessionId: string; alreadyCarried: string[] };
      /**
       * Revoke shape only (`fromGeneration === toGeneration`), and only from `BindingRegistry.revoke`'s
       * `holdEscalationRepliesForRenewal` — continuity's revocation of a BOOTSTRAP_CTO it recovers on
       * the same session. A PENDING, unclaimed, never-carried ESCALATION_REPLY that still answers its
       * run (`#escalationReplyCarriable` at this very generation) is left PENDING at this generation
       * and recorded as held, for `carryHeldEscalationReplies` to carry or reject at the renewal.
       * Every other row is decided exactly as it is without it.
       */
      holdEscalationRepliesForRenewal?: boolean;
    } = {},
  ): { retargeted: string[]; rejected: string[] } {
    const now = this.clock.nowIso();
    const pending = this.db.all<RawOutbox>(
      `SELECT * FROM outbox WHERE role_key = ? AND binding_generation = ?
        AND (
          status IN ('PENDING','IN_FLIGHT')
          OR (status = 'SENT' AND kind IN (${HOLDER_CLAIMED_KIND_SQL}, ${IN_BAND_KIND_SQL}))
        )`,
      [roleKey, fromGeneration],
    );

    const retargeted: string[] = [];
    const rejected: string[] = [];
    const held: string[] = [];

    if (roleKey === "CEO" && toGeneration !== fromGeneration) readdressCeoNotifications(this.db, toGeneration, toSessionId);

    for (const row of pending) {
      const holderClaimed = HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind);
      if (holderClaimed || row.kind === MessageKind.CEO_NOTIFICATION) {
        // A canonical recovery owns the peer carry/refusal record in this transaction.
        if (row.kind === MessageKind.PEER_MESSAGE && toGeneration === fromGeneration &&
            options.holdPeerMessagesAddressedTo?.sessionId === row.target_session_id) continue;
        if (holderClaimed && !this.#handOverEligible(row.message_id)) {
          this.db.run("UPDATE outbox SET status = 'REJECTED', reason_code = ? WHERE message_id = ?",
            [ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH, row.message_id]);
          this.settleHolderClaimOrThrow(row.message_id);
          rejected.push(row.message_id);
          continue;
        }
        // Role mail outlives its holder. SENT without ACK is redelivered with the same durable ID.
        // A revoke has no recipient yet; leave it queued until a later authenticated binding.
        if (toGeneration !== fromGeneration) {
          this.db.run(`UPDATE outbox SET binding_generation = ?, target_session_id = ?,
            reason_code = CASE WHEN kind = 'CEO_NOTIFICATION' AND reason_code IN
              ('BUZZ_SIGNER_NOT_REGISTERED','BUZZ_SIGNER_MEMBERSHIP_UNVERIFIED','BUZZ_LOCAL_SEND_POLICY_REFUSED') THEN reason_code ELSE ? END,
            claim_token = NULL, claimed_at = NULL WHERE message_id = ? AND status IN ('PENDING','SENT')`,
            [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id]);
          retargeted.push(row.message_id);
        }
        continue;
      }
      const escalationReply = row.kind === MessageKind.ESCALATION_REPLY;
      // The renewal hold: the reply stays exactly as it is, addressed to this generation, which only
      // the same owner's renewal at the next generation can take it from (see the option).
      if (
        escalationReply &&
        toGeneration === fromGeneration &&
        options.holdEscalationRepliesForRenewal === true &&
        this.#escalationReplyUnclaimed(row, now) &&
        this.#stillHeld(row)
      ) {
        this.audit.record({
          kind: ESCALATION_REPLY_HELD,
          runId: row.run_id,
          roleKey,
          sessionId: row.target_session_id,
          evidence: { messageId: row.message_id, correlationId: row.message_id, fromGeneration, fromSession: row.target_session_id },
        });
        continue;
      }
      // ACP-R1-01: an actionable instruction, whatever its route, follows the one handover policy —
      // carried to the successor, kept for the next authenticated binding on a revoke, or superseded
      // with its reason. A kept row is in neither list, so `BindingRegistry.revoke` does not reject it.
      const successor = toGeneration === fromGeneration ? null : { generation: toGeneration, sessionId: toSessionId };
      const handover = this.#instructionHandover(row, successor);
      if (handover.kind !== "OUT_OF_SCOPE") {
        const applied = this.#applyInstructionHandover(row, handover, successor, successor ? "TAKEOVER" : "REVOKE");
        if (handover.kind === "CARRY" && applied) retargeted.push(row.message_id);
        else if (handover.kind === "KEEP") held.push(row.message_id);
        else if (handover.kind === "SUPERSEDE" && applied) rejected.push(row.message_id);
        continue;
      }
      // Every other outward delivery keeps its delivery-window rules.
      const retargetable = escalationReply
        ? toGeneration !== fromGeneration && this.#escalationReplyUnclaimed(row, now) &&
          this.#escalationReplyCarriable(row, toGeneration, toSessionId)
        : row.status === "PENDING" && RETARGETABLE_KINDS.has(row.kind as MessageKind) && row.expires_at > now;
      const carriedOnce = escalationReply
        ? ` AND claim_token IS NULL AND (reason_code IS NULL OR reason_code <> ?)` : "";
      const moved = retargetable
        ? this.db.run(
            `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
               WHERE message_id = ? AND status = 'PENDING'${carriedOnce}`,
            escalationReply
              ? [
                  toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id,
                  ReasonCode.OUTBOX_RETARGETED,
                ]
              : [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id],
          ).changes
        : 0;
      if (moved === 1) {
        retargeted.push(row.message_id);
        if (escalationReply) this.#recordEscalationReplyCarry(row, toGeneration, toSessionId);
      } else {
        this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
            WHERE message_id = ?`,
          [
            !holderClaimed && row.expires_at <= now
              ? ReasonCode.OUTBOX_EXPIRED
              : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
            row.message_id,
          ],
        );
        rejected.push(row.message_id);
      }
    }

    // A takeover is a route change for everything it addressed to the successor.
    if (toGeneration !== fromGeneration) {
      rearmRetainedDeliveries(this.db, { sessionId: toSessionId, roleKey, bindingGeneration: toGeneration });
    }

    this.audit.record({
      kind: "OUTBOX_FENCE",
      reasonCode: ReasonCode.OUTBOX_RETARGETED,
      roleKey,
      evidence: { fromGeneration, toGeneration, toSessionId, retargeted, rejected, held },
    });

    return { retargeted, rejected };
  }

  /** Carry unread peer mail only across an authenticated same-conversation succession.
   * The first carry record preserves the admitted source; later carries validate against it.
   * UnACKed SENT mail keeps its ID for at-least-once delivery. Invalid or settled sources refuse.
   */
  carryPeerMessagesToSameActorSuccessor(
    authority: PeerMessageCarryAuthority,
    alreadyCarried: readonly string[] = [],
  ): { retargeted: string[]; rejected: string[] } {
    const succession = peerMessageCarrySuccessionOf(authority, this.db);
    if (succession === null) {
      return fail(ReasonCode.COMPLETION_AUTHORITY_DENIED, "PEER_MESSAGE_CARRY_AUTHORITY_DENIED", {});
    }
    const { roleKey, fromGeneration, fromSessionId, toGeneration, toSessionId } = succession;
    return this.db.tx(() => {
      const record = (row: RawOutbox, refusal: PeerMessageCarryRefusal | null): void => {
        const outcome = refusal === null ? "CARRIED" : "REFUSED";
        // ACP-RESTART-04: every refused row is owed a notice to the CEO, kept until a holder of the
        // role reports it — the successor or whoever holds the role after it.
        if (refusal !== null) this.#owePeerMessageNotice(row, refusal);
        // One refusal per message: a row revived and refused again keeps its first record.
        if (refusal !== null && this.db.get(
          `SELECT 1 AS present FROM peer_message_carries WHERE message_id = ? AND outcome = 'REFUSED'`,
          [row.message_id],
        )) return;
        const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
        // ACP-RESTART-02: the record binds the digest of the admitted row its key names — read
        // from that row, not from the pointer — and the insert trigger checks it against that row.
        const sourcePayloadDigest = pointer
          ? this.#admittedPayloadDigest(pointer.sourceChannel, pointer.sourceNonce)
          : null;
        this.db.withPeerMessageCarry(authority, () =>
          this.db.run(
            `INSERT INTO peer_message_carries (
               message_id, outcome, refusal, source_channel, source_nonce, source_payload_digest, role_key,
               from_session_id, from_session_incarnation, from_binding_generation, from_assignment_id,
               to_session_id, to_session_incarnation, to_binding_generation, to_assignment_id,
               actor_id, conversation_uuid, buzz_actor_id, recovery_audit_event_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.message_id, outcome, refusal, pointer?.sourceChannel ?? null, pointer?.sourceNonce ?? null,
              sourcePayloadDigest,
              succession.roleKey,
              succession.fromSessionId, succession.fromSessionIncarnation, succession.fromGeneration,
              succession.fromAssignmentId,
              succession.toSessionId, succession.toSessionIncarnation, succession.toGeneration,
              succession.toAssignmentId,
              succession.actorId, succession.conversationUuid, succession.buzzActorId,
              succession.recoveryAuditEventId, this.clock.nowIso(),
            ],
          ));
      };

      // The revoke's own fence rejected these and settled their turns; only the notice is owed.
      for (const messageId of alreadyCarried) {
        const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
        if (row && IDENTITY_BOUND_KINDS.has(row.kind as MessageKind) && row.status === "REJECTED") {
          record(row, PeerMessageCarryRefusal.ALREADY_CARRIED);
        }
      }

      const rows = this.db.all<RawOutbox>(
        `SELECT * FROM outbox
          WHERE role_key = ? AND binding_generation = ?
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND status IN ('PENDING','IN_FLIGHT','SENT')
          ORDER BY created_at, rowid`,
        [roleKey, fromGeneration],
      ).filter((row) => IDENTITY_BOUND_KINDS.has(row.kind as MessageKind));
      if (rows.length === 0) return { retargeted: [], rejected: [] };

      const retargeted: string[] = [];
      const rejected: string[] = [];
      for (const read of rows) {
        let row = read;
        let refusal = this.#peerMessageCarryRefusal(row, succession);
        // A verified continuation of the same conversation may recover the same unACKed ID
        // after any restart, including a crash after handover. The old first-carry record remains
        // historical evidence; it no longer acts as a delivery budget.
        if ((refusal === PeerMessageCarryRefusal.ALREADY_CARRIED ||
             (refusal === PeerMessageCarryRefusal.ALREADY_CLAIMED && row.status === "SENT")) &&
            succession.proven && row.target_session_id === fromSessionId && this.#handOverEligible(row.message_id) &&
            this.#peerSourceMatchesConversation(row, succession.buzzActorId)) {
          const moved = this.db.run(`UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
            WHERE message_id = ? AND role_key = ? AND binding_generation = ? AND target_session_id = ?
              AND status IN ('PENDING','SENT') AND ${handOverEligibleSql("outbox")}`,
            [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id, roleKey, fromGeneration, fromSessionId]).changes;
          if (moved === 1) retargeted.push(row.message_id);
          continue;
        }
        // Both writes name the whole tuple the read saw, so a row another writer decided in this
        // transaction — carried, handed over, rejected — changes nothing here and is left as it is.
        if (refusal === null) {
          const moved = this.db.run(
            `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
              WHERE message_id = ? AND status = 'PENDING' AND kind = ?
                AND role_key = ? AND binding_generation = ? AND target_session_id = ?
                AND attempts = 0 AND sent_at IS NULL AND claim_token IS NULL
                AND ${handOverEligibleSql("outbox")}`,
            [
              toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id, row.kind,
              roleKey, fromGeneration, fromSessionId,
            ],
          ).changes;
          if (moved === 1) {
            record(row, null);
            retargeted.push(row.message_id);
            continue;
          }
          // Not moved. Decided by someone else (no longer open at the released generation): left
          // alone. Still open there but changed since the read: decided again, and at worst
          // rejected — never left addressed to a generation nobody holds.
          const now = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [row.message_id]);
          if (!now || now.role_key !== roleKey || now.binding_generation !== fromGeneration ||
              !["PENDING", "IN_FLIGHT", "SENT"].includes(now.status)) {
            continue;
          }
          row = now;
          refusal = this.#peerMessageCarryRefusal(now, succession) ?? PeerMessageCarryRefusal.ALREADY_CLAIMED;
        }
        const closed = this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
            WHERE message_id = ? AND status = ? AND role_key = ? AND binding_generation = ?
              AND target_session_id = ?`,
          [
            ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, row.message_id, row.status,
            roleKey, fromGeneration, row.target_session_id,
          ],
        ).changes;
        if (closed !== 1) continue;
        this.settleHolderClaimOrThrow(row.message_id);
        record(row, refusal);
        rejected.push(row.message_id);
      }

      this.audit.record({
        kind: "OUTBOX_FENCE",
        reasonCode: ReasonCode.OUTBOX_RETARGETED,
        roleKey,
        evidence: { fromGeneration, toGeneration, fromSessionId, toSessionId, retargeted, rejected },
      });
      return { retargeted, rejected };
    });
  }

  /** Whether a CARRIED record exists for this message: the once-only rule, and nothing else is. */
  /** Attaches continuity's renewal question; see `#renewalPossible`. */
  attachRenewalCheck(renewalPossible: (roleKey: string, generation: number) => boolean): void {
    this.#renewalPossible = renewalPossible;
  }

  /**
   * Whether a held reply stays held: its renewal is still possible. The run is live, still pinned to
   * exactly the generation and session the reply was addressed to, and the escalation it answers is
   * still the one resolved (`#escalationReplyCarriable` at that generation); and continuity's own
   * recovery admission still renews that generation (`#renewalPossible`). A row for which any of it
   * fails can never be carried.
   */
  #stillHeld(row: RawOutbox): boolean {
    return (
      this.#escalationReplyCarriable(row, row.binding_generation, row.target_session_id) &&
      this.#renewalPossible?.(row.role_key, row.binding_generation) === true
    );
  }

  /**
   * A new generation of `roleKey` was bound by a path that is not the renewal (a bind, a switch, a
   * replacement or takeover, even after an earlier revoke): continuity's recovery now refuses the
   * role (`BINDING_ALREADY_ACTIVE`, and a later generation on another actor or session ends the
   * same-runtime chain for good), so no reply held for an earlier generation can ever be carried.
   * Every one is rejected here, in the bind's own transaction.
   */
  rejectHeldEscalationRepliesForRole(roleKey: string, belowGeneration: number, reason: string): string[] {
    const now = this.clock.nowIso();
    return this.db.all<{ run_id: string | null }>(
      `SELECT DISTINCT o.run_id FROM outbox o WHERE o.role_key = ? AND o.binding_generation < ? AND o.kind = ?`,
      [roleKey, belowGeneration, MessageKind.ESCALATION_REPLY],
    ).flatMap((run) => (run.run_id === null ? [] : this.#heldEscalationReplies(run.run_id)))
      .filter((row) => row.role_key === roleKey && row.binding_generation < belowGeneration)
      .map((row) => {
        this.#rejectHeldEscalationReply(row, now, reason);
        return row.message_id;
      });
  }

  /**
   * The renewal half of the escalation-reply hold, called by `RunEngine.restoreRecoveredBootstrapOwner`
   * in the transaction that pins `runId` to its owner's renewed generation, after the pin. Every reply
   * a revocation of `fromGeneration` held for this run and role is decided here, once:
   *
   *   - carried to `to` when it is still PENDING, unclaimed, unexpired and never carried, and
   *     `#escalationReplyCarriable` holds for the renewed owner — the same run, role and project, a
   *     live run, and the escalation still the one resolved — with the carry record written;
   *   - otherwise rejected, here and now, with ESCALATION_REPLY_HOLD_REJECTED, because no later
   *     renewal can carry it: this one consumed the generation the hold was waiting on.
   *
   * The write is a compare-and-set on PENDING, unclaimed and never retargeted, so the carry happens
   * at most once however this is reached.
   */
  carryHeldEscalationReplies(
    runId: string,
    roleKey: string,
    fromGeneration: number,
    to: { generation: number; sessionId: string },
  ): { carried: string[]; rejected: string[] } {
    const now = this.clock.nowIso();
    const carried: string[] = [];
    const rejected: string[] = [];
    for (const row of this.#heldEscalationReplies(runId, { roleKey, generation: fromGeneration })) {
      const moved = this.#escalationReplyUnclaimed(row, now) && this.#escalationReplyCarriable(row, to.generation, to.sessionId)
        ? this.db.run(
            `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
               WHERE message_id = ? AND status = 'PENDING' AND claim_token IS NULL
                 AND (reason_code IS NULL OR reason_code <> ?)`,
            [to.generation, to.sessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id, ReasonCode.OUTBOX_RETARGETED],
          ).changes
        : 0;
      if (moved === 1) {
        this.#recordEscalationReplyCarry(row, to.generation, to.sessionId);
        carried.push(row.message_id);
      } else {
        this.#rejectHeldEscalationReply(row, now, "the renewal cannot carry it");
        rejected.push(row.message_id);
      }
    }
    return { carried, rejected };
  }

  /**
   * Rejects every reply still held for `runId`, in the transaction that ends the run: an ended run's
   * owner is never renewed, so nothing will ever carry them.
   */
  rejectHeldEscalationReplies(runId: string, reason: string): string[] {
    const now = this.clock.nowIso();
    return this.#heldEscalationReplies(runId).map((row) => {
      this.#rejectHeldEscalationReply(row, now, reason);
      return row.message_id;
    });
  }

  /** Replies a revocation held for `runId` (optionally of one role generation) that are neither carried nor settled. */
  #heldEscalationReplies(runId: string, generation?: { roleKey: string; generation: number }): RawOutbox[] {
    return this.db.all<RawOutbox>(
      `SELECT o.* FROM outbox o
        WHERE o.run_id = ? AND o.kind = ? AND o.status IN ('PENDING','IN_FLIGHT','SENT')
          ${generation ? "AND o.role_key = ? AND o.binding_generation = ?" : ""}
          AND EXISTS (SELECT 1 FROM audit_events held WHERE held.kind = ?
                       AND json_extract(held.evidence_json, '$.messageId') = o.message_id
                       AND json_extract(held.evidence_json, '$.fromGeneration') = o.binding_generation)
          AND NOT EXISTS (SELECT 1 FROM audit_events carried WHERE carried.kind = ?
                       AND json_extract(carried.evidence_json, '$.messageId') = o.message_id)
        ORDER BY o.created_at, o.message_id`,
      [
        runId, MessageKind.ESCALATION_REPLY,
        ...(generation ? [generation.roleKey, generation.generation] : []),
        ESCALATION_REPLY_HELD, ESCALATION_REPLY_CARRIED,
      ],
    );
  }

  #rejectHeldEscalationReply(row: RawOutbox, now: string, reason: string): void {
    const expired = row.expires_at <= now;
    this.db.run(
      `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE message_id = ? AND status IN ('PENDING','IN_FLIGHT','SENT')`,
      [expired ? ReasonCode.OUTBOX_EXPIRED : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, row.message_id],
    );
    this.audit.record({
      kind: ESCALATION_REPLY_HOLD_REJECTED,
      runId: row.run_id,
      roleKey: row.role_key,
      sessionId: row.target_session_id,
      evidence: { messageId: row.message_id, generation: row.binding_generation, ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }), expired, reason },
    });
  }

  /** PENDING, unclaimed, unexpired and never retargeted: the row nobody was ever handed or moved. */
  #escalationReplyUnclaimed(row: RawOutbox, now: string): boolean {
    return row.status === "PENDING" &&
      (row.claim_token ?? null) === null &&
      (row.expires_at > now || this.#isInBand(row)) &&
      ((row.reason_code ?? null) !== ReasonCode.OUTBOX_RETARGETED || this.#isInBand(row));
  }

  /**
   * The carry record: the original target generation and session, the successor, and the reply's own
   * id as the correlation id. The row keeps its message id, so the successor is handed this one row
   * and no copy of it exists to be delivered twice.
   */
  #recordEscalationReplyCarry(row: RawOutbox, toGeneration: number, toSessionId: string): void {
    this.audit.record({
      kind: ESCALATION_REPLY_CARRIED,
      runId: row.run_id,
      roleKey: row.role_key,
      sessionId: toSessionId,
      evidence: {
        messageId: row.message_id,
        correlationId: row.message_id,
        fromGeneration: row.binding_generation,
        fromSession: row.target_session_id,
        toGeneration,
        toSessionId,
      },
    });
  }

  /**
   * Whether a takeover may carry this PENDING, unclaimed ESCALATION_REPLY to `toGeneration`'s holder,
   * read in the takeover's own transaction after it repointed the role's live runs. All of these:
   *
   *   - the successor is the run's official new owner: the run is owned by this row's role at exactly
   *     `toGeneration` on exactly `toSessionId` — the takeover's own repoint, not any holder of the role;
   *   - the run is live: not cancelled and not otherwise terminal;
   *   - the reply is the one a CEO_DECISION enqueued, for the escalation its payload names, and that
   *     escalation is still the run's latest blocking one: a newer escalation makes it stale;
   *   - the project is the same: the run's is the one the decision was recorded under, and the
   *     successor's assignment has the project scope of the generation the reply was addressed to;
   *   - it was never carried before: no carry record names it.
   */
  #escalationReplyCarriable(row: RawOutbox, toGeneration: number, toSessionId: string): boolean {
    if (row.run_id === null) return false;
    const run = this.db.get<{
      state: RunState; project_id: string | null; owner_role_key: string | null;
      owner_binding_generation: number | null; owner_session_id: string | null;
    }>(
      `SELECT state, project_id, owner_role_key, owner_binding_generation, owner_session_id FROM runs WHERE run_id = ?`,
      [row.run_id],
    );
    if (!run || isTerminal(run.state)) return false;
    if (run.owner_role_key !== row.role_key || run.owner_binding_generation !== toGeneration || run.owner_session_id !== toSessionId) {
      return false;
    }
    let escalationId: unknown;
    try {
      escalationId = (JSON.parse(row.payload_json) as { escalationId?: unknown }).escalationId;
    } catch {
      return false;
    }
    if (typeof escalationId !== "number") return false;
    const decision = this.db.get<{ project_id: string | null; escalation_id: unknown }>(
      `SELECT project_id, json_extract(evidence_json, '$.escalationId') AS escalation_id FROM audit_events
        WHERE run_id = ? AND kind = 'CEO_DECISION' AND json_extract(evidence_json, '$.messageId') = ?
        ORDER BY event_id DESC LIMIT 1`,
      [row.run_id, row.message_id],
    );
    if (!decision || decision.escalation_id !== escalationId || decision.project_id !== run.project_id) return false;
    const latest = this.db.get<{ event_id: number | null }>(
      `SELECT MAX(event_id) AS event_id FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION'
          AND json_extract(evidence_json, '$.blocksCriticalPath') = 1`,
      [row.run_id],
    );
    if (latest?.event_id !== escalationId) return false;
    const scopes = this.db.all<{ binding_generation: number; project_id: string | null }>(
      `SELECT binding_generation, project_id FROM assignments WHERE role_key = ? AND binding_generation IN (?, ?)`,
      [row.role_key, row.binding_generation, toGeneration],
    );
    const from = scopes.find((scope) => scope.binding_generation === row.binding_generation);
    const to = scopes.find((scope) => scope.binding_generation === toGeneration);
    if (!from || !to || from.project_id !== to.project_id) return false;
    return this.db.get<{ present: number }>(
      `SELECT 1 AS present FROM audit_events WHERE kind = ? AND json_extract(evidence_json, '$.messageId') = ?`,
      [ESCALATION_REPLY_CARRIED, row.message_id],
    ) === undefined;
  }

  /** The one handover policy's decision for `row` (`instructionHandoverOf`). Only reads. */
  #instructionHandover(row: RawOutbox, to: { generation: number; sessionId: string } | null): InstructionHandover {
    return instructionHandoverOf(this.db, row, to);
  }

  /**
   * Applies `#instructionHandover`'s answer inside the caller's transaction. A carry keeps the
   * message id and payload, compare-and-set on the row still being queued or claimed, and releases
   * any delivery claim — at-least-once, deduplicated by the id. One whose Buzz delivery window
   * already closed, carried to a successor reached over Buzz, is given a fresh window there, so the
   * move itself never hands the successor a message it can no longer be sent. An in-band successor
   * is woken after commit. A keep and a supersession are `keepInstruction` and
   * `supersedeInstruction`, the same writes the session-stop fence makes.
   */
  #applyInstructionHandover(
    row: RawOutbox,
    decision: InstructionHandover,
    to: { generation: number; sessionId: string } | null,
    path: InstructionHandoverPath,
  ): boolean {
    if (decision.kind === "OUT_OF_SCOPE") return false;
    if (decision.kind === "KEEP") {
      keepInstruction(this.db, row);
      return true;
    }
    if (decision.kind === "SUPERSEDE") return supersedeInstruction(this.db, this.audit, row, decision, to, path);
    if (!to) return false;
    const inBand = deliveredInBand(this.db, row.kind, to.sessionId, row.role_key, to.generation);
    // FCR-02: a row already sent to the receiver it is handed to is only re-addressed to the new
    // generation; it stays SENT, awaiting that receiver's ACK, and is not delivered again.
    if (row.status === "SENT" && this.db.get<{ same: number }>(
      `SELECT ${sameReceiverSql("o")} AS same FROM outbox o WHERE o.message_id = ?`,
      [to.sessionId, to.sessionId, row.message_id],
    )?.same === 1) {
      const readdressed = this.db.run(
        `UPDATE outbox SET binding_generation = ?, target_session_id = ?,
                           reason_code = CASE WHEN binding_generation = ? THEN reason_code ELSE ? END
          WHERE message_id = ? AND status = 'SENT'`,
        [to.generation, to.sessionId, to.generation, ReasonCode.OUTBOX_RETARGETED, row.message_id],
      ).changes;
      if (readdressed !== 1) return false;
      if (row.kind === MessageKind.ESCALATION_REPLY) this.#recordEscalationReplyCarry(row, to.generation, to.sessionId);
      return true;
    }
    const now = this.clock.nowIso();
    const window = isoPlus(now, DEFAULT_TTL_MS);
    const moved = this.db.run(
      `UPDATE outbox SET binding_generation = ?, target_session_id = ?, ${HANDED_TO_NEW_RECEIVER_SQL},
                         reason_code = CASE WHEN binding_generation = ? THEN reason_code ELSE ? END,
                         expires_at = CASE WHEN ? = 1 OR expires_at > ? THEN expires_at ELSE ? END
        WHERE message_id = ? AND status IN ('PENDING','IN_FLIGHT','SENT')`,
      [to.generation, to.sessionId, to.generation, ReasonCode.OUTBOX_RETARGETED, inBand ? 1 : 0, now, window, row.message_id],
    ).changes;
    if (moved !== 1) return false;
    if (row.kind === MessageKind.ESCALATION_REPLY) this.#recordEscalationReplyCarry(row, to.generation, to.sessionId);
    if (inBand) {
      this.db.afterCommit(() => {
        void this.#wakeInBand([{ messageId: row.message_id, roleKey: row.role_key }], "handover");
      });
    }
    return true;
  }

  #peerMessageCarried(messageId: string): boolean {
    return this.db.get<{ present: number }>(
      `SELECT 1 AS present FROM peer_message_carries WHERE message_id = ? AND outcome = 'CARRIED'`,
      [messageId],
    ) !== undefined;
  }

  /**
   * Whether this admitted event is spent: an outbox row pointing at it, of any kind, has left
   * PENDING (`MESSAGE_DEPARTED`), or its turn has held a terminal fact (`TURN_TERMINAL`). The event
   * half of `handOverEligibleSql`, read from the same append-only record, so a `true` here means no
   * hand-over path can give the event to any holder again. Keyed by the event the caller names,
   * never by an outbox row's current pointer or status.
   */
  sourceEventSpent(channel: string, nonce: string): boolean {
    return this.#sourceSpent(channel, nonce, ["MESSAGE_DEPARTED", "TURN_TERMINAL"]);
  }

  /** Whether this admitted event was spent for any of `reasons`: `sourceNeverSpentSql`, as a read. */
  #sourceSpent(channel: string, nonce: string, reasons: readonly SourceSpentReason[]): boolean {
    return this.db.get<{ present: number }>(
      `SELECT 1 AS present FROM holder_message_source_departures
        WHERE source_channel = ? AND source_nonce = ?
          AND reason IN (${reasons.map((reason) => `'${reason.replace(/'/g, "''")}'`).join(", ")})`,
      [channel, nonce],
    ) !== undefined;
  }

  /** `handOverEligibleSql`, as a read of one row: the same predicate, never a second copy of it. */
  #handOverEligible(messageId: string): boolean {
    const row = this.db.get<{ eligible: number; payload_json: string; message_id: string }>(
      `SELECT ${handOverEligibleSql("o")} AS eligible, o.payload_json, o.message_id FROM outbox o WHERE o.message_id = ?`,
      [messageId],
    );
    return row?.eligible === 1 && this.#payloadHandOverEligible(row.payload_json, row.message_id);
  }

  /**
   * The pointer half of the hand-over rule, decided from the very parse the consumer delivers (review
   * finding 01, narrow reviews 1 and 2). The payload must parse, and be exactly the canonical
   * serialization of that parse — what `enqueue` writes — so it carries no duplicate key and no other
   * spelling SQLite could read differently, and the event its parsed pointer names must never have
   * been spent. This is the restart carry's parsed-pointer check from before the paths were unified,
   * now on every read.
   *
   * Bytes `JSON.parse` refuses are refused here too, not taken to name no event: SQLite may still
   * read a pointer from them (it stops at a NUL that `JSON.parse` rejects), and a takeover or a
   * runtime move would otherwise re-address a message no holder can read. A parse with no Buzz
   * pointer names no event to check; `ownerMessageLedger` refuses a message that carries none.
   */
  #payloadHandOverEligible(payloadJson: string, messageId?: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadJson) as unknown;
    } catch {
      return false;
    }
    if (JSON.stringify(parsed) !== payloadJson) return false;
    const pointer = ownerMessagePointerOf(parsed);
    return pointer === null ||
      this.db.get(`SELECT 1 FROM holder_message_source_departures
        WHERE source_channel = ? AND source_nonce = ?
          AND (reason = 'TURN_TERMINAL' OR message_id IS NOT ?)`,
        [pointer.sourceChannel, pointer.sourceNonce, messageId ?? null]) === undefined;
  }

  /** The digest of the admitted payload stored at this ingress key, or null when unreadable. */
  #admittedPayloadDigest(channel: string, nonce: string): string | null {
    const source = this.db.get<{ payload_json: string | null }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [channel, nonce],
    );
    const admitted = source?.payload_json ? readPayload(source.payload_json) : null;
    return isPlainRecord(admitted) ? digestOf(admitted) : null;
  }

  /**
   * Records that the CEO is owed a notice for one queued peer message a fence just rejected
   * (ACP-RESTART-04): its id, the event and the identity that signed it, why, and the generation
   * and session it was addressed to — never the payload. Written in the rejecting fence's own
   * transaction, under a capability minted here for exactly this entry, so ordinary SQL cannot
   * write one and nothing can delete one. The first entry for a message stands: a row revived and
   * rejected again is not owed a second notice.
   */
  #owePeerMessageNotice(row: RawOutbox, reason: PeerMessageNoticeReason): void {
    if (this.db.get(
      `SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'OWED'`,
      [row.message_id],
    )) return;
    const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
    const sender = pointer
      ? this.db.get<{ actor: string }>(
        `SELECT actor FROM inbound_messages WHERE channel = ? AND nonce = ?`,
        [pointer.sourceChannel, pointer.sourceNonce],
      )?.actor ?? null
      : null;
    const entry: PeerMessageNoticeEntry = {
      messageId: row.message_id,
      entry: "OWED",
      roleKey: row.role_key,
      reason,
      sender,
      sourceChannel: pointer?.sourceChannel ?? null,
      sourceNonce: pointer?.sourceNonce ?? null,
      bindingGeneration: row.binding_generation,
      sessionId: row.target_session_id,
      sessionIncarnation: null,
    };
    this.#writePeerMessageNotice(entry);
  }

  #writePeerMessageNotice(entry: PeerMessageNoticeEntry): void {
    this.db.withPeerMessageNotice(new PeerMessageNoticeAuthorityToken(this.db, entry), () =>
      this.db.run(
        `INSERT INTO peer_message_refusal_notices (
           message_id, entry, role_key, reason, sender, source_channel, source_nonce,
           binding_generation, session_id, session_incarnation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.messageId, entry.entry, entry.roleKey, entry.reason, entry.sender, entry.sourceChannel,
          entry.sourceNonce, entry.bindingGeneration, entry.sessionId, entry.sessionIncarnation,
          this.clock.nowIso(),
        ],
      ));
  }

  /**
   * The notices the CEO is still owed for this role's rejected peer messages (ACP-RESTART-04), as
   * the role's current holder is shown them — whoever holds the role now, the carry successor or
   * not. Every OWED entry of the role with no REPORTED one, oldest first, and nothing at all unless
   * `holder` is the exact current holder (`exactHolderTarget`): a former holder's tuple is shown
   * nothing. Metadata only. Only reads.
   */
  peerMessageRefusalNoticesFor(holder: HolderIdentity): PeerMessageRefusalNoticeRow[] {
    if (!this.#isExactHolder(holder)) return [];
    return this.db.all<PeerMessageRefusalNoticeRow>(
      `SELECT n.message_id, n.reason, n.sender, n.source_channel, n.source_nonce
         FROM peer_message_refusal_notices n
        WHERE n.role_key = ? AND n.entry = 'OWED'
          AND NOT EXISTS (
            SELECT 1 FROM peer_message_refusal_notices r
             WHERE r.message_id = n.message_id AND r.entry = 'REPORTED'
          )
          -- One channel per notice (amendment 1): one the daemon is telling the CEO itself is not shown.
          AND NOT ${daemonHoldsNoticeSql("n")}
        ORDER BY n.created_at, n.message_id`,
      [holder.roleKey],
    );
  }

  /**
   * The role's current holder reports that it told the CEO about one rejected peer message
   * (ACP-RESTART-04), which retires that notice for every later holder. Exact current holder only,
   * and only for a notice this role is owed; a repeat by any current holder answers OK and writes
   * nothing, so a lost acknowledgement can be retried.
   */
  reportPeerMessageRefusal(messageId: string, holder: HolderIdentity): Decision<void> {
    return this.db.txDecision(() => {
      if (!this.#isExactHolder(holder)) {
        return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "only the role's current holder may report a refusal notice", {
          messageId,
        });
      }
      const owed = this.db.get<{ present: number }>(
        `SELECT 1 AS present FROM peer_message_refusal_notices
          WHERE message_id = ? AND entry = 'OWED' AND role_key = ?`,
        [messageId, holder.roleKey],
      );
      if (!owed) {
        return deny(ReasonCode.NOT_FOUND, "this role is owed no refusal notice for that message", { messageId });
      }
      if (this.db.get(
        `SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'REPORTED'`,
        [messageId],
      )) {
        return allow(ReasonCode.OK, undefined);
      }
      // One channel per notice (amendment 1). The report is the holder taking the telling on itself,
      // made before it tells the CEO; a notice the daemon has in doubt or settled is the daemon's, and
      // the holder must not tell it too. Decided in this transaction, which the daemon's IN_DOUBT
      // write serializes against, so exactly one of the two claims lands.
      if (this.db.get(
        `SELECT 1 AS present FROM peer_message_refusal_notices n
          WHERE n.message_id = ? AND n.entry = 'OWED' AND n.role_key = ? AND ${daemonHoldsNoticeSql("n")}`,
        [messageId, holder.roleKey],
      )) {
        return deny(ReasonCode.CONFLICT,
          "the daemon is telling the CEO about this refused peer message itself; do not tell the CEO", { messageId });
      }
      this.#writePeerMessageNotice({
        messageId,
        entry: "REPORTED",
        roleKey: holder.roleKey,
        reason: null,
        sender: null,
        sourceChannel: null,
        sourceNonce: null,
        bindingGeneration: holder.bindingGeneration,
        sessionId: holder.targetSessionId,
        sessionIncarnation: holder.sessionIncarnation,
      });
      return allow(ReasonCode.OK, undefined);
    });
  }

  /**
   * acp-daemon-notice/v1 (#1068 finding 04): every OWED refusal notice the daemon has neither settled
   * nor failed, oldest first, whether or not any CTO holds the role — the daemon tells the CEO itself
   * rather than waiting for a successor to. Each comes with the IN_DOUBT entry an earlier attempt
   * wrote, whose bytes every retry resends unchanged.
   */
  undeliveredPeerMessageNotices(): PeerMessageNoticeDeliveryCandidate[] {
    return this.db.all<{
      message_id: string; role_key: string; reason: string; sender: string | null;
      source_channel: string | null; source_nonce: string | null; created_at: string;
      in_doubt_event_id: string | null; in_doubt_payload_digest: string | null; in_doubt_canonical_json: string | null;
    }>(
      `SELECT n.message_id, n.role_key, n.reason, n.sender, n.source_channel, n.source_nonce, n.created_at,
              d.event_id AS in_doubt_event_id, d.payload_digest AS in_doubt_payload_digest,
              d.canonical_json AS in_doubt_canonical_json
         FROM peer_message_refusal_notices n
         LEFT JOIN peer_message_notice_deliveries d
           ON d.kind = 'NOTICE' AND d.message_id = n.message_id AND d.role_key = n.role_key
          AND d.reason = n.reason AND d.entry = 'IN_DOUBT'
        WHERE n.entry = 'OWED'
          AND NOT EXISTS (
            SELECT 1 FROM peer_message_notice_deliveries done
             WHERE done.kind = 'NOTICE' AND done.message_id = n.message_id AND done.role_key = n.role_key
               AND done.reason = n.reason AND done.entry IN ('SETTLED','FAILED'))
          -- One channel per notice (amendment 1): a holder took this one on itself.
          AND NOT EXISTS (
            SELECT 1 FROM peer_message_refusal_notices r
             WHERE r.message_id = n.message_id AND r.entry = 'REPORTED')
        ORDER BY n.created_at, n.message_id`,
    ).map((row) => ({
      messageId: row.message_id,
      roleKey: row.role_key,
      reason: row.reason,
      sender: row.sender,
      sourceChannel: row.source_channel,
      sourceNonce: row.source_nonce,
      createdAt: row.created_at,
      inDoubt: row.in_doubt_event_id !== null && row.in_doubt_payload_digest !== null &&
        row.in_doubt_canonical_json !== null
        ? { eventId: row.in_doubt_event_id, payloadDigest: row.in_doubt_payload_digest,
            canonicalJson: row.in_doubt_canonical_json }
        : null,
    }));
  }

  /**
   * The IN_DOUBT entry for one notice, written before its first POST (acp-daemon-notice/v1): the exact
   * canonical bytes and their digest. Idempotent: an entry already written for this event id is
   * returned as it stands, whatever was offered, because a retry must resend what was first signed.
   */
  recordPeerMessageNoticeInDoubt(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string; canonicalJson: string;
  }): { payloadDigest: string; canonicalJson: string } | null {
    return this.db.tx(() => {
      const existing = this.db.get<{ payload_digest: string; canonical_json: string }>(
        `SELECT payload_digest, canonical_json FROM peer_message_notice_deliveries
          WHERE event_id = ? AND entry = 'IN_DOUBT'`,
        [input.eventId],
      );
      if (existing) return { payloadDigest: existing.payload_digest, canonicalJson: existing.canonical_json };
      // One channel per notice (amendment 1): a holder that already took the telling on itself keeps
      // it, and the daemon starts nothing. Checked in this transaction, against the holder's report.
      if (this.db.get(
        `SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'REPORTED'`,
        [input.messageId],
      )) return null;
      this.#writePeerMessageNoticeDelivery(
        { eventId: input.eventId, entry: "IN_DOUBT", payloadDigest: input.payloadDigest, receiptId: null, failure: null },
        { kind: "NOTICE", ...input }, { canonicalJson: input.canonicalJson },
      );
      return { payloadDigest: input.payloadDigest, canonicalJson: input.canonicalJson };
    });
  }

  /** The notice reached the CEO: a 200 whose every settlement condition held, and its receipt. */
  settlePeerMessageNoticeDelivery(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string; receiptId: string;
  }): void {
    this.db.tx(() => this.#writePeerMessageNoticeDelivery(
      { eventId: input.eventId, entry: "SETTLED", payloadDigest: input.payloadDigest, receiptId: input.receiptId, failure: null },
      { kind: "NOTICE", ...input }, { receiptId: input.receiptId },
    ));
  }

  /**
   * The notice will not be delivered under this id: Hermes refused it, a 200 did not match, or the
   * pinned CEO destination moved since its bytes were fixed. Terminal, kept with what differed, and
   * shown by the doctor; never re-minted under a new id.
   */
  failPeerMessageNoticeDelivery(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string;
    failure: PeerMessageNoticeDeliveryFailure; diagnostics: Record<string, unknown>;
  }): void {
    this.db.tx(() => this.#writePeerMessageNoticeDelivery(
      { eventId: input.eventId, entry: "FAILED", payloadDigest: input.payloadDigest, receiptId: null, failure: input.failure },
      { kind: "NOTICE", ...input }, { failure: input.failure, diagnosticsJson: JSON.stringify(input.diagnostics) },
    ));
  }

  /** Whether any delivery entry exists for this event id: a probe is sent only when none does. */
  daemonNoticeDeliveryExists(eventId: string): boolean {
    return this.db.get(`SELECT 1 AS present FROM peer_message_notice_deliveries WHERE event_id = ?`, [eventId]) !==
      undefined;
  }

  /**
   * The live-acceptance probe's entries (amendment 1): kind PROBE, no message. IN_DOUBT before its
   * first POST, refused when any entry for the id already exists; SETTLED or FAILED for the first
   * answer; RESENT, with the receipt when it met every settlement condition, for the one resend.
   */
  recordDaemonNoticeProbe(input: {
    eventId: string; entry: "IN_DOUBT" | "SETTLED" | "FAILED" | "RESENT"; payloadDigest: string;
    canonicalJson?: string; receiptId?: string | null; failure?: PeerMessageNoticeDeliveryFailure;
    diagnostics?: Record<string, unknown>;
  }): void {
    this.db.tx(() => this.#writePeerMessageNoticeDelivery(
      { eventId: input.eventId, entry: input.entry, payloadDigest: input.payloadDigest,
        receiptId: input.receiptId ?? null, failure: input.failure ?? null },
      { kind: "PROBE", messageId: null, roleKey: null, reason: null },
      {
        ...(input.canonicalJson === undefined ? {} : { canonicalJson: input.canonicalJson }),
        ...(input.receiptId ? { receiptId: input.receiptId } : {}),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        ...(input.diagnostics === undefined ? {} : { diagnosticsJson: JSON.stringify(input.diagnostics) }),
      },
    ));
  }

  #writePeerMessageNoticeDelivery(
    entry: PeerMessageNoticeDeliveryEntry,
    notice: { kind: "NOTICE" | "PROBE"; messageId: string | null; roleKey: string | null; reason: string | null },
    columns: { canonicalJson?: string; receiptId?: string; failure?: string; diagnosticsJson?: string },
  ): void {
    this.db.withPeerMessageNoticeDelivery(new PeerMessageNoticeDeliveryAuthorityToken(this.db, entry), () =>
      this.db.run(
        `INSERT INTO peer_message_notice_deliveries (
           event_id, entry, kind, message_id, role_key, reason, payload_digest, canonical_json, receipt_id,
           failure, diagnostics_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.eventId, entry.entry, notice.kind, notice.messageId, notice.roleKey, notice.reason, entry.payloadDigest,
          columns.canonicalJson ?? null, columns.receiptId ?? null, columns.failure ?? null,
          columns.diagnosticsJson ?? null, this.clock.nowIso(),
        ],
      ));
    if (entry.entry === "SETTLED" || (entry.entry === "RESENT" && entry.receiptId &&
        JSON.parse(columns.diagnosticsJson ?? "{}").outcome === "SETTLED")) {
      recordCeoNoticeReceiptSupport(this.db, this.audit, entry.eventId);
    }
  }

  /** `exactHolderTarget` for a caller-supplied holder tuple. Only reads. */
  #isExactHolder(holder: HolderIdentity): boolean {
    return this.db.get<{ held: number }>(
      `SELECT ${exactHolderTarget("bound")} AS held`,
      [holder.roleKey, holder.bindingGeneration, holder.targetSessionId, holder.sessionIncarnation],
    )?.held === 1;
  }

  /**
   * Why one held peer row may not be carried to `succession`'s successor, or null when it may.
   * Only reads. The order puts what already happened to the row before what it was admitted as,
   * so the category the successor is shown names the first thing that made a carry impossible.
   */
  #peerSourceMatchesConversation(row: RawOutbox, identity: string): boolean {
    const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
    if (!pointer) return false;
    const source = this.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?", [pointer.sourceChannel, pointer.sourceNonce]);
    if (!source) return false;
    const payload = readPayload(source.payload_json);
    return isPlainRecord(payload) && digestOf(payload) === pointer.sourcePayloadDigest && payload["mention"] === identity &&
      this.db.get(`SELECT 1 FROM peer_message_carries WHERE message_id = ? AND outcome = 'CARRIED'
        AND source_payload_digest IS NOT ?`, [row.message_id, pointer.sourcePayloadDigest]) === undefined;
  }

  #peerMessageCarryRefusal(row: RawOutbox, succession: PeerMessageSuccession): PeerMessageCarryRefusal | null {
    if (this.#peerMessageCarried(row.message_id)) return PeerMessageCarryRefusal.ALREADY_CARRIED;
    // Unclaimed: never handed over, never in flight, never attempted. UNKNOWN and IN_DOUBT
    // outcomes are reconciled with what they already have, never moved. The row's own columns can
    // be put back by any statement, so the one hand-over predicate decides too (review finding 01):
    // a row that ever left PENDING, or whose event was taken under another id or answered, was
    // claimed, whatever it reads now.
    if (
      row.status !== "PENDING" || row.attempts !== 0 || (row.sent_at ?? null) !== null ||
      (row.claim_token ?? null) !== null || !this.#handOverEligible(row.message_id)
    ) {
      return PeerMessageCarryRefusal.ALREADY_CLAIMED;
    }
    if (row.target_session_id !== succession.fromSessionId) return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    // A peer row carrying the retarget mark with no carry record was moved by something that is not
    // a carry (#1044 retargets no identity-bound row). The mark admits nothing; it can still refuse.
    if (row.reason_code === ReasonCode.OUTBOX_RETARGETED) return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
    if (!pointer) return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
    const source = this.db.get<{ payload_json: string | null; turn_claim_json: string | null }>(
      `SELECT payload_json, turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [pointer.sourceChannel, pointer.sourceNonce],
    );
    const admitted = source?.payload_json ? readPayload(source.payload_json) : null;
    if (!isPlainRecord(admitted) || digestOf(admitted) !== pointer.sourcePayloadDigest) {
      return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
    }
    // No receipt: the turn this message opened is still open, and no canonical turn ran for it.
    if (source?.turn_claim_json != null) {
      const claim = readPayload(source.turn_claim_json);
      if (!isPlainRecord(claim)) return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
      if (claim["repliedAt"] !== undefined || claim["noReplyAt"] !== undefined || claim["settledAt"] !== undefined) {
        return PeerMessageCarryRefusal.ALREADY_CLAIMED;
      }
    }
    if (this.db.get(`SELECT 1 AS present FROM canonical_turns WHERE turn_request_id = ?`, [row.message_id])) {
      return PeerMessageCarryRefusal.ALREADY_CLAIMED;
    }
    // Lineage: admitted for exactly the released CTO generation and session.
    const proof = admitted["peer"];
    if (
      !isPlainRecord(proof) || proof["ctoRoleKey"] !== succession.roleKey ||
      proof["ctoBindingGeneration"] !== succession.fromGeneration ||
      proof["ctoSessionId"] !== succession.fromSessionId
    ) {
      return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    }
    // Signer: addressed to the Buzz channel identity this conversation speaks as.
    const mention = typeof admitted["mention"] === "string" ? admitted["mention"].trim() : null;
    if (mention !== succession.buzzActorId) return PeerMessageCarryRefusal.DIFFERENT_ACTOR_OR_SIGNER;
    // Actor, conversation UUID, signer and the recovery record, as the self-claim read them back.
    if (!succession.proven) return PeerMessageCarryRefusal.DIFFERENT_ACTOR_OR_SIGNER;
    return null;
  }

  /**
   * Carries holder mail inside a surviving-conversation switch's transaction. The authenticated
   * counterpart and binding generation stay the same; only its current runtime changes.
   * Both PENDING and genuine unACKed SENT rows retain their ID and payload across this move.
   * Terminal IDs, conflicting source departures and modified payloads cannot be replayed.
   */
  carryHolderMessagesToRuntime(
    roleKey: string,
    bindingGeneration: number,
    fromSessionId: string,
    toSessionId: string,
  ): { carried: string[]; rejected: string[] } {
    if (fromSessionId === toSessionId) return { carried: [], rejected: [] };
    return this.db.tx(() => {
      const rows = this.db.all<RawOutbox>(
        `SELECT * FROM outbox
          WHERE role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND status IN ('PENDING','SENT')
          ORDER BY created_at, message_id`,
        [roleKey, bindingGeneration, fromSessionId],
      );

      const carried: string[] = [];
      const rejected: string[] = [];
      for (const row of rows) {
        if (!this.#handOverEligible(row.message_id)) {
          this.db.run("UPDATE outbox SET status = 'REJECTED', reason_code = ? WHERE message_id = ?",
            [ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH, row.message_id]);
          this.settleHolderClaimOrThrow(row.message_id);
          rejected.push(row.message_id);
          continue;
        }
        const moved = this.db.run(
          `UPDATE outbox SET target_session_id = ?
            WHERE message_id = ? AND status IN ('PENDING','SENT')
              AND role_key = ? AND binding_generation = ? AND target_session_id = ?`,
          [toSessionId, row.message_id, roleKey, bindingGeneration, fromSessionId],
        ).changes;
        if (moved === 1) carried.push(row.message_id);
      }

      this.audit.record({
        kind: "OUTBOX_FENCE",
        reasonCode: ReasonCode.OUTBOX_RETARGETED,
        roleKey,
        evidence: { bindingGeneration, fromSessionId, toSessionId, carried, rejected },
      });

      // ACP-R1-01: the instructions addressed to the outgoing runtime move with the conversation,
      // whatever their route, under the one handover policy. Left behind, the runtime that now holds the
      // role could not read them and the fence would reject them.
      const to = { generation: bindingGeneration, sessionId: toSessionId };
      const instructions = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${handoverInstructionRowSql("o")}
          ORDER BY o.created_at, o.rowid`,
        [roleKey, bindingGeneration, fromSessionId],
      );
      const handed: string[] = [];
      const superseded: string[] = [];
      for (const row of instructions) {
        const handover = this.#instructionHandover(row, to);
        if (!this.#applyInstructionHandover(row, handover, to, "RUNTIME_MOVE")) continue;
        (handover.kind === "CARRY" ? handed : superseded).push(row.message_id);
      }
      if (handed.length > 0 || superseded.length > 0) {
        this.audit.record({
          kind: "OUTBOX_INSTRUCTIONS_HANDED_OVER",
          reasonCode: ReasonCode.OUTBOX_RETARGETED,
          roleKey,
          evidence: { path: "RUNTIME_MOVE", bindingGeneration, fromSessionId, toSessionId, retargeted: handed, rejected: superseded },
        });
      }
      // A runtime move is a route change for everything now addressed to the incoming runtime.
      rearmRetainedDeliveries(this.db, { sessionId: toSessionId, roleKey, bindingGeneration });

      return { carried, rejected };
    });
  }

  /**
   * A queued message whose delivery window has passed. Holder-claimed kinds have no such window.
   *
   * `enqueue` stamps every row with `DEFAULT_TTL_MS` unless the caller names one, so an
   * `OWNER_MESSAGE` used to become `EXPIRED` thirty minutes after it was written — silently, on the
   * next `claimDeliverable` or `Daemon.reconcile`, and terminally: `claimForHolder` requires
   * `PENDING`, `fenceUndeliverable` skips a row that is neither `PENDING`/`IN_FLIGHT` nor `SENT`,
   * and the holder never learned the message existed.
   *
   * A TTL is a statement about a *delivery attempt* — after this instant, stop trying to send. An
   * owner-message is not sent; it is queued for a holder that comes and takes it, and there is no
   * instant after which an owner's words stop being addressed to the role. So the kinds are
   * excluded here, and — because a status the claim path refuses to look at is the same strand
   * wearing a different word — `claimForHolder`'s two `expires_at` conditions are gone with it.
   */
  expireOverdue(): number {
    const result = this.db.run(
      `UPDATE outbox SET status = 'EXPIRED', reason_code = ?,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE status IN ('PENDING','IN_FLIGHT')
          -- An actionable instruction and a CEO notification end only by ACK or a recorded
          -- supersession, never by a delivery window (ACP-R1-01, ACP-R2-01).
          AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL}, ${RETAINED_KIND_SQL})
          AND NOT ${inBandRow("outbox")}
          AND expires_at <= ?`,
      [ReasonCode.OUTBOX_EXPIRED, this.clock.nowIso()],
    );
    return result.changes;
  }

  byIdempotencyKey(key: string): OutboxMessage | null {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE idempotency_key = ?`, [key]);
    return row ? hydrate(row) : null;
  }

  get(messageId: string): OutboxMessage | null {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    return row ? hydrate(row) : null;
  }

  listByRun(runId: string): OutboxMessage[] {
    return this.db
      .all<RawOutbox>(`SELECT * FROM outbox WHERE run_id = ? ORDER BY created_at, message_id`, [runId])
      .map(hydrate);
  }

  /** Operator/doctor/health counts use the same interpretation as individual receipts. */
  deliveryReadback() {
    const rows = this.db.all<{ message_id: string; status: OutboxMessage["status"]; failure_class: FailureClass | null }>(
      "SELECT message_id, status, failure_class FROM outbox ORDER BY created_at, message_id",
    ).map((row) => ({ messageId: row.message_id,
      ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) }));
    // Retention and withholding must remain visible even when no transport attempt took place.
    const pendingCeoNotifications = this.db.all<RawOutbox>(
      "SELECT * FROM outbox WHERE kind = 'CEO_NOTIFICATION' AND status = 'PENDING' ORDER BY created_at, message_id",
    ).map((row) => ({ messageId: row.message_id, targetSessionId: row.target_session_id,
      ...outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }) }));
    return {
      delivered: rows.filter((row) => row.delivered).length,
      completed: rows.filter((row) => row.completed).length,
      unconfirmed: rows.filter((row) => row.automaticResendHeld),
      pendingCeoNotifications,
    };
  }

  /**
   * Fence outward delivery attempts. UnACKed role mail and CEO notifications remain durable, and an
   * instruction is kept or superseded by the handover policy (ACP-R1-01), never fenced.
   */
  fenceUndeliverable(): number {
    return this.db.tx(() => {
      // The backstop for a held ESCALATION_REPLY: it is spared only while its renewal is still
      // possible (`#stillHeld`); one whose renewal can no longer come is rejected below like any
      // other row whose target is gone.
      const now = this.clock.nowIso();
      const stillHeld: string[] = [];
      let heldRejected = 0;
      for (const row of this.db.all<RawOutbox>(`SELECT * FROM outbox WHERE ${heldEscalationReplyCandidatesSql("outbox")}`)) {
        if (this.#stillHeld(row)) {
          stillHeld.push(row.message_id);
        } else {
          this.#rejectHeldEscalationReply(row, now, "its renewal can no longer come");
          heldRejected += 1;
        }
      }
      // ACP-R1-01: an instruction whose target nobody holds is kept for the role's next holder or
      // superseded with its reason, under the one handover policy — never fenced for want of one.
      const unheld = settleUnheldInstructions(this.db, this.audit, this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE ${handoverInstructionRowSql("o")} AND NOT ${liveDeliveryTarget("o")}
            AND o.message_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY o.created_at, o.rowid`,
        [JSON.stringify(stillHeld)],
      ), "FENCE");
      const changes = this.db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE (
                  (status IN ('PENDING','IN_FLIGHT')
                    AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL}, 'CEO_NOTIFICATION')
                    AND NOT ${inBandRow("outbox")}
                    AND NOT ${handoverInstructionRowSql("outbox")})
                  )
            AND NOT ${liveDeliveryTarget("outbox")}
            AND message_id NOT IN (SELECT value FROM json_each(?))`,
        [ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, JSON.stringify(stillHeld)],
      ).changes;
      return changes + heldRejected + unheld.superseded.length;
    });
  }

  /**
   * A message must be fenced by a live binding, and its target must be a session that is
   * legitimately addressable under that binding.
   *
   * Usually the target *is* the holder. A handoff package is the exception §10.1 requires:
   * the outgoing binding stays in force until the ACK, so the package is addressed to the
   * incoming session, which by definition does not hold the binding yet. That case is
   * admitted only when a pending handoff from this exact generation names this session as
   * its recipient — the fence is still the outgoing binding, so a superseded generation
   * cannot send, and a session that is not READY cannot receive.
   */
  private isCurrentTarget(
    roleKey: string,
    bindingGeneration: number,
    sessionId: string,
    kind: MessageKind,
    idempotencyKey: string,
  ): boolean {
    // The same current holder the delivery predicates use, and for the same reason: after a
    // surviving runtime move the assignment's own session names a process that is gone, so an
    // admission that asked it would refuse the owner's next message to a role that plainly has a
    // holder — the registry hands the caller that holder's session id and this would not admit it.
    const holder = this.db.get(
      `SELECT 1 FROM assignments a
        ${HOLDER_ACTOR_JOIN}
        JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
        WHERE a.role_key = ? AND a.binding_generation = ?
          AND ${CURRENT_HOLDER_SESSION} = ?
          AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')`,
      [roleKey, bindingGeneration, sessionId],
    );
    if (holder) return true;

    if (kind !== MessageKind.HANDOFF_PACKAGE) return false;

    return Boolean(
      this.db.get(
        `SELECT 1 FROM handoffs h
          JOIN sessions recipient ON recipient.session_id = h.to_session_id
          JOIN sessions outgoing ON outgoing.session_id = h.from_session_id
          JOIN assignments a ON a.role_key = ? AND a.binding_generation = ?
                            AND a.session_id = h.from_session_id AND a.status = 'ACTIVE'
          WHERE h.kind = 'HANDOFF' AND h.to_session_id = ?
            AND h.status = 'PENDING' AND h.from_generation = ?
            AND ? = 'handoff:' || h.handoff_id
            AND recipient.lifecycle = 'READY'
            AND outgoing.lifecycle IN ('READY','DRAINING')`,
        [roleKey, bindingGeneration, sessionId, bindingGeneration, idempotencyKey],
      ),
    );
  }

  private staleClaim(messageId: string): Decision<void> {
    return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer current", {
      messageId,
    });
  }

}

/**
 * Why a held peer message was not carried to the restarted conversation (ACP-PEER-SUCCESSION-01).
 * Stored on its REFUSED carry record and shown to the successor; the schema's CHECK lists the same
 * five.
 */
/** Which handover asked the in-band instruction policy (ACP-R1-01). */
type InstructionHandoverPath = "RUNTIME_MOVE" | "TAKEOVER" | "REVOKE" | "ADOPTION" | "SESSION_STOPPED" | "FENCE";

/** Why a handover superseded an in-band instruction rather than carrying it (ACP-R1-01). */
type InstructionSupersession = "RUN_TERMINAL" | "RUN_MISSING" | "RUN_OWNED_ELSEWHERE" | "ESCALATION_SUPERSEDED" | "ROLE_REPLACED";

/** `Outbox.#instructionHandover`'s answer for one row. */
type InstructionHandover =
  | { readonly kind: "OUT_OF_SCOPE" }
  | { readonly kind: "CARRY" }
  | { readonly kind: "KEEP" }
  | { readonly kind: "SUPERSEDE"; readonly reason: InstructionSupersession; readonly runState: RunState | null };

export const PeerMessageCarryRefusal = {
  /** The actor, conversation UUID, Buzz signer or recovery record is not one continuous restart. */
  DIFFERENT_ACTOR_OR_SIGNER: "DIFFERENT_ACTOR_OR_SIGNER",
  /** The row, or its admission proof, names a CTO other than the released generation's session. */
  DIFFERENT_LINEAGE: "DIFFERENT_LINEAGE",
  /** An earlier restart carried it once already: one hop only. */
  ALREADY_CARRIED: "ALREADY_CARRIED",
  /** It was handed over, in flight or attempted, or its turn already has a receipt. */
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  /** Its pointer, its admitted source or its turn claim cannot be read as admitted. */
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
} as const;
export type PeerMessageCarryRefusal = (typeof PeerMessageCarryRefusal)[keyof typeof PeerMessageCarryRefusal];

/**
 * Why a queued peer message the CEO is owed a notice for was rejected (ACP-RESTART-04): the path
 * that rejected it, or — when a canonical restart refused to carry it — that refusal's category.
 * The schema's CHECK lists the same eight.
 */
export const PeerMessageNoticeReason = {
  /** The generation it was addressed to was revoked with no successor: a plain revoke or the operator's dead-binding door. */
  REVOKED: "REVOKED",
  /** Another runtime took the role over. */
  REPLACED: "REPLACED",
  /** The same generation moved to another runtime. */
  RUNTIME_MOVED: "RUNTIME_MOVED",
  ...PeerMessageCarryRefusal,
} as const;
export type PeerMessageNoticeReason = (typeof PeerMessageNoticeReason)[keyof typeof PeerMessageNoticeReason];

/** One entry of `peer_message_refusal_notices`, exactly as its insert trigger compares it. */
export interface PeerMessageNoticeEntry {
  readonly messageId: string;
  readonly entry: "OWED" | "REPORTED";
  readonly roleKey: string;
  readonly reason: PeerMessageNoticeReason | null;
  readonly sender: string | null;
  readonly sourceChannel: string | null;
  readonly sourceNonce: string | null;
  readonly bindingGeneration: number;
  readonly sessionId: string;
  readonly sessionIncarnation: string | null;
}

/** An owed notice as `peerMessageRefusalNoticesFor` reads it. */
export interface PeerMessageRefusalNoticeRow {
  message_id: string;
  reason: string;
  sender: string | null;
  source_channel: string | null;
  source_nonce: string | null;
}

/**
 * The capability to write one refusal-notice entry (ACP-RESTART-04).
 *
 * Minted only inside this module — at the fence that rejects a queued peer message and at the
 * current holder's report — for exactly the entry it is about to write; the class is not exported,
 * so no other module can make one, and `Db.withPeerMessageNotice` checks the brand before it raises
 * the marker the entry's insert trigger requires. The same pattern as the carry authority.
 */
class PeerMessageNoticeAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;
  readonly #entry: PeerMessageNoticeEntry;

  constructor(db: Db, entry: PeerMessageNoticeEntry) {
    this.#db = db;
    this.#entry = Object.freeze({ ...entry });
    Object.freeze(this);
  }

  static entryOf(value: unknown, db: Db): PeerMessageNoticeEntry | null {
    if (typeof value !== "object" || value === null || !(#minted in value)) return null;
    return value.#db === db ? value.#entry : null;
  }
}
export type PeerMessageNoticeAuthority = PeerMessageNoticeAuthorityToken;
/** The entry a notice authority names, or null when `value` is not one issued for `db`. */
export const peerMessageNoticeEntryOf = PeerMessageNoticeAuthorityToken.entryOf;

/** Why a notice delivery is terminal (acp-daemon-notice/v1). */
export type PeerMessageNoticeDeliveryFailure = "HERMES_REFUSED" | "RESPONSE_MISMATCH" | "DESTINATION_MOVED";

/** One entry of `peer_message_notice_deliveries`, as its insert trigger's marker names it. */
export interface PeerMessageNoticeDeliveryEntry {
  readonly eventId: string;
  readonly entry: "IN_DOUBT" | "SETTLED" | "FAILED" | "RESENT";
  readonly payloadDigest: string;
  readonly receiptId: string | null;
  readonly failure: PeerMessageNoticeDeliveryFailure | null;
}

/** An OWED notice the daemon still owes the CEO, with the IN_DOUBT entry of an earlier attempt. */
export interface PeerMessageNoticeDeliveryCandidate {
  messageId: string;
  roleKey: string;
  reason: string;
  sender: string | null;
  sourceChannel: string | null;
  sourceNonce: string | null;
  createdAt: string;
  inDoubt: { eventId: string; payloadDigest: string; canonicalJson: string } | null;
}

/**
 * The capability to write one notice-delivery entry (acp-daemon-notice/v1), minted only inside this
 * module for exactly the entry it is about to write; `Db.withPeerMessageNoticeDelivery` checks the
 * brand before it raises the marker the entry's insert trigger requires. As the notice authority.
 */
class PeerMessageNoticeDeliveryAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;
  readonly #entry: PeerMessageNoticeDeliveryEntry;

  constructor(db: Db, entry: PeerMessageNoticeDeliveryEntry) {
    this.#db = db;
    this.#entry = Object.freeze({ ...entry });
    Object.freeze(this);
  }

  static entryOf(value: unknown, db: Db): PeerMessageNoticeDeliveryEntry | null {
    if (typeof value !== "object" || value === null || !(#minted in value)) return null;
    return value.#db === db ? value.#entry : null;
  }
}
export type PeerMessageNoticeDeliveryAuthority = PeerMessageNoticeDeliveryAuthorityToken;
/** The entry a delivery authority names, or null when `value` is not one issued for `db`. */
export const peerMessageNoticeDeliveryEntryOf = PeerMessageNoticeDeliveryAuthorityToken.entryOf;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RawOutbox {
  message_id: string;
  idempotency_key: string;
  role_key: string;
  binding_generation: number;
  target_session_id: string;
  run_id: string | null;
  kind: string;
  payload_json: string;
  payload_digest: string;
  request_fingerprint: string;
  expires_at: string;
  created_at: string;
  status: OutboxMessage["status"];
  attempts: number;
  last_error?: string | null;
  failure_class?: FailureClass | null;
  retry_eligible?: number | null;
  next_attempt_at?: string | null;
  sent_at?: string | null;
  claim_token?: string | null;
  reason_code?: string | null;
}

/**
 * Projects a raw row onto the no-payload shape. `payload_json` is read off the row and simply
 * never copied — the destination type has no field for it.
 */
/** The row as a message, or null when its stored payload is not readable JSON. */
const readableMessage = (row: RawOutbox): OutboxMessage | null => {
  try {
    return hydrate(row);
  } catch {
    return null;
  }
};

/**
 * `claimForHolder`'s default: hand over no `IDENTITY_BOUND_KINDS` row (#1044). A peer message is
 * handed over only to a caller that supplies the predicate proving its proof still current.
 */
const withholdsIdentityBound = (candidate: OutboxMessage): boolean =>
  !IDENTITY_BOUND_KINDS.has(candidate.kind);

const unresolvedOwnerMessage = (row: RawOutbox): UnresolvedOwnerMessage => ({
  messageId: row.message_id,
  roleKey: row.role_key,
  bindingGeneration: row.binding_generation,
  targetSessionId: row.target_session_id,
  kind: row.kind as MessageKind,
  payloadDigest: row.payload_digest,
  sentAt: row.sent_at ?? null,
  attempts: row.attempts,
  createdAt: row.created_at,
});

/** A stored payload for an in-band reader; one that is not readable JSON is shown as null. */
const readPayload = (payloadJson: string): unknown => {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
};

const hydrate = (row: RawOutbox): OutboxMessage => ({
  messageId: row.message_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  roleKey: row.role_key,
  bindingGeneration: row.binding_generation,
  targetSessionId: row.target_session_id,
  runId: row.run_id,
  kind: row.kind as MessageKind,
  payload: JSON.parse(row.payload_json) as unknown,
  payloadDigest: row.payload_digest,
  expiresAt: row.expires_at,
  status: row.status,
  attempts: row.attempts,
  failureClass: row.failure_class ?? null,
  retryEligible: row.retry_eligible === 1,
  nextAttemptAt: row.next_attempt_at ?? null,
  createdAt: row.created_at,
});

const requestFingerprintOf = (input: EnqueueInput): string =>
  payloadDigestOf({
    roleKey: input.roleKey,
    bindingGeneration: input.bindingGeneration,
    targetSessionId: input.targetSessionId,
    runId: input.runId ?? null,
    kind: input.kind,
    payloadDigest: payloadDigestOf(input.payload),
  });

const normalizeFailure = (failure: DeliveryFailure | string): DeliveryFailure =>
  typeof failure === "string" ||
  !KNOWN_FAILURE_CLASSES.has(failure.failureClass) ||
  typeof failure.error !== "string"
    ? {
        failureClass: "unknown_observed",
        retryable: false,
        error: typeof failure === "string" ? failure : "delivery failure classification is invalid",
      }
    : {
        failureClass: failure.failureClass,
        retryable: failure.retryable === true,
        error: failure.error,
      };

const retryDelayMs = (attempts: number, baseDelayMs: number): number =>
  Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
