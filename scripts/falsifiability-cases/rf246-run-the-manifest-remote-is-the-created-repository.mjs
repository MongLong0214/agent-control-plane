/**
 * #246 — Without it the producer creates a repository activation then refuses to match against the manifest — a public repository nothing activates.
 */
const rf246RunTheManifestRemoteIsTheCreatedRepository = {
  id: "rf246-run-the-manifest-remote-is-the-created-repository",
  what: "the approved manifest's remote must be the repository the plan creates, checked before any write",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (declared.remote !== execution.value.repositoryIdentity) {\n",
  replace: "    if (declared.remote !== declared.remote) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunTheManifestRemoteIsTheCreatedRepository;
