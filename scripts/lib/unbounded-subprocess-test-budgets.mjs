/**
 * How many blocking subprocess calls each file under `tests/` still makes without a time bound.
 *
 * `src/` is nearly bounded and its two remaining calls are named one by one in
 * `unbounded-subprocess-exclusions.mjs`. `tests/` is not: 162 calls across 55 files, which is
 * where the #872 failure actually lived. A blocking call in a test is not a lesser problem than
 * one in the product — `spawnSync` holds the event loop, so Vitest's own per-test timeout cannot
 * interrupt it, and Vitest then reports the timeout against whichever test the stalled worker
 * happened to be holding. Measured: three consecutive full-suite runs produced three *different*
 * sets of 60s timeouts, each passing in isolation. The file that fails is not the file that hung.
 *
 * Keyed by file and counted, not keyed by `path:line` like the `src/` list. That difference is
 * deliberate. A line-keyed entry goes stale every time anything above it grows, and with 186 of
 * them almost every test edit would fail this census for a reason that has nothing to do with
 * subprocess bounds. A count survives line movement and still refuses the thing that matters: one
 * more unbounded call in a file, or the first one in a file not listed here.
 *
 * The count is checked for **equality**, not as a ceiling. Bounding a call without lowering its
 * number leaves a budget that permits a future call for free, which is how an allow-list stops
 * being a ratchet. So a slice that bounds calls edits this file in the same commit, and the census
 * names the mismatch in both directions.
 *
 * Remove an entry by bounding its calls. `tests/helpers/bounded-child.ts` is the shape that
 * works for a child that can hang: it spawns rather than blocks, and reaps the child's whole
 * process group at the budget, because `spawnSync`'s own `timeout` signals only the direct child
 * (measured: `grandchildStillAlive: true`).
 *
 * sol-simplify: the backlog stays visible; remove entries as the calls are bounded (#872).
 */
export const UNBOUNDED_SUBPROCESS_TEST_BUDGETS = new Map([
  ["tests/e2e/real-component-integration.test.ts", 6],
  ["tests/feasibility/wake-transport-qualification/harness.ts", 1],
  ["tests/process/approved-copy-migration.test.ts", 1],
  ["tests/process/every-script-has-a-plausible-caller.test.ts", 2],
  ["tests/unit/operator-socket.test.ts", 2],
  ["tests/unit/tracker-loci-strip-invariants.test.ts", 1],
]);
