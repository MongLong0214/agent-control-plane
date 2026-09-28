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
 * **What this row does not reach**, narrowed deliberately after a review found it claimed more: it
 * is about `probeArgv`'s output and nothing else. What an arm actually starts is
 * `the-arm-executes-the-invocation-it-records`'s subject, and the `spawn()` call that consumes the
 * plan is exercised only by the live arms, which do not run where no client is installed. An honest
 * narrow claim beats a wide one nothing checks.
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
