/**
 * Readiness needs the cell under the cursor to be a caret the client drew, not merely a blank.
 *
 * Dropping the inverse-video test turns the predicate into "the cursor is over an empty cell",
 * which an empty screen satisfies at its first byte and a half-drawn banner satisfies wherever
 * the cursor stopped. A harness with that predicate types into a client that has not drawn its
 * input box yet. The killing row cuts every real first screen at every point before its input
 * line and requires none of those prefixes to read as ready.
 */
const interactiveReadinessNeedsADrawnCaret = {
  id: "interactive-readiness-needs-a-drawn-caret",
  what: "the harness does not call a screen with no input line ready: the cursor must rest on an inverse-video caret",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '  const cursorOnCaret = under !== undefined && under.inverse && under.glyph === " ";\n',
  replace: '  const cursorOnCaret = under !== undefined && under.glyph === " ";\n',
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::no prefix of a first screen that ends before its input line is a ready prompt",
  ],
};

export default interactiveReadinessNeedsADrawnCaret;
