/**
 * The other half of #753, and the half the issue was actually about: waiting longer is not the
 * fix if the run that still loses hands back a number. What an owner running item 2 against a live
 * daemon got was `Error: stepping, database is locked (5)` and a bare exit `5` — nothing naming the
 * backup, the daemon, or what to do next, from a procedure whose entire purpose is to be run while
 * the daemon writes.
 *
 * This is a distinct property from the timeout row beside it, and the two are killed by distinct
 * cases: the timeout row's case holds a real lock and would still be refused-with-a-message if only
 * the message were removed, and this row's case stubs `sqlite3` to fail the read outright, so it
 * would still fail with the timeout gone. Replacing the sentence with a generic one leaves the exit
 * status a refusal and the reader exactly as uninformed as before.
 */
const backupRefusalNamesTheConcurrentWriter = {
  id: "backup-refusal-names-the-concurrent-writer",
  what: "the documented backup's refusal names the concurrent writer that locked the source, rather than surfacing a raw SQLite result code",
  file: "docs/ops/owner-actions.md",
  find:
    'echo "refusing: could not read user_version from $SOURCE_DB — it stayed locked for the 30s ' +
    "this read waits, which means a concurrent writer (normally the daemon) is committing to it " +
    'without a gap. No backup was taken and nothing was written. Retry when the daemon is quieter, ' +
    'or stop it first." >&2',
  replace: 'echo "refusing: sqlite3 exited nonzero" >&2',
  killedBy: [
    "tests/process/the-database-backup-step-fails-closed.test.ts::names the concurrent writer when the source stays locked past that read's timeout, instead of handing back a bare SQLITE_BUSY",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default backupRefusalNamesTheConcurrentWriter;
