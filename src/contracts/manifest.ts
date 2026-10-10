import { posix } from "node:path";

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
    mergeStrategy: z.enum(["merge_commit", "fast_forward", "squash", "rebase"]).default("merge_commit"),
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
             * The repository this workflow belongs to, mirroring `verificationCommands` (#512).
             *
             * Without it a declared check was required on every participating repository, and a
             * single `approvedDigest` was compared against a *different* file in each one — so
             * two repositories could satisfy one entry only by carrying byte-identical workflow
             * files. Invisible with one repository, unsatisfiable with two.
             *
             * Defaults to `primary`: every manifest written before this field existed described
             * a run with one repository, and that repository is the primary, so the default
             * leaves their behaviour unchanged. A secondary that declares nothing does not
             * thereby become exempt — `postMergeVerify` denies on an empty effective set, which
             * is the fail-closed direction.
             */
            repositoryRole: z.string().min(1).default("primary"),
            /**
             * Digest of the workflow file the contract approved. A CI result counts as
             * TRUSTED_CI only when the workflow that produced it still matches
             * (Integration §14.4); without this the evidence cannot be trusted and is
             * reported missing rather than accepted.
             */
            approvedDigest: z.string().min(1).nullable().default(null),
            /**
             * Says that this workflow has not been approved yet because the project is being
             * activated for the first time (#527).
             *
             * `null` used to carry this meaning implicitly, and carried a second one at the same
             * time: bootstrap activation read it as *accept any workflow*, post-merge
             * verification read it as *trust nothing*. A manifest that activated cleanly could
             * therefore never merge, and neither layer was wrong on its own — the fault was one
             * value standing for both "not approved yet" and "anything is fine", with nothing
             * marking the transition between them.
             *
             * This flag says only the first. A first activation has no approved digest to state,
             * so it says so; post-merge still refuses, because an unapproved workflow producing
             * trusted CI is the thing §14.4 exists to prevent. The refusal is loud — an operator
             * has to declare the digest — and a loud refusal is the correct trade against
             * silently trusting whatever workflow happens to be at the merge commit.
             *
             * The `superRefine` below makes the two fields express exactly one state each, so
             * `approvedDigest: null` alone no longer parses at all. That is deliberate: the
             * ambiguity is removed where it was introduced rather than patched at each reader.
             */
            unapprovedFirstActivation: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    /**
     * RF-S22 (PRD §14.2, RF-019): the files that hold the decision logic a pinned verification
     * command executes as a gate, each bound by the sha256 of its bytes, so a candidate that
     * rewrites a declared gate script to `process.exit(0)` is refused rather than judged by its
     * own copy.
     *
     * An entry is bound to the command that runs it, never to the project. An entry without
     * `loadedBy` must be invoked directly: some verification command of its repository must name
     * it as its first argument (`node gate/check.mjs`). A command that reaches a script through
     * selection configuration the candidate owns -- `node --run verify`, `npm test`, a package
     * script -- does not bind it, because the candidate can re-point that configuration without
     * touching the script, so such a declaration is refused rather than accepted as protection.
     * An entry with `loadedBy` is a helper that the named declared entry loads for its decision;
     * it is checked wherever its root is. For a TRUSTED_CI command the argv is ACP's statement of
     * what the approved workflow runs: ACP does not parse the workflow, so the approved workflow
     * must itself run that argv, and a workflow `run:` that goes through a package script is
     * selection configuration this binding does not reach.
     *
     * `.optional()` with no default is load-bearing. `manifestDigest` digests the parsed object,
     * so a defaulted `[]` would change the digest of every manifest written before this field
     * and break every stored pin. Absent stays absent, and every existing digest is unchanged.
     *
     * That makes the field optional, not the guarantee: a manifest with no `gateEntries` is NOT
     * RF-S22 compliant. Nothing about its gate logic is pinned, and the absence must never be
     * reported as a pass. `.min(1)` keeps an empty list from looking like a declaration.
     *
     * Only declared files are bound. Nothing is discovered from workflow YAML or followed
     * through imports, and project code, tests and dependencies stay the candidate's (§14.2).
     * A helper an entry imports for its decision is outside the guarantee until it is declared
     * too; an entry that loads any undeclared candidate file in-process can be short-circuited
     * through that file, so a gate entry means something only when it is self-contained. A
     * helper is trusted to be loaded by a path its root's pinned bytes name; a loader that
     * resolves it through candidate configuration (a package.json `imports` map) is not bound.
     */
    gateEntries: z
      .array(
        z
          .object({
            /** Repository-relative path of the file, as git names it at the candidate head. */
            path: z.string().min(1),
            /** The repository the file belongs to, mirroring `ciWorkflows` (#512). */
            repositoryRole: z.string().min(1).default("primary"),
            /** `sha256:<hex>` of the file's bytes, the convention `approvedDigest` uses. */
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            /** The declared entry, in the same repository, that loads this one for its decision. */
            loadedBy: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
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
    for (const workflow of manifest.ciWorkflows) {
      // Exactly one of the two states, never both and never neither (#527). "No digest and no
      // reason for there being no digest" is the shape that let one null mean two things.
      if ((workflow.approvedDigest === null) !== workflow.unapprovedFirstActivation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: workflow.approvedDigest === null
            ? `ciWorkflow '${workflow.checkName}' has no approvedDigest and does not declare unapprovedFirstActivation`
            : `ciWorkflow '${workflow.checkName}' declares unapprovedFirstActivation together with an approvedDigest`,
          path: ["ciWorkflows"],
        });
      }
      if (!roles.has(workflow.repositoryRole)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ciWorkflow '${workflow.checkName}' targets unknown repositoryRole '${workflow.repositoryRole}'`,
          path: ["ciWorkflows"],
        });
      }
    }
    const entries = manifest.gateEntries ?? [];
    const declared = new Map(entries.map((entry) => [gateEntryKey(entry.repositoryRole, entry.path), entry]));
    if (declared.size !== entries.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a gateEntry is declared more than once for the same repository and path",
        path: ["gateEntries"],
      });
    }
    for (const entry of entries) {
      if (!roles.has(entry.repositoryRole)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gateEntry '${entry.path}' targets unknown repositoryRole '${entry.repositoryRole}'`,
          path: ["gateEntries"],
        });
      }
      const root = gateEntryRoot(entry, declared);
      if (root === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gateEntry '${entry.path}' names a loadedBy chain that does not end at a declared entry`,
          path: ["gateEntries"],
        });
      } else if (!manifest.verificationCommands.some((command) => invokesDirectly(command, root))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gateEntry '${root.path}' is invoked directly by no verification command of repositoryRole '${root.repositoryRole}': a command must name it as its first argument`,
          path: ["gateEntries"],
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
  for (const entry of parsed.data.gateEntries ?? []) {
    if (!isPortableRepositoryPath(entry.path)) {
      violations.push(`gate entry '${entry.path}' path must be repository-relative`);
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

type GateEntry = NonNullable<ProjectManifest["gateEntries"]>[number];
type VerificationCommandShape = ReturnType<typeof verificationCommandSchema.parse>;

const gateEntryKey = (repositoryRole: string, path: string): string => `${repositoryRole}\0${path}`;

/**
 * The entry a `loadedBy` chain ends at, or null when the chain names an undeclared entry or
 * loops. Kept as a lookup of declared entries only, so a chain can never leave the manifest.
 */
const gateEntryRoot = (entry: GateEntry, declared: ReadonlyMap<string, GateEntry>): GateEntry | null => {
  let current = entry;
  const seen = new Set<string>();
  while (current.loadedBy !== undefined) {
    if (seen.has(current.path)) return null;
    seen.add(current.path);
    const next = declared.get(gateEntryKey(entry.repositoryRole, current.loadedBy));
    if (!next) return null;
    current = next;
  }
  return current;
};

/**
 * RF-S22 — whether a command runs `entry` itself rather than through selection configuration:
 * its first argument, resolved against its cwd, is the entry's path. An option there
 * (`node --run verify`) or any other position names something the interpreter or a package
 * manager resolves, which the candidate controls.
 */
const invokesDirectly = (command: VerificationCommandShape, entry: GateEntry): boolean => {
  const first = command.argv[1];
  if (command.repositoryRole !== entry.repositoryRole || first === undefined || first.startsWith("-")) return false;
  return posix.normalize(posix.join(command.cwd, first)) === entry.path;
};

/**
 * The gate entries a selected command must find unchanged before it runs: the ones it invokes
 * directly, and every declared helper whose `loadedBy` chain ends at one of them. A command that
 * invokes no entry has none, so a run is never held to a gate it does not execute (#1082 R1-03).
 */
export const gateEntriesFor = (manifest: ProjectManifest, command: VerificationCommandShape): GateEntry[] => {
  const entries = manifest.gateEntries ?? [];
  const declared = new Map(entries.map((entry) => [gateEntryKey(entry.repositoryRole, entry.path), entry]));
  return entries.filter((entry) => {
    const root = gateEntryRoot(entry, declared);
    return root !== null && invokesDirectly(command, root);
  });
};

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
