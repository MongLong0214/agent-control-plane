/**
 * `-n` is not a preference; it is the difference between a probe that answers and one that is
 * killed.
 *
 * Measured against the live canonical claude process (53 descriptors, 7 of them IPv4):
 * `lsof -p <pid> -FfptDin` took 30.07s / 30.08s / 30.08s over three runs, and the same scan with
 * `-n` took 0.05s — 600x. `SUBPROCESS_TIMEOUT_MS` is 5_000, so without the flag every scan was
 * killed before it printed a byte, and the canonical PRIMARY_CTO role could not be claimed (#834).
 *
 * The flag changes nothing about what is observed. The requested fields are `f p t D i n`, and
 * the only entries this module reads are the `cwd` DIR entry and the `txt` REG entry, whose name
 * field is a filesystem path. `-n`/`-P` suppress hostname and port-name rendering on the network
 * entries nothing here consults.
 *
 * Dropping `-n` again is a one-character edit with no visible symptom in any test that measures
 * behaviour rather than argv — which is why the row mutates the argv and the test asserts on it.
 */
const anLsofScanDoesNotResolveNames = {
  id: "an-lsof-scan-does-not-resolve-names",
  what: "the lsof scan suppresses name resolution, so a claimant's sockets cannot stall it past its timeout",
  file: "src/registry/canonical-self-claim.ts",
  find: 'export const lsofScanArgv = (pid: number): string[] => ["-n", "-P", "-p", String(pid), "-FfptDin"];',
  replace: 'export const lsofScanArgv = (pid: number): string[] => ["-P", "-p", String(pid), "-FfptDin"];',
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::the lsof scan asks for numeric names, so a claimant's sockets cannot stall it past its own timeout",
  ],
};

export default anLsofScanDoesNotResolveNames;
