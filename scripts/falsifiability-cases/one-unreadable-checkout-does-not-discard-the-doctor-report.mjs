/**
 * #869. `checkRepositories` probes each registered repository, and once `git()` gained a time
 * bound those probes can refuse instead of hanging. Without a per-repository catch the refusal
 * leaves `doctor.run()` rejecting, so one unreachable checkout carries away every finding already
 * collected about the daemon, the ledger and every other repository. `checkWorktrees` had this
 * catch already; this one was added by #869 and round 1 flagged it as having no witness.
 *
 * The mutation makes the catch rethrow rather than deleting it. Deleting the block would also
 * delete the `findings.push` that the test looks for, so the case would fail for the missing
 * finding instead of for the lost report -- the same verdict from a different cause. Rethrowing
 * keeps the finding's code in the file and removes only the property under test: that the report
 * survives.
 */
const oneUnreadableCheckoutDoesNotDiscardTheDoctorReport = {
  id: "one-unreadable-checkout-does-not-discard-the-doctor-report",
  what: "a repository probe that refused is reported as a finding, and the rest of the doctor report survives it",
  file: "src/doctor/doctor.ts",
  find: '      } catch (err) {\n        findings.push({\n          code: "REPOSITORY_PROBE_FAILED",',
  replace: '      } catch (err) {\n        if (err) throw err;\n        findings.push({\n          code: "REPOSITORY_PROBE_FAILED",',
  killedBy: [
    "tests/unit/one-unreadable-checkout-does-not-discard-the-doctor-report.test.ts::is reported, and does not carry the rest of the doctor report away with it",
  ],
};

export default oneUnreadableCheckoutDoesNotDiscardTheDoctorReport;
