/**
 * An `OSC 1337` command is judged by what it does to the screen, not by the number it shares.
 *
 * Every `OSC 1337` was refused, and the refusal lasted the stream: `SetMark`, which records a
 * navigation mark and touches no cell, left the caret unready for good, so one such sequence before
 * a prompt would fail the readiness wait of a build that is otherwise fine. The mutation looks the
 * whole sequence up instead of its command name, which matches nothing, so every `OSC 1337` is
 * refused again.
 */
const anIterm2CommandIsJudgedByWhatItDoes = {
  id: "an-iterm2-command-is-judged-by-what-it-does",
  what: "the screen model lets an OSC 1337 command that changes no cell through, by its command name",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    if (INERT_ITERM2_COMMANDS.has(command)) return;\n",
  replace: "    if (INERT_ITERM2_COMMANDS.has(raw)) return;\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::an OSC 1337 command is judged by what it does: a mark on the caret is ready",
  ],
};

export default anIterm2CommandIsJudgedByWhatItDoes;
