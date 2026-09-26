/**
 * #954 — the collector settles "never started" before any branch that reads the exit code.
 *
 * `code` is null both when a process dies on a signal and when no process was ever created, so
 * the `outcome.code !== 0` branch below cannot tell those apart. With this branch gone — or moved
 * beneath that one, which produces the identical observable — a deleted pin is recorded as
 * `non-interactive /usage exited on a signal`: a sentence about a process that started and died.
 * The live daemon wrote it every three minutes for four and a half hours while the path it had
 * tried was hashed into `rawOutputDigest` and discarded, so the cause was recoverable from
 * nowhere.
 *
 * The mutation deletes the branch. That is the pre-repair state, and it typechecks: the field is
 * optional and every remaining branch is still reachable.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-cli-that-never-started-is-not-reported-as-an-exit",
  what:
    "ClaudeUsageCollector.collect settles a failed spawn before the exit-code branch and names the "
    + "errno and the binary path in the detail, instead of reporting it as a process that exited",
  file: "src/capacity/usage-collectors.ts",
  find:
    "    if (outcome.spawnError) {\n"
    + "      return failedReading(\n"
    + "        this.provider,\n"
    + "        observedAt,\n"
    + "        source,\n"
    + "        digest,\n"
    + "        `non-interactive /usage never started: the operating system could not spawn the pinned CLI at ` +\n"
    + "          `${this.claudeOptions.binary} (${outcome.spawnError.code ?? \"no errno\"}: ${outcome.spawnError.message})`,\n"
    + "      );\n"
    + "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 names the CLI that never started, instead of reporting it as a process that exited",
  ],
};
export default c;
