import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
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

const runCli = async (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    stdin?: string;
    environmentAllowlist?: readonly string[];
    denyReadPaths?: readonly string[];
    writablePaths?: readonly string[];
    /** Strict packet-only reviewer boundary, distinct from normal agent containment. */
    isolation?: NonNullable<InvocationRequest["isolation"]>;
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
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", [
      "-p",
      isolated
        ? reviewerProfile(workdir, options.isolation!.denyReadPaths)
        : runtimeProfile(workdir, realpathSync(scratch), options.denyReadPaths ?? [], options.writablePaths ?? []),
      file,
      ...args,
    ], {
      cwd: workdir,
      // Reviewer invocation is intentionally unauthenticated: retaining HOME/USER to
      // make a provider CLI work would reintroduce its host account and credentials.
      env: isolated ? {} : runtimeEnvironment(options.environmentAllowlist ?? [], realpathSync(scratch)),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      // A successful child establishes that sandbox-exec accepted the profile. On any
      // error or timeout, be conservative: an invalid profile must not be represented
      // as enforced isolation merely because sandbox-exec itself was launched.
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        isolationEnforced: isolated && code === 0 && !timedOut,
      });
    });
  });
};

const assertReviewerIsolation = (
  workdir: string,
  isolation: NonNullable<InvocationRequest["isolation"]>,
): void => {
  if (isolation.emptyEnvironment !== true || isolation.network !== "deny" || isolation.tools !== "none") {
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
export const runtimeEnvironment = (allowlist: readonly string[], scratch: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
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
  };
  for (const name of allowlist) {
    if (authorityEnvironment(name)) continue;
    const value = process.env[name];
    if (value !== undefined && !looksLikeCredential(value)) environment[name] = value;
  }
  return environment;
};

const runtimeProfile = (
  workdir: string,
  scratch: string,
  denyReadPaths: readonly string[],
  writablePaths: readonly string[],
): string => {
  const home = process.env["HOME"] ?? "";
  const sensitive = [
    ...denyReadPaths,
    ...(
      home
        ? [
            `${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.config/gh`,
            `${home}/.buzz`, `${home}/.agent-control-plane`, `${home}/.git-credentials`,
          ]
        : []
    ),
  ];
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
const reviewerProfile = (packetRoot: string, denyReadPaths: readonly string[]): string => {
  const systemReadRoots = ["/System", "/usr", "/bin", "/sbin", "/Library/Apple"];
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    ...systemReadRoots.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    `(allow file-read* (subpath ${quote(packetRoot)}))`,
    `(allow file-write* (subpath ${quote(packetRoot)}))`,
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
    "(deny network*)",
  ];
  for (const path of denyReadPaths) {
    if (path && path !== packetRoot && !path.startsWith(`${packetRoot}/`)) {
      lines.push(`(deny file-read* (subpath ${quote(path)}))`);
    }
  }
  return lines.join("\n");
};

const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

/**
 * Claude Code headless adapter. Used for CTO sessions and, under continuity fallback,
 * for acting CEO and blind reviewer roles (§15.4).
 */
export class ClaudeCliAdapter implements ProviderAdapter {
  readonly provider = "claude";
  readonly isProduction = true;
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

  constructor(options: CliAdapterOptions) {
    this.#binary = options.binary ?? "claude";
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
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
      isolation: request.isolation,
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
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    const result = await runCli(this.#binary, ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      environmentAllowlist: this.#environmentAllowlist,
      denyReadPaths: this.#denyReadPaths,
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

  constructor(options: CliAdapterOptions) {
    this.#binary = options.binary ?? "codex";
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#environmentAllowlist = options.environmentAllowlist ?? [];
    this.#denyReadPaths = [options.capacityFile, ...(options.denyReadPaths ?? [])];
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
