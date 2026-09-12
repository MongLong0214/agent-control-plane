/**
 * #833 — §21 text in a run's own goal or scope requires the owner with nothing declared.
 *
 * The mutation makes the triggered-items operand always false. A STANDARD run whose goal says
 * "delete the stale run rows" then proceeds without the owner, because nothing was declared and
 * the mode is not GUARDED — and the classifier's whole purpose is that a run cannot avoid §21 by
 * declining to declare it.
 *
 * The items list still reports the trigger, so a test asserting only `items` passes against this
 * mutant. `required` is the assertion that matters.
 */
const triggeringTextAloneRequiresTheOwner = {
  id: "triggering-text-alone-requires-the-owner",
  what: "text matching a §21 trigger in the goal or scope requires the owner by itself, so a run cannot escape the gate by declaring nothing",
  file: "src/ceo/human-gate.ts",
  find: "triggeredItems.length > 0",
  replace: "triggeredItems.length < 0",
  killedBy: [
    "tests/unit/the-human-gate-operands-have-witnesses.test.ts::requires the owner for triggering text alone, with nothing declared and a STANDARD mode",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default triggeringTextAloneRequiresTheOwner;
