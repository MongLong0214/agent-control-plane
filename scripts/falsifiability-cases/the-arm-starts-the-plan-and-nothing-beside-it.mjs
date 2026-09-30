/**
 * What an arm starts is the plan and nothing added beside it.
 *
 * `spawnPlanFor` makes one decision -- executable, argv, and the `command` a reading records -- and
 * this is the site that consumes it. A word appended here and not to the plan is the one divergence
 * no reader of a reading could ever detect: the reading would describe an interactive invocation
 * while the process that ran carried `--print`, every number in it still looking like a pass, and
 * the build would be qualified for a role a process of that shape cannot hold.
 *
 * The mutation is exactly that append, at the call rather than in the plan. The killing row drives
 * the real `runQualificationProbe` with one boundary injected -- the function that starts the
 * process -- and requires that what was started is `[executable, ...argv]` equal to the reading's
 * `command`, and that its flags are `probeArgv`'s flags for the shape. The temp root, the provider,
 * the socket, the wake frame and the capture are the real ones, so the row measures the probe.
 *
 * This site was previously called unreachable where no client is installed, and rows near it were
 * narrowed on that ground. A reviewer refuted it by driving the branch through injected boundaries,
 * so it is anchored here instead of argued about.
 */
const theArmStartsThePlanAndNothingBesideIt = {
  id: "the-arm-starts-the-plan-and-nothing-beside-it",
  what: "an arm starts the spawn plan's executable and argv unaccompanied, so the invocation it records is the one that ran",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    child = startProcess(plan.executable, plan.argv, {\n",
  replace: '    child = startProcess(plan.executable, [...plan.argv, "--print"], {\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::starts the invocation its reading records, and nothing beside it",
  ],
};

export default theArmStartsThePlanAndNothingBesideIt;
