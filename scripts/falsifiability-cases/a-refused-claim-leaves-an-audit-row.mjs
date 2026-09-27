/**
 * The canonical self-claim wrote nothing to `audit_events`, so a claim refused for weeks left no
 * row saying it had been refused. `claim()` now records every decision it hands back, once, at the
 * single boundary where it returns — not beside each `deny`, so a refusal added later is covered
 * without anyone remembering to add a row for it.
 *
 * The mutation keeps the audit record being built and drops only the write, so the mutant
 * typechecks and every refusal and admission is still decided exactly as before. The named verdict
 * asserts the claim's own outcome (refused, CONFLICT) before it reads the table, so under this
 * mutant it fails on the missing row and on nothing else. Measured against the whole file, the
 * mutant kills 47 of its 93 tests: every case in the decision-row block, the five-table success
 * test, whose audit footprint lists the admission row, and every rollback case, because each of
 * those now requires the refusal's own row as the whole of its audit delta rather than leaving the
 * decision kinds out of the count. `killedBy` takes one selector, so the rest are recorded here.
 */
const c = {
  id: "a-refused-claim-leaves-an-audit-row",
  what: "every decision the canonical self-claim hands back, a refusal included, is written to audit_events at its return boundary",
  file: "src/registry/canonical-self-claim.ts",
  find: "    this.audit.record(claimDecisionAuditRecord(asked, decision, (projectId) => this.#isRegisteredProject(projectId)));",
  replace: "    void claimDecisionAuditRecord(asked, decision, (projectId) => this.#isRegisteredProject(projectId));",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a refusal of an unconfigured session leaves exactly one audit row carrying its reason code",
  ],
};
export default c;
