/**
 * #954. The operator's next step is on the pin: the environment variable they set, or the
 * installation the stable name belongs to. A finding that named the path the pin *resolved to*
 * would name a versioned file the provider's own updater owns and the operator never chose — and
 * on the case that produced this defect, where the versioned directory has been pruned, there is
 * no resolved path left to name at all.
 *
 * The mutation substitutes another real, absolute, executable path for the pin in the evidence.
 * `process.execPath` is deliberately something that exists and is executable, so the finding is
 * still produced, still has one entry, and still carries the right `condition` — every assertion
 * about the *shape* of the finding survives. Only the identity of the path fails, which is what
 * isolates this row to the property it claims.
 *
 * Read honestly, this proves the assertion is coupled to the pin's identity rather than to "some
 * path is present". It is not a mutant that canonicalises: `realpathSync` is not imported in
 * `src/doctor/doctor.ts` and a mutation that introduced it would not compile, so the harness
 * could not run it. Canonicalisation is refused structurally — the file cannot call it — and the
 * consequence a reader would notice is covered by `a-pin-readback-follows-the-link`. Whoever
 * later adds `realpathSync` to this file's imports for any reason has removed that structural
 * refusal and owes this directory a row that exercises it directly.
 */
const aPinFindingNamesThePinItWasGiven = {
  id: "a-pin-finding-names-the-pin-it-was-given",
  what: "the finding's evidence carries the pinned path itself, not some other path the check could have resolved",
  file: "src/doctor/doctor.ts",
  find: "          provider: adapter.provider,\n          path,",
  replace: "          provider: adapter.provider,\n          path: process.execPath,",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::does not canonicalise: the evidence names the pin, not what it resolved to",
  ],
};

export default aPinFindingNamesThePinItWasGiven;
