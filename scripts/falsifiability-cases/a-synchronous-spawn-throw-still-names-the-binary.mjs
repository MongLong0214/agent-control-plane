/**
 * #954 — the catch that handles a synchronous `spawn` throw names the binary it tried.
 *
 * `spawn` reaches the `error` event only when the attempt gets far enough to have a child to
 * emit on. It throws synchronously instead when an argument is rejected before any syscall —
 * an empty configured binary gives ERR_INVALID_ARG_VALUE — and when the attempt returns an
 * errno to the caller, which a binary whose parent component is a regular file does with
 * ENOTDIR. Measured on Node 24.18.0 and on this toolchain's Node: both throw synchronously.
 *
 * Those arrive in this catch with no `spawnError` to read, and Node's own text for the second
 * is the whole of `spawn ENOTDIR` — no path, no attempt. Recorded verbatim, that is the same
 * defect the branch below this catch was written for: a sentence with no subject, reaching the
 * operator through `AuditLog.record` under PROBE_FAILED with nothing in it to act on.
 *
 * The mutation restores the bare thrown message. That is the pre-repair state and also what
 * `main` still does, so this row guards a repair rather than a regression from this branch.
 * It typechecks: `error` is `unknown` and the ternary narrows it the same way.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-synchronous-spawn-throw-still-names-the-binary",
  what:
    "the ClaudeUsageCollector catch that handles a synchronous spawn throw states the attempt and "
    + "the configured binary path, rather than recording Node's bare thrown message",
  file: "src/capacity/usage-collectors.ts",
  find:
    "        `non-interactive /usage never started: spawning the configured CLI at ${this.claudeOptions.binary} ` +\n"
    + "          `threw before any process existed (${thrown})`,\n",
  replace: "        thrown,\n",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 names the CLI that was attempted when spawn throws instead of emitting",
  ],
};
export default c;
