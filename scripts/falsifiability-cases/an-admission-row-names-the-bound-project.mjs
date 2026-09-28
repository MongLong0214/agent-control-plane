/**
 * An admitted canonical self-claim's audit row names the project from the committed binding, not
 * from the request. In an ordinary admission the request, the configured entry and the binding all
 * name the same project, so a row built from the request passed the admission test unchanged. The
 * named verdict makes them disagree: the request's first read — the one `claim()` snapshots as what
 * was asked — names a second registered project, every read before the Buzz await names the
 * entitled one, and every read after it names a third.
 *
 * The mutation substitutes the snapshot for the binding's project, exactly, and typechecks.
 */
const c = {
  id: "an-admission-row-names-the-bound-project",
  what: "an admitted canonical self-claim records the project its binding committed, never the one the request carried",
  file: "src/registry/canonical-self-claim.ts",
  find: "      projectId: decision.value.binding.projectId,",
  replace: "      projectId: asked.projectId,",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::an admission row names the project and role key the binding committed, not any the request carried",
  ],
};
export default c;
