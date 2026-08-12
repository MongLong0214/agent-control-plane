import { z } from "zod";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export const REPO_FACTORY_RESULT_SCHEMA_ID = "repo-factory.result.v2";

/** Integration §13.3 — provenance for every external resource write. */
export const externalWriteReceiptSchema = z
  .object({
    bootstrapOperationId: z.string().min(1),
    requestDigest: z.string().min(1),
    operationId: z.string().min(1),
    resourceType: z.string().min(1),
    resourceIdentity: z.string().min(1),
    preexisting: z.boolean(),
    beforeStateDigest: z.string().nullable(),
    afterStateDigest: z.string().nullable(),
    createdAt: z.string().min(1),
    rereadAt: z.string().nullable(),
    verified: z.boolean(),
  })
  .strict();

export type ExternalWriteReceipt = z.infer<typeof externalWriteReceiptSchema>;

export const repoFactoryResultSchema = z
  .object({
    schema: z.literal(REPO_FACTORY_RESULT_SCHEMA_ID),
    runId: z.string().min(1),
    bootstrapOperationId: z.string().min(1),
    planDigest: z.string().min(1),
    projectManifestDigest: z.string().min(1),
    repositories: z
      .array(
        z
          .object({
            role: z.string().min(1),
            identity: z.string().min(1),
            /** Repo Factory may *propose* a local binding; it never commits one. */
            proposedCheckoutPath: z.string().nullable().default(null),
            defaultBranch: z.string().min(1),
            createdBranches: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .min(1),
    externalWriteReceipts: z.array(externalWriteReceiptSchema).default([]),
    bootstrapVerification: z
      .array(
        z
          .object({
            commandId: z.string().min(1),
            repositoryIdentity: z.string().min(1),
            exactHead: z.string().min(1),
            status: z.enum(["PASS", "FAIL", "SKIPPED"]),
          })
          .strict(),
      )
      .default([]),
    ciEvidence: z
      .array(
        z
          .object({
            repositoryIdentity: z.string().min(1),
            checkName: z.string().min(1),
            head: z.string().min(1),
            conclusion: z.string().min(1),
            workflowDigest: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    unresolvedGaps: z.array(z.string()).default([]),
  })
  .strict();

export type RepoFactoryResult = z.infer<typeof repoFactoryResultSchema>;

/**
 * Integration §13.4 — facts a `RepoFactoryResult` must not assert. These are
 * *activation* facts and only the control plane may state them; a result that claims
 * one is rejected rather than trusted (CP-S52, RF-S17).
 */
const FORBIDDEN_CLAIMS = [
  "primaryCtoAssignment",
  "primaryCto",
  "buzzConnection",
  "buzz",
  "doctorPass",
  "doctor",
  "blindReviewPass",
  "blindReview",
  "ceoFinalConfirm",
  "ceoConfirm",
  "projectActive",
  "activity",
];

export const parseRepoFactoryResult = (input: unknown): Decision<RepoFactoryResult> => {
  if (input && typeof input === "object") {
    const overclaims = FORBIDDEN_CLAIMS.filter((key) => key in (input as Record<string, unknown>));
    if (overclaims.length > 0) {
      return deny(
        ReasonCode.BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION,
        "RepoFactoryResult asserts activation facts it has no authority over",
        { overclaims },
      );
    }
  }

  const parsed = repoFactoryResultSchema.safeParse(input);
  if (!parsed.success) {
    return deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "RepoFactoryResult failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  // Integration §16.2 — an unverified external write is not evidence of anything.
  const unverified = parsed.data.externalWriteReceipts.filter((r) => !r.verified || !r.rereadAt);
  if (unverified.length > 0) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "external write receipts are missing post-write re-read verification",
      { unverified: unverified.map((r) => r.resourceIdentity) },
    );
  }

  return allow(ReasonCode.OK, parsed.data);
};

/** Integration §13.6 — the portable handoff seed Repo Factory may supply. */
export const bootstrapHandoffSeedSchema = z
  .object({
    projectGoal: z.string().min(1),
    activeManifestDigest: z.string().min(1),
    createdRepositories: z.array(z.string()).default([]),
    createdBranches: z.array(z.string()).default([]),
    artifactLocations: z.array(z.string()).default([]),
    verificationCommands: z.array(z.string()).default([]),
    knownLimitations: z.array(z.string()).default([]),
    recommendedFirstRuns: z.array(z.string()).default([]),
  })
  .strict();

export type BootstrapHandoffSeed = z.infer<typeof bootstrapHandoffSeedSchema>;
