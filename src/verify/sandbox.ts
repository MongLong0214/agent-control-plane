import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";

const exec = promisify(execFile);

export interface SandboxRequest {
  command: VerificationCommand;
  /** Disposable worktree the command runs in. Nothing outside it is writable. */
  worktreePath: string;
  /** Extra environment values, filtered through the command's own allowlist. */
  env?: Record<string, string>;
}

export interface SandboxOutcome {
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputDigest: string;
  outputTruncated: boolean;
  peakRssMb: number | null;
  enforcement: SandboxEnforcement;
  reasonCode: string | null;
}

export interface SandboxEnforcement {
  worktreeIsolated: true;
  secretsStripped: true;
  networkPolicy: VerificationCommand["network"];
  networkEnforced: boolean;
  writeConfinement: boolean;
  processGroupKill: true;
  mechanism: "seatbelt" | "none";
}

/**
 * Environment variables that must never reach a candidate command (PRD §17.4,
 * §33.3, Integration §15). The sandbox builds its environment from an allowlist, so
 * this list is a second, explicit assertion rather than the primary defence.
 */
const FORBIDDEN_ENV = [
  /GITHUB.*TOKEN/i,
  /^GH_TOKEN$/i,
  /^GITHUB_/i,
  /BUZZ_/i,
  /TELEGRAM_/i,
  /ANTHROPIC_/i,
  /OPENAI_/i,
  /XAI_/i,
  /_API_KEY$/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^ACP_TRUSTED_/i,
];

export const isForbiddenEnvName = (name: string): boolean =>
  FORBIDDEN_ENV.some((pattern) => pattern.test(name));

const seatbeltAvailable = (): boolean => existsSync("/usr/bin/sandbox-exec");

/**
 * Runs one verification command under the isolation PRD §17.4 requires.
 *
 * On macOS the confinement is enforced by seatbelt (`sandbox-exec`): network is
 * denied at the syscall layer and writes are confined to the disposable worktree plus
 * the scratch root. Where that mechanism is unavailable the run fails closed with
 * SANDBOX_NETWORK_DENIED instead of quietly executing unconfined — CP-HI-08 forbids
 * reporting a weaker execution as a pass.
 */
