import { z } from "zod";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * The single canonical VerificationCommand schema (PRD §17.2, Integration §12).
 *
 * Both systems share this shape and there is exactly one implementation of it — a
 * second, subtly different copy is forbidden by Integration §2.2.
 */
const verificationCommandShape = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "command id must be kebab-case"),
    argv: z.array(z.string().min(1)).min(1),
    repositoryRole: z.string().min(1).default("primary"),
    cwd: z.string().default("."),
    timeoutSeconds: z.number().int().positive().max(24 * 3600).default(1200),
    envAllowlist: z.array(z.string()).default([]),
    // `deny`, the default, runs with IP networking and every unix socket outside the command's worktree
    // and scratch denied, and the result records `deny` as enforced; a command that needs the network
    // declares `allow`, which runs with outbound network and local IPC open and records `allow`.
    // The field and its default stay so every existing manifest keeps its digest. `allowlist` is
    // retained in the wire union solely to return an explicit migration error for old manifests:
    // seatbelt cannot enforce a destination allowlist, so it is not a production-supported contract.
    network: z.enum(["deny", "allowlist", "allow"]).default("deny"),
    networkAllowlist: z.array(z.string()).default([]),
    // §17.7's authoritative input count has no optional-evidence counterpart at the
    // production and review gates. Rejecting `false` keeps the contract singular: every
    // declared command is an input that must be corroborated before publication.
    required: z.literal(true).default(true),
    evidenceMode: z.enum(["LOCAL_COMMAND", "TRUSTED_CI", "BOTH_REQUIRED"]).default("LOCAL_COMMAND"),
    maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).default(1024 * 1024),
    maxMemoryMb: z.number().int().positive().max(65536).default(4096),
    /** Absent means the command timeout is also its hard CPU budget. */
    maxCpuSeconds: z.number().int().positive().max(24 * 3600).optional(),
  })
  .strict();

