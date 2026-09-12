/**
 * #833 — a declared owner item requires the owner on its own.
 *
 * `required` is a three-way disjunction, which is the shape that hides untested operands: any one
 * being true carries the whole condition, so a case that sets two proves nothing about either.
 * The mutation makes the declared-items operand always false. A STANDARD run that declares an
 * item and triggers no §21 phrase then stops being gated — the task contract's own addition to
 * the owner questions silently drops.
 *
 * Inverted rather than deleted: deleting the operand leaves `declaredItems` used only for
 * `items`, which still compiles, but inversion keeps the mutation local to the one operand under
 * test and cannot be satisfied by the neighbouring reasons.
 */
const aDeclaredOwnerItemRequiresTheOwner = {
  id: "a-declared-owner-item-requires-the-owner",
  what: "an item the task contract declares requires the owner even when the mode is not GUARDED and no trigger phrase appears",
  file: "src/ceo/human-gate.ts",
  find: "declaredItems.length > 0",
  replace: "declaredItems.length < 0",
  killedBy: [
    "tests/unit/the-human-gate-operands-have-witnesses.test.ts::requires the owner for a declared item on a STANDARD run with no trigger text",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDeclaredOwnerItemRequiresTheOwner;
