/**
 * #674. A role sender is admitted as its role, and the owner's own conversation is not a role.
 *
 * The collaboration door exists so that a CTO can reach the CEO without being added to
 * `ownerActors` — the one-line fix the owner forbade, because it would let that identity speak
 * *as the owner* on every path, not only on the one the ticket is about. The refusal that keeps
 * the two apart is the `addressedTo === "CEO"` check: `CEO` there is the owner's conversation,
 * reached by recipient string, while the CEO *role* is reached by a `p` tag and resolved like any
 * other role.
 *
 * Mutating the condition to `if (false)` promotes every role holder to owner, which is precisely
 * the outcome the design exists to avoid. The row is killed by the case that sends a
 * `CEO`-addressed envelope from a granted role sender and asserts both the refusal and that no
 * relation was consulted for it — a relation lookup there would mean the implementation asked
 * permission to be the owner.
 */
const aRoleSenderIsNotTheOwner = {
  id: "a-role-sender-is-not-the-owner",
  what: "a role sender cannot address the owner's own conversation",
  file: "src/ingress/buzz-message.ts",
  find: "      if (input.addressedTo === BUZZ_MESSAGE_RECIPIENT_CEO) {\n",
  replace: "      if (false) {\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses a role sender addressing the owner's own conversation, and asks no relation about it",
  ],
};

export default aRoleSenderIsNotTheOwner;
