/**
 * The membership test itself: a presented build is admitted only if it equals a member.
 *
 * The mutant keeps the shape of a set check and drops what makes it one — any declared build is
 * admitted as long as the set is not empty. That is the loosening this slice was told never to make
 * (no floor, no range, no prefix), arrived at without writing any of them. Registration, the
 * daemon's unwakeable-binding finding and the feasibility test's agreement rules all ask this one
 * predicate, so all three would loosen together.
 *
 * The killing row presents a fixture set of three builds and a list of builds near them — newer,
 * between two members, a prefix of one, one extending one, a member's version under another name —
 * and expects every near build refused, alongside each member admitted as the control.
 */
const aBuildOutsideTheQualifiedSetIsNotAdmitted = {
  id: "a-build-outside-the-qualified-set-is-not-admitted",
  what: "a declared client build is a wake-transport member only by exact equality with a member of the set",
  file: "src/mcp/role-conversation.ts",
  find:
    "  client !== undefined && members.some((member) => member.name === client.name && member.version === client.version);\n",
  replace: "  client !== undefined && members.length > 0;\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::admits each member of a set of several builds exactly, and nothing near one",
  ],
};

export default aBuildOutsideTheQualifiedSetIsNotAdmitted;
