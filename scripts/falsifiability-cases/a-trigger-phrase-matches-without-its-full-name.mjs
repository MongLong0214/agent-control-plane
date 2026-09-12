/**
 * #833 — a short trigger phrase fires the gate without the trigger's full name appearing.
 *
 * `matches` is `text.includes(normalise(trigger)) || phrases.some(...)`. The mutation removes the
 * phrase half, leaving only the full-name check. A goal reading "expose the run receipt over the
 * public api" then stops requiring the owner, because the full trigger name — "public api or
 * protocol breaking change" — never appears in it.
 *
 * That is the operand's whole purpose: these are narrow textual classifiers, and a real goal
 * states the thing, not the §21 class name. Without the phrase half the classifier only
 * recognises text that quotes the table back at it.
 *
 * The mutation narrows `includes` to `===` rather than deleting the operand. Deleting it leaves
 * `TRIGGER_PHRASES` unused and the mutant fails `tsc` with exit 2 — measured — so the harness
 * refuses it before any test runs. Requiring the phrase to be the entire text keeps the file
 * compiling and removes the substring behaviour that is the point.
 */
const aTriggerPhraseMatchesWithoutItsFullName = {
  id: "a-trigger-phrase-matches-without-its-full-name",
  what: "a §21 trigger is recognised from a short phrase a real goal would contain, not only from the trigger's own full name",
  file: "src/ceo/human-gate.ts",
  // Anchored on the phrase operand alone, not the whole line. A line-wide `find` credits every
  // operand inside it, and here that would name `text.includes(normalise(trigger))` too — an
  // operand this row does not test, which then leaves its measured UNANSWERED entry unconsumed
  // and fails the census as a stale entry. Measured on this branch.
  find: "TRIGGER_PHRASES[trigger].some((phrase) => text.includes(phrase))",
  replace: "TRIGGER_PHRASES[trigger].some((phrase) => text === phrase)",
  killedBy: [
    "tests/unit/the-human-gate-operands-have-witnesses.test.ts::matches a short phrase that is not the trigger's own name",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aTriggerPhraseMatchesWithoutItsFullName;
