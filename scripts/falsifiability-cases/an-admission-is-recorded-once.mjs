/**
 * ACP-REVIEW-01. The admission's row moved into the admission's transaction; `claim()` still writes
 * the row for every refusal on its way out. What keeps the admission from being recorded at both
 * sites is the early return `claim()` takes for an allowed decision.
 *
 * The mutation discards that return, so `claim()` records an admission a second time after the
 * transaction already wrote one. It typechecks: the record builder accepts either kind. The named
 * verdict reads the decision rows back exactly and requires one admission row.
 */
const c = {
  id: "an-admission-is-recorded-once",
  what: "an admitted canonical self-claim leaves exactly one admission row, written in its transaction and not again by claim()",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (decision.allowed) return decision;",
  replace: "    void decision.allowed;",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a successful adoption leaves exactly one audit row naming the admitted session and its role key",
  ],
};
export default c;
