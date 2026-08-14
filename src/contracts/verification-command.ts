import { z } from "zod";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * The single canonical VerificationCommand schema (PRD §17.2, Integration §12).
 *
 * Both systems share this shape and there is exactly one implementation of it — a
 * second, subtly different copy is forbidden by Integration §2.2.
 */
export const verificationCommandSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "command id must be kebab-case"),
    argv: z.array(z.string().min(1)).min(1),
    repositoryRole: z.string().min(1).default("primary"),
    cwd: z.string().default("."),
    timeoutSeconds: z.number().int().positive().max(24 * 3600).default(1200),
    envAllowlist: z.array(z.string()).default([]),
    // `allowlist` is retained in the wire union solely to return an explicit migration
    // error for old manifests. Seatbelt cannot enforce a destination allowlist, so it is
    // not a production-supported network contract until a proxy/firewall backend exists.
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
  .strict()
  .superRefine((cmd, ctx) => {
    // Integration §12 — refuse a contract that directly names a shell, launcher, pipe,
    // redirection or substitution. This is defence in depth against a contract that
    // declares a shell, not a claim that an allowlisted interpreter cannot execute one.
    if (isVerificationCommandRefused(cmd.argv)) {
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
 * predicate keeps the check above as a lint on contract intent, not a claim about code an
 * allowlisted interpreter may execute after it starts.
 */
const isSafeLiteral = (arg: string): boolean => /^[^`\n;|&]*$/.test(arg) && !arg.includes("$(");

/**
 * The only executables a committed verification contract may launch directly.
 *
 * This is intentionally an allowlist of product-supported tools. It is defence in depth:
 * it refuses a contract that declares `sh`, `env`, `arch` or another non-build executable,
 * but it is not the execution boundary. `node`, `npm`, `npx` and `vitest` are themselves
 * general-purpose interpreters, so an allowlisted interpreter can still execute a shell.
 * The confinement boundary is the sandbox applied after this contract check.
 */
export const ALLOWED_VERIFICATION_EXECUTABLES: ReadonlySet<string> = new Set([
  "node",
  "npm",
  "pnpm",
  "npx",
  "tsc",
  "vitest",
  "eslint",
  "git",
]);

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
  /** Repository/toolchain roots available to the sandbox. */
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

const permittedRootPaths = (
  options: VerificationExecutableResolutionOptions,
): string[] => {
  const searchPath = verificationExecutableSearchPath(options.additionalRoots, options.path);
  const runtimePath = canonicalPath(process.execPath);
  const roots = [
    ...SYSTEM_EXECUTABLE_ROOTS,
    ...searchPath,
    ...(options.additionalRoots ?? []),
    ...(options.cwd ? [options.cwd] : [process.cwd()]),
    ...(runtimePath ? [dirname(runtimePath), dirname(dirname(runtimePath))] : []),
  ];

  // Package-manager shims are commonly symlinks from a `bin` directory into their
  // installation prefix. Permit the real target in that prefix while retaining the
  // executable allowlist below.
  for (const root of searchPath) {
    if (basename(root).toLowerCase() === "bin") roots.push(dirname(root));
  }

  return uniquePaths(
    roots.map((root) => canonicalPath(root) ?? resolve(nativePath(root))),
  );
};

const pathIsWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const candidateFor = (
  value: string,
  options: VerificationExecutableResolutionOptions,
): string | null => {
  const raw = nativePath(value);
  const hasPath = raw.includes(sep) || /^[A-Za-z]:[\\/]/.test(value);
  if (hasPath) {
    const candidate = isAbsolute(raw) ? raw : resolve(nativePath(options.cwd ?? process.cwd()), raw);
    return isExecutableFile(candidate) ? candidate : null;
  }

  for (const root of verificationExecutableSearchPath(options.additionalRoots, options.path)) {
    const candidate = join(root, raw);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
};

const allowedTargetPaths = (
  options: VerificationExecutableResolutionOptions,
): ReadonlySet<string> => {
  const targets = new Set<string>();
  for (const name of ALLOWED_VERIFICATION_EXECUTABLES) {
    for (const root of verificationExecutableSearchPath(options.additionalRoots, options.path)) {
      const candidate = join(root, name);
      if (!isExecutableFile(candidate)) continue;
      const target = canonicalPath(candidate);
      if (target) targets.add(target);
    }
  }
  return targets;
};

/** Resolve first, then apply the defence-in-depth allowlist and real-path checks. */
export const resolveVerificationExecutable = (
  argv0: string,
  options: VerificationExecutableResolutionOptions = {},
): VerificationExecutableResolution => {
  const candidate = candidateFor(argv0, options);
  const resolvedPath = candidate ? canonicalPath(candidate) : null;
  const roots = permittedRootPaths(options);
  const inPermittedRoot = resolvedPath !== null && roots.some((root) => pathIsWithin(resolvedPath, root));
  // The allowlist has to be decided on what will actually execute, not on what the caller
  // called it. Checking `executableName(argv0)` meant a file *named* `node` whose realpath is
  // `/bin/sh` satisfied the name half, while the target being in `/bin` satisfied the
  // permitted-root half — so a symlink restored exactly the launcher form P1-15 was filed
  // for. Both halves now describe the resolved binary.
  const resolvedName = resolvedPath !== null ? executableName(resolvedPath) : null;
  const namedAllowed = resolvedName !== null && ALLOWED_VERIFICATION_EXECUTABLES.has(resolvedName);
  const targetAllowed = resolvedPath !== null && allowedTargetPaths(options).has(resolvedPath);
  return {
    name: executableName(argv0),
    resolvedPath,
    allowed: resolvedPath !== null && inPermittedRoot && (namedAllowed || targetAllowed),
  };
};

/** Shared contract/sandbox refusal predicate; it is not the candidate-code boundary. */
export const isVerificationCommandRefused = (
  argv: readonly string[],
  options: VerificationExecutableResolutionOptions = {},
): boolean => !resolveVerificationExecutable(argv[0] ?? "", options).allowed;

export const verificationExecutableRefusalMessage = (
  argv: readonly string[],
  options: VerificationExecutableResolutionOptions = {},
): string => {
  const resolution = resolveVerificationExecutable(argv[0] ?? "", options);
  return `verification executable '${resolution.name || "<empty>"}' is not on the verification executable allowlist` +
    ` (resolved path: ${resolution.resolvedPath ?? "unresolved"}; allowlist is defence in depth,` +
    ` not a boundary against shell execution by an allowlisted interpreter)`;
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