export const runSandboxed = async (request: SandboxRequest): Promise<SandboxOutcome> => {
  const { command, worktreePath } = request;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "acp-sbx-"));

  const mechanism: SandboxEnforcement["mechanism"] = seatbeltAvailable() ? "seatbelt" : "none";
  const needsConfinement = command.network !== "allow";

  if (mechanism === "none" && needsConfinement) {
    rmSync(scratch, { recursive: true, force: true });
    const endedAt = new Date().toISOString();
    return {
      status: "ERROR",
      exitCode: null,
      signal: null,
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      stdout: "",
      stderr: "sandbox confinement mechanism unavailable; refusing to run unconfined",
      outputDigest: sha256(""),
      outputTruncated: false,
      peakRssMb: null,
      enforcement: {
        worktreeIsolated: true,
        secretsStripped: true,
        networkPolicy: command.network,
        networkEnforced: false,
        writeConfinement: false,
        processGroupKill: true,
        mechanism,
      },
      reasonCode: ReasonCode.SANDBOX_NETWORK_DENIED,
    };
  }

  const env = buildEnv(command, scratch, request.env);
  const cwd = join(worktreePath, command.cwd === "." ? "" : command.cwd);

  // seatbelt matches on resolved paths — on macOS the temp root is a symlink
  // (/var/folders -> /private/var/folders), so an unresolved path would confine the
  // command to a directory it can never reach and every write would fail.
  const { file, argv } =
    mechanism === "seatbelt"
      ? {
          file: "/usr/bin/sandbox-exec",
          argv: [
            "-p",
            seatbeltProfile(command, realpathSync(worktreePath), realpathSync(scratch)),
            ...command.argv,
          ],
        }
      : { file: command.argv[0]!, argv: command.argv.slice(1) };

  const child = spawn(file, argv, {
    cwd,
    env,
    detached: true, // own process group so the timeout can reap the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  const maxBytes = command.maxOutputBytes;
  let outBytes = 0;
  let truncated = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const collect = (chunks: string[]) => (buf: Buffer) => {
    if (truncated) return;
    outBytes += buf.length;
    if (outBytes > maxBytes) {
      truncated = true;
      chunks.push(buf.toString("utf8").slice(0, Math.max(0, maxBytes - (outBytes - buf.length))));
      killGroup(child.pid, "SIGKILL");
      return;
    }
    chunks.push(buf.toString("utf8"));
  };

  child.stdout?.on("data", collect(stdoutChunks));
  child.stderr?.on("data", collect(stderrChunks));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, "SIGTERM");
    setTimeout(() => killGroup(child.pid, "SIGKILL"), 5_000).unref();
  }, command.timeoutSeconds * 1000);

  let peakRssMb: number | null = null;
  const memPoll = setInterval(() => {
    void groupRssMb(child.pid).then((rss) => {
      if (rss == null) return;
      peakRssMb = Math.max(peakRssMb ?? 0, rss);
      if (rss > command.maxMemoryMb) killGroup(child.pid, "SIGKILL");
    });
  }, 500);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", () => resolve({ code: null, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  clearTimeout(timer);
  clearInterval(memPoll);
  killGroup(child.pid, "SIGKILL"); // §17.4 child cleanup — orphans do not survive the run
  rmSync(scratch, { recursive: true, force: true });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const endedAt = new Date().toISOString();

  const status: SandboxOutcome["status"] = timedOut
    ? "TIMEOUT"
    : exit.code === 0
      ? "PASS"
      : exit.code == null
        ? "ERROR"
        : "FAIL";

  return {
    status,
    exitCode: exit.code,
    signal: exit.signal,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    stdout,
    stderr,
    outputDigest: sha256(`${stdout}\u0000${stderr}`),
    outputTruncated: truncated,
    peakRssMb,
    enforcement: {
      worktreeIsolated: true,
      secretsStripped: true,
      networkPolicy: command.network,
      networkEnforced: mechanism === "seatbelt" && command.network === "deny",
      writeConfinement: mechanism === "seatbelt",
      processGroupKill: true,
      mechanism,
    },
    reasonCode: timedOut
      ? ReasonCode.VERIFICATION_TIMEOUT
      : truncated
        ? ReasonCode.VERIFICATION_OUTPUT_TRUNCATED
        : null,
  };
};

/**
 * The environment is constructed, never inherited. HOME and TMPDIR point into the
 * scratch root so a candidate cannot read ~/.gitconfig, ~/.npmrc, ~/.claude or any
 * other credential store through a tool's normal lookup path.
 */
const buildEnv = (
  command: VerificationCommand,
  scratch: string,
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: scratch,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    LC_ALL: "C",
    CI: "true",
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const name of command.envAllowlist) {
    if (isForbiddenEnvName(name)) continue; // an allowlist cannot re-admit a secret
    const value = extra?.[name] ?? process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (command.envAllowlist.includes(name) && !isForbiddenEnvName(name)) env[name] = value;
  }

  for (const name of Object.keys(env)) {
    if (isForbiddenEnvName(name)) delete env[name];
  }
  return env;
};

/** Seatbelt profile: writes confined to the worktree and scratch, network per policy. */
const seatbeltProfile = (
  command: VerificationCommand,
  worktreePath: string,
  scratch: string,
): string => {
  const lines = ["(version 1)", "(allow default)"];
  if (command.network === "deny") lines.push("(deny network*)");
  lines.push(
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(worktreePath)}))`,
    `(allow file-write* (subpath ${quote(scratch)}))`,
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
  );
  return lines.join("\n");
};

const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already reaped */
    }
  }
};

/** Summed RSS of the whole process group, in MB. */
const groupRssMb = async (pid: number | undefined): Promise<number | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "rss=", "-g", String(pid)], { encoding: "utf8" });
    const total = stdout
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0);
    return total / 1024;
  } catch {
    return null;
  }
};
