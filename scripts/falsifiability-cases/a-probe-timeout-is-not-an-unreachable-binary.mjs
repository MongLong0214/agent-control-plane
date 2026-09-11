/**
 * The field this classifier reads is the whole of the defect. `execFileSync` does not set `killed`
 * — it reports a timeout as `code: "ETIMEDOUT"` with `signal: "SIGTERM"` — so the original
 * `failed.killed === true` was never true and `TIMED_OUT` was unreachable on every path (#838).
 *
 * The mutation restores that: every probe failure becomes `SCAN_FAILED`, which tells an operator
 * "lsof is not reachable" for a scan that was killed by its own budget. #834 was exactly that
 * scan — a real 30.07s timeout — so the classification added in its fix could not have classified
 * the incident it was written for.
 */
const aProbeTimeoutIsNotAnUnreachableBinary = {
  id: "a-probe-timeout-is-not-an-unreachable-binary",
  what: "a child killed by its own timeout budget is TIMED_OUT, never SCAN_FAILED",
  file: "src/registry/canonical-self-claim.ts",
  find: '  failed.code === "ETIMEDOUT" ? "TIMED_OUT" : "SCAN_FAILED";\n',
  replace: '  "SCAN_FAILED";\n',
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a probe killed by its own budget classifies as TIMED_OUT, and an exit status does not",
  ],
};

export default aProbeTimeoutIsNotAnUnreachableBinary;
