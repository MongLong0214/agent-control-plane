/**
 * #246 — Without it an approval for a public repository authorises a private one, and the reverse — the exposure decision the owner made is not the one executed.
 *
 * The mutation is a never-true self-comparison rather than `if (false && …)` or `… && false`:
 * TypeScript drops its narrowing inside a constant-false operand or branch, the mutant then fails
 * `tsc --noEmit`, and the harness refuses an uncompilable mutant as an unusable row (measured).
 */
const rf246ThePlannedVisibilityMustBeTheApprovedVisibility = {
  id: "rf246-the-planned-visibility-must-be-the-approved-visibility",
  what: "a plan that would create a repository at a visibility the owner did not approve is refused before any GitHub call",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "  if (first.desiredState.visibility !== authority.visibility) {\n",
  replace: "  if (first.desiredState.visibility !== first.desiredState.visibility) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246ThePlannedVisibilityMustBeTheApprovedVisibility;
