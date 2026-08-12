import { z } from "zod";

import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { verificationCommandSchema } from "./verification-command.ts";

export const PROJECT_MANIFEST_SCHEMA_ID = "agent-control-plane.project.v2";

/** Committed manifest location (Integration §10.1). */
export const MANIFEST_RELATIVE_PATH = ".agent-control-plane/project.json";

export const branchProfileSchema = z
  .object({
    longLived: z.array(z.string().min(1)).min(1).default(["main", "dev"]),
    defaultBranch: z.string().min(1).default("dev"),
    updateStrategy: z.enum(["rebase_before_review", "merge_from_target"]).default(
      "rebase_before_review",
    ),
    mergeStrategy: z.enum(["merge_commit", "fast_forward", "squash"]).default("merge_commit"),
    releaseTagPolicy: z.enum(["semver", "none"]).default("semver"),
    releaseBranchCleanup: z.enum(["delete", "keep"]).default("keep"),
  })
  .strict();

export type BranchProfile = z.infer<typeof branchProfileSchema>;

export const projectManifestSchema = z
  .object({
    schema: z.literal(PROJECT_MANIFEST_SCHEMA_ID),
    projectId: z.string().min(1),
    repositories: z
      .array(
        z
          .object({
            role: z.string().min(1),
            remote: z.string().min(1),
            manifestRoot: z.string().default("."),
          })
          .strict(),
      )
      .min(1),
    branchProfile: branchProfileSchema,
    verificationProfiles: z
      .object({
        simple: z.array(z.string()).default([]),
        standard: z.array(z.string()).default([]),
        guarded: z.array(z.string()).default([]),
      })
      .strict(),
    verificationCommands: z.array(verificationCommandSchema).default([]),
    postMergeCommands: z.array(z.string()).default([]),
    ciWorkflows: z
      .array(
        z
          .object({
            path: z.string().min(1),
            checkName: z.string().min(1),
            /**
             * Digest of the workflow file the contract approved. A CI result counts as
             * TRUSTED_CI only when the workflow that produced it still matches
             * (Integration §14.4); without this the evidence cannot be trusted and is
             * reported missing rather than accepted.
             */
            approvedDigest: z.string().nullable().default(null),
          })
          .strict(),
      )
      .default([]),
    commitlore: z
      .object({ mode: z.enum(["required", "preferred", "off"]).default("preferred") })
      .strict()
      .default({ mode: "preferred" }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set(manifest.verificationCommands.map((c) => c.id));
    for (const [profile, refs] of Object.entries(manifest.verificationProfiles)) {
      for (const ref of refs) {
        if (!ids.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `verificationProfiles.${profile} references unknown command '${ref}'`,
            path: ["verificationProfiles", profile],
          });
        }
      }
    }
    const roles = new Set(manifest.repositories.map((r) => r.role));
    for (const cmd of manifest.verificationCommands) {
      if (!roles.has(cmd.repositoryRole)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verificationCommand '${cmd.id}' targets unknown repositoryRole '${cmd.repositoryRole}'`,
          path: ["verificationCommands"],
        });
      }
    }
    if (!manifest.branchProfile.longLived.includes(manifest.branchProfile.defaultBranch)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultBranch must be one of the long-lived branches",
        path: ["branchProfile", "defaultBranch"],
      });
    }
  });

export type ProjectManifest = z.infer<typeof projectManifestSchema>;

/**
 * Integration §10.2 — a committed manifest must be machine-portable. Secret and
 * authority identifiers are content-wide concerns; filesystem paths are checked on the
 * fields that actually carry paths below, never inferred from serialized JSON.
 */
const NON_PORTABLE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ses|sess|session)_[A-Za-z0-9]{8,}/, "session identifier"],
  [/\bnsec1[a-z0-9]{20,}/, "buzz/nostr private key"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/, "github token"],
  [/\bsk-[A-Za-z0-9]{20,}/, "provider api key"],
  [/"(token|secret|password|apiKey|credential)"\s*:/i, "secret-bearing field"],
  [/\btelegram(ChatId|UserId)\b/i, "telegram identity"],
  [/\bbuzz(Channel|Address|Actor)\b/i, "buzz channel identity"],
  [/\bremainingPercent\b/, "provider quota snapshot"],
];

export const assertPortableManifest = (manifest: unknown): Decision<ProjectManifest> => {
  const parsed = projectManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return deny(ReasonCode.INVALID_ARGUMENT, "manifest failed schema validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const text = canonicalJson(parsed.data);
  const violations = NON_PORTABLE_PATTERNS.filter(([pattern]) => pattern.test(text)).map(
    ([, label]) => label,
  );

  for (const repo of parsed.data.repositories) {
    if (!isPortableRepositoryPath(repo.manifestRoot)) {
      violations.push(`repository '${repo.role}' manifestRoot must be repository-relative`);
    }
    if (!isPortableRemoteIdentity(repo.remote)) {
      violations.push(`repository '${repo.role}' remote must be a portable remote identity`);
    }
  }
  for (const workflow of parsed.data.ciWorkflows) {
    if (!isPortableRepositoryPath(workflow.path)) {
      violations.push(`CI workflow '${workflow.checkName}' path must be repository-relative`);
    }
  }
  for (const command of parsed.data.verificationCommands) {
    for (const [index, arg] of command.argv.entries()) {
      if (
        isAbsoluteFilesystemPath(arg) ||
        arg.startsWith("~/") ||
        arg.startsWith("~\\") ||
        arg.split(/[\\/]/).includes("..")
      ) {
        violations.push(`verification command '${command.id}' argv[${index}] contains a filesystem path`);
      }
    }
    if (command.network === "allowlist") {
      violations.push(`verification command '${command.id}' requests unsupported network allowlist`);
    }
  }

  if (violations.length > 0) {
    return deny(ReasonCode.MANIFEST_NOT_PORTABLE, "manifest is not machine-portable", {
      violations,
    });
  }

  return allow(ReasonCode.OK, parsed.data);
};

export const manifestDigest = (manifest: ProjectManifest): string => digestOf(manifest);

/** Commands selected by an execution mode, resolved through the profile map. */
export const commandsForMode = (
  manifest: ProjectManifest,
  mode: "SIMPLE" | "STANDARD" | "GUARDED",
): ReturnType<typeof verificationCommandSchema.parse>[] => {
  const key = mode.toLowerCase() as "simple" | "standard" | "guarded";
  const wanted = new Set(manifest.verificationProfiles[key]);
  return manifest.verificationCommands.filter((c) => wanted.has(c.id));
};

const isPortableRemoteIdentity = (value: string): boolean => {
  if (!/^(github|git):[^/\\\s:]+\/.+/.test(value)) return false;
  const parts = value.slice(value.indexOf(":") + 1).split(/[\\/]/);
  return (
    !isAbsoluteFilesystemPath(value) &&
    parts.length >= 2 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
};

const isPortableRepositoryPath = (value: string): boolean => {
  if (value === ".") return true;
  if (isAbsoluteFilesystemPath(value) || value.startsWith("~") || value.length === 0) return false;
  const parts = value.split(/[\\/]/);
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

const isAbsoluteFilesystemPath = (value: string): boolean =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
