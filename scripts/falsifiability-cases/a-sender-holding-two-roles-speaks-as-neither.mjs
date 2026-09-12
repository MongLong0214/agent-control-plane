/**
 * #674. An identity that cannot be addressed unambiguously cannot speak unambiguously either.
 *
 * `buzzMentionRouter.rolesFor` already refuses a `p` tag that resolves to more than one role —
 * `MENTION_TARGET_UNBOUND`, on the grounds that a `find` over the candidates answers with whichever
 * role the registry returned first. The sending side needs the same rule for a stronger reason: a
 * sender resolved to the first of two roles acts with that role's grants while holding another's,
 * so the union of two projects' relations becomes reachable from one identity.
 *
 * Mutating the count test to take the first candidate is the defect. It is killed by the row whose
 * session is bound as `PRIMARY_CTO` in two projects — the same fixture shape
 * `buzz-message-ingress.test.ts` uses for the addressing side.
 */
const aSenderHoldingTwoRolesSpeaksAsNeither = {
  id: "a-sender-holding-two-roles-speaks-as-neither",
  what: "an identity holding two roles is not resolved to either of them",
  file: "src/daemon/agentcpd.ts",
  find: "      if (held.length !== 1) return null;\n",
  replace: "      if (held.length === 0) return null;\n",
  killedBy: [
    "tests/unit/buzz-collaboration-authority.test.ts::answers no role for an identity holding two, for an unbound one, and for a dead session",
  ],
};

export default aSenderHoldingTwoRolesSpeaksAsNeither;
