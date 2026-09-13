/**
 * #886 — the comparison that decides the finding, mutated away.
 *
 * Removing `deployed === C0_QUALIFIED_CLIENT.version` leaves the null test alone, so every
 * *activated* deployment reports a disagreement — including the one where the two pins agree,
 * which is the state the whole check exists to distinguish. This is the fail-loud direction, and
 * it is the one a reader is least likely to catch by inspection: the finding's text would be
 * correct in shape and wrong in every instance.
 *
 * The control case is what dies, and it is deliberately a control rather than a second positive:
 * a check whose only test is the failing case cannot tell "reports the disagreement" from
 * "reports always". Both cases read the version out of `C0_QUALIFIED_CLIENT` rather than writing
 * one down, so neither becomes a third authority on the question #886 is about.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const anAgreeingPinRaisesNothing = {
  id: "an-agreeing-pin-raises-nothing",
  what:
    "an activated deployment whose executor pin names the build the wake transport was qualified on "
    + "raises no finding, so the check distinguishes a disagreement from merely being activated",
  file: "src/daemon/daemon.ts",
  find: "    if (deployed === null || deployed === C0_QUALIFIED_CLIENT.version) return [];\n",
  replace: "    if (deployed === null) return [];\n",
  killedBy: [
    "tests/unit/the-two-halves-of-the-canonical-end-state-name-one-build.test.ts::stays quiet when the deployment pin names the qualified build — the control",
  ],
};

export default anAgreeingPinRaisesNothing;
