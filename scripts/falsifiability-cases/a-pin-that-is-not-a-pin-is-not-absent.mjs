/**
 * The lineage pin is trust-on-first-use, so "no pin" means *trust the next thing that answers*.
 * A file that exists and is not a pin must never take that meaning: one bad write would silently
 * re-open first use and the next Hermes to reply would become the pinned one.
 *
 * Weakening the shape check to `false` makes every malformed payload read as a valid pin, which
 * the per-operand row catches one payload at a time.
 */
const aPinThatIsNotAPinIsNotAbsent = {
  id: "a-pin-that-is-not-a-pin-is-not-absent",
  what: "a recorded Hermes lineage pin that does not verify is refused rather than read as a pin",
  file: "src/bootstrap/ceo-self-bootstrap.ts",
  find: "  if (\n    !record ||\n    typeof record.lineageRootDigest !== \"string\" ||\n    !isDigest(record.lineageRootDigest) ||\n    typeof record.executorRuntimeIdentity !== \"string\" ||\n    record.executorRuntimeIdentity.trim() === \"\"\n  ) {",
  replace: "  if (\n    false\n  ) {",
  killedBy: [
    "tests/unit/the-daemon-binds-the-ceo-itself.test.ts::refuses every shape that is not a pin, one operand at a time",
  ],
};

export default aPinThatIsNotAPinIsNotAbsent;
