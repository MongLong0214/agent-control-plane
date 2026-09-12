/**
 * #833/#866. The refusal that makes a frozen count detectable is itself detectable.
 *
 * `verify-refusal-operands-are-watched.mjs` derives three operand totals and then refuses when
 * they do not reconcile. Without this row the refusal is the one thing in that file no gate holds:
 * a merge-gate review deleted the whole `if` block and the census still exited 0 while every test,
 * every anchor and the enforcement-symbol census stayed green.
 *
 * The reason it escaped is worth keeping. `selected` and `excluded` are complementary filters over
 * the same `candidates`, so their operand counts sum to the repository's *by construction* — no
 * arrangement of source files can make the branch fire, and the neighbouring row's anchor sits on
 * a derivation line rather than on the refusal. A guard reachable only by editing the script is
 * exactly what this harness is for, and exactly what a data-driven fixture cannot reach alone.
 *
 * The killing case therefore injects the defect the refusal names — one total rewritten as a
 * literal — into a copy of the census, in a temporary root with a stubbed `scripts/lib`. It
 * asserts the refusal's own wording and that no `CENSUS:` line is printed, so a census that
 * complained *and also* reported its disproved split would not pass either.
 */
const theReconciliationRefusalIsWitnessed = {
  id: "the-reconciliation-refusal-is-witnessed",
  what: "a census whose split does not reconcile refuses instead of reporting",
  file: "scripts/verify-refusal-operands-are-watched.mjs",
  find: "if (selectedOperands + excludedOperands !== repositoryOperands) {\n",
  replace: "if (false) {\n",
  killedBy: [
    "tests/process/the-refusal-operand-census-derives-subjects.test.ts::refuses its own report when one of the three totals has stopped being derived",
  ],
};

export default theReconciliationRefusalIsWitnessed;
