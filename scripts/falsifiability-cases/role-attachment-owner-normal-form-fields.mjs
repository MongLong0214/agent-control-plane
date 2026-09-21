// Even an optional schema-only field must fail equality with the actual receipt declaration.
//
// `approvalSchema` no longer has anything to do with attachment issuance -- that gate is gone --
// and its only consumer is now `src/ceo/cto-binding-delegation.ts`. The declaration and this row
// stay where they are until the delegation path is removed, at which point both go with it. The
// half of the old witness that proved consumption identity went with the gate; what is left is
// the key-equality half, which is what this mutation actually breaks.
const roleAttachmentOwnerNormalFormFields = {
  id: "role-attachment-owner-normal-form-fields",
  what: "the owner-approval normal form declares exactly the receipt's fields, no more",
  file: "src/session/role-attachment-credentials.ts",
  find: "}) satisfies z.ZodType<OwnerApprovalReceipt>;",
  replace: "}).extend({ unproved: z.string().optional() }) satisfies z.ZodType<OwnerApprovalReceipt>;",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::the owner-approval normal form declares exactly the receipt's fields",
  ],
};

export default roleAttachmentOwnerNormalFormFields;
