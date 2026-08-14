import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  ClaudeUsageCollector,
  CodexUsageCollector,
  GrokUsageCollector,
  type UsageCollector,
} from "../capacity/usage-collectors.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";
import {
  type CapacityReading,
  type ManagedInvocationWrite,
  type ManagedInvocationWriteBroker,
  type InvocationRequest,
  type InvocationResult,
  type ProviderAdapter,
  ProviderSessionProvisionError,
  REVIEWER_EGRESS_DENY_PROBE_ENDPOINTS,
  type ReviewerEgressConfig,
  type ReviewerEgressProbe,
  type ReviewerEgressRecord,
  type SessionHandle,
  type SessionSpec,
  extractJson,
} from "./provider.ts";
import {
  acquireReviewerEgress,
  ReviewerEgressError,
  type EgressProbes,
  type ReviewerEgressLease,
} from "./reviewer-egress.ts";

export interface CliAdapterOptions {
  clock: Clock;
  /**
   * Daemon-owned capacity mirror path. Kept for doctor compatibility and deny-path
   * confinement; shipped adapters never treat a human-edited file as a capacity source.
   */
  capacityFile: string;
  /** How long a reading stays usable before new allocation is suspended (§14.3). */
  freshnessWindowMs?: number;
  binary?: string;
  /** Explicit non-authority variables a runtime invocation may inherit. */
  environmentAllowlist?: readonly string[];
  /** Control-plane paths that a runtime process must not read or write. */
  denyReadPaths?: readonly string[];
  /**
   * CP-HI-01 composition for a writable runtime. Omitting this is safe: non-read-only
   * invocations are refused rather than inheriting write access to their workdir.
   */
  managedWriteBroker?: ManagedInvocationWriteBroker;
  /**
   * A credential store this deployment provisioned for the provider. Its presence is what
   * makes closing the host keychain possible rather than self-defeating: on macOS the
   * provider's own login and the host's other secrets share one store, so denying it without
   * an alternative stops every session authenticating (measured: `claude --print` answers
   * "Not logged in", and dispatch then fails SESSION_NOT_READY).
   */
  providerCredentialDir?: string;
  /** Dependency-injection seam for a real /usage collector; production supplies one below. */
  usageCollector?: UsageCollector;
  /** Observations beyond this lead are not valid freshness evidence. */
  maxClockSkewMs?: number;
  /**
   * Daemon-owned provider-only reviewer egress. The adapter never reads an owner's
   * allowlist directly: this configuration only points at the profile/proxy and the
   * runtime generates a fresh provider-specific allowlist for each invocation.
   */
  reviewerEgress?: ReviewerEgressConfig;
}

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** Tools a read-only invocation must not have. Denied by name, not by permission mode. */
const DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Grep",
  "Glob",
  "Task",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
];

const resolveExecutable = (binary: string): string => {
  if (binary.includes("/")) {
    try {
      return realpathSync(binary);
    } catch {
      return binary;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching; an unavailable configured binary is reported by the probe.
    }
  }
  return binary;
};

/**
 * Provider executables are resolved before the child environment is constructed, so an
 * invocation does not need to inherit the daemon's general-purpose tool path. In
 * particular, keeping `gh` out of PATH prevents a provider tool call from acquiring the
 * daemon's GitHub identity by convention. Direct paths remain subject to the seatbelt's
 * credential-store denials below.
 */
