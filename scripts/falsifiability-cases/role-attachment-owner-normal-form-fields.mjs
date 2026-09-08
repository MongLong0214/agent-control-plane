// Even an optional schema-only field must fail equality with the actual receipt declaration.
const roleAttachmentOwnerNormalFormFields = {
  id: "role-attachment-owner-normal-form-fields",
  what: "attachment authorization: schema fields exactly match the proved and consumed receipt",
  file: "src/session/role-attachment-credentials.ts",
  find: "}) satisfies z.ZodType<OwnerApprovalReceipt>;",
  replace: "}).extend({ unproved: z.string().optional() }) satisfies z.ZodType<OwnerApprovalReceipt>;",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::approval schema fields and consumed normal form exactly match the proved receipt",
  ],
};

export default roleAttachmentOwnerNormalFormFields;
