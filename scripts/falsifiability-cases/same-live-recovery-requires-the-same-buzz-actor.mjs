/**
 * #833 - the recovery is the *same* runtime, which means the same Buzz identity.
 *
 * The claim reuses the predecessor's actor, and the actor is what inbound resolution routes on.
 * Removing this conjunct lets a claimant presenting a different `buzzActorId` inherit the
 * predecessor's binding, which is a role handed to an identity the deployment authenticated for
 * something else.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "same-live-recovery-requires-the-same-buzz-actor",
  what:
    "same-live recovery requires the claimant to present the predecessor's own Buzz actor id",
  file: "src/registry/canonical-self-claim.ts",
  find: " || predecessor.buzzActorId !== request.buzzActorId",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::same-live recovery refuses buzz mismatch without effects",
  ],
};
export default c;
