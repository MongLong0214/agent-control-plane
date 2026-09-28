/**
 * The baseline turn is established by a captured model request, never assumed from the fact that
 * the prompt was passed.
 *
 * The interactive arm is *started* with its prompt as a positional argument, so nothing in the run
 * observes a keystroke being accepted. The only evidence that the client took the prompt is the
 * request it sent to be inferred on -- the same kind of evidence the wake itself is judged by -- and
 * a run that proceeds without it measures the wake's follow-up against a baseline that never
 * happened. Then `followUpAfterInjection` is a comparison with nothing, and the arm can report a
 * pass for a session that never turned at all.
 *
 * The mutation is the assumption written down: acceptance without an observation. The killing row
 * feeds an empty capture, a whitespace-only one, and one holding only a request to another endpoint,
 * and requires each to be "no turn seen".
 *
 * This row is the predicate; the branch that acts on it is `an-unobserved-baseline-stops-the-arm`,
 * anchored at the `if (!baselineSeen)` refusal itself. That branch was previously called unreachable
 * where no client is installed and this claim was narrowed on that ground; a reviewer refuted it by
 * bypassing the refusal through injected boundaries with every selected offline body still passing.
 * So the refusal is anchored rather than argued about, and between the two rows the predicate and the
 * act each have a row that dies without them.
 */
const aBaselineTurnIsObservedNotAssumed = {
  id: "a-baseline-turn-is-observed-not-assumed",
  what: "the harness's baseline predicate requires a captured model request before it says the baseline turn happened",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "export const baselineTurnObserved = (capture: string, prompt: string): boolean =>\n" +
    "  modelRequestsIn(capture).some((request) => userMessageTexts(request.body).some((text) => text.trim() === prompt));\n",
  replace: "export const baselineTurnObserved = (_capture: string, _prompt: string): boolean => true;\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::the baseline turn is a captured model request, and nothing short of one counts as having seen it",
  ],
};

export default aBaselineTurnIsObservedNotAssumed;
