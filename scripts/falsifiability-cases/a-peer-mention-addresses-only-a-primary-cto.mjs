/**
 * #1038. A peer turn has one recipient class: the bound PRIMARY_CTO. The registry answers for a
 * channel identity whose live session holds exactly one mentionable role, and this operand is what
 * makes that role a PRIMARY_CTO rather than whichever role it happens to be.
 *
 * Removed, the CEO's own channel identity resolves to the CEO binding as a "target", and the CEO
 * could address itself as a peer. The killing row presents exactly that mention and requires the
 * target refusal — with this operand gone the refusal it gets is a different one (the CEO runtime
 * has no project channel), so the row fails on the reason code.
 */
const aPeerMentionAddressesOnlyAPrimaryCto = {
  id: "a-peer-mention-addresses-only-a-primary-cto",
  what: "a CEO-authored peer envelope may address only a session whose one role is a PRIMARY_CTO",
  file: "src/daemon/agentcpd.ts",
  // Anchored on the role operand alone, so this row names only what it mutates; `!only` beside it
  // is answered in refusal-operands-unanswered.mjs (TypeScript refuses its removal).
  find: "|| only.role !== Role.PRIMARY_CTO) return null;\n",
  replace: ") return null;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a CEO envelope that does not address exactly the bound PRIMARY_CTO, with zero writes",
  ],
};

export default aPeerMentionAddressesOnlyAPrimaryCto;