const agentPath = (): string => {
  const directories = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(directories.filter((directory) => {
    try {
      accessSync(join(directory, "gh"), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  }))].join(":");
};

/**
 * Legacy mirror parser retained for migration/doctor fixtures. Production CLI adapters
 * collect interactive provider usage instead; this function must not become a fallback
 * after a failed live collection.
 */
export const readCapacityFile = (
  provider: string,
  file: string,
  clock: Clock,
  freshnessMs: number,
  maxClockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): CapacityReading => {
  const base = {
    provider,
    observedAt: clock.nowIso(),
    buckets: [] as CapacityReading["buckets"],
    source: `structured-local-file:${file}`,
  };

  if (!existsSync(file)) {
    return {
      ...base,
      sensorHealth: "ERROR",
      runtimeHealth: "UNKNOWN",
      error: "capacity file not present",
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      observedAt?: string;
      runtimeHealth?: CapacityReading["runtimeHealth"];
      buckets?: CapacityReading["buckets"];
    };
    // A file with no timestamp is not evidence of freshness; substituting "now" would
    // make a static file fresh forever (§14.3).
    if (!parsed.observedAt) {
      return { ...base, sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", error: "no observedAt" };
    }
    const observedAt = parsed.observedAt;
    const observedMs = new Date(observedAt).getTime();
    if (!Number.isFinite(observedMs)) {
      return {
        ...base,
        sensorHealth: "ERROR",
        runtimeHealth: "UNKNOWN",
        error: `unparsable observedAt: ${observedAt}`,
      };
    }
    const ageMs = new Date(clock.nowIso()).getTime() - observedMs;
    const buckets = (parsed.buckets ?? []).map((bucket) => ({
      id: String(bucket.id),
      remainingPercent:
        typeof bucket.remainingPercent === "number" ? bucket.remainingPercent : null,
      resetAt: bucket.resetAt ?? null,
      capabilities: Array.isArray(bucket.capabilities) ? bucket.capabilities.map(String) : [],
    }));

    if (buckets.length === 0) {
      return { ...base, sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", error: "no buckets" };
    }
    if (ageMs < -maxClockSkewMs) {
      return {
        ...base,
        sensorHealth: "ERROR",
        runtimeHealth: "UNKNOWN",
        error: `observedAt exceeds clock-skew allowance by ${-ageMs}ms`,
      };
    }
    return {
      ...base,
      // A small permitted clock lead is normalized before it reaches persistence. This
      // prevents one future-dated row from masking all observations until that date.
      observedAt: ageMs < 0 ? clock.nowIso() : observedAt,
      buckets,
      sensorHealth: ageMs > freshnessMs ? "STALE" : "HEALTHY",
      // A quota file says nothing about whether the CLI runs. When the file does not
      // state runtime health, it is unknown and must be probed, not assumed.
      runtimeHealth: parsed.runtimeHealth ?? "UNKNOWN",
    };
  } catch (err) {
    return {
      ...base,
      sensorHealth: "ERROR",
      runtimeHealth: "UNKNOWN",
      error: (err as Error).message,
    };
  }
};


/**
 * A settings file the control plane owns, so a managed session runs no code the daemon did
 * not sanction.
 *
 * The provider CLI reads *hooks* — arbitrary shell commands — from the operator's own
 * settings. Two problems, one measured: unsanctioned code executes inside a managed session,
 * and a hook whose binary is not on the agent's restricted PATH makes the CLI exit non-zero,
 * which the review gate correctly reads as "no verdict" and the whole run stops at
 * REVIEW_UNAVAILABLE. Replacing the config directory is not an option — OAuth is bound to it
 * on this platform, and pointing it elsewhere answers "Not logged in" — so the settings are
 * overridden instead, which leaves authentication untouched.
 */
const sanctionedSettingsFile = (scratch: string): string => {
  const file = join(scratch, "acp-settings.json");
  writeFileSync(file, JSON.stringify({ hooks: {}, enabledPlugins: {} }), { mode: 0o600 });
  return file;
};

/**
 * macOS rejects nested `sandbox-exec` applications, so the owner egress profile and the
 * generated packet profile are composed into one per-invocation file. The resulting child
 * still has the required `sandbox-exec -f … env HTTPS_PROXY=…` shape; its rules are the
 * union of the independently checked owner boundary and the packet-only denials.
 */
const reviewerSandboxArgs = (
  profile: string,
  file: string,
  args: readonly string[],
  egress?: ReviewerEgressLease,
  composedProfilePath?: string,
): string[] => {
  if (!egress) return ["-p", profile, file, ...args];
  if (!composedProfilePath) {
    throw new Error("reviewer egress invocation is missing its composed Seatbelt profile");
  }
  return [
      "-f",
      composedProfilePath,
      "/usr/bin/env",
      `HTTPS_PROXY=${egress.proxyUrl}`,
      file,
      ...args,
    ];
};

/**
 * Seatbelt profiles are conjunctions, but `sandbox-exec` cannot apply one profile from
 * inside another on current macOS. Keep the owner profile's bytes intact and append only
 * the generated profile's rules after stripping its duplicate header/default declaration.
 */
const composeReviewerProfile = (ownerProfileText: string, packetProfile: string): string => {
  const ownerProfile = ownerProfileText.trimEnd();
  const packetRules = packetProfile
    .split("\n")
    .filter((line) => !/^\s*\(version\s+1\)\s*$/.test(line) && !/^\s*\(allow\s+default\)\s*$/.test(line));
  return `${ownerProfile}\n${packetRules.join("\n")}\n`;
};

const killChildTree = (child: ReturnType<typeof spawn>): void => {
  try {
    process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const productionRunCli = async (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    stdin?: string;
    environmentAllowlist?: readonly string[];
    denyReadPaths?: readonly string[];
    providerCredentialDir?: string;
    writablePaths?: readonly string[];
    /** Strict packet-only reviewer boundary, distinct from normal agent containment. */
    isolation?: NonNullable<InvocationRequest["isolation"]>;
    /** Provider state the reviewer CLI must read to authenticate, never inherited wholesale. */
    reviewerCredentialPaths?: readonly string[];
    /** Provider config root used while HOME points at the packet directory. */
    reviewerConfigDirectory?: string;
    /** A provider-specific reviewer environment, constructed rather than inherited. */
    reviewerEnvironment?: NodeJS.ProcessEnv;
    /** Extra provider runtime executables required by a reviewed invocation. */
    reviewerExecutablePaths?: readonly string[];
    /** Daemon-owned egress infrastructure for this packet-only reviewer process. */
    reviewerEgress?: ReviewerEgressConfig;
    /** Provider whose compiled endpoint set generates the proxy allowlist. */
    reviewerProvider?: string;
    /** Handshake and verdict processes produce separately labelled JSONL records. */
    reviewerEgressPhase?: ReviewerEgressRecord["phase"];
  },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  isolationEnforced: boolean;
  egressEvidence?: ReviewerEgressRecord[];
}> => {
  const scratch = mkdtempSync(join(tmpdir(), "acp-runtime-"));
  if (!existsSync("/usr/bin/sandbox-exec")) {
    rmSync(scratch, { recursive: true, force: true });
    return {
      stdout: "",
      stderr: "runtime filesystem confinement is unavailable; refusing unconfined CLI execution",
      exitCode: null,
      timedOut: false,
      isolationEnforced: false,
    };
  }
  let egress: ReviewerEgressLease | null = null;
  const abandonEgress = async (): Promise<void> => {
    const active = egress;
    egress = null;
    if (active) await active.abandon();
  };
  try {
    const workdir = realpathSync(options.cwd);
    if (options.isolation) {
      assertReviewerIsolation(workdir, options.isolation, options.reviewerCredentialPaths ?? []);
    }
    const isolated = options.isolation !== undefined;
    if (isolated) {
      if (!options.reviewerProvider) {
        throw new ReviewerEgressError(
          "REVIEWER_EGRESS_CONFIG_MISSING",
          "packet-only reviewer invocation did not name its provider for egress policy generation",
        );
      }
      egress = await acquireReviewerEgress(options.reviewerEgress, options.reviewerProvider);
    }

    const environment: NodeJS.ProcessEnv = isolated
      ? { ...(options.reviewerEnvironment ?? reviewerEnvironment(workdir, options.reviewerConfigDirectory)) }
      : runtimeEnvironment(options.environmentAllowlist ?? [], realpathSync(scratch), options.providerCredentialDir);
    if (egress) {
      // The child receives only the loopback proxy route. Do not let a caller-supplied
      // environment retain an alternate proxy, no-proxy escape hatch, or credentials.
      delete environment.HTTP_PROXY;
      delete environment.http_proxy;
      delete environment.HTTPS_PROXY;
      delete environment.https_proxy;
      delete environment.ALL_PROXY;
      delete environment.all_proxy;
      delete environment.NO_PROXY;
      delete environment.no_proxy;
      environment.HTTPS_PROXY = egress.proxyUrl;
    }
    const profile = isolated
      ? reviewerProfile(
          workdir,
          options.isolation!.denyReadPaths,
          file,
          options.reviewerCredentialPaths ?? [],
          options.reviewerExecutablePaths ?? [],
          egress?.port,
        )
      : runtimeProfile(
          workdir,
          realpathSync(scratch),
          options.denyReadPaths ?? [],
          options.writablePaths ?? [],
          options.providerCredentialDir,
        );
    const composedProfilePath = isolated && egress
      ? join(scratch, "reviewer-composed.sb")
      : undefined;
    if (composedProfilePath && egress) {
      writeFileSync(composedProfilePath, composeReviewerProfile(egress.profileText, profile), { mode: 0o600 });
    }

    // sandbox-exec accepting a profile only says its syntax parsed. A reviewer may attest
    // isolation only after live probes prove the requested transcript, no-tools and the
    // three egress facts on this invocation. In particular, a cached proxy health check or
    // an allow-default profile is not evidence that the boundary actually bit.
    let egressProbes: EgressProbes | null = null;
    if (isolated) {
      const isolation = await proveReviewerIsolation(
        profile,
        workdir,
        environment,
        options.isolation!,
        args,
        options.timeoutMs,
        egress!,
        composedProfilePath,
      );
      if (!isolation.enforced) {
        await abandonEgress();
        rmSync(scratch, { recursive: true, force: true });
        return {
          stdout: "",
          stderr: isolation.reason,
          exitCode: null,
          timedOut: false,
          isolationEnforced: false,
        };
      }
      if (!isolation.egressProbes) {
        await abandonEgress();
        rmSync(scratch, { recursive: true, force: true });
        return {
          stdout: "",
          stderr: "REVIEWER_EGRESS_LOG_INVALID: provider-only probes did not return evidence",
          exitCode: null,
          timedOut: false,
          isolationEnforced: false,
        };
      }
      egressProbes = isolation.egressProbes;
    }

    const execution = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
      egressLost: boolean;
    }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("/usr/bin/sandbox-exec", reviewerSandboxArgs(
          profile,
          file,
          args,
          egress ?? undefined,
          composedProfilePath,
        ), {
          cwd: workdir,
          env: environment,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null, timedOut: false, egressLost: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let egressLost = false;
      let settled = false;
      const stopWatchingEgress = egress?.onDeath(() => {
        egressLost = true;
        killChildTree(child);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, options.timeoutMs);
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopWatchingEgress?.();
        resolve({ stdout, stderr, exitCode, timedOut, egressLost });
      };
      child.stdout?.on("data", (buffer: Buffer) => (stdout += buffer.toString("utf8")));
      child.stderr?.on("data", (buffer: Buffer) => (stderr += buffer.toString("utf8")));
      if (options.stdin !== undefined) child.stdin?.write(options.stdin);
      child.stdin?.end();
      child.on("error", (error) => {
        stderr += error.message;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });

    if (!isolated) {
      rmSync(scratch, { recursive: true, force: true });
      return { ...execution, isolationEnforced: false };
    }
    if (execution.egressLost || !egressProbes) {
      await abandonEgress();
      rmSync(scratch, { recursive: true, force: true });
      return {
        ...execution,
        stderr: execution.egressLost
          ? "REVIEWER_EGRESS_PROXY_DIED: reviewer process was stopped when its egress proxy died"
          : "REVIEWER_EGRESS_LOG_INVALID: reviewer egress probes were not retained",
        isolationEnforced: false,
      };
    }

    const activeEgress = egress;
    egress = null;
    if (!activeEgress) {
      rmSync(scratch, { recursive: true, force: true });
      return {
        ...execution,
        stderr: "REVIEWER_EGRESS_LOG_INVALID: reviewer egress lease disappeared before evidence capture",
        isolationEnforced: false,
      };
    }
    try {
      const evidence = await activeEgress.finalise(options.reviewerEgressPhase ?? "reviewer-invocation", egressProbes);
      rmSync(scratch, { recursive: true, force: true });
      return {
        ...execution,
        isolationEnforced: true,
        egressEvidence: [evidence],
      };
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      return {
        ...execution,
        stderr: error instanceof Error ? error.message : String(error),
        isolationEnforced: false,
      };
    }
  } catch (error) {
    await abandonEgress();
    rmSync(scratch, { recursive: true, force: true });
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut: false,
      isolationEnforced: false,
    };
  }
};

// The production path always uses productionRunCli. This narrow test-only seam lets the
// provider-session contract be regression-tested without weakening or faking the live
// reviewer isolation probes themselves.
let runCli: typeof productionRunCli = productionRunCli;

interface ProfileCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Run a tiny, real child under precisely the profile the reviewer would receive. */
const runProfileCommand = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  egress?: ReviewerEgressLease,
  composedProfilePath?: string,
): Promise<ProfileCommandResult> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/sandbox-exec", reviewerSandboxArgs(profile, file, args, egress, composedProfilePath), {
        cwd,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, exitCode: null, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, Math.min(Math.max(timeoutMs, 1), 5_000));
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

const profileAccepted = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  egress?: ReviewerEgressLease,
  composedProfilePath?: string,
): Promise<{ accepted: boolean; stderr: string; exitCode: number | null; timedOut: boolean }> => {
  // Reviewer profiles deny arbitrary process execution. `process.execPath` is the one
  // runtime executable they explicitly permit, so it is the meaningful syntax/liveness
  // probe rather than `/usr/bin/true`, which the no-tools profile should refuse.
  const result = await runProfileCommand(
    profile,
    cwd,
    environment,
    process.execPath,
    ["-e", "process.exit(0)"],
    timeoutMs,
    egress,
    composedProfilePath,
  );
  return {
    accepted: result.exitCode === 0 && !result.timedOut,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
};

type IsolationProbe =
  | { enforced: true; egressProbes?: EgressProbes }
  | { enforced: false; reason: string };

const reviewerToolContractPresent = (args: readonly string[]): boolean => {
  const mode = args.indexOf("--permission-mode");
  const denied = args.indexOf("--disallowedTools");
  if (mode !== -1 && args[mode + 1] === "plan" && denied !== -1) {
    const configured = new Set((args[denied + 1] ?? "").split(",").filter(Boolean));
    return DENIED_TOOLS.every((tool) => configured.has(tool));
  }
  // Codex has no equivalent model-facing --tools=none switch for `exec`. Its reviewer
  // path therefore combines a provider-recognised read-only sandbox with an exact
  // host-profile no-shell/no-write proof, and refuses if any of those command controls
  // disappear. The profile probe below is the enforcement; these flags are the required
  // provider-side half of that contract.
  const isCodexExec = args[0] === "exec";
  const readOnly = args.some((arg) => arg === 'sandbox_mode="read-only"') ||
    args.some((arg, index) => arg === "-s" && args[index + 1] === "read-only");
  return isCodexExec &&
    args.includes("--json") &&
    args.includes("--strict-config") &&
    args.includes("--ignore-user-config") &&
    args.includes("--ignore-rules") &&
    args.includes("--skip-git-repo-check") &&
    readOnly;
};

const reviewerTranscriptRoots = (): string[] => {
  const homes = [...new Set([homedir(), process.env["HOME"]].filter((home): home is string => Boolean(home)))];
  return homes.flatMap((home) => [`${home}/.claude`, `${home}/.codex`]);
};

const parseProbe = (text: string): Record<string, unknown> | null => safeParse(text.trim());

const probeDeniedTranscriptPaths = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  packetRoot: string,
  denyReadPaths: readonly string[],
  timeoutMs: number,
  egress?: ReviewerEgressLease,
  composedProfilePath?: string,
): Promise<IsolationProbe> => {
  const paths = [...new Set([...denyReadPaths, ...reviewerTranscriptRoots()].map(resolvePath))]
    .filter((path) => path && path !== packetRoot && !path.startsWith(`${packetRoot}/`));
  const existing: Array<{ path: string; kind: "directory" | "file" }> = [];
  for (const path of paths) {
    try {
      existing.push({ path, kind: lstatSync(path).isDirectory() ? "directory" : "file" });
    } catch {
      // An absent transcript cannot demonstrate a denial. At least one real requested path
      // must be probeable below; otherwise the adapter refuses to attest.
    }
  }
  if (existing.length === 0) {
    return { enforced: false, reason: "reviewer isolation has no existing transcript path to probe" };
  }

  const source = [
    "const fs = require('node:fs');",
    "const [target, kind] = process.argv.slice(1);",
    "try {",
    "  if (kind === 'directory') fs.readdirSync(target); else fs.readFileSync(target);",
    "  process.stdout.write(JSON.stringify({ denied: false }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ denied: error && (error.code === 'EPERM' || error.code === 'EACCES'), code: error && error.code }));",
    "}",
  ].join("\n");
  for (const target of existing) {
    const result = await runProfileCommand(
      profile,
      cwd,
      environment,
      process.execPath,
      ["-e", source, target.path, target.kind],
      timeoutMs,
      egress,
      composedProfilePath,
    );
    const observation = parseProbe(result.stdout);
    if (result.exitCode !== 0 || result.timedOut || observation?.["denied"] !== true) {
      return {
        enforced: false,
        reason: `reviewer transcript denial probe did not bite for ${target.path}: ${
          result.stderr || result.stdout || "no denial observed"
        }`,
      };
    }
  }
  return { enforced: true };
};

const probeNoTools = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  packetRoot: string,
  timeoutMs: number,
  egress?: ReviewerEgressLease,
  composedProfilePath?: string,
): Promise<IsolationProbe> => {
  // A model-facing denylist alone cannot stop a malicious Bash tool. The actual profile
  // denies all process execution except the provider and Node runtimes, so prove a shell
  // cannot start under this very profile.
  const shell = await runProfileCommand(
    profile,
    cwd,
    environment,
    "/bin/sh",
    ["-c", "exit 0"],
    timeoutMs,
    egress,
    composedProfilePath,
  );
  if (shell.exitCode === 0 || shell.timedOut) {
    return { enforced: false, reason: "reviewer no-tools probe could execute a shell" };
  }

  const writeTarget = join(dirname(packetRoot), `.acp-review-write-probe-${randomUUID()}`);
  const source = [
    "const fs = require('node:fs');",
    "try {",
    "  fs.writeFileSync(process.argv[1], 'probe');",
    "  process.stdout.write(JSON.stringify({ denied: false }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ denied: error && (error.code === 'EPERM' || error.code === 'EACCES'), code: error && error.code }));",
    "}",
  ].join("\n");
  const write = await runProfileCommand(
    profile,
    cwd,
    environment,
    process.execPath,
    ["-e", source, writeTarget],
    timeoutMs,
    egress,
    composedProfilePath,
  );
  const observation = parseProbe(write.stdout);
  const escapedWrite = existsSync(writeTarget);
  // If a boundary failure created the exact probe file, remove only that uniquely-created
  // target before returning the denial. It is never a caller-provided path.
  if (escapedWrite) rmSync(writeTarget, { force: true });
  if (write.exitCode !== 0 || write.timedOut || observation?.["denied"] !== true || escapedWrite) {
    return { enforced: false, reason: "reviewer no-tools probe could write outside the packet" };
  }
  return { enforced: true };
};

