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
  /**
   * Typed `boolean` rather than the literal `false` so a *test-owned* subclass can opt
   * into the production route it needs to exercise. The safety is the runtime check in
   * `ProviderRegistry.register`, not this type: nothing under `src/` overrides it, so the
   * shipped composition root still has no production-eligible double.
   */
  readonly isProduction: boolean = false;
  readonly defaultModels = { cto: "scripted-cto", reviewer: "scripted-reviewer", worker: "scripted-worker", ceo: "scripted-ceo" } as const;

  readonly invocations: InvocationRequest[] = [];
  #responses: ScriptedResponse[] = [];
  #capacity: CapacityReading | null = null;
  #runtime: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" = "HEALTHY";
  #knownSessions = new Set<string>();
  #sessionHealth = new Map<string, "HEALTHY" | "DEGRADED" | "UNAVAILABLE">();
  #nextSessionHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | null = null;

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

  /** Lets a scenario model a session the provider no longer recognises while its runtime remains healthy. */
  setNextSessionHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void {
    this.#nextSessionHealth = health;
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    const externalSessionId = randomUUID();
    this.#knownSessions.add(externalSessionId);
    if (this.#nextSessionHealth) {
      this.#sessionHealth.set(externalSessionId, this.#nextSessionHealth);
      this.#nextSessionHealth = null;
    }
    return {
      externalSessionId,
      provider: this.provider,
      model: spec.model,
      effort: spec.effort ?? null,
      pid: null,
      workdir: spec.workdir,
    };
  }

  async stopSession(handle?: SessionHandle): Promise<void> {
    if (!handle || handle.provider !== this.provider) return;
    this.#knownSessions.delete(handle.externalSessionId);
    this.#sessionHealth.delete(handle.externalSessionId);
  }

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
        providerSessionId: request.externalSessionId ?? null,
        // A deterministic in-process double has no OS boundary. It must never certify
        // reviewer isolation merely because a test supplied the requested shape.
        isolationAttested: false,
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
      providerSessionId: request.externalSessionId ?? null,
      isolationAttested: false,
    };
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#runtime;
  }

  async probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    if (handle.provider !== this.provider || !this.#knownSessions.has(handle.externalSessionId)) {
      return "UNAVAILABLE";
    }
    return this.#sessionHealth.get(handle.externalSessionId) ?? this.#runtime;
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
