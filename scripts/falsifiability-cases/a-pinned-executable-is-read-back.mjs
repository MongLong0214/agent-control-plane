/**
 * #954. The daemon follows a pinned provider CLI path for its whole life and, until this check,
 * never read it back. On 2026-09-26 the pin this host resolved at 01:59:50Z was pruned by the
 * provider's own updater a minute later; every probe afterwards spawned a path that was not there
 * while the deployment reported `sensorHealth: ERROR`, `runtimeHealth: UNAVAILABLE`, `buckets: []`
 * and a CTO role revoked every ~3 minutes — all consequences, no cause.
 *
 * The mutation leaves `checkProviderExecutables` in the file and makes `run()` stop reading it,
 * which is the state the repository was in before this change: the method could be there, correct
 * and tested in isolation, and the doctor would still say nothing. `findings.length < 0` is never
 * true, so the call compiles and the private method stays referenced.
 *
 * The witness is the daemon-start row rather than a doctor-level one, because it is the strictly
 * stronger observation: it drives `Daemon.start()` -> `reconcile()` -> `runSystemDoctorCheck()`
 * and then asserts the finding on the report that pass recorded. Boot is the moment a pin
 * resolved by an installer that ran at some other time is first followed, so a readback that only
 * happens when an operator types `doctor` is not the readback this defect needs. The harness
 * takes one test name per row; the doctor-level rows in this directory carry the rest.
 */
const aPinnedExecutableIsReadBack = {
  id: "a-pinned-executable-is-read-back",
  what: "the doctor stats each production adapter's pinned executable, and the daemon's start path reaches that check",
  file: "src/doctor/doctor.ts",
  find: "      findings.push(...this.checkProviderExecutables());",
  replace: "      if (findings.length < 0) findings.push(...this.checkProviderExecutables());",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::is reached by the daemon's own start path, on the report that start writes",
  ],
};

export default aPinnedExecutableIsReadBack;
