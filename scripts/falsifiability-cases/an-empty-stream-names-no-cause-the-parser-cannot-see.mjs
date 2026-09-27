/**
 * #954 — the empty-stream sentence reports what was observed and stops there.
 *
 * `parseUsageOutput` receives text. It cannot see a spawn result, so it cannot know why a stream
 * was empty. The sentence it produced named one cause anyway — a CLI outside the daemon's PATH
 * resolving to a bare name — which was correct for #564/#568 and wrong for #954, where an
 * absolute pin named a version directory the provider's updater had deleted. An operator reading
 * it went looking for a PATH problem that did not exist.
 *
 * This is the same defect as the collector's "exited on a signal": a sentence naming a cause the
 * code did not measure. The distinction the branch legitimately draws — said nothing at all,
 * versus said something that was not a quota screen — is untouched by this row; only the
 * unmeasured attribution is.
 *
 * The mutation restores the old sentence, which is a plausible wrong implementation rather than a
 * break: it reads as more helpful than the honest one, which is how it survived two issues.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-empty-stream-names-no-cause-the-parser-cannot-see",
  what:
    "the empty interactive stream is reported as unexplained rather than attributed to a PATH "
    + "resolution this parser never observed",
  file: "src/capacity/usage-collectors.ts",
  find:
    "          \"interactive CLI produced no output at all; this parser sees only text and cannot say \" +\n"
    + "          \"why it was silent (the process may never have started, or started and printed nothing)\",\n",
  replace:
    "          \"interactive CLI produced no output; the binary may not have launched \" +\n"
    + "          \"(a CLI outside the daemon's PATH resolves to a bare name and never starts)\",\n",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::tells a CLI that never launched apart from one that showed the wrong screen",
  ],
};
export default c;
