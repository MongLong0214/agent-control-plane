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
  /**
   * The non-negotiable boundary for a blind-review invocation. It deliberately does
   * not share the more permissive CTO/worker runtime environment: a reviewer may
   * inspect only its immutable packet and has no authority-bearing host tools.
   */
  isolation?: {
    /** The only directory the reviewer may read or write. */
    packetRoot: string;
    /** Daemon and repository roots that must remain unreadable even if discovered. */
    denyReadPaths: readonly string[];
    emptyEnvironment: true;
    network: "deny";
    tools: "none";
  };
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
  /**
   * True only when this adapter actually enforced `InvocationRequest.isolation` for
   * this invocation. A caller must not turn an unattested result into review evidence.
   */
  isolationAttested: boolean;
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
  /** Constrained worktree used for the provider operation that constituted this session. */
  workdir?: string;
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
  /**
   * A known runtime capability, not proof for a particular invocation. An omitted value
   * means the adapter must still prove the boundary through `InvocationResult`.
   */
  readonly supportsReviewerIsolation?: boolean;

  startSession(spec: SessionSpec): Promise<SessionHandle>;
  stopSession(handle: SessionHandle): Promise<void>;
  invoke(request: InvocationRequest): Promise<InvocationResult>;
  /** Cheap liveness check for an existing critical session (§14.3). */
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE">;
  /**
   * Authenticated liveness check for the exact session that would receive a critical
   * role. A binary version check cannot establish this: it says nothing about provider
   * authentication, network reachability, or the constituted session.
   */
  probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE">;
  probeCapacity(): Promise<CapacityReading>;
}

/**
 * PRD §14.2 — the two mandatory refresh points that belong to a provider operation
 * rather than to a control-plane decision: constituting or invoking a blind reviewer,
 * and a provider failing.
 *
 * Declared here as a narrow port instead of importing the capacity monitor, because the
 * monitor reads *this* module: the runtime must not depend on the component that measures
 * it. The literal trigger names are the monitor's own `RefreshTrigger` values.
 */
export type RuntimeRefreshTrigger = "BLIND_REVIEW" | "PROVIDER_SWITCH_OR_FAILURE";

export interface RuntimeCapacityObserver {
  refresh(trigger: RuntimeRefreshTrigger, providerIds?: readonly string[]): Promise<unknown>;
}

/**
 * The review gate names its reviewer session `blind-review` / `blind-review-final`, and a
 * continuity failover names it `continuity:BLIND_REVIEWER`. The purpose is the only role
 * signal a session constitution carries, so it is what the runtime classifies on.
 */
const BLIND_REVIEW_PURPOSE = /blind[-_ ]?review/i;

/**
 * Wraps an adapter so the §14.2 refreshes happen whoever calls it.
 *
 * Handing this wrapper out from the registry is what makes those refreshes mandatory: the
 * review gate, the CTO lifecycle and the continuity kernel all obtain their adapters from
 * the registry, so none of them can constitute a reviewer, invoke one, or absorb a
 * provider failure against a reading nobody re-took.
 *
 * Probes are deliberately not wrapped — a probe *is* the measurement, and refreshing on a
 * failed probe would re-enter the same sensor.
 */
class CapacityObservedAdapter implements ProviderAdapter {
  constructor(
    private readonly inner: ProviderAdapter,
    private readonly capacity: RuntimeCapacityObserver,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }

  get isProduction(): boolean {
    return this.inner.isProduction;
  }

  get defaultModels(): Readonly<Record<string, string>> {
    return this.inner.defaultModels;
  }

  get supportsReviewerIsolation(): boolean | undefined {
    return this.inner.supportsReviewerIsolation;
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    // A reviewer session is constituted before it can be bound, so the refresh belongs
    // ahead of the call: after it, the allocation has already been made.
    if (BLIND_REVIEW_PURPOSE.test(spec.purpose)) await this.observe("BLIND_REVIEW");
    try {
      return await this.inner.startSession(spec);
    } catch (err) {
      await this.observe("PROVIDER_SWITCH_OR_FAILURE");
      throw err;
    }
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    return this.inner.stopSession(handle);
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    // The packet-only isolation contract is the one part of a request a caller cannot
    // fake by naming: an isolated invocation *is* a blind review (§18.3).
    if (request.isolation) await this.observe("BLIND_REVIEW");
    try {
      const result = await this.inner.invoke(request);
      // A refused or timed-out invocation is provider-failure evidence even when the
      // process exits politely, and §14.2 wants the reading re-taken at that point rather
      // than whatever the last caller happened to have read.
      if (!result.ok) await this.observe("PROVIDER_SWITCH_OR_FAILURE");
      return result;
    } catch (err) {
      await this.observe("PROVIDER_SWITCH_OR_FAILURE");
      throw err;
    }
  }

  async probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.inner.probeRuntime();
  }

  async probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.inner.probeSession(handle);
  }

  async probeCapacity(): Promise<CapacityReading> {
    return this.inner.probeCapacity();
  }

  private async observe(trigger: RuntimeRefreshTrigger): Promise<void> {
    try {
      await this.capacity.refresh(trigger, [this.inner.provider]);
    } catch {
      // A sensor that fails while a provider failure is being reported must not replace
      // the failure being reported. The monitor audits its own probe errors, so the
      // evidence is not lost by keeping the original error primary here.
    }
  }
}

export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();
  #capacity: RuntimeCapacityObserver | null = null;

  /**
   * §14.2 — routes every adapter this registry hands out through the refresh wrapper.
   * Wired by the composition root; until it is, adapters are returned unwrapped so that a
   * unit exercise of the registry itself does not need a capacity monitor.
   */
  attachCapacity(capacity: RuntimeCapacityObserver): void {
    this.#capacity = capacity;
  }

  /** Production registration is an explicit trusted act, never a test convenience. */
  register(adapter: ProviderAdapter): void {
    if (!adapter.isProduction) {
      throw new Error(`non-production adapter '${adapter.provider}' cannot be registered for production`);
    }
    this.insert(adapter);
  }

  /**
   * Test composition may retain deterministic adapters for direct unit exercises, but
   * every production routing path must still inspect `isProduction` independently.
   */
  registerTestAdapter(adapter: ProviderAdapter): void {
    if (adapter.isProduction) {
      throw new Error(`production adapter '${adapter.provider}' must use production registration`);
    }
    this.insert(adapter);
  }

  private insert(adapter: ProviderAdapter): void {
    if (this.#adapters.has(adapter.provider)) {
      throw new Error(`provider '${adapter.provider}' is already registered`);
    }
    this.#adapters.set(adapter.provider, adapter);
  }

  get(provider: string): ProviderAdapter | null {
    const adapter = this.#adapters.get(provider);
    return adapter ? this.observed(adapter) : null;
  }

  require(provider: string): ProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new Error(`no adapter registered for provider '${provider}'`);
    return this.observed(adapter);
  }

  list(): ProviderAdapter[] {
    return [...this.#adapters.values()].map((adapter) => this.observed(adapter));
  }

  /** Adapters eligible for real work. Excludes anything that fabricates responses. */
  production(): ProviderAdapter[] {
    return this.list().filter((a) => a.isProduction);
  }

  private observed(adapter: ProviderAdapter): ProviderAdapter {
    return this.#capacity ? new CapacityObservedAdapter(adapter, this.#capacity) : adapter;
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
