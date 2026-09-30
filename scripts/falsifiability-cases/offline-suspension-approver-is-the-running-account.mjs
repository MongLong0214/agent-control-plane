/**
 * #1032. The offline approver is the account the kernel says runs the command, not a name the
 * caller types. The mutant accepts any declared owner's name from any account.
 */
const offlineSuspensionApproverIsTheRunningAccount = {
  id: "offline-suspension-approver-is-the-running-account",
  what: "an offline project suspension refuses a declared owner's name typed by another account",
  file: "src/db/state-admin.ts",
  find: "    if (approvedBy !== account) {\n",
  replace: "    if (account.length < 0) {\n",
  killedBy: [
    "tests/unit/an-offline-project-suspension.test.ts::refuses a declared owner's name typed by an account that is not that owner",
  ],
};

export default offlineSuspensionApproverIsTheRunningAccount;
