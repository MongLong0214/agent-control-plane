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
  find: "    if (current.bindingGeneration !== request.expectedBindingGeneration) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::refuses a request that names a different target",
  ],
};

export default aDeadBindingRecoveryReleasesOnlyTheGenerationItNames;
