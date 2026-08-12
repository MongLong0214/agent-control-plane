import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  resourceLimitsEnforced: boolean;
  childContainmentEnforced: boolean;
  mechanism: "seatbelt" | "none";
}

/** Only these non-authority values may cross into a verification process. */
const SAFE_COMMAND_ENV = new Set(["NODE_ENV", "NO_COLOR", "FORCE_COLOR", "TZ"]);
const SAFE_NODE_ENV = new Set(["development", "test", "production"]);
const SAFE_BOOLEAN_ENV = new Set(["0", "1"]);
const RESOURCE_WRAPPER = "/usr/bin/python3";

/*
 * The wrapper is trusted control-plane code, not candidate-provided shell. It lowers
 * both soft and hard limits before exec so candidate code cannot raise them again.
 * RLIMIT_NPROC=1 makes a new session/process group impossible: the initial command is
 * already its own group leader, and a detached descendant would require a fork first.
 */
const RESOURCE_WRAPPER_PROGRAM = String.raw`
import os, resource, sys

def hard_limit(kind, value):
    soft, hard = resource.getrlimit(kind)
    if soft > value:
        resource.setrlimit(kind, (value, hard))
    resource.setrlimit(kind, (value, value))
    if resource.getrlimit(kind) != (value, value):
        raise RuntimeError("limit was not applied")

try:
    hard_limit(resource.RLIMIT_CPU, int(sys.argv[1]))
    hard_limit(resource.RLIMIT_NPROC, 1)
    hard_limit(resource.RLIMIT_AS, int(sys.argv[2]))
except Exception as error:
    print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
    sys.exit(125)

os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
`;

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

  const env = buildSandboxEnvironment(command, scratch, request.env);
  const targets = resolveCommandTargets(command, worktreePath);
  if (!targets.allowed) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(command, startedMs, startedAt, mechanism, targets.reasonCode, targets.reason);
  }
  if (!existsSync(RESOURCE_WRAPPER)) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(
      command,
      startedMs,
      startedAt,
      mechanism,
      ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE,
      "resource-limit wrapper is unavailable",
    );
  }

  // seatbelt matches on resolved paths — on macOS the temp root is a symlink
  // (/var/folders -> /private/var/folders), so an unresolved path would confine the
  // command to a directory it can never reach and every write would fail.
  const resourceArgs = [
    "-c",
    RESOURCE_WRAPPER_PROGRAM,
    String(command.maxCpuSeconds ?? command.timeoutSeconds),
    String(command.maxMemoryMb * 1024 * 1024),
    ...command.argv,
  ];
  const file = "/usr/bin/sandbox-exec";
  const argv = [
    "-p",
    seatbeltProfile(command, targets.worktree, realpathSync(scratch), request.denyReadPaths ?? []),
    RESOURCE_WRAPPER,
    ...resourceArgs,
  ];

  const child = spawn(file, argv, {
    cwd: targets.cwd,
    env,
    detached: true, // own process group so the timeout can reap the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.on("error", () => resolveExit({ code: null, signal: null }));
      child.on("close", (code, signal) => resolveExit({ code, signal }));
    },
  );
  const identity = await processIdentity(child.pid);
  let timedOut = false;
  let isolationLost = identity === null;
  let escalation: NodeJS.Timeout | undefined;
  let closed = false;

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
      void killKnownGroup(identity, "SIGKILL").then((killed) => {
        if (!killed) isolationLost = true;
      });
      return;
    }
    chunks.push(buf.toString("utf8"));
  };

  child.stdout?.on("data", collect(stdoutChunks));
  child.stderr?.on("data", collect(stderrChunks));

  const timer = setTimeout(() => {
    timedOut = true;
    void killKnownGroup(identity, "SIGTERM").then((killed) => {
      if (!killed) isolationLost = true;
      if (closed) return;
      escalation = setTimeout(() => {
        void killKnownGroup(identity, "SIGKILL").then((forced) => {
          if (!forced) isolationLost = true;
        });
      }, 5_000);
      escalation.unref();
    });
  }, command.timeoutSeconds * 1000);

  const exit = await exitPromise;

  closed = true;
  clearTimeout(timer);
  if (escalation) clearTimeout(escalation);
  if (identity && !(await processGroupReaped(identity))) isolationLost = true;
  rmSync(scratch, { recursive: true, force: true });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const endedAt = new Date().toISOString();

  const resourceUnavailable = exit.code === 125 && stderr.includes("ACP_RESOURCE_LIMIT_UNAVAILABLE:");
  const resourceExceeded = exit.signal === "SIGXCPU";
  const status: SandboxOutcome["status"] =
    isolationLost || resourceUnavailable || resourceExceeded
      ? "ERROR"
      : timedOut
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
    peakRssMb: null,
    enforcement: {
      worktreeIsolated: true,
      secretsStripped: true,
      networkPolicy: command.network,
      networkEnforced: mechanism === "seatbelt" && command.network === "deny",
      writeConfinement: mechanism === "seatbelt",
      readConfinement: mechanism === "seatbelt" ? "sensitive-paths" : "none",
      processGroupKill: true,
      resourceLimitsEnforced: !resourceUnavailable,
      childContainmentEnforced: !isolationLost,
      mechanism,
    },
    reasonCode: isolationLost
      ? ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED
      : resourceUnavailable
        ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
        : resourceExceeded
          ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED
          : timedOut
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
export const buildSandboxEnvironment = (
  command: VerificationCommand,
  scratch: string,
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
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
    if (!SAFE_COMMAND_ENV.has(name)) continue;
    const value = extra?.[name];
    if (value === undefined || !safeEnvironmentValue(name, value)) continue;
    env[name] = value;
  }
  return env;
};

