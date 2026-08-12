import { z } from "zod";
import { basename } from "node:path";

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
    network: z.enum(["deny", "allowlist", "allow"]).default("deny"),
    networkAllowlist: z.array(z.string()).default([]),
    required: z.boolean().default(true),
    evidenceMode: z.enum(["LOCAL_COMMAND", "TRUSTED_CI", "BOTH_REQUIRED"]).default("LOCAL_COMMAND"),
    maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).default(1024 * 1024),
    maxMemoryMb: z.number().int().positive().max(65536).default(4096),
    /** Absent means the command timeout is also its hard CPU budget. */
    maxCpuSeconds: z.number().int().positive().max(24 * 3600).optional(),
  })
  .strict()
  .superRefine((cmd, ctx) => {
    // Integration §12 — no shell, no pipes, no redirection, no substitution.
    const head = executableName(cmd.argv[0] ?? "");
    if (SHELL_INTERPRETERS.has(head) || envLaunchesShell(cmd.argv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `shell interpreter '${head}' is not an allowed verification command`,
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
    if (cmd.network === "allowlist" && cmd.networkAllowlist.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "network=allowlist requires a non-empty networkAllowlist",
        path: ["networkAllowlist"],
      });
    }
  });

export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

/**
 * A handful of arguments legitimately contain `$` or `>` (a jest name filter, a
 * version range). They are safe precisely because there is no shell — this predicate
 * exists so the check above stays a lint on intent rather than a false blocker.
 */
const isSafeLiteral = (arg: string): boolean => /^[^`\n;|&]*$/.test(arg) && !arg.includes("$(");

const SHELL_INTERPRETERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

const executableName = (value: string): string =>
  basename(value.replaceAll("\\", "/")).toLowerCase();

const envLaunchesShell = (argv: readonly string[]): boolean => {
  if (executableName(argv[0] ?? "") !== "env") return false;
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value === "-u" || value === "--unset") {
      i += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return SHELL_INTERPRETERS.has(executableName(value));
  }
  return false;
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
