/**
 * A receipt refuses an arm whose executed image is not the one the receipt names.
 *
 * Each arm records the digest of what it executed, read after its measurement. A reading is the
 * claim "this build qualified", and an arm that ran other bytes can still pass every number the
 * verdict reads, so the refusal cannot live in the verdict: `buildReceipt` throws, and no reading is
 * written. The killing row builds a receipt with one arm on another digest and one arm on none.
 */
const aReadingRefusesAnArmOnAnotherImage = {
  id: "a-reading-refuses-an-arm-on-another-image",
  what: "a qualification receipt refuses an arm that executed an image other than the one it names",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    if (run.imageSha256 !== input.image.sha256) {\n",
  replace: "    if (run.imageSha256 !== run.imageSha256) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-image-hold.test.ts::a reading cannot name an image one of its arms did not execute",
  ],
};

export default aReadingRefusesAnArmOnAnotherImage;
