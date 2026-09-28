/**
 * A saved cursor belongs to the buffer it was saved on.
 *
 * xterm keeps one saved cursor for the main screen and one for the alternate (`cursor.c`,
 * `sc[whichBuf]`), and leaving the alternate with `CSI ?1049l` restores the main screen's. The
 * model kept one for both, so a DECSC made on the alternate screen replaced the cursor the way out
 * puts back: review parked the cursor on row 1, saved on the caret's row inside the alternate, left
 * it, and read `ready: true` where a terminal's cursor is on row 1. The mutation writes every save
 * to both slots, which is that single shared cursor again.
 */
const aSavedCursorBelongsToItsBuffer = {
  id: "a-saved-cursor-belongs-to-its-buffer",
  what: "the screen model keeps one saved cursor per buffer, so leaving the alternate screen restores the main screen's",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    saved[shown()] = { row, col, inverse, doubt: cursorDoubt };\n",
  replace: "    saved.main = saved.alternate = { row, col, inverse, doubt: cursorDoubt };\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a cursor saved on the alternate screen is not the one leaving it with 1049 restores",
  ],
};

export default aSavedCursorBelongsToItsBuffer;
