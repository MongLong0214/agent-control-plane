import { z } from "zod";

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
  })
  .strict()
  .superRefine((cmd, ctx) => {
    // Integration §12 — no shell, no pipes, no redirection, no substitution.
    const head = cmd.argv[0] ?? "";
    if (/^(sh|bash|zsh|fish|dash|cmd|powershell|pwsh)$/.test(head)) {
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
    if (cmd.cwd.startsWith("/") || cmd.cwd.includes("..")) {
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

export const parseVerificationCommand = (input: unknown): VerificationCommand =>
  verificationCommandSchema.parse(input);