/**
 * Proves the provider-only network boundary under the exact composed profile that will run
 * the reviewer. The proxy returns 200 only after it has opened the allowlisted remote host;
 * it must return 403 for a real public host outside the generated provider allowlist. Direct Node sockets
 * explicitly remove/override HTTPS_PROXY and must still receive the seatbelt errno.
 */
const probeProviderOnlyNetwork = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  egress: ReviewerEgressLease,
  composedProfilePath: string | undefined,
): Promise<IsolationProbe> => {
  const proxySource = [
    "const net = require('node:net');",
    "const [proxyHost, proxyPort, target] = process.argv.slice(1);",
    "let done = false;",
    "const finish = (value) => { if (done) return; done = true; process.stdout.write(JSON.stringify(value)); process.exit(0); };",
    "const socket = net.connect({ host: proxyHost, port: Number(proxyPort) });",
    "socket.setTimeout(3000, () => { socket.destroy(); finish({ connected: false, timeout: true }); });",
    "socket.once('connect', () => socket.write(`CONNECT ${target}:443 HTTP/1.1\\r\\nHost: ${target}:443\\r\\n\\r\\n`));",
    "let response = '';",
    "socket.on('data', (chunk) => {",
    "  response += chunk.toString('latin1');",
    "  if (!response.includes('\\r\\n\\r\\n')) return;",
    "  const statusCode = Number(/^HTTP\\/1\\.[01]\\s+(\\d{3})/.exec(response)?.[1] || 0);",
    "  socket.destroy(); finish({ connected: statusCode === 200, statusCode });",
    "});",
    "socket.once('error', (error) => finish({ connected: false, errorCode: error && error.code }));",
  ].join("\n");
  const directSource = [
    "const net = require('node:net');",
    "const [proxyMode, target] = process.argv.slice(1);",
    "if (proxyMode === 'unset') delete process.env.HTTPS_PROXY;",
    "else process.env.HTTPS_PROXY = 'http://127.0.0.1:1';",
    "let done = false;",
    "const finish = (value) => { if (done) return; done = true; process.stdout.write(JSON.stringify(value)); process.exit(0); };",
    "const socket = net.connect({ host: target, port: 443 });",
    "socket.setTimeout(3000, () => { socket.destroy(); finish({ connected: false, timeout: true }); });",
    "socket.once('connect', () => { socket.destroy(); finish({ connected: true }); });",
    "socket.once('error', (error) => finish({ connected: false, errorCode: error && error.code }));",
  ].join("\n");
  const proxyProbe = async (target: string): Promise<ReviewerEgressProbe | null> => {
    const result = await runProfileCommand(
      profile,
      cwd,
      environment,
      process.execPath,
      ["-e", proxySource, "127.0.0.1", String(egress.port), target],
      timeoutMs,
      egress,
      composedProfilePath,
    );
    const observation = parseProbe(result.stdout);
    if (!observation || result.exitCode !== 0 || result.timedOut) return null;
    return {
      host: target,
      connected: observation["connected"] === true,
      statusCode: typeof observation["statusCode"] === "number" ? observation["statusCode"] : null,
      errorCode: typeof observation["errorCode"] === "string" ? observation["errorCode"] : null,
    };
  };
  const directProbe = async (proxyMode: "unset" | "override", target: string): Promise<ReviewerEgressProbe | null> => {
    const result = await runProfileCommand(
      profile,
      cwd,
      environment,
      process.execPath,
      ["-e", directSource, proxyMode, target],
      timeoutMs,
      egress,
      composedProfilePath,
    );
    const observation = parseProbe(result.stdout);
    if (!observation || result.exitCode !== 0 || result.timedOut) return null;
    const errorCode = typeof observation["errorCode"] === "string" ? observation["errorCode"] : null;
    return {
      host: target,
      proxyMode,
      connected: observation["connected"] === true,
      blocked: observation["connected"] !== true && (errorCode === "EPERM" || errorCode === "EACCES"),
      errorCode,
    };
  };

  const providerHost = egress.allowedEndpoints[0];
  if (!providerHost) return { enforced: false, reason: "reviewer egress has no provider endpoint to probe" };
  const allowedEndpoint = await proxyProbe(providerHost);
  if (!allowedEndpoint || allowedEndpoint.connected !== true || allowedEndpoint.statusCode !== 200) {
    return { enforced: false, reason: `allowlisted provider endpoint probe did not reach ${providerHost}` };
  }
  // A syntactically impossible `.invalid` name only proves that DNS or a proxy rejected
  // nonsense. Pick a real external endpoint instead, so an open proxy cannot satisfy this
  // attestation merely by special-casing `.invalid`.
  const generatedAllowlist = new Set(egress.allowedEndpoints.map((host) => host.toLowerCase()));
  const nonAllowlistedHost = REVIEWER_EGRESS_DENY_PROBE_ENDPOINTS.find(
    (host) => !generatedAllowlist.has(host),
  );
  if (!nonAllowlistedHost) {
    return { enforced: false, reason: "reviewer egress has no real non-allowlisted endpoint to probe" };
  }
  const deniedEndpoint = await proxyProbe(nonAllowlistedHost);
  if (!deniedEndpoint || deniedEndpoint.statusCode !== 403) {
    return { enforced: false, reason: `non-allowlisted endpoint probe was not refused for ${nonAllowlistedHost}` };
  }
  deniedEndpoint.denied = true;

  const directSocket = await Promise.all([
    directProbe("unset", providerHost),
    directProbe("override", providerHost),
  ]);
  if (directSocket.some((probe) => !probe || probe.blocked !== true || probe.connected === true)) {
    return {
      enforced: false,
      reason: "direct-socket probe remained reachable after unsetting or overriding HTTPS_PROXY",
    };
  }
  return {
    enforced: true,
    egressProbes: {
      allowedEndpoint,
      deniedEndpoint,
      directSocket: directSocket as ReviewerEgressProbe[],
    },
  };
};

