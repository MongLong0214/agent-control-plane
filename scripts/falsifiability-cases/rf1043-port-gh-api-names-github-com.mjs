/**
 * PR #1043 review, RF1043-05 — Without it `GH_HOST` routes the REST half to another server while git pushes to github.com.
 */
const rf1043PortGhApiNamesGithubCom = {
  id: "rf1043-port-gh-api-names-github-com",
  what: "every `gh api` call names github.com explicitly",
  file: "src/bootstrap/github-write-port.ts",
  find: "    const args = [\"api\", \"--hostname\", GITHUB_HOST, \"--method\", method, path];\n",
  replace: "    const args = [\"api\", \"--method\", method, path];\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf1043PortGhApiNamesGithubCom;
