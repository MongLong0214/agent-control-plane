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

export const payloadDigestOf = (payload: unknown): string => digestOf(payload);
