/**
 * The interactive arm starts the client in the one invocation shape that may hold the canonical
 * claim.
 *
 * `isInteractiveClaudeInvocation` (src/registry/canonical-self-claim.ts) refuses `-p`, `--print`,
 * `--output-format` and `--input-format`, so the process this deployment allows to hold the claim
 * has exactly the shape with none of them. An arm carrying any one of them measures the transport
 * into a process that could never be the holder, and the reading would qualify a build for a role it
 * cannot fill -- while every number in that reading still looked like a pass. The baseline turn's
 * prompt travels as a positional argument precisely because an operand is not a flag and leaves the
 * shape alone.
 *
 * The killing row calls that predicate on the argv this function returns, for both shapes: the
 * interactive one must be accepted, the headless one refused, so the row cannot pass by saying yes
 * to everything.
 *
 * This row is about `probeArgv`'s output. That the shape survives into the process is two further
 * rows: `the-arm-executes-the-invocation-it-records` for the plan, and
 * `the-arm-starts-the-plan-and-nothing-beside-it` for the call that consumes it -- the latter driving
 * the real probe through an injected process boundary, which is how a flag appended at the spawn and
 * not to the plan dies. That call was previously called unreachable where no client is installed and
 * this claim was narrowed on that ground; a reviewer refuted it by executing the branch, so the three
 * rows between them now cover argv, plan and start.
 */
const theInteractiveArmIsTheShapeTheClaimAccepts = {
  id: "the-interactive-arm-is-the-shape-the-claim-accepts",
  what: "the argv probeArgv builds for the interactive arm carries none of the flags the canonical-claim interactivity predicate refuses",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    ? [...shared, BASELINE_PROMPT]\n",
  replace: '    ? ["--print", ...shared, BASELINE_PROMPT]\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::the interactive argv is an invocation the canonical-claim predicate accepts, positional prompt and all",
  ],
};

export default theInteractiveArmIsTheShapeTheClaimAccepts;
