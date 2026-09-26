const x = {
  id: "sensor-binding-live-native-incumbent-survives-failed-role-sensor",
  what: "A live native-identified READY incumbent survives an unavailable runtime verdict from a failed role sensor.",
  file: "src/daemon/daemon.ts",
  find:
    "        const nativeIncumbentAlive =\n" +
    '          currentCapacity?.sensorHealth === "ERROR" &&\n' +
    '          currentCapacity.runtimeHealth === "UNAVAILABLE" &&\n' +
    "          session?.lifecycle === SessionLifecycle.READY &&\n" +
    "          session?.osPid != null && session.osProcessStartedAt != null &&\n" +
    "          session.osProcessStartedAt === readProcessStartToken(session.osPid);\n",
  replace: "        const nativeIncumbentAlive = false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#954: a live native-identified READY CTO keeps its generation and outbox on a failed role sensor",
  ],
};
export default x;
