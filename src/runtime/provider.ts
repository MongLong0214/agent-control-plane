import type { Decision } from "../core/errors.ts";

/** Provider ids are deployment config, not architecture (PRD §14.1). */
export const ProviderId = {
  gpt: "gpt",
  claude: "claude",
  grok: "grok",
  /** Deterministic adapter for tests. Never selectable by a production routing path. */
  scripted: "scripted",
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

export interface InvocationRequest {
  prompt: string;
  systemPrompt?: string;
  workdir: string;
  timeoutMs: number;
  model?: string;
  effort?: string;
  /** JSON Schema the final answer must satisfy, when the caller needs structured output. */
  responseSchema?: Record<string, unknown>;
  /** Read-only invocations must not be able to mutate or explore a repository. */
  readOnly: boolean;
  /** Hard cost ceiling for one invocation, where the runtime supports one. */
  maxBudgetUsd?: number;
  /** Stable id so an interrupted invocation can be correlated in provider logs. */
  correlationId: string;
  /**
   * External session id the control plane constituted for this role. Where the runtime
   * supports it, the invocation must *be* that session — otherwise the session the
   * independence check was performed against is not the session that produced the verdict.
   */
  externalSessionId?: string;
}

export interface InvocationResult {
  ok: boolean;
  text: string;
  json: unknown | null;
  provider: string;
  model: string;
  durationMs: number;
  exitCode: number | null;
  error: string | null;
  /** Session identity the provider reports for this invocation, when it reports one. */
  providerSessionId: string | null;
}

export interface SessionSpec {
  model: string;
  effort?: string | null;
  workdir: string;
  purpose: string;
}

export interface SessionHandle {
  externalSessionId: string;
  provider: string;
  model: string;
  effort: string | null;
  pid: number | null;
}

/** PRD §14.3 — one bucket of a provider's quota. */
export interface CapacityBucket {
  id: string;
  remainingPercent: number | null;
  resetAt: string | null;
  capabilities: string[];
}

export interface CapacityReading {
  provider: string;
  sensorHealth: "HEALTHY" | "STALE" | "ERROR";
  /**
   * Whether the provider's runtime actually runs. UNKNOWN is a first-class value: a quota
   * file says nothing about the CLI, and an unprobed provider must not be routed to
   * (§14.3 — routing has no UNKNOWN state, so UNKNOWN suspends rather than passes).
   */
  runtimeHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
  observedAt: string;
  buckets: CapacityBucket[];
  source: string;
  error?: string;
}

/**
 * A provider runtime. Adapters hide collection differences (§40 Maintainability) so the
 * continuity kernel never branches on which provider it is talking to.
 */
export interface ProviderAdapter {
  readonly provider: string;
  /**
   * False for adapters that fabricate responses. The routing path refuses to select a
   * non-production adapter, so a deterministic test double can never stand in for a
   * real model on a production run (PRD: no mock-only production path).
   */
  readonly isProduction: boolean;
  readonly defaultModels: Readonly<Record<string, string>>;

  startSession(spec: SessionSpec): Promise<SessionHandle>;
  stopSession(handle: SessionHandle): Promise<void>;
  invoke(request: InvocationRequest): Promise<InvocationResult>;
  /** Cheap liveness check for an existing critical session (§14.3). */
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE">;
  probeCapacity(): Promise<CapacityReading>;
}

export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.#adapters.set(adapter.provider, adapter);
  }

  get(provider: string): ProviderAdapter | null {
    return this.#adapters.get(provider) ?? null;
  }

  require(provider: string): ProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new Error(`no adapter registered for provider '${provider}'`);
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.#adapters.values()];
  }

  /** Adapters eligible for real work. Excludes anything that fabricates responses. */
  production(): ProviderAdapter[] {
    return this.list().filter((a) => a.isProduction);
  }

  has(provider: string): boolean {
    return this.#adapters.has(provider);
  }
}

export const extractJson = (text: string): unknown | null => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      continue;
    }
  }
  return null;
};

export type CapacityDecision = Decision<CapacityReading>;
