/**
 * Each arm's recorded argv must be the shape that arm claims, judged by the predicate production
 * judges by.
 *
 * `isInteractiveClaudeInvocation` (src/registry/canonical-self-claim.ts) decides which processes
 * may hold the canonical claim, and the interactive arm exists to measure a session of exactly that
 * shape. A reading whose "interactive" arm carries an argv the predicate refuses qualifies a
 * process that could never be the holder -- reproduced by adding `--output-format=json` to a
 * committed reading's interactive command, which passed every offline check. The headless direction
 * is checked too: an arm recorded as headless whose argv the predicate accepts is not the control
 * the comparison needs.
 *
 * The mutation compares the predicate's answer with itself, so the rule still calls the real
 * predicate and can never disagree with it. The killing row supplies both directions.
 */
const anArmIsTheShapeItClaimsToBe = {
  id: "an-arm-is-the-shape-it-claims-to-be",
  what: "a reading qualifies a build only when each arm's argv is what the canonical-claim predicate says its shape is",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '    } else if (isInteractiveClaudeInvocation(run.command) !== (run.shape === "interactive")) {\n',
  replace:
    "    } else if (isInteractiveClaudeInvocation(run.command) !== isInteractiveClaudeInvocation(run.command)) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm is the shape it claims, judged by the predicate production judges by",
  ],
};

export default anArmIsTheShapeItClaimsToBe;
