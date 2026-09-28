/**
 * Whatever is written at a cursor in doubt lands in cells in doubt.
 *
 * Erasing the screen after an inline image makes its cells known, but not the cursor: the image
 * moved it by a size the model cannot know. A line feed and text written from there land on a row
 * the model cannot name, so a park by both coordinates afterwards finds the model's caret and not
 * necessarily the terminal's. The mutation stops a write at a doubtful cursor from putting the
 * cells back in doubt, which forgives the image at the erase alone.
 */
const aWriteAtADoubtfulCursorIsInDoubt = {
  id: "a-write-at-a-doubtful-cursor-is-in-doubt",
  what: "a write at a cursor whose position is in doubt puts the cells of the shown buffer in doubt",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    cellDoubt[shown()] = withNames(cellDoubt[shown()], cursorDoubt);\n",
  replace: "    cellDoubt[shown()] = withNames(cellDoubt[shown()], []);\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a repaint that has not placed the cursor, or writes before placing it, leaves the screen in doubt",
  ],
};

export default aWriteAtADoubtfulCursorIsInDoubt;
