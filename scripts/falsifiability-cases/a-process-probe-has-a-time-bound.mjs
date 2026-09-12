/**
 * #844/#859 — every `ps` this sandbox runs is bounded in time.
 *
 * The mutation removes the bound from the identity probe, which is the state before this change:
 * `promisify(execFile)` waits forever, `runSandboxed` awaits that probe unconditionally, and
 * `command.timeoutSeconds` binds only the child. So probe latency becomes the sandbox's own
 * runtime. Measured at 8s per `ps`: a command needing 50ms against a 3-second budget returned
 * `ERROR` / `SANDBOX_CHILD_CLEANUP_FAILED` after 24,081ms.
 *
 * The identity probe is the one to mutate rather than the constant, because it is the probe on
 * the release gate — the candidate is SIGSTOPed until its identity is captured — so it is
 * reached on every run, including one whose command exits immediately.
 *
 * Killed by a test that puts a deliberately slow `ps` first on PATH and asserts the sandbox
 * returns on a bound of its own. The assertion is on elapsed time because a bound in time has no
 * other observable; the margin is what makes it a measurement rather than a guess.
 */
const aProcessProbeHasATimeBound = {
  id: "a-process-probe-has-a-time-bound",
  what: "the sandbox's process-identity probe cannot hold the run longer than its own bound, so a slow `ps` cannot spend a command's budget for it",
  file: "src/verify/sandbox.ts",
  find: '    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {\n      encoding: "utf8",\n      timeout: PROCESS_PROBE_TIMEOUT_MS,\n    });\n',
  replace: '    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });\n',
  killedBy: [
    "tests/unit/a-process-probe-has-a-time-bound.test.ts::returns on a bound of its own when every ps stalls, rather than on the probe's latency",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aProcessProbeHasATimeBound;
