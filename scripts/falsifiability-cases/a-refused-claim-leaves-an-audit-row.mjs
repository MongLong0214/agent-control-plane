/**
 * The canonical self-claim wrote nothing to `audit_events`, so a claim refused for weeks left no
 * row saying it had been refused. `claim()` now records every refusal it hands back, once, at the
 * single boundary where it returns — not beside each `deny`, so a refusal added later is covered
 * without anyone remembering to add a row for it. The admission's row is no longer written here:
 * it moved into the admission's own transaction (`an-admission-row-commits-with-its-admission`),
 * so this row's anchor moved into the `try` that keeps a failed refusal insert from escaping.
 *
 * The mutation keeps the audit record being built and drops only the write, so the mutant
 * typechecks and every refusal and admission is still decided exactly as before. The named verdict
 * asserts the claim's own outcome (refused, CONFLICT) before it reads the table, so under this
 * mutant it fails on the missing row and on nothing else. Re-measured against the whole file after
 * the move, the mutant kills 48 of its 97 tests: every refusal case in the decision-row block,
 * every rollback case, because each requires the refusal's own row as the whole of its audit
 * delta, and the four audit-failure cases, whose injection observes which inserts were attempted.
 * The five-table success test and the two admission-row cases no longer die, since the admission's
 * row is not written by this line. `killedBy` takes one selector, so the rest are recorded here.
 */
const c = {
  id: "a-refused-claim-leaves-an-audit-row",
  what: "every refusal the canonical self-claim hands back is written to audit_events at its return boundary",
  file: "src/registry/canonical-self-claim.ts",
  find: "      this.audit.record(claimDecisionAuditRecord(asked, decision, (projectId) => this.#isRegisteredProject(projectId)));",
  replace: "      void claimDecisionAuditRecord(asked, decision, (projectId) => this.#isRegisteredProject(projectId));",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a refusal of an unconfigured session leaves exactly one audit row carrying its reason code",
  ],
};
export default c;
