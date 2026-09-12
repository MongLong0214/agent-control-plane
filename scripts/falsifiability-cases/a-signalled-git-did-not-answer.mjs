/**
 * #859 — a child that produced no exit code did not answer, whoever killed it.
 *
 * `promisify(execFile)` reports a timeout as `{ code: null, signal: "SIGTERM", killed: true }`, and
 * `killed` is Node's flag for *"I sent the signal"*. So for a child ended by launchd, systemd, an
 * OOM kill or a stray `pkill`, the same shape arrives with `killed: false` — measured on Node 22.
 *
 * The first repair tested `killed`, classified that as git answering, and then synthesized
 * `exitCode: 1` for it. One is the value `git status --porcelain` uses to say *no*, so an
 * `allowFailure` caller read "the working tree is clean/dirty" out of a process that never ran, and
 * the work-tree reader built on top of it reported a real checkout as not being a work tree. A
 * merge-gate review reproduced the whole chain.
 *
 * The mutation restores the `killed`-dependent test. It is killed by the case whose fake git sends
 * itself SIGTERM — this process never calls `kill`, which is exactly what makes `killed` false and
 * the shape indistinguishable from the one the old code trusted.
 *
 * The killing case asserts on `git()` directly, and that placement is measured rather than chosen.
 * Naming the *registry* case left this row SURVIVED: the work-tree reader now keys on git's own
 * words, so it refuses correctly whatever `didNotRun` decides, and it cannot witness this
 * definition. The observable that changes is `git()`'s own refusal — `evidence.signal` present
 * instead of a fabricated `exitCode`.
 */
const aSignalledGitDidNotAnswer = {
  id: "a-signalled-git-did-not-answer",
  what: "a git that produced no exit code is a probe that did not run, whether or not this process killed it",
  file: "src/git/git.ts",
  find: "    const signalled = (e.code ?? null) === null;\n",
  replace: "    const signalled = (e.code ?? null) === null && e.killed === true;\n",
  killedBy: [
    "tests/unit/every-git-call-has-a-time-bound.test.ts::treats a child killed from outside as a probe that did not run, not as exit 1",
  ],
};

export default aSignalledGitDidNotAnswer;
