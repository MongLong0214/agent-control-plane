// Even an optional schema-only field must fail equality with the actual receipt declaration.
const roleAttachmentOwnerNormalFormFields = {
  id: "role-attachment-owner-normal-form-fields",
  what: "attachment authorization: schema and declaration keys match and consumption proves the same object",
  file: "src/session/role-attachment-credentials.ts",
  find: "}) satisfies z.ZodType<OwnerApprovalReceipt>;",
  replace: "}).extend({ unproved: z.string().optional() }) satisfies z.ZodType<OwnerApprovalReceipt>;",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::approval schema matches declared keys and consumption proves the same normal-form object",
  ],
};

export default roleAttachmentOwnerNormalFormFields;
