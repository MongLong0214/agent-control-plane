/**
 * PR #1043 review, RF1043-05 — Without it any `gh` behaviour that consults GH_HOST can route this port away from github.com.
 */
const rf1043PortGhHostIsNotInherited = {
  id: "rf1043-port-gh-host-is-not-inherited",
  what: "a `gh` child does not inherit GH_HOST",
  file: "src/bootstrap/github-write-port.ts",
  find: "  delete child[\"GH_HOST\"];\n",
  replace: "\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf1043PortGhHostIsNotInherited;
