/**
 * The recovery mints nothing, so the only way a generation could move backwards through this door
 * is a replayed request being applied to a binding that has since been superseded. The equality
 * check is what refuses that, and deleting it also removes the "wrong target" refusal the CEO's
 * third case names.
 */
const aDeadBindingRecoveryReleasesOnlyTheGenerationItNames = {
  id: "a-dead-binding-recovery-releases-only-the-generation-it-names",
  what: "a recovery naming a generation that is not in force is refused, not applied",
  file: "src/daemon/dead-binding-recovery.ts",
  // Remove the whole refusal so its unreachable body does not lose TypeScript narrowing.
  find: "    if (current.bindingGeneration !== request.expectedBindingGeneration) {\n" +
    "      return deny(\n" +
    "        ReasonCode.WRITE_BINDING_GENERATION_STALE,\n" +
    "        \"the recovery names a binding generation that is not the one in force\",\n" +
    "        {\n" +
    "          projectId: request.projectId,\n" +
    "          roleKey,\n" +
    "          expectedGeneration: request.expectedBindingGeneration,\n" +
    "          currentGeneration: current.bindingGeneration,\n" +
    "        },\n" +
    "      );\n" +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::refuses a request that names a different target",
  ],
};

export default aDeadBindingRecoveryReleasesOnlyTheGenerationItNames;
