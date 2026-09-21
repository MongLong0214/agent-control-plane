/**
 * A probe that never ran has not observed a value that failed to match.
 *
 * `lsofEntries` returned `[]` on any throw, the cwd lookup turned that into `null`, and this
 * branch read `null` as a directory that disagreed with the configured one. On production
 * (#834) the scan was being killed by its own 5_000ms budget — measured at 30.07s, three runs,
 * because `lsof` without `-n` reverse-resolves every socket the claimant holds — while
 * `lsof -a -p <pid> -d cwd` reported exactly the directory then configured as
 * `ACP_CANONICAL_CTO_WORKDIR`. The canonical PRIMARY_CTO role was unclaimable and the refusal
 * named the one thing that was correct.
 *
 * That comparison, its config field and that variable are all gone now, so the mutation no
 * longer produces a wrong diagnosis — it produces a wrong record. With this branch removed a cwd
 * nothing read is admitted, and `null` is written as the binding's `workdir` and compared against
 * a predecessor's on the next idempotent re-claim, which then reads the absence as a session that
 * moved. The row outlived the thing it was written about because what it guards is the refusal,
 * not the comparison; the reason to keep it changed and the row did not.
 */
const aProbeThatCouldNotRunIsNotAMismatch = {
  id: "a-probe-that-could-not-run-is-not-a-mismatch",
  what: "a working directory no probe read refuses as a failed probe, never as a directory that did not match",
  file: "src/registry/canonical-self-claim.ts",
  find: "  if (identity.cwd === null) {\n",
  replace: "  if (false) {\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 2 — a working directory the probe never read refuses as a failed probe, not as a mismatch",
  ],
};

export default aProbeThatCouldNotRunIsNotAMismatch;
