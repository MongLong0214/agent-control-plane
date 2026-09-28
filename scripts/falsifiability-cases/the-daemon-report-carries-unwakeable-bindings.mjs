/**
 * The system report includes the unwakeable-binding finding.
 *
 * `supplementalSystemFindings` is the one list the daemon's system-scope evaluations draw on. A finding
 * method nobody calls is correct code that reports nothing: the port would still answer, and no
 * operator would ever read the answer. The killing row runs the daemon's real `doctor.run` with a
 * holder outside the qualified set on the real CTO socket.
 */
const theDaemonReportCarriesUnwakeableBindings = {
  id: "the-daemon-report-carries-unwakeable-bindings",
  what: "the daemon's system report carries a finding for each binding that cannot receive wakes",
  file: "src/daemon/daemon.ts",
  find: "      ...this.unwakeableBindingFindings(),\n",
  replace: "",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::names the build and says the binding cannot receive wakes, without naming a path",
  ],
};

export default theDaemonReportCarriesUnwakeableBindings;