const proveReviewerIsolation = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  isolation: NonNullable<InvocationRequest["isolation"]>,
  args: readonly string[],
  timeoutMs: number,
  egress: ReviewerEgressLease,
  composedProfilePath: string | undefined,
): Promise<IsolationProbe> => {
  if (!reviewerToolContractPresent(args)) {
    return { enforced: false, reason: "reviewer no-tools CLI contract is incomplete" };
  }
  const profileCheck = await profileAccepted(profile, cwd, environment, timeoutMs, egress, composedProfilePath);
  if (!profileCheck.accepted) {
    return {
      enforced: false,
      reason: profileCheck.stderr || "reviewer isolation profile was not accepted",
    };
  }
  const transcripts = await probeDeniedTranscriptPaths(
    profile,
    cwd,
    environment,
    cwd,
    isolation.denyReadPaths,
    timeoutMs,
    egress,
    composedProfilePath,
  );
  if (!transcripts.enforced) return transcripts;
  const tools = await probeNoTools(profile, cwd, environment, cwd, timeoutMs, egress, composedProfilePath);
  if (!tools.enforced) return tools;
  return probeProviderOnlyNetwork(profile, cwd, environment, timeoutMs, egress, composedProfilePath);
};

const assertReviewerIsolation = (
  workdir: string,
  isolation: NonNullable<InvocationRequest["isolation"]>,
  credentialPaths: readonly string[],
): void => {
  if (isolation.emptyEnvironment !== true || isolation.network !== "provider-only" || isolation.tools !== "none") {
    throw new Error("reviewer isolation contract is incomplete");
  }
  if (realpathSync(isolation.packetRoot) !== workdir) {
    throw new Error("reviewer packet root must be the invocation working directory");
  }
  // A provider credential scope inside a normal conversation store would make the profile
  // choose between provider login and producer-history isolation. That is not a trade-off
  // the adapter may silently make: require a dedicated scope or fail the review closed.
  const transcriptRoots = reviewerTranscriptRoots().map(resolvePath);
  for (const credentialPath of credentialPaths.map(resolvePath)) {
    if (transcriptRoots.some((root) => credentialPath === root || credentialPath.startsWith(`${root}/`))) {
      throw new Error("reviewer credential scope overlaps a host transcript store");
    }
  }
};

const AUTHORITY_ENV = [
  /GITHUB.*TOKEN/i,
  /^GH_TOKEN$/i,
  /^GITHUB_/i,
  /^ACP_GITHUB_/i,
  /^BUZZ_/i,
  /^TELEGRAM_/i,
  /^ACP_TRUSTED_/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
];

const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^nsec1[a-z0-9]{20,}$/,
  /^xox[baprs]-/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z0-9+/]{60,}={0,2}$/,
];

const authorityEnvironment = (name: string): boolean => AUTHORITY_ENV.some((pattern) => pattern.test(name));
const looksLikeCredential = (value: string): boolean => SECRET_VALUE_SHAPES.some((pattern) => pattern.test(value.trim()));

/**
 * Constructed, never inherited: an agent CLI receives no daemon authority.
 *
 * What it *does* receive is its own provider identity. An agent session exists in order to
 * authenticate to its provider, and both shipped CLIs read that from the real `HOME`
 * (`~/.claude`, `~/.codex`); pointing HOME at an empty scratch directory does not contain
 * the agent, it stops it from being an agent at all. The daemon's authority is withheld by
 * refusing every authority-shaped variable and every credential-shaped value below, and by
 * confining writes to the scratch and work directories — not by blinding the provider to
 * its own login.
 */
