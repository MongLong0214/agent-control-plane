/**
 * #246 — Without it a protection GitHub weakened on write is receipted as the approved one.
 *
 * The mutation is a never-true self-comparison rather than `if (false && …)` or `… && false`:
 * TypeScript drops its narrowing inside a constant-false operand or branch, the mutant then fails
 * `tsc --noEmit`, and the harness refuses an uncompilable mutant as an unusable row (measured).
 */
const rf246AProtectionReadbackMustMatchTheRequest = {
  id: "rf246-a-protection-readback-must-match-the-request",
  what: "branch protection GitHub holds after the write must be the protection requested, or nothing is receipted",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (!sameProtection(reread.value, desired)) {\n",
  replace: "    if (reread.value.enforceAdmins !== reread.value.enforceAdmins) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AProtectionReadbackMustMatchTheRequest;
