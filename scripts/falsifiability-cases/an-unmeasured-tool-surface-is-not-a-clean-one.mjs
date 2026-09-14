/**
 * #655 condition 3 - a tool census nobody took is not a census that came back clean.
 *
 * The condition is a gate on *starting*: "if mutating and external tools are not **measured** as
 * off, the run does not start." The number behind it is that a trivial prompt once produced 65
 * tool calls.
 *
 * Removing this refusal leaves the two checks below, and both pass on a census that was never
 * taken: `tools` is `{}`, so no forbidden tool is `undefined`... except every one of them is, so
 * the second check catches it today. That is why this mutation is worth a row rather than being
 * dismissed as redundant - the completeness check is a different statement, and a future census
 * that carries a full map of `false` defaults with `measuredAt: null` would satisfy it while
 * having measured nothing. The absence has to be its own refusal, separately reported, because
 * the operator's next action is "go and take one" rather than "change the child".
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-unmeasured-tool-surface-is-not-a-clean-one",
  what:
    "a probe tool census that was never taken is refused rather than read as clean, so a run "
    + "that measured nothing cannot start",
  file: "src/acceptance/disposable-realm.ts",
  find: '  if (census.measuredAt === null) {\n    return deny(\n      ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE,\n      "the probe child\'s tool surface was never measured, so the run does not start",\n      { targetRoot: census.targetRoot },\n    );\n  }\n',
  replace: "",
  killedBy: [
    "tests/unit/the-two-preconditions-the-list-names.test.ts::refuses a census that was never taken, rather than reading its empty tool map as clean",
  ],
};
export default c;
