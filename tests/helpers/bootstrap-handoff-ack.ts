import type { Harness } from './harness.ts';

/** Consume the actual fixture package before acknowledging it, through its configured route. */
export async function acknowledgeBootstrapHandoff(h: Harness, handoffId: string, sessionId: string) {
  const session = h.cp.sessions.require(sessionId);
  const message = h.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${handoffId}`)!;
  const pending = h.cp.outbox.pendingInBandFor(sessionId, session.incarnation)
    .find(row => row.messageId === message.messageId);
  if (!pending) await h.buzzAdapter.deliverPending();
  const received = pending ?? h.cp.outbox.get(message.messageId)!;
  return h.cp.bootstrap.acknowledgeActivationHandoff(handoffId, sessionId, session.incarnation, {
    messageId: received.messageId, bindingGeneration: received.bindingGeneration, payloadDigest: received.payloadDigest,
  });
}
