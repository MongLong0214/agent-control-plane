import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  type CapacityReading,
  type InvocationRequest,
  type InvocationResult,
  type ProviderAdapter,
  type SessionHandle,
  type SessionSpec,
  extractJson,
} from "./provider.ts";

export interface CliAdapterOptions {
  clock: Clock;
  /**
   * Structured local capacity interface (PRD §14.2, first-choice source). A JSON file
   * the owner or a future provider CLI maintains; see docs/capacity-source.md.
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
   * A credential store this deployment provisioned for the provider. Its presence is what
   * makes closing the host keychain possible rather than self-defeating: on macOS the
   * provider's own login and the host's other secrets share one store, so denying it without
   * an alternative stops every session authenticating (measured: `claude --print` answers
   * "Not logged in", and dispatch then fails SESSION_NOT_READY).
   */
  providerCredentialDir?: string;
  /** Observations beyond this lead are not valid freshness evidence. */
  maxClockSkewMs?: number;
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
 * Reads the structured local capacity file.
 *
 * Neither shipped CLI exposes a quota interface today, so this file *is* the sensor.
 * When it is absent, unreadable or past its freshness window the reading is ERROR or
 * STALE — never a guess. §14.3 is explicit that routing has no UNKNOWN quota, so a
 * failed sensor suspends new allocation rather than inventing a number.
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

const runCli = async (
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
  },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  isolationEnforced: boolean;
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
  let workdir: string;
  try {
    workdir = realpathSync(options.cwd);
    if (options.isolation) assertReviewerIsolation(workdir, options.isolation);
  } catch (err) {
    rmSync(scratch, { recursive: true, force: true });
    return {
      stdout: "",
      stderr: (err as Error).message,
      exitCode: null,
      timedOut: false,
      isolationEnforced: false,
    };
  }
  const isolated = options.isolation !== undefined;
  const environment = isolated
    ? reviewerEnvironment(workdir, options.reviewerConfigDirectory)
    : runtimeEnvironment(options.environmentAllowlist ?? [], realpathSync(scratch), options.providerCredentialDir);
  const profile = isolated
    ? reviewerProfile(
        workdir,
        options.isolation!.denyReadPaths,
        file,
        options.reviewerCredentialPaths ?? [],
      )
    : runtimeProfile(
        workdir,
        realpathSync(scratch),
        options.denyReadPaths ?? [],
        options.writablePaths ?? [],
        options.providerCredentialDir,
      );

  // sandbox-exec is a wrapper around the provider process. A provider may return a
  // non-zero status for an invalid answer while the seatbelt still held; prove the
  // profile separately so isolation attestation cannot be confused with model success.
  let isolationEnforced = false;
  if (isolated) {
    const profileCheck = await profileAccepted(profile, workdir, environment, options.timeoutMs);
    if (!profileCheck.accepted) {
      rmSync(scratch, { recursive: true, force: true });
      return {
        stdout: "",
        stderr: profileCheck.stderr || "reviewer isolation profile was not accepted",
        exitCode: profileCheck.exitCode,
        timedOut: profileCheck.timedOut,
        isolationEnforced: false,
      };
    }
    isolationEnforced = true;
  }

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/sandbox-exec", [
        "-p",
        profile,
        file,
        ...args,
      ], {
        cwd: workdir,
        env: environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      rmSync(scratch, { recursive: true, force: true });
      resolve({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: null,
        timedOut: false,
        isolationEnforced: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      resolve({ stdout, stderr: stderr + err.message, exitCode: null, timedOut, isolationEnforced: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        isolationEnforced,
      });
    });
  });
};

const profileAccepted = async (
  profile: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ accepted: boolean; stderr: string; exitCode: number | null; timedOut: boolean }> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], {
        cwd,
        env: environment,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      resolve({ accepted: false, stderr: (err as Error).message, exitCode: null, timedOut: false });
      return;
    }
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ accepted: exitCode === 0 && !timedOut, stderr, exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, Math.min(Math.max(timeoutMs, 1), 5_000));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => {
      stderr += err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

const assertReviewerIsolation = (
  workdir: string,
  isolation: NonNullable<InvocationRequest["isolation"]>,
): void => {
  if (isolation.emptyEnvironment !== true || isolation.network !== "provider-only" || isolation.tools !== "none") {
    throw new Error("reviewer isolation contract is incomplete");
  }
  if (realpathSync(isolation.packetRoot) !== workdir) {
    throw new Error("reviewer packet root must be the invocation working directory");
  }
};

const AUTHORITY_ENV = [
  /GITHUB.*TOKEN/i,
  /^GH_TOKEN$/i,
  /^GITHUB_/i,
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
  // other session does, and `isolation.providerCredentials` records which of the two held.
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
    join(configDirectory, ".credentials.json"),
    join(configDirectory, ".claude.json"),
  ];
};

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
    `(allow file-write* (subpath ${quote(workdir)}))`,
    `(allow file-write* (subpath ${quote(scratch)}))`,
    ...writablePaths.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
  );
  return lines.join("\n");
};

/**
 * A reviewer cannot use the normal profile: it deliberately permits ordinary host reads
 * so CTO and worker CLIs can operate in their supplied worktree. This profile starts
 * from deny-default, grants only the packet directory plus OS runtime files, and denies
 * all network traffic. Paths supplied by the caller are included as explicit denials as
 * defense in depth; deny-default already keeps them inaccessible unless one is packetRoot.
 */
