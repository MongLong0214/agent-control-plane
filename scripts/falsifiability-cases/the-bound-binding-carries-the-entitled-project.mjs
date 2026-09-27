/**
 * Review #1006/sol ACP1006-R1-02, the second of the two sites the entitlement owns. The role key
 * assembled above decides which role key the generation is counted against; this argument decides
 * which project the assignment row itself names. They are one authority and they failed the same
 * way, so each carries its own row rather than one row standing for both.
 *
 * The witness here is the generation-1 await case, because the binding it returns is built from
 * this argument: with `request.projectId` the mutant either binds a project the entitlement never
 * authorized or is refused by a project row that does not exist, and the case asserts the project
 * the receipt carries.
 */
const c = {
  id: "the-bound-binding-carries-the-entitled-project",
  what: "the assignment row names the entitled project, not whatever the request says after the await",
  file: "src/registry/canonical-self-claim.ts",
  find: "        projectId: entry.projectId,",
  replace: "        projectId: request.projectId,",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::binds the entitled project even when the request",
  ],
};
export default c;
