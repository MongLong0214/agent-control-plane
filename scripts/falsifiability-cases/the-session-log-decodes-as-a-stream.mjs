/**
 * The session log is decoded as one stream, not once per pipe read.
 *
 * A pipe read ends wherever the pipe was drained, not on a character boundary: of eleven client
 * starts captured on 2026-09-28, three split a three-byte glyph across two reads, and decoding each
 * read on its own turns each half into U+FFFD. `terminalOutput` keeps the bytes and decodes the
 * concatenation, so the only mangled glyph possible is one the client had not finished writing.
 *
 * **A narrow row, deliberately.** This text is diagnosis only -- the session log a failed arm
 * prints and the file every run copies out beside its capture. Nothing in the harness measures
 * anything off it and nothing may; what it owes is to be readable by whoever opens it after a
 * failure. The row that used to say this was deleted with the screen model it was written beside,
 * while the guarantee stayed, so a reviewer found the subject still here with no guard on it.
 *
 * The mutation decodes each read on its own. The killing row feeds `❯` split after one byte and
 * after two, requires the glyph back, and keeps the naive decode's three replacement characters as
 * its control.
 */
const theSessionLogDecodesAsAStream = {
  id: "the-session-log-decodes-as-a-stream",
  what: "the harness's diagnosis-only session log decodes the concatenated bytes, so a glyph split across two pipe reads survives",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '    text: () => Buffer.concat(chunks).toString("utf8"),\n',
  replace: '    text: () => chunks.map((chunk) => chunk.toString("utf8")).join(""),\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a glyph split across two reads survives, which decoding each read on its own does not",
  ],
};

export default theSessionLogDecodesAsAStream;
