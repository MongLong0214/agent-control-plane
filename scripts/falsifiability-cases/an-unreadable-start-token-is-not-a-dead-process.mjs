/**
 * A fail-closed branch is the easiest line in a file to flip, because nothing fails when it does.
 *
 * `#predecessorProcessIsGone` answers three ways, and only two of them are witnessed by the
 * scenarios the suite otherwise builds: a pid absent from the inspector is gone, a pid carrying a
 * different start token is gone. The third — a pid the inspector *does* answer for, whose native
 * start token cannot be read — is the fail-closed one, and it is a real shape on the default
 * inspector, where `ps` supplies ppid and command while `readProcessStartToken` returns null on a
 * native or kernel failure.
 *
 * Flipped, "unknown" becomes "gone" for a process that is alive: the abandoned-runtime path
 * engages, every #824 ownership guard is skipped, the live holder is transitioned to STOPPED, and
 * an ordinary claim succeeds whenever the assignment is already REVOKED. That is a stranger
 * evicting a live canonical CTO — the outcome the line's own comment says it prevents, which
 * before this row was a claim in prose with nothing enforcing it.
 */
const anUnreadableStartTokenIsNotADeadProcess = {
  id: "an-unreadable-start-token-is-not-a-dead-process",
  what: "a live pid whose start token cannot be read is unknown, not gone, so the strict same-live branch stays engaged",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (observed.startedAt === null) return false;\n",
  replace: "    if (observed.startedAt === null) return true;\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a predecessor pid that is live but whose start token cannot be read is not gone",
  ],
};

export default anUnreadableStartTokenIsNotADeadProcess;
