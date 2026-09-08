/**
 * Rule 2, the backstop. The key list is a list, and a list is a guess about next month; the
 * identifier is the thing that must not reach `main`. Without the redaction an unlisted key — or
 * an ordinary sentence carrying the URL — publishes it, and rule 1 never sees it.
 */
const aSessionReferenceIsRedactedUnderAnyKey = {
  id: "a-session-reference-is-redacted-under-any-key",
  what: "a session identifier is redacted wherever it appears, not only under a known key",
  file: "src/github/merge-commit-message.ts",
  find: "  const redacted = kept.map((line) => line.replace(SESSION_REFERENCE, REDACTED_SESSION_REFERENCE));",
  replace: "  const redacted = kept.map((line) => line);",
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::redacts a session identifier under a key nobody enumerated",
  ],
};

export default aSessionReferenceIsRedactedUnderAnyKey;
