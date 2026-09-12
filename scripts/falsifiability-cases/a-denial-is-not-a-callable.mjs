/**
 * #833 — a callable cannot pass as a denial.
 *
 * `isAcpError` is deliberately structural rather than `instanceof`-based, so anything carrying the
 * shape is trusted as a denial whichever realm produced it. The refusals are the whole of what
 * keeps that from meaning "anything at all".
 *
 * The mutation removes the object test. A string or a number is refused either way — reading
 * `reasonCode` off one yields `undefined` — so those are not this operand's witness. A **function
 * is**: functions hold their own properties, `typeof fn` is `"function"`, and without this operand
 * `Object.assign(() => undefined, denial)` is accepted as a denial.
 *
 * That is not a curiosity. Every caller reads `reasonCode` and `evidence` off whatever this
 * returns true for, and a callable admitted here is a value some code path will also invoke.
 */
const aDenialIsNotACallable = {
  id: "a-denial-is-not-a-callable",
  what: "a value carrying the denial contract on a function's own properties is refused, so a callable cannot pass as a denial",
  file: "src/core/errors.ts",
  find: "typeof value !== \"object\" || ",
  replace: "",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses a function carrying the contract on its own properties"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialIsNotACallable;
