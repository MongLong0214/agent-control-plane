import { z } from "zod";
import { genesisBundleSchema } from "./genesis-bundle.ts";
import { githubOperationSchema } from "./repo-factory-github.ts";

/**
 * #1240 — a Repo Factory project's STANDARD_WORK PLAN maps its tasks to responsibility units (several
 * tasks may share one unit: implementation, review and correction of one deliverable). Each unit links
 * one GitHub issue and one milestone, each either an existing one by number (adopted, verified by
 * readback) or a `new` one ACP creates with exactly this text. `tasks` names this submission's task
 * keys or the run's existing task ids. The latest PLAN's units are the run's whole approved scope.
 */
const workText = z.string().max(65_536);
export const workUnitsSchema = z.array(z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  tasks: z.array(z.string().min(1)).min(1),
  issue: z.union([
    z.object({ number: z.number().int().positive() }).strict(),
    z.object({ new: z.object({ title: z.string().trim().min(1).max(256), body: workText }).strict() }).strict(),
  ]),
  milestone: z.union([
    z.object({ number: z.number().int().positive() }).strict(),
    z.object({ new: z.object({ title: z.string().trim().min(1).max(256), description: workText.default("") }).strict() }).strict(),
  ]),
}).strict()).min(1).max(200);
export type WorkUnitDeclaration = z.infer<typeof workUnitsSchema>[number];

// Shared with the ordinary plan_submit path; attached input receives the same validation.
export const submittedPlanSchema = z.object({
  workUnits: workUnitsSchema.optional(),
  summary: z.string(),
  genesis: genesisBundleSchema.optional(),
  repositoryContentChange: z.boolean().optional(),
  firstActivation: z.boolean().optional(),
  workflowRevisions: z.array(z.object({
    repositoryRole: z.string(), repositoryIdentity: z.string(), path: z.string(), checkName: z.string(),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/), fileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict()).optional(),
  dependencies: z.array(z.string()).default([]),
  repositoryIntent: z.array(z.string()).default([]),
  verificationIntent: z.array(z.string()).default([]),
  knownConflicts: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  removedOverengineering: z.array(z.string()).default([]),
  bootstrapOperationId: z.string().min(1).optional(),
  // Explicit retired project replaced by this bootstrap; covered by the normalized PLAN digest.
  supersedesProjectId: z.string().min(1).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  requestDigest: z.string().min(1).optional(),
  projectManifestDigest: z.string().min(1).optional(),
  // Issue #246 — each operation as the Repo Factory runner executes it and the owner
  // approves it, desired state included: `githubOperationSchema` itself, rather than a
  // second copy of its rules here. An operation named by identity only is still accepted,
  // as before; such a PLAN is refused as PLAN_NOT_EXECUTABLE at approval and execution.
  githubOperations: z.array(z.union([
    githubOperationSchema,
    z.object({
      operationId: z.string().min(1),
      resourceType: z.string().min(1),
      resourceIdentity: z.string().min(1),
    }).strict(),
  ])).optional(),
  // Issue #246 PR-C slice C2 — a project-less bootstrap run's full project manifest. It must be
  // portable and its digest must be `projectManifestDigest`; the PLAN keeps it, so the PLAN
  // digest covers it. #246 B2-a — a CONTRACT_CHANGE run's PLAN must carry it, under the same
  // rules and checked against the run's pinned manifest. Any other run's plan never stores it.
  projectManifest: z.record(z.unknown()).optional(),
});

export const submittedTasksSchema = z.array(z.object({ key: z.string(), title: z.string(), category: z.enum(["mechanical", "implementation", "investigation", "integration", "test", "review", "docs", "migration", "benchmark", "security"]), dependsOn: z.array(z.string()).default([]), spec: z.record(z.unknown()).default({}) })).min(1);

export const bootstrapPlanInputSchema = z.object({
  runId: z.string().min(1),
  plan: submittedPlanSchema,
  tasks: submittedTasksSchema,
}).strict();
