/**
 * Insert-line moves the lines below it, and the caret with them.
 *
 * The screen model used to drop `CSI L`: a caret drawn at row 38 and a line inserted above it left
 * the model's caret at 38 while a terminal's is at 39, so a park at 38 read `ready: true` and a park
 * at 39 read `ready: false` -- both wrong, and silently, because the sequence was simply ignored.
 * The killing row draws exactly that screen and parks on both rows.
 */
const anInsertedLineMovesTheCaret = {
  id: "an-inserted-line-moves-the-caret",
  what: "the screen model applies insert-line, so a caret it pushes down is found on its new row",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '      case "L": insertLines(count(0)); break;\n',
  replace: '      case "L": break;\n',
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::an inserted line moves the caret down with it: a park on its old row is not ready, and on its new row is",
  ],
};

export default anInsertedLineMovesTheCaret;
