/**
 * #753: the documented online backup exited `5` under a concurrent writer, and `5` is `SQLITE_BUSY`.
 * It was never `.backup` — the `sqlite3` shell maps every backup failure to `1`, and `.backup`
 * already carried `.timeout 30000`. It was step 1's `PRAGMA user_version` read of the *live*
 * database, which carried no busy timeout at all: under `journal_mode=delete` a committing writer
 * holds `EXCLUSIVE` for a window in which a plain read is refused outright rather than queued, and
 * `set -e` carried that status out of the command substitution before `.backup` was ever reached.
 *
 * Dropping the dot command restores exactly that line. The mutation is watched by a case that holds
 * a real `BEGIN EXCLUSIVE` on the source and only then starts the block, so the contention is
 * certain rather than sampled — which is the difference between this row and the load-dependent
 * concurrent-writer case that passed on one CI leg and failed on the other for one merge SHA.
 */
const backupSourceReadWaitsOutACommittingWriter = {
  id: "backup-source-read-waits-out-a-committing-writer",
  what: "the documented backup's read of the live database queues behind a commit instead of exiting SQLITE_BUSY before the backup runs",
  file: "docs/ops/owner-actions.md",
  find: "sqlite3 -readonly \"$SOURCE_DB\" '.timeout 30000' 'PRAGMA user_version;'",
  replace: "sqlite3 -readonly \"$SOURCE_DB\" 'PRAGMA user_version;'",
  killedBy: [
    "tests/process/the-database-backup-step-fails-closed.test.ts::completes against a source that is already locked when it starts, rather than exiting SQLITE_BUSY before the backup runs",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default backupSourceReadWaitsOutACommittingWriter;
