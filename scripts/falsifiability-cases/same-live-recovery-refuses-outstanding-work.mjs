/**
 * #833 - same-live recovery refuses a predecessor with work in flight.
 *
 * The recovery adopts the predecessor's runtime identity, so anything the predecessor was still
 * doing becomes the successor's - including a run whose ownership nothing reassigned. Removing
 * `work` from the eleven-way conjunction lets the recovery proceed and the row is reconciled under
 * a claimant that never observed that work.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "same-live-recovery-refuses-outstanding-work",
  what:
    "same-live recovery refuses a predecessor with work in flight, rather than adopting a runtime "
    + "whose outstanding work nothing reassigned",
  file: "src/registry/canonical-self-claim.ts",
  find: "work || ",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::same-live recovery refuses work mismatch without effects",
  ],
};
export default c;
