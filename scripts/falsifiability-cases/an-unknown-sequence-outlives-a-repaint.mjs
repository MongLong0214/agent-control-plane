/**
 * A sequence the model cannot confine to cells and the cursor stays in doubt across a repaint.
 *
 * A repaint overwrites cells and the cursor and no mode: after `CSI 4h` every glyph of the most
 * careful redraw still pushes its line right. So the short lifetime is given only to a sequence
 * named for it, and the default is the stream. The mutation makes the short lifetime the default,
 * which is clearing the doubt too eagerly: insert mode, origin mode, an unknown final and an
 * unclassified `OSC 1337` command would each be forgiven by the next repaint.
 */
const anUnknownSequenceOutlivesARepaint = {
  id: "an-unknown-sequence-outlives-a-repaint",
  what: "an unmodelled sequence is in doubt for the rest of the stream unless it is named as confined to the screen",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '  const refuse = (raw: string, doubt: Doubt = "stream"): void => {\n',
  replace: '  const refuse = (raw: string, doubt: Doubt = "screen"): void => {\n',
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::and not the doubt of a sequence that changes how later bytes land",
  ],
};

export default anUnknownSequenceOutlivesARepaint;
