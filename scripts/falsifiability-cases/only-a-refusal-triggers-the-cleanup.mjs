/**
 * #833 — the self-cleanup runs on a refusal, never on a directory that was accepted.
 *
 * The mutation makes the refusal operand always true, so `judgeAndCleanupIfJustCreated` deletes
 * every directory this call created — including the ones it just judged safe. The checkout leaf
 * is created and then immediately removed, and the producer returns `allowed` pointing at a path
 * that no longer exists.
 *
 * The neighbouring `justCreated` operand cannot answer for this: both are true on the accepted
 * path, so only an assertion that the accepted directory still exists distinguishes them.
 */
const onlyARefusalTriggersTheCleanup = {
  id: "only-a-refusal-triggers-the-cleanup",
  what: "a directory this call created and judged safe is kept, so the self-cleanup is driven by the refusal rather than by having created it",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "!judged.allowed &&",
  replace: "true &&",
  killedBy: [
    "tests/unit/repo-factory-producer.test.ts::createCheckoutLeafOrDeny refuses EEXIST rather than silently reusing an already-existing directory — deterministic, no race required",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default onlyARefusalTriggersTheCleanup;
