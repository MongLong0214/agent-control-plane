/**
 * #954. The native start and the lstart are read separately, so a pid reused between the reads could
 * pair the old process's native start with the replacement's lstart. The second native read must
 * agree with the first. The mutant drops it, and the reuse case is treated as the incumbent.
 */
const aCoverageHoldReadsOneProcessAcrossItsReads = {
  id: "a-coverage-hold-reads-one-process-across-its-reads",
  what: "a coverage hold refuses a pid whose native start changed between its reads",
  file: "src/daemon/daemon.ts",
  find: "  if (read.native(session.osPid) !== native) return false;\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::refuses when the pid is reused between the native and lstart reads",
  ],
};

export default aCoverageHoldReadsOneProcessAcrossItsReads;