const safeEnvironmentValue = (name: string, value: string): boolean =>
  (name === "NODE_ENV" && SAFE_NODE_ENV.has(value)) ||
  ((name === "NO_COLOR" || name === "FORCE_COLOR") && SAFE_BOOLEAN_ENV.has(value)) ||
  (name === "TZ" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value));

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
): SandboxOutcome => refused(
  command,
  startedMs,
  startedAt,
  mechanism,
  ReasonCode.SANDBOX_NETWORK_DENIED,
  reason,
);

const refused = (
  command: VerificationCommand,
  startedMs: number,
  startedAt: string,
  mechanism: SandboxEnforcement["mechanism"],
  reasonCode: ReasonCode,
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
    resourceLimitsEnforced: false,
    childContainmentEnforced: false,
    mechanism,
  },
  reasonCode,
});

const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

const processIdentity = async (pid: number | undefined): Promise<ProcessIdentity | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const startedAt = stdout.trim();
    return startedAt ? { pid, startedAt } : null;
  } catch {
    return null;
  }
};

/** Signals only the process group whose leader still has the identity we observed. */
const killKnownGroup = async (
  identity: ProcessIdentity | null,
  signal: NodeJS.Signals,
): Promise<boolean> => {
  if (!identity) return false;
  const current = await processIdentity(identity.pid);
  if (!current || current.startedAt !== identity.startedAt) return false;
  try {
    process.kill(-identity.pid, signal);
    return true;
  } catch {
    return false;
  }
};

/** A close event alone is not enough: an unreaped process group makes PASS impossible. */
const processGroupReaped = async (identity: ProcessIdentity): Promise<boolean> => {
  const current = await processIdentity(identity.pid);
  if (current && current.startedAt === identity.startedAt) return false;
  try {
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(identity.pid)], {
      encoding: "utf8",
    });
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
};

type TargetResolution =
  | { allowed: true; worktree: string; cwd: string }
  | { allowed: false; reasonCode: ReasonCode; reason: string };

/** Canonical path checks stop committed symlinks from retargeting a verification command. */
const resolveCommandTargets = (
  command: VerificationCommand,
  worktreePath: string,
): TargetResolution => {
  try {
    const worktree = realpathSync(worktreePath);
    const cwd = realpathSync(resolve(worktree, command.cwd));
    if (!isWithin(worktree, cwd)) {
      return {
        allowed: false,
        reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
        reason: "verification cwd resolves outside the disposable worktree",
      };
    }

    for (const arg of command.argv) {
      const explicitPath = isAbsolute(arg) || arg.startsWith("./") || arg.startsWith("../");
      const localTarget = !arg.startsWith("-") && existsSync(resolve(cwd, arg));
      if (!explicitPath && !localTarget) continue;
      const target = realpathSync(isAbsolute(arg) ? arg : resolve(cwd, arg));
      if (!isWithin(worktree, target)) {
        return {
          allowed: false,
          reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
          reason: `verification target '${arg}' resolves outside the disposable worktree`,
        };
      }
    }
    return { allowed: true, worktree, cwd };
  } catch (error) {
    return {
      allowed: false,
      reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
      reason: `unable to resolve verification target: ${(error as Error).message}`,
    };
  }
};
