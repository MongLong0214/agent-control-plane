/**
 * #954 — the other half of "distinguishable": a failed spawn is in its own field AND NOT in stderr.
 *
 * The sibling row `a-spawn-failure-travels-in-its-own-field` deletes the field, and the collector
 * test notices because the composed sentence disappears. It cannot notice this: an implementation
 * that sets `spawnError` and ALSO returns the spawn message as `stderr` composes exactly the same
 * sentence. A reviewer measured that directly — every assertion on the sentence still passed while
 * the failure was back in `stderr`, and therefore back in `raw` and the raw-output digest. That is
 * the original fold reintroduced beside the fix rather than instead of it.
 *
 * So the mutation is that implementation, not a deletion. It typechecks and it keeps the field.
 * Only a test that reads the probe's own outcome can kill it.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-failed-spawn-is-absent-from-stderr",
  what:
    "SpawnNonInteractiveUsageProbe leaves stderr empty when no process was created, so the spawn "
    + "failure cannot re-enter the raw output or its digest as if a child had written it",
  file: "src/capacity/usage-collectors.ts",
  find: "          stdout,\n          stderr,\n          code: outcome.code,\n",
  replace: "          stdout,\n          stderr: stderr || outcome.spawnError?.message || \"\",\n          code: outcome.code,\n",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 leaves stderr empty when the spawn failed, which is the other half of distinguishable",
  ],
};
export default c;
