const roleAttachmentRound2TransferSharedActor = {
  id: "role-attachment-round2-transfer-shared-actor",
  what: "attachment round 2: actor moves publish every affected role binding",
  file: "src/session/binding-registry.ts",
  find: "const publications = [transferred, ...siblings];",
  replace: "const publications = [transferred];",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::shared actor transfers invalidate both role attachments",
  ],
};

export default roleAttachmentRound2TransferSharedActor;
