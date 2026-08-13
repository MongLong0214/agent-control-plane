import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  /**
   * Which mechanism bounded memory. `hard` is a kernel address-space limit the candidate
   * cannot raise; `observed` is the RSS sampling below, used where the kernel does not
   * honour RLIMIT_AS (Darwin). `none` means neither mechanism was established, and can
   * therefore never accompany a passing outcome. Recorded because a reader of this evidence
   * must be able to tell the difference — the CPU and process-count limits are hard in both
   * cases.
   */
  memoryLimit: "hard" | "observed" | "none";
  childContainmentEnforced: boolean;
  mechanism: "seatbelt" | "none";
}

const SAFE_NODE_ENV = new Set(["development", "test", "production"]);
const SAFE_BOOLEAN_ENV = new Set(["0", "1"]);
/** Only these non-authority values may cross into a verification process. */
const SAFE_COMMAND_ENV: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["NODE_ENV", (value) => SAFE_NODE_ENV.has(value)],
  ["NO_COLOR", (value) => SAFE_BOOLEAN_ENV.has(value)],
  ["FORCE_COLOR", (value) => SAFE_BOOLEAN_ENV.has(value)],
  ["TZ", (value) => /^[A-Za-z0-9_+\-/]{1,64}$/.test(value)],
]);
// A harmless name cannot turn an authority-shaped value into sandbox input.
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^nsec1[a-z0-9]{20,}$/,
  /^xox[baprs]-/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z0-9+/]{60,}={0,2}$/,
];
const RESOURCE_WRAPPER = "/usr/bin/python3";

/*
 * The wrapper is trusted control-plane code, not candidate-provided shell. It lowers
 * both soft and hard limits before exec so candidate code cannot raise them again.
 * RLIMIT_NPROC=1 makes a new session/process group impossible: the initial command is
 * already its own group leader, and a detached descendant would require a fork first.
 *
 * The address-space limit is passed as 0 on hosts whose kernel does not honour
 * RLIMIT_AS (Darwin accepts the call and then ignores it, so `getrlimit` never confirms
 * it). Refusing every verification on such a host would not be caution — it would make
 * the only supported platform unable to verify anything — so the caller decides, and the
 * outcome records which memory bound was actually in force. CPU and process-count limits
 * are hard requirements everywhere and still fail closed.
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
    address_space = int(sys.argv[2])
    if address_space > 0:
        hard_limit(resource.RLIMIT_AS, address_space)
except Exception as error:
    print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
    sys.exit(125)

os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
`;

/**
 * Darwin's `setrlimit(RLIMIT_AS, …)` succeeds and has no effect, so a hard address-space
 * bound cannot be established there. Where it cannot, the RSS observation below is the
 * memory bound and the outcome says so rather than claiming a limit it does not have. The
 * hard-address-space backend is unavailable only on Darwin.
 */
export const memoryLimitForPlatform = (
  platform: NodeJS.Platform = process.platform,
): "hard" | "observed" => (platform === "darwin" ? "observed" : "hard");

const hardAddressSpaceAvailable = (): boolean => memoryLimitForPlatform() === "hard";

