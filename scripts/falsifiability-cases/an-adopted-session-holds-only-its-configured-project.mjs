/**
 * #1005 - the entitlement, which is the half the old single-UUID pin never had.
 *
 * Before the set, `projectId` reached `roleKeyFor(Role.PRIMARY_CTO, { projectId })` from the
 * request without being compared to anything: passing the identity pin was sufficient to assemble
 * `PRIMARY_CTO:<any registered project>`. The entry is what the project is checked against now,
 * and dropping this comparison restores exactly that: one entitled session, every project.
 *
 * Mutated to a tautology rather than deleted, so the mutant keeps `entry` read and typechecks.
 */
const c = {
  id: "an-adopted-session-holds-only-its-configured-project",
  what: "an adopted session may hold PRIMARY_CTO only for the project its own entry names",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (entry.projectId !== request.projectId) {",
  replace: "    if (entry.projectId !== entry.projectId) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 4 — an entitled session claiming another project is refused, on the derived UUID and before any row",
  ],
};
export default c;
