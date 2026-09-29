/**
 * #954. Restoration records what a revoked role is owed and stops; the claim path is the only
 * creator of an assignment row. A binding continuity minted would carry no session proof, which is
 * why `CONTINUITY_RESTORE_AWAITS_CLAIM` exists instead.
 *
 * The mutant is that rejected alternative: for an unbound, staffable role, `restore()` provisions a
 * routable session and binds it instead of recording the need. The killing test attaches the
 * readiness and Buzz ports continuity needs to provision, so the mutant is not stopped by a missing
 * port before it writes; what kills it is the assertion that the role's only assignment row is the
 * revoked generation 1, that no binding is active, and that no session was constituted.
 */
const restorationDoesNotMintARevokedBinding = {
  id: "restoration-does-not-mint-a-revoked-binding",
  what: "restoration of a revoked role records the need and writes no assignment row",
  file: "src/continuity/continuity-kernel.ts",
  find:
    "        deferred.push({ roleKey: assignment.roleKey, reasonCode: ReasonCode.BINDING_REVOKED });\n" +
    "        if (!this.recordRestorationAwaitsClaim(assignment.roleKey, assignment.provider)) alreadyRecorded += 1;\n",
  replace:
    "        const owed = this.requiredRoles().find((required) => required.roleKey === assignment.roleKey);\n" +
    "        if (owed) {\n" +
    "          const minted = await this.provisionRoutableSession(owed.role, assignment.provider, \"continuity:restore\");\n" +
    "          if (minted.allowed) {\n" +
    "            this.bindings.bind({\n" +
    "              role: owed.role,\n" +
    "              sessionId: minted.value.sessionId,\n" +
    "              projectId: owed.projectId,\n" +
    "              runId: owed.runId,\n" +
    "              taskId: owed.taskId,\n" +
    "            });\n" +
    "            restored.push(assignment.roleKey);\n" +
    "          }\n" +
    "        }\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::restores nothing by writing an assignment row the claim path is the only creator of",
  ],
};

export default restorationDoesNotMintARevokedBinding;
