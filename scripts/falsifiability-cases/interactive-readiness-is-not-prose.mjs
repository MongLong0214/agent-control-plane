/**
 * The qualification harness decides the interactive client is at its prompt from the caret it
 * drew, not from a phrase in its output.
 *
 * The predicate this replaces was `/for shortcuts/` over the escape-stripped stream, and 2.1.283
 * never satisfied it: the renderer repaints by difference, skips a cell it already shares with the
 * previous frame by moving the cursor, and deleting that move reads `shortuts`. Every build that
 * renders its hint that way was unqualifiable, because the measurement starts by typing into the
 * prompt. The mutation puts that predicate back; the 2.1.283 first-screen fixture is the one whose
 * stripped text never says it.
 */
const interactiveReadinessIsNotProse = {
  id: "interactive-readiness-is-not-prose",
  what: "the harness recognises the interactive prompt by the drawn caret, not by the prose hint in the stripped stream",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  const ready = cursorOnCaret && rendered.unmodelled.length === 0;\n",
  replace: "  const ready = /for shortcuts/.test(strip(stream));\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::the prompt is recognised on the first screen of claude-code@2.1.283",
  ],
};

export default interactiveReadinessIsNotProse;
