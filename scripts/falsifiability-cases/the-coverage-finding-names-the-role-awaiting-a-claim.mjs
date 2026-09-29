/**
 * #954. A role continuity revoked and can staff again is the one state that reaches
 * PARTIAL_COVERAGE with nothing uncovered, so a finding that carries only `uncovered` names nothing
 * and sends the reader to the providers when the missing thing is a claim on a role.
 *
 * The mutant drops `restorationPending` from the finding's evidence and leaves the sentence alone.
 * The killing test enters through the daemon's operator `DOCTOR_RUN` on a started daemon and asserts
 * the evidence names the pending role. The sentence is a separate expression and is not this row's
 * subject.
 */
const theCoverageFindingNamesTheRoleAwaitingAClaim = {
  id: "the-coverage-finding-names-the-role-awaiting-a-claim",
  what: "the partial-coverage doctor finding carries the role that waits on a claim in its evidence",
  file: "src/doctor/doctor.ts",
  find: "          restorationPending: plan.restorationPending,\n          action: plan.action,\n",
  replace: "          action: plan.action,\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::names the role that waits on a claim in the doctor finding an operator's DOCTOR_RUN returns",
  ],
};

export default theCoverageFindingNamesTheRoleAwaitingAClaim;