export const runtimeEnvironment = (
  allowlist: readonly string[],
  scratch: string,
  providerCredentialDir?: string,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    PATH: agentPath(),
    HOME: process.env["HOME"] ?? scratch,
    // Both CLIs resolve their own login through the invoking user's keychain, and neither
    // finds it without USER. Measured, not assumed: with HOME alone `claude --print`
    // answers "Not logged in"; with USER added it authenticates.
    ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // This is a provider namespace selector, not a credential. Preserve it so a
    // deployment that provisions a dedicated Claude secure-storage scope does not need
    // the host Keychains directory reopened merely to authenticate its own provider.
    ...(providerCredentialDir ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: providerCredentialDir } : {}),
  };
  for (const name of allowlist) {
    // PATH is a containment control, not a caller-provided convenience variable. The
    // provider executable was already resolved before this environment was constructed.
    if (name === "PATH" || authorityEnvironment(name)) continue;
    const value = process.env[name];
    if (value !== undefined && !looksLikeCredential(value)) environment[name] = value;
  }
  return environment;
};

/**
 * A reviewer gets a disposable home and, when the deployment explicitly supplies one,
 * a dedicated provider credential scope. `CLAUDE_SECURESTORAGE_CONFIG_DIR` makes Claude
 * use that scope's secure-storage namespace; the profile below never grants the daemon's
 * login-keychain files. Keeping USER preserves the CLI's measured login lookup, while
 * the daemon's normal environment and authority-bearing variables remain absent.
 */
export const reviewerEnvironment = (packetRoot: string, configDirectory?: string): NodeJS.ProcessEnv => ({
  PATH: agentPath(),
  // A reviewer is still a provider session: with HOME pointed at the packet root and no
  // scoped credential store, it cannot log in and every review returns EVIDENCE_MISSING —
  // measured on a real run, not inferred. Where the deployment provisioned a scope, the
  // reviewer gets that and nothing else; where it did not, it authenticates the way any
  // other session does. Login availability is not isolation evidence: the runtime still
  // has to prove every requested reviewer boundary before it launches the review.
  HOME: configDirectory ? packetRoot : (process.env["HOME"] ?? packetRoot),
  ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
  TMPDIR: packetRoot,
  LANG: "C.UTF-8",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...(configDirectory ? {
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: configDirectory,
  } : {}),
});

const claudeCredentialPaths = (configDirectory?: string): string[] => {
  if (!configDirectory) return [];
  return [
    configDirectory,
    join(configDirectory, ".credentials.json"),
    join(configDirectory, ".claude.json"),
  ];
};

/**
 * Codex keeps its authenticated session state under CODEX_HOME. A packet reviewer is
 * allowed to use it only when the deployment supplied a dedicated reviewer-only root;
 * pointing it at ~/.codex would make prior producer transcripts readable by the provider
 * CLI before the model even receives its packet.
 */
const codexCredentialPaths = (configDirectory?: string): string[] =>
  configDirectory ? [configDirectory] : [];

const codexReviewerEnvironment = (packetRoot: string, configDirectory: string): NodeJS.ProcessEnv => ({
  PATH: agentPath(),
  HOME: packetRoot,
  CODEX_HOME: configDirectory,
  ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
  TMPDIR: packetRoot,
  LANG: "C.UTF-8",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

/** Credential stores that are daemon authority, not provider identity. */
const hostCredentialPaths = (providerCredentialDir?: string): string[] => {
  const home = process.env["HOME"] ?? "";
  if (!home) return [];
  return [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gh`,
    `${home}/.buzz`,
    `${home}/.agent-control-plane`,
    `${home}/.git-credentials`,
    `${home}/.gitconfig`,
    `${home}/.netrc`,
    // The login keychain is denied only when the deployment gave the provider somewhere else
    // to keep its own credentials. On macOS the provider's login and the host's other secrets
    // live in the same store, so denying it outright does not confine an agent — it stops the
    // agent authenticating at all, and every session then fails SESSION_NOT_READY (measured:
    // `claude --print` answers "Not logged in"). Where a scoped store is configured, the host
    // keychain is closed; where it is not, it stays open and the isolation evidence says so.
    ...(providerCredentialDir ? [`${home}/Library/Keychains`] : []),
  ];
};

/**
 * A provider credential scope the deployment provisioned, if any. Its presence is what makes
 * closing the host keychain possible rather than self-defeating; see `hostCredentialPaths`.
 */
export const scopedProviderCredentials = (): string | null =>
  process.env["ACP_PROVIDER_CREDENTIAL_DIR"] ?? process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ?? null;

const runtimeProfile = (
  workdir: string,
  scratch: string,
  denyReadPaths: readonly string[],
  writablePaths: readonly string[],
  providerCredentialDir?: string,
): string => {
  const sensitive = [
    ...denyReadPaths,
    ...hostCredentialPaths(providerCredentialDir),
  ].map(resolvePath);
  const lines = ["(version 1)", "(allow default)"];
  for (const path of sensitive) {
    if (!path || path === workdir || path.startsWith(`${workdir}/`) || path === scratch || path.startsWith(`${scratch}/`)) continue;
    lines.push(`(deny file-read* (subpath ${quote(path)}))`);
  }
  lines.push(
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(scratch)}))`,
    // `workdir` is intentionally absent. A provider gets a writable checkout only when
    // its particular invocation has passed through the guard-backed broker, and then only
    // for the exact target that broker authorised. A caller cannot regain blanket checkout
    // access merely by choosing `readOnly: false`.
    ...writablePaths.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
  );
  return lines.join("\n");
};

/**
 * The reviewer's confinement. Seatbelt must retain allow-default reads for dyld and Node,
 * so transcript and credential roots are explicit denies and are actively probed before an
 * attestation. The profile also permits only the provider executable and Node runtime to
 * exec; a shell probe confirms that a model cannot turn `Bash` into host process access.
 *
 * When a daemon-owned egress lease is present, this packet profile repeats the owner's
 * remote-TCP/UDP denies and loopback exception. It is composed with independently
 * validated owner-profile bytes before launch, so either missing rule fails the live
 * probes instead of expanding a reviewer's network reach.
 */
const reviewerProfile = (
  packetRoot: string,
  denyReadPaths: readonly string[],
  executable: string,
  credentialPaths: readonly string[],
  additionalExecutables: readonly string[] = [],
  egressPort?: number,
): string => {
  const lines = ["(version 1)", "(allow default)"];
  const sensitive = [
    ...hostCredentialPaths(credentialPaths[0]),
    ...reviewerTranscriptRoots(),
    ...denyReadPaths,
  ];
  for (const path of [...new Set(sensitive)]) {
    const resolved = resolvePath(path);
    if (resolved && resolved !== packetRoot && !resolved.startsWith(`${packetRoot}/`)) {
      lines.push(`(deny file-read* (subpath ${quote(resolved)}))`);
    }
  }
  if (egressPort !== undefined) {
    lines.push(
      "(deny network-outbound (remote tcp))",
      "(deny network-outbound (remote udp))",
      `(allow network-outbound (remote tcp "localhost:${egressPort}"))`,
      "(allow network-outbound (remote unix-socket))",
    );
  }
  // `sandbox-exec` evaluates this profile for the initial exec too. The resolved provider
  // binary and Node are the only executables it may start; all arbitrary tools are denied.
  lines.push("(deny process-exec*)");
  // Some packaged provider CLIs are a small Node launcher followed by a provider-owned
  // native executable. Both are enumerated by the adapter; a broad executable directory
  // or shell allowance would turn a no-tools reviewer into an ordinary local agent.
  for (const allowed of [...new Set([
    resolvePath(executable),
    ...additionalExecutables.map(resolvePath),
    resolvePath(process.execPath),
    "/usr/bin/env",
  ])]) {
    if (allowed) lines.push(`(allow process-exec (literal ${quote(allowed)}))`);
  }
  lines.push(
    // The provider may need packet-local transient state, but it cannot write a checkout,
    // daemon state, transcript or any sibling path. The active no-tools probe tests that
    // this deny/allow boundary really rejects a write outside the packet.
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(packetRoot)}))`,
    '(allow file-write* (subpath "/dev"))',
    '(allow file-write-data (literal "/dev/null"))',
  );
  return lines.join("\n");
};

const resolvePath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

type ManagedWriteScope =
  | { allowed: true; targetPath: string; write: ManagedInvocationWrite }
  | { allowed: false; reason: string };

/**
 * A workdir is an input location, never a blanket write grant. Keep this check beside the
 * sandbox profile so a malformed or cross-checkout authorisation cannot widen the profile
 * before the guard sees it. The task receipt and assigned worktree are the authority;
 * caller-selected workdir is deliberately not used as the write boundary.
 */
const managedWriteScope = (request: InvocationRequest): ManagedWriteScope => {
  if (request.readOnly || request.isolation) {
    return { allowed: false, reason: "a read-only or isolated invocation may not request a managed write" };
  }
  if (!request.managedWrite) {
    return {
      allowed: false,
      reason: "WRITE_REQUIRES_MANAGED_RUN: writable runtime invocation lacks per-effect authorisation",
    };
  }
  try {
    const targetPath = canonical(request.managedWrite.targetPath);
    const assignedWorktreeId = canonical(request.managedWrite.assignedWorktreeId);
    if (!request.managedWrite.taskId || !request.managedWrite.taskReceiptId) {
      return {
        allowed: false,
        reason: "WRITE_REQUIRES_MANAGED_RUN: writable runtime invocation lacks a task receipt",
      };
    }
    if (!isWithin(assignedWorktreeId, targetPath)) {
      return {
        allowed: false,
        reason: "WRITE_TARGET_OUTSIDE_RUN_SCOPE: authorised write target is outside the assigned worktree",
      };
    }
    return {
      allowed: true,
      targetPath,
      write: { ...request.managedWrite, targetPath, assignedWorktreeId },
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `WRITE_REQUIRES_MANAGED_RUN: could not resolve managed write target: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
};

