/**
 * Which conversation a canonical turn belongs to, for any ingress channel.
 *
 * Moved out of `telegram-polling.ts` unchanged when the Buzz path needed the same answer (#858).
 * It was never Telegram's: the query below names no channel, and the alternative -- importing it
 * from the Telegram listener into the daemon's Buzz composition -- would make the Buzz path
 * depend on the Telegram one for a fact neither owns.
 */
import type { ControlPlane } from "../app/control-plane.ts";

/**
 * The canonical turn's target, resolved the way `claim()` itself resolves one -- by binding and
 * current attestation, with no executor kind and no attestation protocol in the question.
 *
 * `receiptIdentityForCurrentHermesCeo` below cannot answer this. It asks for `Role.CEO` bound to
 * `executor_kind = 'hermes'` with a `hermes.target-bind/v1` attestation carrying a receipt, and
 * that is correct for what it feeds: reconciling an authenticated Hermes receipt. It is not the
 * question `canonical_turns` asks. Measured against the live deployment on 2026-09-15, all three
 * of its conditions are empty there -- the only `CEO` assignment was revoked at generation 1, the
 * one active assignment is a `PRIMARY_CTO` bound to `claude-cli`, and all six attestations carry
 * `acp.canonical-self-claim/v1`, whose module says in as many words that it is "deliberately
 * distinct from `hermes.target-bind/v1`". A bridge gated on that resolver can never fire in this
 * deployment, and `#932` landing it that way would have been a writer that cannot write.
 *
 * `ConversationTurnCoordinator.claim()` has no such filter, and running its own currency query
 * against the live database returns exactly one admissible attestation. So the target is there;
 * only the question was wrong.
 *
 * Exactly one target actor, or nothing. Two would mean the deployment cannot say which
 * conversation an owner message belongs to, and guessing is the failure `canonical_turns` exists
 * to make impossible.
 */
export const canonicalTurnTarget = (cp: ControlPlane): {
  targetActorId: string;
  bindingGeneration: number;
  targetBindingId: string;
  targetAttestationId: string;
  executorSessionId: string;
  executorSessionIncarnation: string;
} | null => {
  // The conditions below are `claim()`'s, restated because this runs before it and must agree
  // with it: an admission that names a target `claim()` would refuse is worse than none, since it
  // turns a refusal the owner can see into a claim that fails later where nothing reads it.
  const rows = cp.db.all<{
    target_actor_id: string;
    binding_generation: number;
    target_binding_id: string;
    target_attestation_id: string;
    executor_session_id: string;
    executor_session_incarnation: string;
  }>(
    `SELECT tb.target_actor_id AS target_actor_id,
            asg.binding_generation AS binding_generation,
            tb.target_binding_id AS target_binding_id,
            att.target_attestation_id AS target_attestation_id,
            att.executor_session_id AS executor_session_id,
            att.executor_session_incarnation AS executor_session_incarnation
       FROM actor_target_attestations att
       JOIN actor_target_bindings tb
         ON tb.target_binding_id = att.target_binding_id
       JOIN conversational_actors ca
         ON ca.actor_id = tb.target_actor_id
       JOIN sessions sess
         ON sess.session_id = ca.current_session_id
       JOIN assignments asg
         ON asg.assignment_id = att.assignment_id
        AND asg.actor_id = ca.actor_id
        AND asg.status = 'ACTIVE'
        AND asg.binding_generation = att.binding_generation
      WHERE ca.retired_at IS NULL
        AND sess.lifecycle = 'READY'
        AND ca.current_session_id = att.executor_session_id
        AND sess.incarnation = att.executor_session_incarnation
      ORDER BY att.attested_at DESC, att.rowid DESC`,
    [],
  );
  if (rows.length === 0) return null;
  const first = rows[0]!;
  // More than one attestation is ordinary -- a rebind writes another. More than one *actor* is
  // not, and this refuses rather than take the newest, because "newest" is not an answer to
  // "which conversation did the owner mean".
  if (rows.some((row) => row.target_actor_id !== first.target_actor_id)) return null;
  return {
    targetActorId: first.target_actor_id,
    bindingGeneration: first.binding_generation,
    targetBindingId: first.target_binding_id,
    targetAttestationId: first.target_attestation_id,
    executorSessionId: first.executor_session_id,
    executorSessionIncarnation: first.executor_session_incarnation,
  };
};
