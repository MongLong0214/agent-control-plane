/**
 * #833 / #831 - the branch that replaces an abandoned runtime asks whether the *process* is gone.
 *
 * This is the operand #831 is about. A predecessor row sitting at READY is not a live runtime, and
 * a rule keyed on the row hands the canonical role to a claimant while the old process is still
 * answering signals. Removing `predecessorRuntimeIsGone` makes the abandoned-runtime branch fire
 * on lifecycle alone, which is exactly the reading that took the role offline.
 *
 * The comment above the conjunct states the property in the file itself - "Liveness of a row is
 * not liveness of a process (#831)" - and this row is what makes that sentence checkable.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "the-abandoned-branch-needs-the-runtime-gone",
  what:
    "the abandoned-runtime branch requires the predecessor's process to be gone, not merely its "
    + "row to be non-terminal",
  file: "src/registry/canonical-self-claim.ts",
  find: " && predecessorRuntimeIsGone",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a predecessor whose ancestry probe failed but whose process answers a signal keeps the role",
  ],
};
export default c;
