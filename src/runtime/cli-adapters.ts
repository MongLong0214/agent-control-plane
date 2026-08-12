import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

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

const exec = promisify(execFile);

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
}

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Reads the structured local capacity file.
 *
 * Neither shipped CLI exposes a quota interface today, so this file *is* the sensor.
 * When it is absent, unreadable or past its freshness window the reading is ERROR or
 * STALE — never a guess. §14.3 is explicit that routing has no UNKNOWN quota, so a
 * failed sensor suspends new allocation rather than inventing a number.
 */
const readCapacityFile = (
  provider: string,
  file: string,
  clock: Clock,
  freshnessMs: number,
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
      runtimeHealth: "HEALTHY",
      error: "capacity file not present",
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      observedAt?: string;
      runtimeHealth?: CapacityReading["runtimeHealth"];
      buckets?: CapacityReading["buckets"];
    };
    const observedAt = parsed.observedAt ?? base.observedAt;
    const ageMs = new Date(clock.nowIso()).getTime() - new Date(observedAt).getTime();
    const buckets = (parsed.buckets ?? []).map((bucket) => ({
      id: String(bucket.id),
      remainingPercent:
        typeof bucket.remainingPercent === "number" ? bucket.remainingPercent : null,
      resetAt: bucket.resetAt ?? null,
      capabilities: Array.isArray(bucket.capabilities) ? bucket.capabilities.map(String) : [],
    }));

    if (buckets.length === 0) {
      return { ...base, sensorHealth: "ERROR", runtimeHealth: "HEALTHY", error: "no buckets" };
    }
    return {
      ...base,
      observedAt,
      buckets,
      sensorHealth: ageMs > freshnessMs ? "STALE" : "HEALTHY",
      runtimeHealth: parsed.runtimeHealth ?? "HEALTHY",
    };
  } catch (err) {
    return {
      ...base,
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      error: (err as Error).message,
    };
  }
};

const runCli = async (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env },
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
      resolve({ stdout, stderr: stderr + err.message, exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });

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

  constructor(options: CliAdapterOptions) {
    this.#binary = options.binary ?? "claude";
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
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
    if (request.readOnly) {
      // Plan mode plus a read-only tool allowlist: the reviewer receives the diff in
      // its prompt and has no reason, and now no ability, to mutate the candidate.
      args.push("--permission-mode", "plan", "--allowedTools", "Read", "Grep", "Glob");
    }
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);

    const result = await runCli(this.#binary, [...args, request.prompt], {
      cwd: request.workdir,
      timeoutMs: request.timeoutMs,
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
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    try {
      await exec(this.#binary, ["--version"], { timeout: 15_000 });
      return "HEALTHY";
    } catch {
      return "UNAVAILABLE";
    }
  }

  async probeCapacity(): Promise<CapacityReading> {
    const reading = readCapacityFile(this.provider, this.#capacityFile, this.#clock, this.#freshnessMs);
    if (reading.sensorHealth === "ERROR") {
      return { ...reading, runtimeHealth: await this.probeRuntime() };
    }
    return reading;
  }
}

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

  constructor(options: CliAdapterOptions) {
    this.#binary = options.binary ?? "codex";
    this.#clock = options.clock;
    this.#capacityFile = options.capacityFile;
    this.#freshnessMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_MS;
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    return {
      externalSessionId: randomUUID(),
      provider: this.provider,
      model: spec.model,
      effort: spec.effort ?? null,
      pid: null,
    };
  }

  async stopSession(): Promise<void> {
    /* codex exec is one-shot */
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const started = Date.now();
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
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    try {
      await exec(this.#binary, ["--version"], { timeout: 15_000 });
      return "HEALTHY";
    } catch {
      return "UNAVAILABLE";
    }
  }

  async probeCapacity(): Promise<CapacityReading> {
    const reading = readCapacityFile(this.provider, this.#capacityFile, this.#clock, this.#freshnessMs);
    if (reading.sensorHealth === "ERROR") {
      return { ...reading, runtimeHealth: await this.probeRuntime() };
    }
    return reading;
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
