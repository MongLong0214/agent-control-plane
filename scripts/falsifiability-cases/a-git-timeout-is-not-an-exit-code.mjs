/**
 * #859 — Measured: `promisify(execFile)` reports a timed-out child as `{ code: null, signal: "SIGTERM", killed: true }` — `code` is null, not "ETIMEDOUT" as the synchronous family reports. So `e.code ?? 1` made it exit 1, the same value git uses to say no, and an `allowFailure` caller could not tell a dirty working tree from a check that did not run. Killed by the allowFailure case, which is the one that would otherwise swallow it.
 */
const aGitTimeoutIsNotAnExitCode = {
  id: 'a-git-timeout-is-not-an-exit-code',
  what: 'a git killed by its own bound is reported as git never answering, not as git answering no',
  file: "src/git/git.ts",
  find: '    const timedOut = e.killed === true && e.signal === "SIGTERM" && (e.code ?? null) === null;\n',
  replace: '    const timedOut = false;\n',
  killedBy: [
    'tests/unit/every-git-call-has-a-time-bound.test.ts::does not let allowFailure turn a timeout into an exit code',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aGitTimeoutIsNotAnExitCode;
