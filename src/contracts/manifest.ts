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
     * `loadedBy` must be run by a local verification command of its repository in the one admitted
     * launch form, `node <entry>` (see `launchedEntry`). A command that reaches a script through
     * selection configuration the candidate owns -- `node --run verify`, `pnpm <name>`, `npm test`
     * -- does not bind it, because the candidate can re-point that configuration without touching
     * the script, so such a declaration is refused rather than accepted as protection. An entry
     * with `loadedBy` is a helper that the named declared entry loads for its decision; it is
     * checked wherever its root is.
     *
     * The validator arm covers local execution only. A gate entry on a TRUSTED_CI command is
     * refused: CI runs it after earlier steps of the approved job that ACP cannot see, so nothing
     * ACP checks binds what CI executed. BOTH_REQUIRED is admitted because its local run is checked.
     *
     * Every declared file -- entry and helper alike -- is `.mjs` or `.cjs`, exactly (#1082 R1-02,
     * rounds 3 and 4). Node runs a `.js` file as CommonJS or as an ES module according to the
     * nearest package.json `"type"` and, with no type, the file's own syntax, so a candidate that
     * changes only its package.json could change what unchanged pinned bytes decide; and `require`
     * runs a file of any unknown extension as JavaScript. Anything else is refused with the issue
     * refusal code `GATE_ENTRY_MODULE_FORMAT_UNPINNED`; nothing is renamed or loaded another way on
     * the producer's behalf.
     *
     * A declared file is reached by a path its loader's pinned bytes name, relative to it. The
     * package.json Node consults for a declared file -- the nearest one at or above its directory --
     * must define none of `imports`, `exports` and `main`, or verification refuses CONTRACT_UNVERIFIED
     * before anything runs: those fields let package configuration, not pinned bytes, choose which
     * file a `#name`, self-reference or directory specifier loads (round 4). A project whose root
     * package.json defines them puts a package.json without them beside its gate files.
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
     * through that file, so a gate entry means something only when it is self-contained. The
     * same holds for a program the entry runs by name: the sandbox PATH lists the worktree, so a
     * name can resolve to a file the candidate commits. A bare specifier resolves through the
     * candidate's node_modules, which is the candidate's dependency tree and is not bound either.
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
      const unpinnedFormat = moduleFormatRefusal(entry);
      if (unpinnedFormat !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: unpinnedFormat,
          path: ["gateEntries"],
          params: { refusal: GATE_ENTRY_MODULE_FORMAT_UNPINNED },
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
          message: `gateEntry '${root.path}' is run by no local verification command of repositoryRole '${root.repositoryRole}' as 'node ${root.path}'`,
          path: ["gateEntries"],
        });
      }
    }
    for (const command of manifest.verificationCommands) {
      const launched = launchedEntry(command);
      if (
        command.evidenceMode === "TRUSTED_CI" &&
        entries.some((entry) => entry.repositoryRole === command.repositoryRole && entry.path === launched)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verificationCommand '${command.id}' runs gate entry '${launched}' only in trusted CI, where it cannot be checked before it runs; declare it LOCAL_COMMAND or BOTH_REQUIRED`,
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
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        // A refusal a producer has to act on in a particular way names itself, so it can be told
        // apart from a typo without matching on the message.
        ...(i.code === z.ZodIssueCode.custom && typeof i.params?.["refusal"] === "string"
          ? { refusal: i.params["refusal"] as string }
          : {}),
      })),
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
 * RF-S22 (#1082 R1-02, round 3) — the refusal code a manifest issue carries when a declared gate
 * file does not fix its own module format. Part of the producer contract: a producer matches on
 * it, not on the message.
 */
export const GATE_ENTRY_MODULE_FORMAT_UNPINNED = "GATE_ENTRY_MODULE_FORMAT_UNPINNED";

/**
 * The only extensions a declared gate file -- entry or helper -- may have (#1082 R1-02, round 4):
 * the two whose module format Node takes from the extension alone. An allowlist, not a list of the
 * extensions known to vary: a closure review declared a `gate/decide.txt` helper, which a denylist
 * of `.js`, `.ts` and extensionless admitted, and node's `require` ran it as JavaScript through its
 * fallback loader. That node can run a file is never a reason to admit it.
 */
const EXPLICIT_MODULE_EXTENSIONS: ReadonlySet<string> = new Set([".mjs", ".cjs"]);

/**
 * Why `entry` cannot be pinned by its bytes alone, or null. The same bytes run as CommonJS or as
 * an ES module depending on files the candidate owns, and the two can decide differently: measured,
 * an unchanged `.js` gate that exits 1 under `{"type":"commonjs"}` exited 0 when the candidate
 * changed only `package.json` to `{"type":"module"}`. So every declared file must be `.mjs` or
 * `.cjs`, exactly. No existing declaration is rewritten to another extension or run through
 * another loader: it is refused, and the producer renames the file and re-pins it.
 */
const moduleFormatRefusal = (entry: GateEntry): string | null => {
  const extension = posix.extname(entry.path);
  if (EXPLICIT_MODULE_EXTENSIONS.has(extension)) return null;
  const named = `'${extension || "an extensionless file"}'`;
  return entry.loadedBy === undefined
    ? `gateEntry '${entry.path}' must name its module format in its extension (.mjs or .cjs): node decides how ` +
        `${named} runs from the candidate's package.json "type" and the file's own syntax, so the same pinned ` +
        "bytes can decide differently"
    : `gateEntry '${entry.path}' (loaded by '${entry.loadedBy}') must be .mjs or .cjs: ${named} is not an extension ` +
        "that fixes how node loads the file";
};

/**
 * RF-S22 — the file a command's launch form executes as-is, or null when its launcher picks what
 * runs from anything else (#1082 R1-02).
 *
 * This is an allowlist of launch semantics, not of spellings. The one admitted form is `node
 * <entry> [args...]`: node executes the file its first operand names, resolved against the
 * command's cwd, and reads everything after it as the script's own arguments. Any node option
 * before the entry can change what is loaded (`--run`, `-e`, `-r`/`--require`, `--import`,
 * `--loader`, `--env-file`), so a first operand that starts with "-" is never an entry.
 *
 * Nothing else launches a gate. Package managers and task runners (npm, pnpm, yarn, npx, bun,
 * make, just) and tools that read their own configuration (vitest, eslint, tsc) choose what runs
 * from candidate files: `pnpm gate/check.mjs` runs a package script of that name. git is not an
 * interpreter. node is also the only interpreter the verification executable allowlist admits,
 * and an entry run as argv[0] is not on it either. Python and Deno are left out on their own
 * terms: CPython puts the script's directory first on its import path and runs an unchecked
 * hash-based .pyc in place of a declared helper's source, and Deno resolves imports through a
 * deno.json it discovers in the candidate tree.
 */
// The entry this returns is matched against the declarations, and those are refused unless they
// end in `.mjs` or `.cjs` (`moduleFormatRefusal`), so the launch form and the bytes it executes are
// both fixed by the manifest, not by the candidate's package.json.
const launchedEntry = (command: VerificationCommandShape): string | null => {
  const [launcher, operand] = command.argv;
  if (launcher !== "node" || operand === undefined || operand.startsWith("-")) return null;
  return posix.normalize(posix.join(command.cwd, operand));
};

/**
 * Whether `command` runs `entry` where ACP can check it first. A TRUSTED_CI command's run happens
 * on CI, after whatever earlier step of the approved job ran -- a dependency install's lifecycle
 * scripts, a local action -- any of which can rewrite the entry before it runs, and ACP sees only
 * the result. Requiring the approved workflow to carry a `run:` line equal to the argv was
 * rejected rather than adopted: it binds the line, not what ran before it in the same job. So the
 * validator arm binds local execution only: LOCAL_COMMAND, and BOTH_REQUIRED, whose local run is
 * checked.
 */
const invokesDirectly = (command: VerificationCommandShape, entry: GateEntry): boolean =>
  command.repositoryRole === entry.repositoryRole &&
  command.evidenceMode !== "TRUSTED_CI" &&
  launchedEntry(command) === entry.path;

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
