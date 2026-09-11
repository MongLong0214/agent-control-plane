/**
 * A probe that never ran has not observed a value that failed to match.
 *
 * `lsofEntries` returned `[]` on any throw, the cwd lookup turned that into `null`, and this
 * branch read `null` as a directory that disagreed with the configured one. On production
 * (#834) the scan was being killed by its own 5_000ms budget — measured at 30.07s, three runs,
 * because `lsof` without `-n` reverse-resolves every socket the claimant holds — while
 * `lsof -a -p <pid> -d cwd` reported exactly `ACP_CANONICAL_CTO_WORKDIR`. The canonical
 * PRIMARY_CTO role was unclaimable and the refusal named the one thing that was correct.
 *
 * The mutation puts the two facts back on one outcome: with this branch gone, a cwd nothing read
 * falls through to the `CONFLICT` below and is reported as a workdir mismatch again. The claim
 * socket puts only the `reasonCode` on the wire, so that is the entire diagnosis an operator
 * gets, and it points away from the defect.
 */
const aProbeThatCouldNotRunIsNotAMismatch = {
  id: "a-probe-that-could-not-run-is-not-a-mismatch",
  what: "a working directory no probe read refuses as a failed probe, never as a directory that did not match",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (identity.cwd === null) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 2 — a working directory the probe never read refuses as a failed probe, not as a mismatch",
  ],
};

export default aProbeThatCouldNotRunIsNotAMismatch;
