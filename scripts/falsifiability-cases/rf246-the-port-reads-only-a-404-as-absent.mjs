/**
 * #246 — Without it a 502 or a dropped connection reads as an absent repository, and the producer would create over a name it could not see.
 */
const rf246ThePortReadsOnlyA404AsAbsent = {
  id: "rf246-the-port-reads-only-a-404-as-absent",
  what: "the production port reads a 404 as absent and propagates every other failure",
  file: "src/bootstrap/github-write-port.ts",
  find: "    if (statusOf(error) === 404) return null;\n",
  replace: "    return null;\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf246ThePortReadsOnlyA404AsAbsent;
