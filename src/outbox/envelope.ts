import { digestOf } from "../core/digest.ts";

/** PRD §15.7 — every message envelope carries these fields, without exception. */
export interface FencedEnvelope {
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  runId: string | null;
  messageId: string;
  payloadDigest: string;
  expiresAt: string;
}

export const MessageKind = {
  RUN_DISPATCH: "RUN_DISPATCH",
  TASK_ASSIGN: "TASK_ASSIGN",
  REVIEW_REQUEST: "REVIEW_REQUEST",
  REVISION_REQUEST: "REVISION_REQUEST",
  HANDOFF_PACKAGE: "HANDOFF_PACKAGE",
  RECOVERY_PACKAGE: "RECOVERY_PACKAGE",
  DRAIN_REQUEST: "DRAIN_REQUEST",
  ESCALATION_REPLY: "ESCALATION_REPLY",
  CEO_NOTIFICATION: "CEO_NOTIFICATION",
  CANCEL_REQUEST: "CANCEL_REQUEST",
  /**
   * An owner's message addressed to whoever holds a role, consumed by that holder itself.
   *
   * Unlike every kind above it, nothing in the daemon delivers this one *outward*. The holder
   * comes and takes it over its own authenticated connection, which is why it is excluded from
   * `claimDeliverable` below and why it is not retargetable: the message is addressed to a
   * conversation, and a conversation does not survive its runtime being replaced.
   */
  OWNER_MESSAGE: "OWNER_MESSAGE",
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

/**
 * Which pending messages survive a binding switch.
 *
 * Retargetable messages describe *role-level* intent — the new incarnation of the role
 * can act on them unchanged. Everything else is addressed to a specific incarnation
 * (an in-flight handoff, a reply to a question that session asked) and is stale the
 * moment the binding moves, so it is rejected rather than silently redelivered.
 */
export const RETARGETABLE_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  MessageKind.RUN_DISPATCH,
  MessageKind.TASK_ASSIGN,
  MessageKind.CANCEL_REQUEST,
  MessageKind.CEO_NOTIFICATION,
]);

/**
 * Kinds that only their addressed holder may consume, over its own authenticated connection.
 *
 * The generic delivery sweep (`Outbox.claimDeliverable`) must not be able to pick one of these up,
 * and that is a security boundary rather than a routing preference: `BuzzAdapter.deliverPending`
 * drains whatever that sweep returns and transmits it to the target session's Buzz address, so a
 * kind that leaked into the sweep would have its payload sent out over a channel that never
 * authenticated the holder. Excluding by *set membership* rather than by a literal in the query
 * means adding a second such kind cannot forget the exclusion.
 *
 * Deliberately disjoint from `RETARGETABLE_KINDS`: a message only its exact holder may read is by
 * construction not one a successor may inherit, and a kind appearing in both sets would be saying
 * both at once.
 */
export const HOLDER_CLAIMED_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  MessageKind.OWNER_MESSAGE,
]);

export const payloadDigestOf = (payload: unknown): string => digestOf(payload);
