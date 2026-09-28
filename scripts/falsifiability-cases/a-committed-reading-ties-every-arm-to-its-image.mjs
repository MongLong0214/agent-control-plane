/**
 * A committed reading is refused unless every arm in it executed the image the reading names.
 *
 * `buildReceipt` refuses an arm on another digest while a reading is being produced, and that is the
 * only place the claim was ever checked -- which says nothing about a reading that reaches the
 * repository some other way: hand-edited, written by an older instrument, or with its runs replaced.
 * Measured on 2026-09-28: the readings on disk carried no per-arm digest at all, and the consistency
 * row passed on them. So a reading whose arms ran on another build was indistinguishable from one
 * whose arms ran on the build it names, while every number in it still read as a pass -- the exact
 * substitution the image hold and the per-arm digest exist to catch.
 *
 * One comparison covers both failures, because an arm that does not say which image it executed is
 * not an arm that said the right one. The killing row builds a reading with one arm on another
 * digest and a reading with one arm carrying no digest, and keeps the instrument's own reading as
 * its control.
 */
const aCommittedReadingTiesEveryArmToItsImage = {
  id: "a-committed-reading-ties-every-arm-to-its-image",
  what: "a committed reading is a disagreement unless every one of its arms names the image the reading names",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      if (run.imageSha256 === reading.client.imageSha256) return;\n",
  replace: "      if (run.imageSha256 === run.imageSha256) return;\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm that executed another image, or will not say which it executed, is a failure",
  ],
};

export default aCommittedReadingTiesEveryArmToItsImage;
