/**
 * An arm whose prompt never became a turn stops, rather than measuring the wake against nothing.
 *
 * `baselineTurnObserved` is the predicate; this is the branch that acts on it. Proceeding past a
 * baseline nobody observed leaves `followUpAfterInjection` comparing the wake's follow-up against a
 * count that never included the prompt, so the arm can report a pass for a session that was never
 * seen to accept a turn at all -- and the run would write a reading saying so.
 *
 * The mutation empties the refusal and keeps everything else: the predicate still runs, the wait
 * still spends its ceiling, and the arm proceeds on the answer it got. The killing row starts a
 * stand-in that binds the socket and takes a turn that is *not* this arm's prompt, so every
 * condition except the one observation the arm requires is satisfied, and requires the probe to
 * reject naming the prompt it was started with.
 *
 * This site was previously called unreachable where no client is installed, and the predicate's row
 * was narrowed on that ground. A reviewer refuted it by bypassing this refusal through injected
 * boundaries with all 24 selected offline bodies still passing, so the branch carries its own row.
 */
const anUnobservedBaselineStopsTheArm = {
  id: "an-unobserved-baseline-stops-the-arm",
  what: "an arm that never observed its prompt become a turn fails the run instead of measuring the wake against an unobserved baseline",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "    if (!baselineSeen) {\n" +
    "      throw new Error(\n" +
    "        `the client sent no model request carrying ${JSON.stringify(BASELINE_PROMPT)}, the prompt it was started with\\n${stderr}\\n` +\n" +
    "          `--- terminal tail, escapes deleted rather than applied; diagnosis only ---\\n${strip(terminal.text()).slice(-2000)}`,\n" +
    "      );\n" +
    "    }\n",
  replace: "    if (!baselineSeen) {\n      // the mutation: proceed on an unobserved baseline\n    }\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::refuses an arm whose prompt never became a turn, rather than measuring against nothing",
  ],
};

export default anUnobservedBaselineStopsTheArm;
