// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
/**
 * #1008 round 2 - the delegated CTO binding refuses an observed image that arrives without its
 * sha256, rather than attesting it.
 *
 * Its attestation digest is the one reader of the image's hash, and it has only ever digested one
 * of three image shapes: an image with its hash, no image, or a scan that never ran. An image whose
 * bytes could not be read would be a fourth, so it is refused. The mutant deletes the refusal; the
 * killing mode has the hashing inspector answer with a path and version and no hash, and requires
 * the bind to be refused with no attestation written.
 *
 * Of the three operands the line names, only `image.sha256 === undefined` compiles on its own
 * removal. Without `image !== null` the `.sha256` read is on a possibly-null value (TS18047), and
 * without `!isExecutingImageProbeFailure(image)` it is on a union member that has no such field
 * (TS2339): TypeScript is their enforcement site, and this row names them because its range holds
 * them, not because it isolates them.
 */
const c = {
  id: "a-delegated-bind-refuses-an-image-it-could-not-hash",
  what: "the delegated CTO binding refuses an observed executing image that arrives without its sha256 instead of attesting it",
  file: "src/daemon/cto-binding-runtime.ts",
  find: "            if (image !== null && !isExecutingImageProbeFailure(image) && image.sha256 === undefined) return null;\n",
  replace: "",
  killedBy: [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*unreadable-image",
  ],
};
export default c;
