/**
 * PR #1043 review round 2, RF1043-04 sibling — Without it unreadable contexts are dropped and the remainder reads as everything GitHub holds.
 */
const rf1043ContextsReadInFullOrUnobserved = {
  id: "rf1043-contexts-read-in-full-or-unobserved",
  what: "status-check contexts GitHub returned that cannot be read in full are unobserved, never a shorter list",
  file: "src/bootstrap/github-write-port.ts",
  find: "  return strings.length === contexts.length ? strings.sort() : null;\n",
  replace: "  return strings.sort();\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf1043ContextsReadInFullOrUnobserved;
