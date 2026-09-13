/**
 * #872 — the bound signals the child's process *group*, not the child alone.
 *
 * `process.kill(pid, …)` reaches one process. `process.kill(-pid, …)` reaches the group the child
 * leads, which it leads only because `spawn` was given `detached: true`. Dropping the minus sign is
 * the plausible edit: it typechecks, it reads as "kill the child", and every other assertion about
 * the bound still passes — the parent still returns at the budget and the typed failure still names
 * the command. What changes is the one thing the whole helper exists for.
 *
 * The named case is built on a real hang with two generations: a child that never exits and a
 * grandchild that never exits either, publishing its pid by rename before it hangs. Measured
 * against `spawnSync`'s own timeout, which reaps only the direct child:
 *
 *     { elapsedMs: 2002, status: null, signal: "SIGTERM", killed: null, grandchildStillAlive: true }
 *
 * That is the state this mutation restores. On a host where the wedge is shared — Gatekeeper
 * assessing a script at a new inode, say — one surviving grandchild is how a single hung child
 * turns into an arbitrary set of 60-second timeouts in unrelated files, which is the reading this
 * repository carried as "local runs are unreliable" for weeks without a mechanism.
 *
 * The same containment, for the same reason, is in `src/verify/sandbox.ts` (`detached: true, //
 * own process group so the timeout can reap the whole tree`). This row is the test-side half of a
 * property the production side already had.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const aBoundedChildSignalsItsGroupNotOnlyItself = {
  id: "a-bounded-child-signals-its-group-not-only-itself",
  what:
    "the child bound signals the whole process group, so a grandchild the timed-out child started "
    + "does not survive the run and wedge the next test",
  file: "tests/helpers/bounded-child.ts",
  find: "      process.kill(-pid, signal);\n",
  replace: "      process.kill(pid, signal);\n",
  killedBy: [
    "tests/process/a-bounded-child-does-not-outlive-its-budget.test.ts::returns at the budget with a typed failure naming the command, and reaps the whole group",
  ],
};

export default aBoundedChildSignalsItsGroupNotOnlyItself;
