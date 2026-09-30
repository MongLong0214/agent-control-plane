/**
 * #1032. An offline suspension records ownerApproved: true, so the approver must be a cli owner the
 * deployment declared in `owner-identities`. The mutant accepts any name.
 */
const offlineSuspensionNeedsADeclaredOwner = {
  id: "offline-suspension-needs-a-declared-owner",
  what: "an offline project suspension refuses an approver the deployment did not declare as a cli owner",
  file: "src/db/state-admin.ts",
  find: "    if (!owners.some((owner) => owner.channel === \"cli\" && owner.actor === approvedBy)) {\n",
  replace: "    if (owners.length < 0) {\n",
  killedBy: [
    "tests/unit/an-offline-project-suspension.test.ts::refuses an approver the deployment did not declare as a cli owner",
  ],
};

export default offlineSuspensionNeedsADeclaredOwner;