const RSS_SAMPLE_INTERVAL_MS = 100;

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
  const hardMemoryLimit = hardAddressSpaceAvailable();
  const resourceArgs = [
    "-c",
    RESOURCE_WRAPPER_PROGRAM,
    String(command.maxCpuSeconds ?? command.timeoutSeconds),
    String(hardMemoryLimit ? command.maxMemoryMb * 1024 * 1024 : 0),
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
  // Start both probes at once. A successful command can legitimately disappear before
  // `ps -o lstart` returns; that loses only the fenced signalling handle, not a recorded
  // RSS observation or the later process-group containment proof.
  const identityAttempt = processIdentity(child.pid);
  let identity: ProcessIdentity | null = null;
  let timedOut = false;
  // Not knowing the leader's start time only costs us the ability to *signal* the group by
  // a fenced identity; containment itself is proven after the run by the group listing.
  let isolationLost = false;
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

  let peakRssMb: number | null = null;
  let memoryLimitExceeded = false;
  let sampling = false;
  let inFlightRssSample: Promise<void> | null = null;

  const sampleRss = (): Promise<void> => {
    if (sampling) return inFlightRssSample ?? Promise.resolve();
    if (closed) return Promise.resolve();

    sampling = true;
    const sample = (async () => {
      try {
        const rss = await groupRssMb(child.pid);
        if (rss === null) return;

        peakRssMb = Math.max(peakRssMb ?? 0, rss);
        if (rss <= command.maxMemoryMb || memoryLimitExceeded) return;

        // RSS is the Darwin memory boundary, so crossing it is a resource-limit breach,
        // not a generic command failure. Reap the entire candidate process group at once.
        memoryLimitExceeded = true;
        const killed = await killKnownGroup(identity, "SIGKILL");
        if (!killed && !closed) isolationLost = true;
      } catch {
        // A missing sample remains null and the PASS gate below refuses to claim observation.
      }
    })();
    inFlightRssSample = sample;
    void sample.then(() => {
      sampling = false;
      if (inFlightRssSample === sample) inFlightRssSample = null;
    });
    return sample;
  };

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

  // Sample immediately so a short command has evidence too, then retain the peak for the
  // whole process-group lifetime. A command that cannot be sampled is not eligible to pass.
  await sampleRss();
  identity = await identityAttempt;
  const memoryPoll = setInterval(() => {
    void sampleRss();
  }, RSS_SAMPLE_INTERVAL_MS);
  memoryPoll.unref();

  const exit = await exitPromise;

  closed = true;
  clearTimeout(timer);
  if (escalation) clearTimeout(escalation);
  clearInterval(memoryPoll);
  if (inFlightRssSample) await inFlightRssSample;
  if (!(await processGroupReaped(child.pid, identity?.startedAt ?? null))) isolationLost = true;
  rmSync(scratch, { recursive: true, force: true });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const endedAt = new Date().toISOString();

  const resourceUnavailable = exit.code === 125 && stderr.includes("ACP_RESOURCE_LIMIT_UNAVAILABLE:");
  const resourceExceeded = exit.signal === "SIGXCPU";
  // The RSS sample is the memory evidence. A leader identity is needed only to signal a
  // live group; requiring it here makes a cleanly reaped, fast command impossible to pass.
  const memoryLimitObserved = !resourceUnavailable && !hardMemoryLimit && peakRssMb !== null;
  const memoryEvidenceUnavailable =
    peakRssMb === null || (!hardMemoryLimit && !memoryLimitObserved);
  const status: SandboxOutcome["status"] =
    isolationLost || resourceUnavailable || resourceExceeded || memoryLimitExceeded
      ? "ERROR"
      : timedOut
        ? "TIMEOUT"
        : exit.code === 0
          ? memoryEvidenceUnavailable ? "ERROR" : "PASS"
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
      // A hard address-space limit still needs an RSS sample for auditable peak evidence.
      resourceLimitsEnforced:
        !resourceUnavailable && peakRssMb !== null && (hardMemoryLimit || memoryLimitObserved),
      memoryLimit: resourceUnavailable ? "none" : hardMemoryLimit ? "hard" : memoryLimitObserved ? "observed" : "none",
      childContainmentEnforced: !isolationLost,
      mechanism,
    },
    reasonCode: isolationLost
      ? ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED
      : resourceUnavailable
        ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
        : resourceExceeded || memoryLimitExceeded
          ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED
          : exit.code === 0 && memoryEvidenceUnavailable
            ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
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
    const accepts = SAFE_COMMAND_ENV.get(name);
    const value = extra?.[name];
    if (!accepts || value === undefined) continue;
    if (looksLikeCredential(value) || !accepts(value)) continue;
    env[name] = value;
  }
  return env;
};

const looksLikeCredential = (value: string): boolean =>
  CREDENTIAL_VALUE_SHAPES.some((pattern) => pattern.test(value.trim()));

/**
 * Named locations a candidate command must never read. Seatbelt retains allow-default
 * reads for dyld and the Node toolchain, so these absolute denies—not HOME redirection
 * alone—protect provider, GitHub, Buzz and Telegram authority stores.
 */
export const sensitiveReadPaths = (extra: readonly string[]): string[] => {
  // A candidate can call os.userInfo().homedir(), which reads the passwd entry rather
  // than HOME. Cover that account home as well as an explicitly configured daemon HOME.
  const homes = [...new Set([homedir(), process.env["HOME"]].filter((home): home is string => Boolean(home)))];
  const homePaths = homes.flatMap((home) => [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gh`,
    `${home}/.config/git/credentials`,
    `${home}/.config/gcloud`,
    `${home}/.claude`,
    `${home}/.codex`,
    `${home}/.buzz`,
    `${home}/.agent-control-plane`,
    `${home}/.npmrc`,
    `${home}/.netrc`,
    `${home}/.gitconfig`,
    `${home}/.git-credentials`,
    `${home}/.docker/config.json`,
    `${home}/Library/Keychains`,
    `${home}/Library/Application Support/Code`,
    `${home}/Library/Application Support/GitHub CLI`,
  ]);
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
    memoryLimit: "none",
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

/**
 * A close event alone is not enough: an unreaped process group makes PASS impossible.
 *
 * The group is named by its leader's pid, and `startedAt` fences a reused pid — while the
 * leader is still the process we launched, the group is by definition not reaped. A leader
 * we never managed to snapshot is *not* evidence of a leak: a command that exits in
 * milliseconds is gone before `ps` can describe it, so the group listing is the evidence.
 *
 * `ps -g` exits 1 with no output when nothing matches, which is exactly the answer "this
 * group is empty". Any other failure leaves containment unproven, and CP-HI-08 makes that
 * a refusal rather than an assumption.
 */
const processGroupReaped = async (
  pid: number | undefined,
  startedAt: string | null,
): Promise<boolean> => {
  if (!pid) return false;
  if (startedAt !== null) {
    const current = await processIdentity(pid);
    if (current && current.startedAt === startedAt) return false;
  }
  try {
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" });
    return stdout.trim().length === 0;
  } catch (err) {
    const failure = err as { code?: number; stdout?: string };
    return failure.code === 1 && (failure.stdout ?? "").trim().length === 0;
  }
};

/** Summed resident set size of the entire candidate process group, in MB. */
const groupRssMb = async (pid: number | undefined): Promise<number | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "rss=", "-g", String(pid)], { encoding: "utf8" });
    const rssPages = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value));
    if (rssPages.length === 0) return null;
    return rssPages.reduce((total, value) => total + value, 0) / 1024;
  } catch {
    return null;
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
