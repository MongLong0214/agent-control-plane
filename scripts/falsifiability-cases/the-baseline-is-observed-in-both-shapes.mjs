/**
 * The baseline turn is observed in the interactive arm too, not assumed for it.
 *
 * The interactive arm is started with its prompt as a positional argument, which makes it the arm
 * where assuming the prompt became a turn is most tempting and least safe: the argument being
 * accepted is exactly what a build could stop doing. A reviewer showed that a mutation confined to
 * that shape survived the offline rows, which drove the headless one only -- so the refusal was
 * demonstrated for the arm that types nothing and left unmeasured for the arm that types nothing
 * *and* was started with a prompt.
 *
 * The mutation takes the interactive arm's baseline on trust. The killing row starts the
 * interactive shape against a stand-in that takes a turn which is not this arm's prompt, and
 * requires the run to be refused by name.
 */
const theBaselineIsObservedInBothShapes = {
  id: "the-baseline-is-observed-in-both-shapes",
  what: "the harness observes the baseline turn in the interactive arm rather than trusting the prompt it passed",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "    const baselineSeen = await waitFor(\n" +
    "      () => baselineTurnObserved(readFileSync(capturePath, \"utf8\"), BASELINE_PROMPT),\n" +
    "      options.baselineCeilingMs ?? 120_000,\n" +
    "    );\n",
  replace:
    "    const baselineSeen =\n" +
    "      options.shape === \"interactive\" ||\n" +
    "      (await waitFor(\n" +
    "        () => baselineTurnObserved(readFileSync(capturePath, \"utf8\"), BASELINE_PROMPT),\n" +
    "        options.baselineCeilingMs ?? 120_000,\n" +
    "      ));\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::refuses an arm whose prompt never became a turn, rather than measuring against nothing",
  ],
};

export default theBaselineIsObservedInBothShapes;
