import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import { isWithin } from "../guard/workspace-probe.ts";

const exec = promisify(execFile);

export interface SandboxRequest {
  command: VerificationCommand;
  /** Disposable worktree the command runs in. Nothing outside it is writable. */
  worktreePath: string;
  /** Extra environment values, filtered through the command's own allowlist. */
  env?: Record<string, string>;
  /**
   * Additional absolute paths the candidate must not read — the control plane's own
   * secret store and state directory, and any other checkout on this machine.
   */
  denyReadPaths?: readonly string[];
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
  /**
   * How reads are restricted. `sensitive-paths` is a deny list, not a whitelist: a
   * whitelist cannot be expressed for a Node toolchain, because dyld needs a set of
   * paths that is not enumerable in advance — denying reads wholesale aborts the
   * interpreter before it starts. So the credential stores are named and denied, and this
   * field says exactly that rather than claiming full read isolation.
   */
  readConfinement: "sensitive-paths" | "none";
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

/**
 * Credential shapes recognised in a *value*.
 *
 * A name blacklist can always be sidestepped — `PROVIDER_TOKEN`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, `GH_ENTERPRISE_TOKEN` are all names nobody enumerated. What
 * a credential looks like is far more stable than what it is called.
 */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^nsec1[a-z0-9]{20,}$/,
  /^xox[baprs]-/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z0-9+/]{60,}={0,2}$/, // long opaque base64 blobs
];

export const looksLikeSecretValue = (value: string): boolean =>
  SECRET_VALUE_SHAPES.some((pattern) => pattern.test(value.trim()));

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

  // Integration §12 allows `allowlist`, but seatbelt cannot express per-host network
  // policy. Claiming to honour a host allowlist while permitting all traffic would be a
  // silent downgrade, so it is refused until a mechanism that can enforce it exists.
  if (command.network === "allowlist") {
    rmSync(scratch, { recursive: true, force: true });
    return unconfined(
      command,
      startedMs,
      startedAt,
      mechanism,
      "network=allowlist cannot be enforced by the available mechanism",
    );
  }

  // Confinement is required for every command, not only when the network must be denied:
  // an unconfined command can also write anywhere and read any file this user can.
  if (mechanism === "none") {
    rmSync(scratch, { recursive: true, force: true });
    return unconfined(
      command,
      startedMs,
      startedAt,
      mechanism,
      "sandbox confinement mechanism unavailable; refusing to run unconfined",
    );
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
            seatbeltProfile(
              command,
              realpathSync(worktreePath),
              realpathSync(scratch),
              request.denyReadPaths ?? [],
            ),
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
      readConfinement: mechanism === "seatbelt" ? "sensitive-paths" : "none",
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
    if (value === undefined) continue;
    // A name nobody blacklisted is no reason to pass a credential through.
    if (looksLikeSecretValue(value)) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!command.envAllowlist.includes(name)) continue;
    if (isForbiddenEnvName(name) || looksLikeSecretValue(value)) continue;
    env[name] = value;
  }

  for (const [name, value] of Object.entries(env)) {
    if (isForbiddenEnvName(name) || (value !== undefined && looksLikeSecretValue(value))) {
      delete env[name];
    }
  }
  return env;
};

/**
 * Paths a toolchain must be able to read to run at all: the interpreter, system
 * libraries, and the dyld cache. Everything else — the owner's home, other checkouts,
 * `~/.config/gh`, `.npmrc` — stays unreadable.
 */
/**
 * Locations a candidate command must never read. §33.3 requires provider, GitHub, Buzz
 * and Telegram secrets to be out of reach; redirecting HOME only defeats lookup by
 * convention, so the real stores are denied by absolute path as well.
 */
const sensitiveReadPaths = (extra: readonly string[]): string[] => {
  const home = process.env["HOME"] ?? "";
  const homePaths = home
    ? [
        `${home}/.ssh`,
        `${home}/.aws`,
        `${home}/.gnupg`,
        `${home}/.config/gh`,
        `${home}/.config/gcloud`,
        `${home}/.claude`,
        `${home}/.codex`,
        `${home}/.buzz`,
        `${home}/.agent-control-plane`,
        `${home}/.npmrc`,
        `${home}/.netrc`,
        `${home}/.gitconfig`,
        `${home}/.git-credentials`,
        `${home}/Library/Keychains`,
        `${home}/Library/Application Support/Code`,
      ]
    : [];
  // seatbelt matches resolved paths, so an unresolved symlinked path (a temp dir under
  // /var/folders, say) would silently match nothing and the deny would be a no-op.
  return [...homePaths, ...extra].filter(Boolean).map(resolveIfPossible);
};

const resolveIfPossible = (path: string): string => {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
};

/**
 * Seatbelt profile.
 *
 * Reads are denied by default and re-allowed only for the worktree, the scratch root and
 * the system paths above. §33.3 requires the candidate not to reach provider, GitHub,
 * Buzz or Telegram secrets, and redirecting HOME only defeats *lookup by convention* —
 * an absolute path to the owner's credential store would still have worked.
 */
const seatbeltProfile = (
  command: VerificationCommand,
  worktreePath: string,
  scratch: string,
  denyReadPaths: readonly string[],
): string => {
  const lines = ["(version 1)", "(allow default)"];
  if (command.network === "deny") lines.push("(deny network*)");

  // A deny path that contains the worktree or the scratch root would stop the command
  // from reading its own inputs. Such a path is a configuration mistake, not a policy.
  for (const path of sensitiveReadPaths(denyReadPaths)) {
    if (isWithin(path, worktreePath) || isWithin(path, scratch)) continue;
    lines.push(`(deny file-read* (subpath ${quote(path)}))`);
  }

  lines.push(
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(worktreePath)}))`,
    `(allow file-write* (subpath ${quote(scratch)}))`,
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
  );
  return lines.join("\n");
};

/** Shared shape for a command that was refused rather than run unconfined. */
const unconfined = (
  command: VerificationCommand,
  startedMs: number,
  startedAt: string,
  mechanism: SandboxEnforcement["mechanism"],
  reason: string,
): SandboxOutcome => ({
  status: "ERROR",
  exitCode: null,
  signal: null,
  startedAt,
  endedAt: new Date().toISOString(),
  durationMs: Date.now() - startedMs,
  stdout: "",
  stderr: reason,
  outputDigest: sha256(""),
  outputTruncated: false,
  peakRssMb: null,
  enforcement: {
    worktreeIsolated: true,
    secretsStripped: true,
    networkPolicy: command.network,
    networkEnforced: false,
    writeConfinement: false,
    readConfinement: "none",
    processGroupKill: true,
    mechanism,
  },
  reasonCode: ReasonCode.SANDBOX_NETWORK_DENIED,
});

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
