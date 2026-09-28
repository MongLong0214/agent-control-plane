/**
 * Erasing the whole screen ends the doubt a screen-confined sequence left about its cells.
 *
 * An inline image moves cells and the cursor by a size the model cannot know, and nothing else. A
 * repaint -- the screen erased, the cursor placed -- overwrites both, so a client that draws one
 * before its prompt and then repaints is ready again. Without this, the image's doubt outlived
 * every later frame, which is the permanent refusal review found. The mutation keeps the doubt
 * through the erase.
 */
const aRepaintEndsAScreenConfinedDoubt = {
  id: "a-repaint-ends-a-screen-confined-doubt",
  what: "an erase of the whole screen ends the doubt an inline image left about the cells of that buffer",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "          cellDoubt[shown()] = [];\n",
  replace: "          cellDoubt[shown()] = [...cellDoubt[shown()]];\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a repaint ends the doubt an inline image leaves",
  ],
};

export default aRepaintEndsAScreenConfinedDoubt;
