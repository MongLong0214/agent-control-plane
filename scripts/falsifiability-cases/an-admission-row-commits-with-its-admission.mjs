/**
 * ACP-REVIEW-01. The canonical self-claim's admission row used to be written by `claim()` after the
 * admission's transaction had committed. An insert that threw there escaped `claim()` with the
 * session, the binding and the generation bump already durable, so the listener answered
 * INTERNAL_ERROR for a claim the database said had succeeded. The row is now written last inside
 * the admission's own transaction, so a failed insert rolls the admission back.
 *
 * The mutation moves that one write back outside the transaction through the database's own
 * after-commit hook, which runs it exactly where the old call site did: after COMMIT, outside the
 * try that turns a failure into a refusal. It typechecks and every ordinary admission still writes
 * its one row, so only a failing insert can tell the two apart. The named verdict fills the disk at
 * the admission's insert and requires a returned refusal with every table unchanged; under the
 * mutant the claim throws with its binding committed instead.
 */
const c = {
  id: "an-admission-row-commits-with-its-admission",
  what: "the canonical self-claim writes its admission row inside the admission's transaction, so a failed insert rolls the admission back instead of throwing past a committed binding",
  file: "src/registry/canonical-self-claim.ts",
  find: "        this.audit.record(claimDecisionAuditRecord(asked, admitted, (projectId) => this.#isRegisteredProject(projectId)));",
  replace: "        this.db.afterCommit(() => this.audit.record(claimDecisionAuditRecord(asked, admitted, (projectId) => this.#isRegisteredProject(projectId))));",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::an admission whose audit row cannot be written is rolled back and refused, not committed and reported as an internal error",
  ],
};
export default c;
