const roleAttachmentReviewApprovalRun = {
  id: "role-attachment-review-approval-run",
  what: "attachment review: an otherwise admitted run approval cannot issue attachments",
  file: "src/session/role-attachment-credentials.ts",
  find: "        approval.runId !== null || approval.parameterDigest !== digestOf(scope.value)) {",
  replace: "        approval.parameterDigest !== digestOf(scope.value)) {",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::an otherwise valid run-bound approval cannot issue an attachment"],
};

export default roleAttachmentReviewApprovalRun;
