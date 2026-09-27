/**
 * #833 - the recovery is the *same* runtime, which means the same Buzz identity.
 *
 * The claim reuses the predecessor's actor, and the actor is what inbound resolution routes on.
 * Removing this conjunct lets a session whose stored actor belongs to a different identity inherit
 * the predecessor's binding, which is a role handed to an identity the deployment authenticated
 * for something else.
 *
 * #1005 moved the comparison's right-hand side. It was `request.buzzActorId` — a value the
 * claimant presented, checked against the deployment's one configured actor before reaching here.
 * The request cannot carry an actor any more: it comes from the claimant's own configured entry,
 * so this is now "the stored actor is the one this session is configured to speak as" rather than
 * "the presented actor matches what is stored". The conjunct is the same guard over a stronger
 * operand, and its `killedBy` test now configures the mismatch instead of sending it.
 *
 * Exercised with `--only` after the move: `killed`.
 */
const c = {
  id: "same-live-recovery-requires-the-same-buzz-actor",
  what:
    "same-live recovery requires the predecessor's stored actor to be the configured one",
  file: "src/registry/canonical-self-claim.ts",
  find: " || predecessor.buzzActorId !== entry.buzzActorId",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::same-live recovery refuses buzz mismatch without effects",
  ],
};
export default c;
