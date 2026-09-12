/**
 * #833 — each of the three reasons the human gate fires is driven by an input only it explains.
 *
 * `required` is a disjunction, which is the shape that hides untested operands: any one of the
 * three being true carries the whole condition, so a test that sets two of them proves nothing
 * about either. The mutation removes the GUARDED-mode reason. A GUARDED run with nothing declared
 * and nothing triggered is the one case only that operand answers, and it is not a corner: the
 * function's own docstring says such a run stays required with a deliberately empty item list,
 * and that callers must fail closed rather than read the empty list as an opt-out.
 *
 * The mutation inverts the comparison rather than deleting the operand. Deleting it leaves the
 * `ExecutionMode` value import unused and the mutant fails `tsc` with exit 2 — measured — so the
 * harness refuses it before any test runs. Inversion keeps the file compiling and removes exactly
 * the behaviour under test.
 *
 * The other two operands are covered by their own cases in the same file — a declared item on a
 * STANDARD run, and triggering text with nothing declared — plus a control asserting an
 * ordinary STANDARD run is not gated, without which all three pass against a gate that always
 * fires.
 */
const theHumanGateFiresForEachReason = {
  id: "the-human-gate-fires-for-each-reason",
  what: "a GUARDED run requires the owner even with no declared item and no triggering text, so the mode is its own reason rather than a duplicate of the other two",
  file: "src/ceo/human-gate.ts",
  find: "input.executionMode === ExecutionMode.GUARDED ||",
  replace: "input.executionMode !== ExecutionMode.GUARDED &&",
  killedBy: [
    "tests/unit/the-human-gate-operands-have-witnesses.test.ts::requires the owner for a GUARDED run with nothing declared and nothing triggered",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theHumanGateFiresForEachReason;
