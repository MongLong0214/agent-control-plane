/**
 * #674. The relation is judged against the bindings that are current, not against every binding
 * the role ever had.
 *
 * `senderRoleFor` deliberately runs early — before `guard.admit` spends the replay slot and before
 * the `p` tag is resolved, so an identity this daemon has granted nothing cannot cause either.
 * That ordering creates a window: between the two answers the sender's assignment can be revoked.
 * What closes it is that `currentBindingFor` reads `currentBindingsForRoles`, which is ACTIVE
 * bindings only — so a revoked sender resolves to nothing and the null branch refuses.
 *
 * The mutation is on the lookup rather than on the null check, and that is forced. The check is
 * partly enforced by the compiler: `if (false)` there leaves `sender` possibly-null at four later
 * uses and the mutant dies of TS18047 rather than of a test. `history(roleKey)` returns every
 * binding including REVOKED ones, so taking its last entry is the implementation that trusts the
 * key it was handed — it typechecks, it passes every other row here, and it hands a revoked role
 * a live relation.
 *
 * It is killed by the row that derives the role, revokes the assignment, and then asks for the
 * relation — the sequence the ordering actually produces, rather than a hand-built null.
 */
const aRevokedSenderHoldsNoRelation = {
  id: "a-revoked-sender-holds-no-relation",
  what: "a sender whose assignment was revoked after its role was derived holds no relation",
  file: "src/daemon/agentcpd.ts",
  find:
    "    currentBindingsForRoles(cp, MENTIONABLE_ROLES).find((binding) => binding.roleKey === roleKey) ??\n    null;\n",
  replace: "    cp.bindings.history(roleKey).at(-1) ?? null;\n",
  killedBy: [
    "tests/unit/buzz-collaboration-authority.test.ts::refuses a sender whose assignment was revoked after its role was derived",
  ],
};

export default aRevokedSenderHoldsNoRelation;