const refusedInvocation = (
  request: InvocationRequest,
  provider: string,
  model: string,
  started: number,
  error: string,
): InvocationResult => ({
  ok: false,
  text: "",
  json: null,
  provider,
  model,
  durationMs: Date.now() - started,
  exitCode: null,
  error,
  providerSessionId: null,
  isolationAttested: false,
  ...(request.isolation ? { isolationReasonCode: ReasonCode.ISOLATION_LOST } : {}),
});

/**
 * Claude Code headless adapter. Used for CTO sessions and, under continuity fallback,
 * for acting CEO and blind reviewer roles (§15.4).
 */
export class ClaudeCliAdapter implements ProviderAdapter {
  readonly provider = "claude";
  readonly isProduction = true;
  readonly supportsReviewerIsolation = true;
  readonly defaultModels = {
    cto: "opus",
    reviewer: "opus",
    worker: "sonnet",
    ceo: "opus",
  } as const;

  readonly #binary: string;
  readonly #clock: Clock;
  readonly #capacityFile: string;
  readonly #freshnessMs: number;
  readonly #maxClockSkewMs: number;
  readonly #environmentAllowlist: readonly string[];
  readonly #denyReadPaths: readonly string[];
  readonly #providerCredentialDir: string | undefined;
  readonly #reviewerEgress: ReviewerEgressConfig | undefined;
  readonly #managedWriteBroker: ManagedInvocationWriteBroker | undefined;
  readonly #usageCollector: UsageCollector;

  constructor(options: CliAdapterOptions) {
    this.#binary = resolveExecutable(options.binary ?? "claude");
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
    this.#providerCredentialDir = options.providerCredentialDir;
    this.#reviewerEgress = options.reviewerEgress;
    this.#managedWriteBroker = options.managedWriteBroker;
    this.#usageCollector = options.usageCollector ?? new ClaudeUsageCollector({
      clock: this.#clock,
      binary: this.#binary,
      providerCredentialDir: this.#providerCredentialDir,
    });
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    // Claude Code is invoked per turn in headless mode; the session id is what makes
    // successive turns one conversation, and a fresh uuid is what makes a session
    // genuinely fresh for CP-HI-04 isolation.
    return {
      externalSessionId: randomUUID(),
      provider: this.provider,
      model: spec.model,
      effort: spec.effort ?? null,
      pid: null,
      workdir: spec.workdir,
    };
  }

  async stopSession(): Promise<void> {
    /* headless invocations own no long-lived process */
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const started = Date.now();
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      request.model ?? this.defaultModels.cto,
    ];
    // Hooks and plugins are the operator's, not this run's; see `sanctionedSettingsFile`.
    args.push("--settings", sanctionedSettingsFile(mkdtempSync(join(tmpdir(), "acp-settings-"))));
    // Make the invocation *be* the constituted session, so the identity the independence
    // check was performed against is the identity that produces the answer.
    if (request.externalSessionId) args.push("--session-id", request.externalSessionId);
    if (request.readOnly || request.isolation) {
      // §18.3 — a blind reviewer judges exactly the inputs it was given. Granting it
      // repository tools invites it to go exploring, which both changes what it saw and
      // turns a single verdict into an open-ended tool loop. Plan mode blocks mutation;
      // the deny list removes the exploration surface entirely.
      args.push(
        "--permission-mode",
        "plan",
        "--disallowedTools",
        DENIED_TOOLS.join(","),
        "--max-budget-usd",
        String(request.maxBudgetUsd ?? 5),
      );
    }
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);

    // The prompt goes over stdin rather than as a positional argument: several of the
    // CLI's options are variadic, and a trailing positional is liable to be swallowed by
    // whichever flag precedes it.
    const execute = (writablePaths: readonly string[], cwd = request.workdir) => runCli(this.#binary, args, {
      cwd,
      timeoutMs: request.timeoutMs,
      stdin: request.prompt,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
      writablePaths,
      isolation: request.isolation,
      reviewerCredentialPaths: request.isolation ? claudeCredentialPaths(this.#providerCredentialDir) : undefined,
      reviewerConfigDirectory: request.isolation
        ? this.#providerCredentialDir
        : undefined,
      reviewerEgress: request.isolation ? this.#reviewerEgress : undefined,
      reviewerProvider: request.isolation ? this.provider : undefined,
      reviewerEgressPhase: request.isolation ? "reviewer-invocation" : undefined,
    });

    let result: Awaited<ReturnType<typeof runCli>>;
    if (request.readOnly || request.isolation) {
      result = await execute([]);
    } else {
      const scope = managedWriteScope(request);
      if (!scope.allowed) {
        return refusedInvocation(request, this.provider, request.model ?? this.defaultModels.cto, started, scope.reason);
      }
      if (!this.#managedWriteBroker) {
        return refusedInvocation(
          request,
          this.provider,
          request.model ?? this.defaultModels.cto,
          started,
          "WRITE_REQUIRES_MANAGED_RUN: this runtime has no guard-backed local-write broker",
        );
      }
      const authorised = await this.#managedWriteBroker.authorize(
        scope.write,
        () => execute([scope.targetPath], scope.write.assignedWorktreeId),
      );
      if (!authorised.allowed) {
        return refusedInvocation(
          request,
          this.provider,
          request.model ?? this.defaultModels.cto,
          started,
          `${authorised.reasonCode}: ${authorised.message}`,
        );
      }
      result = authorised.value;
    }

    const envelope = safeParse(result.stdout);
    const text =
      typeof envelope?.["result"] === "string" ? (envelope["result"] as string) : result.stdout;
    const isolationSucceeded = request.isolation === undefined || result.isolationEnforced;

    return {
      // A provider answer produced after a failed packet boundary is not a successful
      // invocation. Keeping `ok` false matches the attestation result and prevents a
      // caller that forgets the separate field from treating it as usable evidence.
      ok: result.exitCode === 0 && !result.timedOut && isolationSucceeded,
      text,
      json: extractJson(text),
      provider: this.provider,
      model: request.model ?? this.defaultModels.cto,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      error: result.timedOut
        ? "timeout"
        : result.exitCode === 0 && isolationSucceeded
          ? null
          : result.stderr.slice(0, 2000),
      providerSessionId:
        typeof envelope?.["session_id"] === "string" ? (envelope["session_id"] as string) : null,
      isolationAttested: request.isolation !== undefined && result.isolationEnforced,
      isolationReasonCode:
        request.isolation !== undefined && !result.isolationEnforced ? ReasonCode.ISOLATION_LOST : undefined,
      egressEvidence: result.egressEvidence,
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    const result = await runCli(this.#binary, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
    });
    return result.exitCode === 0 && !result.timedOut ? "HEALTHY" : "UNAVAILABLE";
  }

  async probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    if (handle.provider !== this.provider) return "UNAVAILABLE";
    const result = await runCli(this.#binary, [
      "-p", "--output-format", "json", "--model", handle.model, "--session-id", handle.externalSessionId,
    ], {
      cwd: handle.workdir ?? process.cwd(),
      timeoutMs: 30_000,
      stdin: "Reply with READY.",
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
    });
    if (result.exitCode !== 0 || result.timedOut) return "UNAVAILABLE";
    const sessionId = safeParse(result.stdout)?.["session_id"];
    return sessionId !== undefined && sessionId !== handle.externalSessionId ? "DEGRADED" : "HEALTHY";
  }

  async probeCapacity(): Promise<CapacityReading> {
    return resolveRuntimeHealth(
      await this.#usageCollector.collect(),
      () => this.probeRuntime(),
    );
  }
}

