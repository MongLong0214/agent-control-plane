/**
 * #246 — Without it a protection GitHub weakened on write is receipted as the approved one.
 */
const rf246AProtectionReadbackMustMatchTheRequest = {
  id: "rf246-a-protection-readback-must-match-the-request",
  what: "branch protection GitHub holds after the write must be the protection requested, or nothing is receipted",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (!sameProtection(reread.value, desired)) {\n",
  replace: "    if (false && !sameProtection(reread.value, desired)) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AProtectionReadbackMustMatchTheRequest;