export const verificationCommandSchema = verificationCommandShape.superRefine((cmd, ctx) => {
  // argv[0] may be any executable (owner directive 2026-10-31): there is no executable allowlist.
  // A bare name or an absolute path must lead to an executable file on this host. A relative path
  // names a file in the repository (`./gradlew`), so it is resolved at launch against the
  // command's cwd in its worktree (`verificationLaunchArgv`), where it is refused if it does not.
  if (!isRepositoryRelativeExecutable(cmd.argv[0] ?? "") && isVerificationCommandRefused(cmd.argv)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: verificationExecutableRefusalMessage(cmd.argv),
      path: ["argv", 0],
    });
  }
  for (const [i, arg] of cmd.argv.entries()) {
    if (/[|;&><`$\n]/.test(arg) && !isSafeLiteral(arg)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `argv[${i}] contains shell metacharacters; argv is executed without a shell`,
        path: ["argv", i],
      });
    }
  }
  if (!isPortableRelativePath(cmd.cwd)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cwd must be repository-relative and must not escape the repository",
      path: ["cwd"],
    });
  }
  if (cmd.network === "allowlist") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "network=allowlist is not production-supported: no runtime backend can enforce it",
      path: ["network"],
    });
  }
  if (cmd.network !== "allowlist" && cmd.networkAllowlist.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "networkAllowlist is unsupported unless a future enforceable network backend is installed",
      path: ["networkAllowlist"],
    });
  }
});

export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

/**
 * A handful of arguments legitimately contain `$` or `>` (a jest name filter, a
 * version range). They are safe because the initial argv is passed without a shell. This
 * predicate keeps the check above as a lint on contract intent, not a claim about code the
 * declared executable may run after it starts.
 */
const isSafeLiteral = (arg: string): boolean => /^[^`\n;|&]*$/.test(arg) && !arg.includes("$(");

const SYSTEM_EXECUTABLE_ROOTS = [
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
] as const;

export interface VerificationExecutableResolutionOptions {
  /** Directory used to interpret a relative argv[0]. */
  cwd?: string;
  /** Controlled PATH used for a bare argv[0]. */
  path?: string;
  /** Repository roots whose `node_modules/.bin` and top level are searched after the system and daemon PATH. */
  additionalRoots?: readonly string[];
}

export interface VerificationExecutableResolution {
  name: string;
  resolvedPath: string | null;
  allowed: boolean;
}

const executableName = (value: string): string => {
  const name = basename(value.replaceAll("\\", "/")).toLowerCase();
  if (process.platform === "win32") return name.replace(/\.(?:exe|cmd|bat)$/, "");
  return name;
};

const nativePath = (value: string): string => value.replaceAll("\\", sep);

const uniquePaths = (paths: readonly string[]): string[] => [...new Set(paths.filter((path) => path.length > 0))];

/**
 * Search roots are constructed by the daemon, never inherited by a candidate. The
 * runtime and system roots are always present; the daemon's configured PATH contributes
 * package-manager installations, and a sandbox may add the current repository's local
 * tool bin.
 */
export const verificationExecutableSearchPath = (
  additionalRoots: readonly string[] = [],
  configuredPath = process.env["PATH"] ?? "",
): string[] => {
  const configured = configuredPath
    .split(delimiter)
    .map(nativePath)
    .filter((path) => path.length > 0);
  const repositoryBins = additionalRoots.flatMap((root) => [
    join(nativePath(root), "node_modules", ".bin"),
    nativePath(root),
  ]);
  return uniquePaths([
    dirname(process.execPath),
    ...SYSTEM_EXECUTABLE_ROOTS,
    ...configured,
    ...repositoryBins,
  ]);
};

const canonicalPath = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const hasPathSeparator = (value: string): boolean =>
  nativePath(value).includes(sep) || /^[A-Za-z]:[\\/]/.test(value);

/** argv[0] names a file by a path relative to the command's cwd, as `./gradlew` does. */
const isRepositoryRelativeExecutable = (value: string): boolean =>
  hasPathSeparator(value) && !isAbsolute(nativePath(value)) && !/^[A-Za-z]:[\\/]/.test(value);

const candidateFor = (
  value: string,
  options: VerificationExecutableResolutionOptions,
): string | null => {
  const raw = nativePath(value);
  if (hasPathSeparator(value)) {
    const candidate = isAbsolute(raw) ? raw : resolve(nativePath(options.cwd ?? process.cwd()), raw);
    return isExecutableFile(candidate) ? candidate : null;
  }

  for (const root of verificationExecutableSearchPath(options.additionalRoots, options.path)) {
    const candidate = join(root, raw);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
};

/**
 * What argv[0] executes: a path as declared (a relative one against the cwd), or a bare name found
 * in the daemon-built search path, system and daemon directories first, so a repository's file of
 * the same name never shadows an installed tool. `resolvedPath` is its realpath, the binary that
 * actually runs, which the launch binds to (`verificationLaunchArgv`). Any executable file is
 * allowed; one that cannot be found is refused.
 */
export const resolveVerificationExecutable = (
  argv0: string,
  options: VerificationExecutableResolutionOptions = {},
): VerificationExecutableResolution => {
  const candidate = candidateFor(argv0, options);
  const resolvedPath = candidate ? canonicalPath(candidate) : null;
  return { name: executableName(argv0), resolvedPath, allowed: resolvedPath !== null };
};

/** Shared contract/sandbox refusal predicate: argv[0] does not lead to an executable file. */
export const isVerificationCommandRefused = (
  argv: readonly string[],
  options: VerificationExecutableResolutionOptions = {},
): boolean => !resolveVerificationExecutable(argv[0] ?? "", options).allowed;

export const verificationExecutableRefusalMessage = (
  argv: readonly string[],
  options: VerificationExecutableResolutionOptions = {},
): string => {
  const resolution = resolveVerificationExecutable(argv[0] ?? "", options);
  return `verification executable '${resolution.name || "<empty>"}' does not lead to an executable file` +
    ` (resolved path: ${resolution.resolvedPath ?? "unresolved"})`;
};

const isPortableRelativePath = (value: string): boolean => {
  if (value === ".") return true;
  if (
    value.length === 0 ||
    value.startsWith("~") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value)
  ) return false;
  const parts = value.split(/[\\/]/);
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

export const parseVerificationCommand = (input: unknown): VerificationCommand =>
  verificationCommandSchema.parse(input);