/**
 * A quota file cannot vouch for the runtime. When the sensor failed, or the file did not
 * state runtime health, the CLI is probed — otherwise a fresh quota file would mask an
 * unavailable provider.
 */
const resolveRuntimeHealth = async (
  reading: CapacityReading,
  probe: () => Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE">,
): Promise<CapacityReading> => {
  if (reading.sensorHealth === "ERROR" || reading.runtimeHealth === "UNKNOWN") {
    return { ...reading, runtimeHealth: await probe() };
  }
  return reading;
};

const codexThreadId = (output: string): string | null => {
  for (const line of output.split("\n")) {
    const event = safeParse(line);
    if (event?.["type"] === "thread.started" && typeof event["thread_id"] === "string") {
      return event["thread_id"];
    }
  }
  return null;
};

const codexLastAgentMessage = (output: string): string | null => {
  let text: string | null = null;
  for (const line of output.split("\n")) {
    const event = safeParse(line);
    const item = event?.["item"];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record["type"] === "agent_message" && typeof record["text"] === "string") text = record["text"];
  }
  return text;
};

const codexPlatformTriple = (): string | null => {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (process.platform === "linux") return process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  return null;
};

/** Resolve the provider-owned native executable behind the npm launcher, when present. */
const codexReviewerExecutables = (binary: string): string[] => {
  const resolved = resolvePath(binary);
  const triple = codexPlatformTriple();
  if (!triple) return [resolved];
  const packageRoot = dirname(dirname(resolved));
  const target = join(
    packageRoot,
    "node_modules",
    "@openai",
    `codex-${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`,
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  return existsSync(target) ? [resolved, resolvePath(target)] : [resolved];
};

const codexReviewerArgs = (
  action: "bootstrap" | "resume",
  model: string,
  effort: string | null | undefined,
  sessionId?: string,
): string[] => {
  const args = action === "bootstrap"
    ? ["exec"]
    : ["exec", "resume"];
  args.push(
    "--json",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-m",
    model,
    // Resume does not expose --sandbox, so retain the same provider-recognised setting
    // on both turns. --strict-config turns a renamed/unsupported setting into refusal.
    "-c",
    'sandbox_mode="read-only"',
  );
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (action === "bootstrap") args.push("-s", "read-only", "-");
  else if (sessionId) args.push(sessionId, "-");
  return args;
};

/**
 * Codex CLI adapter. Preferred runtime for the blind reviewer (GPT-5.6 Sol at xhigh
 * effort, §18.1) and for mechanical worker tasks.
 */
export class CodexCliAdapter implements ProviderAdapter {
  readonly provider = "gpt";
  readonly isProduction = true;
  readonly supportsReviewerIsolation = true;
  readonly requiresReviewerProviderSessionProof = true;
  readonly supportsReviewerEffortAttestation = true;
  readonly defaultModels = {
    reviewer: "gpt-5.6-sol",
    ceo: "gpt-5.6-sol",
    worker: "gpt-5.6-luna-max",
    cto: "gpt-5.6-sol",
  } as const;

  readonly #binary: string;
  readonly #clock: Clock;
  readonly #capacityFile: string;
  readonly #freshnessMs: number;
  readonly #maxClockSkewMs: number;
  readonly #environmentAllowlist: readonly string[];
  readonly #denyReadPaths: readonly string[];
  readonly #providerCredentialDir: string | undefined;
  readonly #reviewerEgress: ReviewerEgressConfig | undefined;
  readonly #managedWriteBroker: ManagedInvocationWriteBroker | undefined;
  readonly #reviewerSessions = new Map<string, {
    workdir: string;
    model: string;
    effort: string | null;
    bootstrapEgressEvidence: ReviewerEgressRecord[];
  }>();
  readonly #usageCollector: UsageCollector;

  constructor(options: CliAdapterOptions) {
    this.#binary = resolveExecutable(options.binary ?? "codex");
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
    this.#providerCredentialDir = options.providerCredentialDir;
    this.#reviewerEgress = options.reviewerEgress;
    this.#managedWriteBroker = options.managedWriteBroker;
    this.#usageCollector = options.usageCollector ?? new CodexUsageCollector({
      clock: this.#clock,
      binary: this.#binary,
      providerCredentialDir: this.#providerCredentialDir,
    });
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    if (spec.isolation) return this.startPacketReviewerSession(spec);
    return {
      externalSessionId: randomUUID(),
      provider: this.provider,
      model: spec.model,
      effort: spec.effort ?? null,
      pid: null,
      workdir: spec.workdir,
    };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    // The dedicated credential root is deployment-owned and may contain the provider's
    // auth state. Only forget the one freshly constituted reviewer id; the review gate
    // removes its packet root in its own finally block.
    this.#reviewerSessions.delete(handle.externalSessionId);
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const started = Date.now();
    if (request.isolation) {
      return this.invokePacketReviewer(request, started);
    }
    const scratch = mkdtempSync(join(tmpdir(), "acp-codex-"));
    const lastMessage = join(scratch, "last-message.txt");
    const model = request.model ?? this.defaultModels.reviewer;

    const args = ["exec", "-m", model, "--skip-git-repo-check", "-o", lastMessage];
    if (request.effort) args.push("-c", `model_reasoning_effort="${request.effort}"`);
    args.push("-s", request.readOnly ? "read-only" : "workspace-write");
    if (request.responseSchema) {
      const schemaFile = join(scratch, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(request.responseSchema));
      args.push("--output-schema", schemaFile);
    }

    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;

    const execute = (writablePaths: readonly string[], cwd = request.workdir) => runCli(this.#binary, [...args, prompt], {
      cwd,
      timeoutMs: request.timeoutMs,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
      writablePaths,
    });
    let result: Awaited<ReturnType<typeof runCli>>;
    if (request.readOnly) {
      result = await execute([]);
    } else {
      const scope = managedWriteScope(request);
      if (!scope.allowed) {
        rmSync(scratch, { recursive: true, force: true });
        return refusedInvocation(request, this.provider, model, started, scope.reason);
      }
      if (!this.#managedWriteBroker) {
        rmSync(scratch, { recursive: true, force: true });
        return refusedInvocation(
          request,
          this.provider,
          model,
          started,
          "WRITE_REQUIRES_MANAGED_RUN: this runtime has no guard-backed local-write broker",
        );
      }
      const authorised = await this.#managedWriteBroker.authorize(
        scope.write,
        () => execute([scope.targetPath], scope.write.assignedWorktreeId),
      );
      if (!authorised.allowed) {
        rmSync(scratch, { recursive: true, force: true });
        return refusedInvocation(
          request,
          this.provider,
          model,
          started,
          `${authorised.reasonCode}: ${authorised.message}`,
        );
      }
      result = authorised.value;
    }

    const text = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8") : result.stdout;
    rmSync(scratch, { recursive: true, force: true });

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      text,
      json: extractJson(text),
      provider: this.provider,
      model,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      error: result.timedOut ? "timeout" : result.exitCode === 0 ? null : result.stderr.slice(0, 2000),
      providerSessionId: /session[_ ]id[:=]\s*([0-9a-f-]{16,})/i.exec(result.stdout)?.[1] ?? null,
      isolationAttested: false,
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    const result = await runCli(this.#binary, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
    });
    return result.exitCode === 0 && !result.timedOut ? "HEALTHY" : "UNAVAILABLE";
  }

  async probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    // Codex's one-shot CLI currently exposes no way to attach a randomly constituted
    // external id to an authenticated operation. Treating `--version` as session proof
    // would revive the exact false-ready path this interface prevents.
    void handle;
    return "UNAVAILABLE";
  }

  async probeCapacity(): Promise<CapacityReading> {
    return resolveRuntimeHealth(
      await this.#usageCollector.collect(),
      () => this.probeRuntime(),
    );
  }

  /**
   * A reviewer is not bound to a local UUID. The first turn runs in the exact packet
   * profile, asks no task question, and extracts Codex's provider-issued `thread_id`.
   * The answer turn then uses `exec resume <thread_id>` under the same profile.
   */
  private async startPacketReviewerSession(spec: SessionSpec): Promise<SessionHandle> {
    if (!this.#providerCredentialDir) {
      throw new ProviderSessionProvisionError(
        ReasonCode.ISOLATION_LOST,
        "Codex packet reviewer requires a dedicated CODEX_HOME credential scope",
      );
    }
    const credentialPaths = codexCredentialPaths(this.#providerCredentialDir);
    const args = codexReviewerArgs("bootstrap", spec.model, spec.effort);
    const result = await runCli(this.#binary, args, {
      cwd: spec.workdir,
      timeoutMs: 60_000,
      stdin: "This is a packet-only reviewer session identity handshake. Reply exactly READY and do not use tools.",
      isolation: spec.isolation,
      reviewerCredentialPaths: credentialPaths,
      reviewerEnvironment: codexReviewerEnvironment(spec.workdir, this.#providerCredentialDir),
      reviewerExecutablePaths: codexReviewerExecutables(this.#binary),
      reviewerEgress: this.#reviewerEgress,
      reviewerProvider: this.provider,
      reviewerEgressPhase: "session-bootstrap",
    });
    if (!result.isolationEnforced || !result.egressEvidence || result.egressEvidence.length === 0) {
      throw new ProviderSessionProvisionError(
        ReasonCode.ISOLATION_LOST,
        result.stderr || "Codex reviewer isolation proof did not complete",
      );
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new ProviderSessionProvisionError(
        ReasonCode.ISOLATION_LOST,
        result.timedOut ? "Codex reviewer session identity handshake timed out" : result.stderr || "Codex reviewer session identity handshake failed",
      );
    }
    const providerSessionId = codexThreadId(result.stdout);
    if (!providerSessionId) {
      throw new ProviderSessionProvisionError(
        ReasonCode.ISOLATION_LOST,
        "Codex did not report a provider thread id for the packet reviewer session",
      );
    }
    this.#reviewerSessions.set(providerSessionId, {
      workdir: spec.workdir,
      model: spec.model,
      effort: spec.effort ?? null,
      bootstrapEgressEvidence: result.egressEvidence,
    });
    return {
      externalSessionId: providerSessionId,
      provider: this.provider,
      model: spec.model,
      effort: spec.effort ?? null,
      providerSessionProven: true,
      pid: null,
      workdir: spec.workdir,
    };
  }

  private async invokePacketReviewer(request: InvocationRequest, started: number): Promise<InvocationResult> {
    const model = request.model ?? this.defaultModels.reviewer;
    const expectedSessionId = request.externalSessionId;
    const constituted = expectedSessionId ? this.#reviewerSessions.get(expectedSessionId) : undefined;
    if (
      !expectedSessionId ||
      !constituted ||
      constituted.workdir !== request.workdir ||
      constituted.model !== model ||
      constituted.effort !== (request.effort ?? null) ||
      !this.#providerCredentialDir
    ) {
      return refusedInvocation(
        request,
        this.provider,
        model,
        started,
        "Codex reviewer invocation is not bound to a freshly proved provider session",
      );
    }

    const args = codexReviewerArgs("resume", model, request.effort, expectedSessionId);
    const result = await runCli(this.#binary, args, {
      cwd: request.workdir,
      timeoutMs: request.timeoutMs,
      stdin: request.systemPrompt ? `${request.systemPrompt}\n\n---\n\n${request.prompt}` : request.prompt,
      isolation: request.isolation,
      reviewerCredentialPaths: codexCredentialPaths(this.#providerCredentialDir),
      reviewerEnvironment: codexReviewerEnvironment(request.workdir, this.#providerCredentialDir),
      reviewerExecutablePaths: codexReviewerExecutables(this.#binary),
      reviewerEgress: this.#reviewerEgress,
      reviewerProvider: this.provider,
      reviewerEgressPhase: "reviewer-invocation",
    });
    const observedSessionId = codexThreadId(result.stdout);
    const sessionMatches = !observedSessionId || observedSessionId === expectedSessionId;
    const text = codexLastAgentMessage(result.stdout) ?? result.stdout;
    const enforced = result.isolationEnforced && sessionMatches && Boolean(result.egressEvidence?.length);
    return {
      ok: result.exitCode === 0 && !result.timedOut && enforced,
      text,
      json: extractJson(text),
      provider: this.provider,
      model,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      error: !sessionMatches
        ? "Codex resume reported a provider session other than the constituted reviewer"
        : result.timedOut
          ? "timeout"
          : result.exitCode === 0 && result.isolationEnforced
            ? null
            : result.stderr.slice(0, 2000),
      providerSessionId: enforced ? expectedSessionId : null,
      isolationAttested: enforced,
      isolationReasonCode: enforced ? undefined : ReasonCode.ISOLATION_LOST,
      effortAttested: enforced && request.effort !== undefined,
      egressEvidence: enforced
        ? [...constituted.bootstrapEgressEvidence, ...(result.egressEvidence ?? [])]
        : undefined,
    };
  }
}

/**
 * Grok is deliberately a sensor and optional diversity provider, not a critical-path
 * fallback. Its collector is real, while any attempted required-role invocation is
 * refused at the adapter boundary.
 */
export class GrokCliAdapter implements ProviderAdapter {
  readonly provider = "grok";
  readonly isProduction = true;
  readonly optionalAdversarialOnly = true;
  readonly supportsReviewerIsolation = false;
  readonly defaultModels = { reviewer: "grok", adversarialReviewer: "grok" } as const;

  readonly #binary: string;
  readonly #clock: Clock;
  readonly #denyReadPaths: readonly string[];
  readonly #providerCredentialDir: string | undefined;
  readonly #usageCollector: UsageCollector;

  constructor(options: CliAdapterOptions) {
    this.#binary = resolveExecutable(options.binary ?? "grok");
    this.#clock = options.clock;
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
    this.#providerCredentialDir = options.providerCredentialDir;
    this.#usageCollector = options.usageCollector ?? new GrokUsageCollector({
      clock: this.#clock,
      binary: this.#binary,
      providerCredentialDir: this.#providerCredentialDir,
    });
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    void spec;
    throw new ProviderSessionProvisionError(
      ReasonCode.ISOLATION_LOST,
      "Grok is registered only for optional adversarial review and cannot constitute a required role",
    );
  }

  async stopSession(): Promise<void> {
    /* Grok never owns a required control-plane session. */
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    return refusedInvocation(
      request,
      this.provider,
      request.model ?? this.defaultModels.adversarialReviewer,
      Date.now(),
      "Grok is optional adversarial-review only; required-role invocation is refused",
    );
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    const result = await runCli(this.#binary, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
    });
    return result.exitCode === 0 && !result.timedOut ? "HEALTHY" : "UNAVAILABLE";
  }

  async probeSession(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return "UNAVAILABLE";
  }

  async probeCapacity(): Promise<CapacityReading> {
    return resolveRuntimeHealth(await this.#usageCollector.collect(), () => this.probeRuntime());
  }
}

const safeParse = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Real seatbelt probes exposed only for regression tests; production uses `runCli`. */
export const __testing = Object.freeze({
  reviewerProfile,
  reviewerSandboxArgs,
  composeReviewerProfile,
  probeNoTools,
  probeDeniedTranscriptPaths,
  reviewerToolContractPresent,
  codexReviewerArgs,
  codexThreadId,
  codexLastAgentMessage,
  setRunCli: (stub: typeof productionRunCli | null): void => {
    runCli = stub ?? productionRunCli;
  },
});
