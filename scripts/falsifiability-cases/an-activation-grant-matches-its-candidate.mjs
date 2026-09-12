/**
 * #833 — a grant naming another candidate snapshot cannot activate this run's manifest.
 *
 * Each variant differs from a valid grant in exactly one field, so an operand that is removed
 * does not change how the grant is refused — it makes the grant **activate**. The test builds a
 * fresh harness per variant because `run_artifacts.content_json` is immutable by trigger: a
 * wrong grant has to be the only grant its run ever had. Its last case is an untouched grant
 * through the same path, which is what stops "refused" from meaning "this path refuses
 * everything".
 *
 * The anchor is the operand rather than its line, because the census credits every operand
 * inside an anchor and both of these conditions hold six.
 */
const anActivationGrantMatchesItsCandidate = {
  id: 'an-activation-grant-matches-its-candidate',
  what: "a grant naming another candidate snapshot cannot activate this run's manifest",
  file: "src/registry/project-registry.ts",
  find: 'content.candidateSnapshotDigest === run.current_candidate_digest',
  replace: 'true',
  killedBy: [
    'tests/unit/cto-registry-r2.test.ts::refuses an activation grant that differs from the run in any single field',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anActivationGrantMatchesItsCandidate;
