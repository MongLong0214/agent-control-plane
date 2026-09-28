/**
 * The boundary an arm records is the capture as it stood when the frame was written.
 *
 * A boundary read at any other moment is a different measurement wearing the same name. Read at the
 * end of the arm, every request is "before the frame" and no follow-up can exist; read before the
 * baseline, the prompt's own turn counts as the wake's follow-up. Either way the number is still an
 * observation the file carries and still agrees with every other rule, so nothing downstream can
 * catch it -- the correctness of this line is the correctness of the whole derivation.
 *
 * The mutation takes it at the end of the arm instead, which is where the capture is read for the
 * observations. The killing row is the session that answers only after the frame: it passes now and
 * fails under the mutation, because its answer would be counted as part of the baseline.
 */
const theBoundaryIsReadWhereTheFrameIsWritten = {
  id: "the-boundary-is-read-where-the-frame-is-written",
  what: "an arm records its injection boundary as the capture stood when it wrote the frame, not as it stood when the arm ended",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    const observations = observationsFrom(finalCapture, { frameWritten, requestsBefore });\n",
  replace:
    "    const observations = observationsFrom(finalCapture, {\n" +
    "      frameWritten,\n" +
    "      requestsBefore: capturedRequests(finalCapture).length,\n" +
    "    });\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::starts the invocation its reading records, and nothing beside it",
  ],
};

export default theBoundaryIsReadWhereTheFrameIsWritten;
