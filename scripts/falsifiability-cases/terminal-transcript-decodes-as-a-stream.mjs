/**
 * The harness decodes the client's stdout as one stream, so a glyph split across two reads stays
 * one glyph.
 *
 * Reads end wherever the pipe was drained; three of eleven first screens captured on 2026-09-28
 * split a three-byte glyph across a boundary. Decoding read by read turns each half into U+FFFD,
 * which is more cells than the terminal drew, and on the input row that moves the modelled caret
 * off the cell the client parks its cursor on — readiness would then never fire. The killing row
 * splits a real first screen inside the prompt glyph.
 */
const terminalTranscriptDecodesAsAStream = {
  id: "terminal-transcript-decodes-as-a-stream",
  what: "the harness decodes stdout with a streaming decoder, so a multi-byte glyph split across reads is not replaced",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      text += decoder.write(chunk);\n",
  replace: '      text += chunk.toString("utf8");\n',
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a glyph split across two reads is decoded whole",
  ],
};

export default terminalTranscriptDecodesAsAStream;
