/**
 * #833 - the predecessor the recovery adopts has to be idle at READY.
 *
 * DRAINING is the state of a runtime still finishing in-flight work, and adopting one is adopting
 * that work. Removing this conjunct lets a draining predecessor be reconciled as an idle revoked
 * one - which is the same class as #831's row-versus-process confusion, one state over.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "same-live-recovery-requires-a-ready-predecessor",
  what:
    "same-live recovery requires the predecessor to be READY, so a DRAINING runtime is not "
    + "adopted as an idle one",
  file: "src/registry/canonical-self-claim.ts",
  find: "predecessor.lifecycle !== SessionLifecycle.READY ||\n",
  replace: "false ||\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::same-live recovery refuses draining mismatch without effects",
  ],
};
export default c;
