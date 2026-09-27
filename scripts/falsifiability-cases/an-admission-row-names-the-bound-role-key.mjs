/**
 * The role-key half of `an-admission-row-names-the-bound-project`, and a separate row because it is
 * a separate site: the admission row's `role_key` comes from the committed binding, and a
 * regression that assembles it from the request instead is a different edit from one that takes
 * the request's project. The row records the role key as a string, so the witness only needs the
 * two projects to differ in name — unlike the transaction's own role-key site, whose effect is
 * which role key the expected generation is counted against.
 *
 * The mutation builds the role key from the snapshotted request with the same helper the
 * transaction uses, so it typechecks and differs from the original only in its source.
 */
const c = {
  id: "an-admission-row-names-the-bound-role-key",
  what: "an admitted canonical self-claim records the role key its binding committed, never one built from the request",
  file: "src/registry/canonical-self-claim.ts",
  find: "      roleKey: decision.value.binding.roleKey,",
  replace: "      roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: asked.projectId }),",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::an admission row names the project and role key the binding committed, not any the request carried",
  ],
};
export default c;
