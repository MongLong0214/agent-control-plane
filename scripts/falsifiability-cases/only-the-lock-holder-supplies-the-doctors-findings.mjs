/**
 * Only the daemon holding the single-instance lock supplies the doctor's findings.
 *
 * The supplier every doctor door draws from used to be registered in the `Daemon` constructor,
 * before `start()` takes the lock. A second daemon over the same control plane that `start()` then
 * refused still replaced the live daemon's supplier, and because it had no wake peers of its own,
 * the live daemon's MCP `doctor_run` doors and its automatic refresh answered from a set with none
 * of the live daemon's holders in it. `start()` now registers only after the lock is its own and
 * after the refusals that give the lock back.
 *
 * The mutant puts a registration back ahead of `this.lock.acquire`, leaving the later one in place:
 * a daemon that is then refused has already replaced the supplier, which is the reviewer's failure
 * exactly, and a daemon that is not refused registers twice to no effect, so only the refused case
 * can tell the mutant from the repair. The killing row refuses a second daemon on a live daemon's
 * control plane and reads the live daemon's CTO door and its automatic refresh.
 */
const onlyTheLockHolderSuppliesTheDoctorsFindings = {
  id: "only-the-lock-holder-supplies-the-doctors-findings",
  what: "a daemon that is refused the single-instance lock does not replace the live daemon's doctor findings",
  file: "src/daemon/daemon.ts",
  find: "    const acquired = this.lock.acquire(startedAt);\n",
  replace:
    "    this.cp.doctor.setSupplementalFindings(this.#doctorSupplier);\n" +
    "    const acquired = this.lock.acquire(startedAt);\n",
  killedBy: [
    "tests/unit/every-doctor-door-answers-from-one-set-of-findings.test.ts::a second daemon refused the lock leaves the live daemon's doors carrying its holder's finding",
  ],
};

export default onlyTheLockHolderSuppliesTheDoctorsFindings;
