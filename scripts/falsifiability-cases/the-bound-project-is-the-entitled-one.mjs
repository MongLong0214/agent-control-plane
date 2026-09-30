/**
 * Review #1006/sol ACP1006-R1-02. The entitlement is compared — `entry.projectId` against
 * `request.projectId` — before the Buzz address is resolved, and resolving it awaits a transport
 * outside this process. The transaction then used to read `request.projectId` again to assemble the
 * role key and to bind. `request` is the caller's own object, so a caller holding a reference could
 * pass the entitlement check for one project and be bound to another.
 *
 * The entitlement is the authority, so the entitlement is what names the project at both sites.
 */
const c = {
  id: "the-bound-project-is-the-entitled-one",
  what: "the role key names the entitled project, not whatever the request says after the await",
  file: "src/registry/canonical-self-claim.ts",
  find: "      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: entry.projectId });",
  replace: "      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: request.projectId });",
  killedBy: [
    // Not the generation-1 await case: this site's only effect the receipt does not carry back is
    // which role key the expected generation is counted against, and at generation 1 the entitled
    // and the foreign key both count zero, so that case's mutant survives (measured). The witness
    // has to be the one where the two keys disagree.
    "tests/unit/canonical-self-claim.test.ts::counts the expected generation against the entitled project",
  ],
};
export default c;
