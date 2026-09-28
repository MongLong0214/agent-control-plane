/**
 * An arm's observations name the digest of the capture bytes they were read from.
 *
 * It is the one thread between a committed reading and the artefact it was derived from. The raw
 * capture is not in the repository, so the binding is weak by construction -- a reader without the
 * file checks nothing, and a reader with it learns only that their copy is the copy these
 * observations came from. Weak is not nothing: a digest that names no capture at all cannot even be
 * contradicted.
 *
 * The probe writes those same bytes to the durable capture, so the digest names a file rather than
 * a file read twice. The mutation digests something else, which is the shape a later refactor would
 * take -- re-reading the path instead of digesting the snapshot.
 */
const observationsAreDigestedFromTheCaptureTheyRead = {
  id: "observations-are-digested-from-the-capture-they-read",
  what: "an arm's observation record carries the SHA-256 of the capture bytes it was built from",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '  return { rawCaptureSha256: createHash("sha256").update(Buffer.from(capture, "utf8")).digest("hex"), requests };\n',
  replace: '  return { rawCaptureSha256: createHash("sha256").update("").digest("hex"), requests };\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::keeps each request's time, method and URL, and digests the capture they came from",
  ],
};

export default observationsAreDigestedFromTheCaptureTheyRead;
