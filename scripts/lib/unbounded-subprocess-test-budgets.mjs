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
  ["tests/process/canonical-self-claim-identity.test.ts", 6],
  ["tests/process/canonical-self-claim-listener-claim.test.ts", 2],
  ["tests/process/ci-preflight.test.ts", 1],
  ["tests/process/every-script-has-a-plausible-caller.test.ts", 2],
  ["tests/process/falsifiability-cases-load-fail-closed.test.ts", 2],
  ["tests/process/falsifiability-verdict.test.ts", 2],
  ["tests/process/fd-vfs-binding.test.ts", 8],
  ["tests/process/fd-vfs-lease.test.ts", 5],
  ["tests/process/fixtures/a-hermes-receipt-across-a-restart.ts", 1],
  ["tests/process/fixtures/an-owner-message-across-a-restart.ts", 1],
  ["tests/process/fixtures/turn-claim-across-a-restart.ts", 1],
  ["tests/process/harness-refuses-concurrent-edits.test.ts", 1],
  ["tests/process/reason-code-static-outflow-census.test.ts", 1],
  ["tests/process/the-falsifiability-sweep-is-sharded-without-gaps.test.ts", 1],
  ["tests/process/the-gate-set-cannot-drift-from-ci.test.ts", 3],
  ["tests/process/the-hooks-refuse-what-they-name.test.ts", 10],
  ["tests/process/the-merge-path-carries-the-record.test.ts", 4],
  ["tests/process/the-reason-code-census-sees-an-unclassified-staleness-code.test.ts", 2],
  ["tests/process/the-refusal-operand-census-derives-subjects.test.ts", 1],
  ["tests/process/the-rollback-preflight-refuses-a-missing-backup-file.test.ts", 2],
  ["tests/process/the-schema-probe-puts-the-file-back.test.ts", 6],
  ["tests/process/the-shell-path-cannot-send-an-unaddressed-message.test.ts", 5],
  ["tests/process/the-tx-denial-census-sees-a-write-then-deny.test.ts", 1],
  ["tests/process/v1-experiment-isolation-declaration.test.ts", 1],
  ["tests/unit/a-head-that-could-not-be-read-is-not-a-detached-head.test.ts", 1],
  ["tests/unit/acceptance-adapter-source.test.ts", 2],
  ["tests/unit/an-approval-is-a-capability-over-one-database.test.ts", 3],
  ["tests/unit/an-incremental-migration-owns-what-it-creates.test.ts", 1],
  ["tests/unit/an-unreadable-worktree-listing-is-not-an-empty-one.test.ts", 1],
  ["tests/unit/database-migration-restore.test.ts", 4],
  ["tests/unit/doctor-daemon-r2.test.ts", 2],
  ["tests/unit/enforcement-symbols.test.ts", 2],
  ["tests/unit/falsifiability-harness-worktree.test.ts", 4],
  ["tests/unit/guard-hardening.test.ts", 2],
  ["tests/unit/handoff-p1-boundaries.test.ts", 1],
  ["tests/unit/local-write-broker.test.ts", 1],
  ["tests/unit/merge-commit-message.test.ts", 2],
  ["tests/unit/operator-socket.test.ts", 2],
  ["tests/unit/peercred-unreachability-gate.test.ts", 2],
  ["tests/unit/release-version.test.ts", 2],
  ["tests/unit/repo-factory-producer.test.ts", 1],
  ["tests/unit/reviewer-egress.test.ts", 1],
  ["tests/unit/reviewer-isolation-probes.test.ts", 1],
  ["tests/unit/reviewer-transcript-isolation.test.ts", 5],
  ["tests/unit/ssot-report.test.ts", 1],
  ["tests/unit/tracker-loci-strip-invariants.test.ts", 1],
  ["tests/unit/usage-collectors.test.ts", 1],
  ["tests/unit/verify-r2.test.ts", 1],
  ["tests/unit/verify-stale-coordinate-literals.test.ts", 1],
]);
