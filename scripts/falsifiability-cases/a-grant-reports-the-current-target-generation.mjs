/**
 * #674 meeting #639. The grant's generation is the target's, read at judgement time.
 *
 * The delivery-time `bindingDigest` fence compares a receipt against the generation the turn was
 * claimed under, so a grant carrying a stale generation would let a receipt from the previous
 * holder satisfy it. The sender's own generation is the tempting wrong answer: it is in scope, it
 * is a number, and every row that only checks *that a number is reported* passes with it.
 *
 * Mutating the grant to report the sender's generation is that wrong answer. It is killed by the
 * row that rebinds the CEO between two reads and asserts the grant names the new generation —
 * which is also why that row asserts `after > before` first: with one generation the two numbers
 * are equal and the mutation is invisible.
 */
const aGrantReportsTheCurrentTargetGeneration = {
  id: "a-grant-reports-the-current-target-generation",
  what: "a collaboration grant reports the addressed role's current binding generation",
  file: "src/daemon/agentcpd.ts",
  find: "      if (sender.projectId === null) return unscoped;\n",
  replace:
    "      if (sender.projectId === null) return unscoped;\n      if (target.bindingGeneration !== sender.bindingGeneration) {\n        return allow(ReasonCode.OK, {\n          senderRoleKey: sender.roleKey,\n          projectId: null,\n          targetGeneration: sender.bindingGeneration,\n        });\n      }\n",
  killedBy: [
    "tests/unit/buzz-collaboration-authority.test.ts::reports the target's generation as it is when the relation is judged, not as it was",
  ],
};

export default aGrantReportsTheCurrentTargetGeneration;
