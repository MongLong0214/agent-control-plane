/**
 * ACP-REVIEW-01. A refusal commits nothing, so its audit row is written by `claim()` outside any
 * transaction. A failed insert there used to escape `claim()`, and the listener then answered
 * INTERNAL_ERROR in place of the refusal's own reason code. The failure is now swallowed and the
 * refusal returned as it was decided; the row is lost.
 *
 * The mutation turns the swallow back into a throw, which is what removing the try amounts to. It
 * typechecks. The named verdict fails the refusal's insert at the database boundary and requires
 * the refusal's own reason code back; both of its cases, a refusal decided before the transaction
 * opens and one from inside the rolled-back transaction, share the selector's prefix.
 */
const c = {
  id: "a-refusal-whose-row-fails-keeps-its-reason-code",
  what: "a canonical self-claim refusal whose audit row cannot be written still returns its own reason code rather than a throw",
  file: "src/registry/canonical-self-claim.ts",
  find: "      // Deliberately empty: the refusal stands without its row. See the docblock above.",
  replace: "      throw new Error(\"the refusal's audit row could not be written\");",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a refusal whose audit row cannot be written still returns its own reason code",
  ],
};
export default c;
