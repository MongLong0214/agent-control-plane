import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import type {
  CapacityReading,
  InvocationRequest,
  InvocationResult,
  ProviderAdapter,
  SessionHandle,
  SessionSpec,
} from "./provider.ts";
import { extractJson } from "./provider.ts";

export interface ScriptedResponse {
  /** Matches against the invocation prompt; first match wins and is consumed once. */
  match: RegExp;
  text: string;
  ok?: boolean;
  /** Consume this entry after one use. Defaults to true. */
  once?: boolean;
  delayMs?: number;
}

/**
 * Deterministic adapter for scenario tests.
 *
 * `isProduction = false` and the provider id is its own — the routing path filters on
 * both, so this adapter can never be selected for real work. It exists so continuity,
 * fencing and review-gate scenarios can be driven to an exact outcome without spending
 * provider quota, not as a stand-in for a real model on a production path.
 */
export class ScriptedAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly isProduction = false;
  readonly defaultModels = { cto: "scripted-cto", reviewer: "scripted-reviewer", worker: "scripted-worker", ceo: "scripted-ceo" } as const;

  readonly invocations: InvocationRequest[] = [];
  #responses: ScriptedResponse[] = [];
  #capacity: CapacityReading | null = null;
  #runtime: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" = "HEALTHY";

  /**
   * `provider` is overridable so a scenario can model two distinct providers (fan-out,
   * continuity failover) without either becoming production-eligible.
   */
  constructor(
    private readonly clock: Clock,
    provider = "scripted",
  ) {
    this.provider = provider;
  }

  script(...responses: ScriptedResponse[]): this {
    this.#responses.push(...responses);
    return this;
  }

  reset(): void {
    this.#responses = [];
    this.invocations.length = 0;
  }

  setCapacity(reading: CapacityReading | null): void {
    this.#capacity = reading;
  }

  setRuntimeHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void {
    this.#runtime = health;
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

  async stopSession(): Promise<void> {}

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.invocations.push(request);
    const index = this.#responses.findIndex((r) => r.match.test(request.prompt));
    if (index === -1) {
      return {
        ok: false,
        text: "",
        json: null,
        provider: this.provider,
        model: request.model ?? "scripted",
        durationMs: 0,
        exitCode: 1,
        error: `no scripted response matched prompt: ${request.prompt.slice(0, 200)}`,
      };
    }
    const response = this.#responses[index]!;
    if (response.once !== false) this.#responses.splice(index, 1);
    if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));

    return {
      ok: response.ok ?? true,
      text: response.text,
      json: extractJson(response.text),
      provider: this.provider,
      model: request.model ?? "scripted",
      durationMs: response.delayMs ?? 1,
      exitCode: response.ok === false ? 1 : 0,
      error: response.ok === false ? "scripted failure" : null,
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#runtime;
  }

  async probeCapacity(): Promise<CapacityReading> {
    if (this.#capacity) return this.#capacity;
    return {
      provider: this.provider,
      sensorHealth: "HEALTHY",
      runtimeHealth: this.#runtime,
      observedAt: this.clock.nowIso(),
      source: "scripted",
      buckets: [
        {
          id: "scripted-bucket",
          remainingPercent: 100,
          resetAt: null,
          capabilities: ["ceo", "blind-review", "cto", "worker", "luna-worker"],
        },
      ],
    };
  }
}
