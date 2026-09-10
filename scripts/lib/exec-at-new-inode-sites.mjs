/**
 * The two declared lists `verify-tests-do-not-exec-new-inodes.mjs` reads.
 *
 * Both are keyed by content: `<file>::<name or path expression> in <the function or the test it
 * sits in>`. No line coordinate appears in a key. A file:line key goes stale the moment something
 * above it grows, and this repository has already had a check fail on a known-good item for
 * exactly that reason. A key that no longer occurs fails the run, so renaming the variable or the
 * test that holds a declared site forces someone to read it again rather than silently retiring it.
 *
 * ALLOWED is permanent, and admits exactly two reasons, both of which the entry must state:
 *   - the site must produce new bytes, and running them at a new inode is what the test is for;
 *   - the check named it and a person read it: the bytes are never an assessment subject, because
 *     an interpreter runs them, or the analyser merged two names that are not the same file.
 *
 * UNFIXED is a backlog: a real instance of the defect, owned by a follow-up unit rather than by
 * the unit that added the check. Every run prints it and the RESULT line counts it. It is not
 * coverage, and an empty UNFIXED is the goal.
 */

/** Named, read, and not the defect. Each entry says which of the two admissible reasons applies. */
export const ALLOWED = new Map([
  [
    'tests/unit/reviewer-egress.test.ts::id:credentialProxy in it "refuses credential-shaped content before proxy JSONL can become evidence"',
    "Read: the bytes are never exec'd. `acquireReviewerEgress` spawns `effectiveConfig.pythonBinary ?? \"/usr/bin/python3\"` with the proxy path as an argument (src/runtime/reviewer-egress.ts), so the script is data to an already-assessed interpreter. The `mode: 0o700` is vestigial and could be dropped; the check reads the exec bit as intent and cannot follow the path into src/.",
  ],
  [
    'tests/unit/reviewer-egress.test.ts::id:dyingProxy in it "invalidates a lease as soon as its supervised proxy dies"',
    "Read: same shape as credentialProxy above — the proxy is an argument to /usr/bin/python3, never argv[0], so no new inode is ever assessed.",
  ],
]);

/** Real instances of the defect, each owned by a named follow-up unit of #817. */
export const UNFIXED = new Map([
  [
    "tests/unit/hermes-target-bind.test.ts::id:executable in makeFixture",
    "#817 follow-up: writes a Node script, chmods it 0o700, and hands it to `runHermesTargetBind` as the program to spawn — a three-line script at a new inode, the shape measured at over 120 seconds. The fix is for the fixture to name an interpreter and pass the script as an argument.",
  ],
]);