/**
 * The reviewer's confinement.
 *
 * Deny-by-default was tried and does not work: the loader needs paths that cannot be
 * enumerated in advance, so even `/usr/bin/true` fails to start and every review returns
 * "profile was not accepted" — the same lesson the verification sandbox already recorded
 * (issue #247 item 1). So this is allow-by-default with a named deny list, and the
 * attestation says exactly that rather than claiming reads are packet-only:
 *
 *   - the daemon's own state, whatever the caller names in `denyReadPaths`
 *   - the host credential locations: keychains, ssh, aws, gnupg, gh config, git identity
 *   - every write outside the packet root
 *   - all network
 *
 * What that buys is the thing CP-HI-04 needs: a reviewer cannot read the daemon's database,
 * another checkout, or a credential, and cannot write anywhere its verdict could leak into.
 */
const reviewerProfile = (
  packetRoot: string,
  denyReadPaths: readonly string[],
  executable: string,
  credentialPaths: readonly string[],
): string => {
  void executable;
  void credentialPaths;
  // Network is *not* denied, and the contract says so rather than claiming otherwise: a
  // blind reviewer is a model invocation, so cutting its egress does not confine it, it
  // makes it impossible — measured, the CLI simply hangs until the invocation times out.
  // The confinement that matters for CP-HI-04 is the filesystem: the reviewer cannot read
  // the daemon's state, another checkout or a credential, and cannot write outside its
  // packet, so it cannot reach the candidate it is judging or leave anything behind.
  const lines = ["(version 1)", "(allow default)"];
  for (const path of [...hostCredentialPaths(credentialPaths[0]), ...denyReadPaths]) {
    const resolved = resolvePath(path);
    if (resolved && resolved !== packetRoot && !resolved.startsWith(`${packetRoot}/`)) {
      lines.push(`(deny file-read* (subpath ${quote(resolved)}))`);
    }
  }
  lines.push(
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

  constructor(options: CliAdapterOptions) {
    this.#binary = resolveExecutable(options.binary ?? "claude");
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
    this.#providerCredentialDir = options.providerCredentialDir;
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
    const result = await runCli(this.#binary, args, {
      cwd: request.workdir,
      timeoutMs: request.timeoutMs,
      stdin: request.prompt,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
      isolation: request.isolation,
      reviewerCredentialPaths: request.isolation ? claudeCredentialPaths(process.env["CLAUDE_CONFIG_DIR"]) : undefined,
      reviewerConfigDirectory: request.isolation
        ? process.env["CLAUDE_CONFIG_DIR"]
        : undefined,
    });

    const envelope = safeParse(result.stdout);
    const text =
      typeof envelope?.["result"] === "string" ? (envelope["result"] as string) : result.stdout;

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      text,
      json: extractJson(text),
      provider: this.provider,
      model: request.model ?? this.defaultModels.cto,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      error: result.timedOut ? "timeout" : result.exitCode === 0 ? null : result.stderr.slice(0, 2000),
      providerSessionId:
        typeof envelope?.["session_id"] === "string" ? (envelope["session_id"] as string) : null,
      isolationAttested: request.isolation !== undefined && result.isolationEnforced,
      isolationReasonCode:
        request.isolation !== undefined && !result.isolationEnforced ? ReasonCode.ISOLATION_LOST : undefined,
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
      readCapacityFile(this.provider, this.#capacityFile, this.#clock, this.#freshnessMs, this.#maxClockSkewMs),
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

/**
 * Codex CLI adapter. Preferred runtime for the blind reviewer (GPT-5.6 Sol at xhigh
 * effort, §18.1) and for mechanical worker tasks.
 */
export class CodexCliAdapter implements ProviderAdapter {
  readonly provider = "gpt";
  readonly isProduction = true;
  readonly supportsReviewerIsolation = false;
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

  constructor(options: CliAdapterOptions) {
    this.#binary = resolveExecutable(options.binary ?? "codex");
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
    this.#providerCredentialDir = options.providerCredentialDir;
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
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
    /* codex exec is one-shot */
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const started = Date.now();
    if (request.isolation) {
      // Codex's current CLI exposes a read-only sandbox, but no host-enforced
      // no-tools mode. Running it and claiming packet-only isolation would be worse
      // than an unavailable reviewer, so the review gate must select another adapter.
      return {
        ok: false,
        text: "",
        json: null,
        provider: this.provider,
        model: request.model ?? this.defaultModels.reviewer,
        durationMs: Date.now() - started,
        exitCode: null,
        error: "Codex CLI cannot enforce reviewer tools:none isolation",
        providerSessionId: null,
        isolationAttested: false,
        isolationReasonCode: ReasonCode.ISOLATION_LOST,
      };
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

    const result = await runCli(this.#binary, [...args, prompt], {
      cwd: request.workdir,
      timeoutMs: request.timeoutMs,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
      providerCredentialDir: this.#providerCredentialDir,
      writablePaths: [scratch],
    });

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
      readCapacityFile(this.provider, this.#capacityFile, this.#clock, this.#freshnessMs, this.#maxClockSkewMs),
      () => this.probeRuntime(),
    );
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
