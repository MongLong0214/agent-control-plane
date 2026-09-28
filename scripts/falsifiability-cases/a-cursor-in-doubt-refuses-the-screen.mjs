/**
 * A cursor whose position is in doubt refuses the screen, even over cells that are not.
 *
 * An image drawn on the alternate screen moves the cursor, and leaving by 1047 neither clears the
 * main screen nor restores the cursor. The main screen's cells are the model's, the model's cursor
 * is on the caret, and the terminal's is wherever the image left it. The mutation reads only the
 * cells' doubt, which reads that screen as ready.
 */
const aCursorInDoubtRefusesTheScreen = {
  id: "a-cursor-in-doubt-refuses-the-screen",
  what: "readiness refuses a screen whose cursor position is in doubt after a screen-confined sequence",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    standing.has(name) || cursorDoubt.includes(name) || cellDoubt[shown()].includes(name));\n",
  replace: "    standing.has(name) || cellDoubt[shown()].includes(name));\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a repaint that has not placed the cursor, or writes before placing it, leaves the screen in doubt",
  ],
};

export default aCursorInDoubtRefusesTheScreen;
