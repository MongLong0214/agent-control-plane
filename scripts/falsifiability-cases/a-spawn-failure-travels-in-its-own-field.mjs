/**
 * #954 — the probe reports "no process was created" as its own fact, not as stderr text.
 *
 * `spawn` does not throw on ENOENT; it emits `error`, and this probe resolves from that handler.
 * The resolved outcome used to fold the message into `stderr` (`stderr: stderr || outcome.error`),
 * which merged two different events into one field: a child that complained, and a child that
 * never existed. Nothing downstream could tell them apart, so a pin whose target the provider's
 * updater had deleted arrived at the caller as `code === null` and an opaque string.
 *
 * The mutation is that state, reached the way it would actually regress: the field simply stops
 * being propagated. It still typechecks — `spawnError` is optional on the probe's contract — which
 * is exactly why a compiler cannot be the thing that watches this.
 *
 * Inferring the cause from `stderr` content instead was ruled out: a CLI may legitimately print
 * the word ENOENT, and a string match would then invent a spawn failure that never happened.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-spawn-failure-travels-in-its-own-field",
  what:
    "SpawnNonInteractiveUsageProbe resolves a failed spawn in a dedicated spawnError field, so a "
    + "binary that never started is distinguishable from one that ran and wrote to stderr",
  file: "src/capacity/usage-collectors.ts",
  find: "          ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),\n",
  replace: "",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 names the CLI that never started, instead of reporting it as a process that exited",
  ],
};
export default c;
