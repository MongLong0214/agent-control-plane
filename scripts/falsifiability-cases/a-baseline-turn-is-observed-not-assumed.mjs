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
 * **What this row does not reach**: the predicate, not the refusal. The arm's `if (!baselineSeen)`
 * branch -- the line that actually throws and fails the run -- is executed only when a real client
 * has been started, so no row that must die where no client is installed can be anchored there. The
 * claim is narrowed to the predicate accordingly.
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
