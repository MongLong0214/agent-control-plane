import { deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ManagedWriteGuard, WriteOperation } from "../guard/managed-write-guard.ts";

/**
 * The complete, per-effect identity a local runtime needs before it can receive a
 * writable sandbox. This is deliberately a request rather than a capability stored on a
 * session: a session may outlive a claim, a binding generation, or a source-read fence.
 */
export interface ManagedInvocationWrite {
  operation: WriteOperation;
  /** Absolute target the provider process may mutate for this one invocation. */
  targetPath: string;
  /** The task whose worker receipt authorises this invocation. */
  taskId: string;
  /** Durable task_executions receipt for this particular worker attempt. */
  taskReceiptId: string;
  /** Canonical disposable worktree bound to the task receipt. */
  assignedWorktreeId: string;
  repositoryIdentity?: string | null;
  targetBranch?: string | null;
  targetWorktreeId?: string | null;
  runId: string;
  sessionId: string;
  bindingGeneration: number;
  actor?: string | null;
}

/**
 * The only port through which a runtime adapter may start a writable local invocation.
 * It deliberately returns the guard's decision, rather than a boolean a caller could
 * mistake for a durable grant.
 */
export interface ManagedInvocationWriteBroker {
  authorize<T>(
    write: ManagedInvocationWrite,
    effect: () => T | Promise<T>,
  ): Promise<Decision<T>>;
}

/**
 * Production composition of the local-runtime boundary with CP-HI-01. The guard keeps
 * the grant in flight while the provider process is launched and runs, so revocation,
 * claims and the source-read fence are rechecked around that invocation. The sandbox and
 * assigned-worktree boundary constrain the process's individual file writes; those syscalls
 * are not each separate Guard API calls.
 */
export class GuardedInvocationWriteBroker implements ManagedInvocationWriteBroker {
  constructor(private readonly guard: ManagedWriteGuard) {}

  authorize<T>(
    write: ManagedInvocationWrite,
    effect: () => T | Promise<T>,
  ): Promise<Decision<T>> {
    const missing = [
      ["taskId", write.taskId],
      ["taskReceiptId", write.taskReceiptId],
      ["assignedWorktreeId", write.assignedWorktreeId],
    ].filter(([, value]) => typeof value !== "string" || value.trim().length === 0).map(([name]) => name);
    if (missing.length > 0) {
      return Promise.resolve(deny(
        ReasonCode.WRITE_REQUIRES_MANAGED_RUN,
        "writable runtime invocation must name its task receipt and assigned worktree",
        { missing },
      ));
    }
    return this.guard.authorize(
      {
        operation: write.operation,
        targetPath: write.targetPath,
        repositoryIdentity: write.repositoryIdentity ?? null,
        targetBranch: write.targetBranch ?? null,
        // The binding, rather than a caller-selected worktree label, is authoritative.
        targetWorktreeId: write.assignedWorktreeId,
        assignedWorktreeId: write.assignedWorktreeId,
        taskId: write.taskId,
        taskReceiptId: write.taskReceiptId,
        runId: write.runId,
        sessionId: write.sessionId,
        bindingGeneration: write.bindingGeneration,
        actor: "runtime-cli",
      },
      () => effect(),
    );
  }
}

/** Provider ids are deployment config, not architecture (PRD §14.1). */
export const ProviderId = {
  gpt: "gpt",
  claude: "claude",
  grok: "grok",
  /** Deterministic adapter for tests. Never selectable by a production routing path. */
  scripted: "scripted",
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

/**
 * The only provider hostnames a packet-only reviewer may ask the daemon to route.
 *
 * This lives beside the provider identity contract rather than in the owner-supplied
 * proxy allowlist: the latter is infrastructure, while this map is the daemon's policy.
 * A deployment may replace the map through `ReviewerEgressConfig.providerEndpoints`,
 * but an omitted provider never falls through to another provider's hosts.
 */
export const REVIEWER_PROVIDER_ENDPOINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gpt: Object.freeze(["api.openai.com"]),
  claude: Object.freeze(["api.anthropic.com"]),
  grok: Object.freeze(["api.x.ai"]),
});

/**
 * Real public endpoints used only to prove that the proxy refuses a destination outside
 * the selected provider policy. The runtime chooses one not present in that invocation's
 * generated allowlist; `.invalid` is deliberately not an attestation target because a
 * resolver can reject it without the proxy applying the allowlist at all.
 */
export const REVIEWER_EGRESS_DENY_PROBE_ENDPOINTS: readonly string[] = Object.freeze([
  "api.openai.com",
  "api.anthropic.com",
  "api.x.ai",
  "example.com",
  "www.iana.org",
]);

/**
 * Owner-provided egress infrastructure. These are paths, not policy: the daemon writes a
 * fresh allowlist from `REVIEWER_PROVIDER_ENDPOINTS` (or the explicitly configured map)
 * for every isolated reviewer invocation.
 */
export interface ReviewerEgressConfig {
  /** Seatbelt profile that blocks remote TCP/UDP except the local proxy port. */
  profilePath: string;
  /** Owner-provided CONNECT allowlist proxy implementation. */
  proxyPath: string;
  /** Daemon-private parent for per-invocation allowlists and JSONL logs. */
  runtimeDir: string;
  /** The loopback port granted by the seatbelt profile. Defaults to 18443. */
  port?: number;
  /** Interpreter used to launch `proxyPath`. Defaults to /usr/bin/python3 on macOS. */
  pythonBinary?: string;
  /** Optional complete replacement for the compiled provider endpoint map. */
  providerEndpoints?: Readonly<Record<string, readonly string[]>>;
}

export interface ReviewerEgressProbe {
  host: string;
  /** Whether the direct socket stripped or replaced HTTPS_PROXY before it connected. */
  proxyMode?: "unset" | "override";
  connected?: boolean;
  denied?: boolean;
  blocked?: boolean;
  statusCode?: number | null;
  errorCode?: string | null;
}

/**
 * Verbatim proxy evidence for one confined provider process. `jsonl` is copied only after
 * the daemon has stopped its proxy, so the bytes in a BLIND_REVIEW artifact are immutable
 * evidence for that invocation rather than a pointer to a mutable host log.
 */
export interface ReviewerEgressRecord {
  provider: string;
  allowedEndpoints: string[];
  /** sha256 of the exact generated `allowlist.txt` bytes passed to the proxy process. */
  allowlistDigest: string;
  proxyPort: number;
  phase: "session-bootstrap" | "reviewer-invocation";
  jsonl: string;
  probes: {
    allowedEndpoint: ReviewerEgressProbe;
    deniedEndpoint: ReviewerEgressProbe;
    directSocket: ReviewerEgressProbe[];
  };
}

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
  /**
   * Mandatory for every non-read-only provider invocation. A workdir is only a read
   * context; it never implicitly grants the provider permission to write that checkout.
   * The adapter passes this through `ManagedInvocationWriteBroker` immediately around
   * process launch and grants the seatbelt only this target path.
   */
  managedWrite?: ManagedInvocationWrite;
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
    /**
     * The caller requires provider-only egress. A blind reviewer is a model invocation, so
     * broad egress denial makes the CLI hang; the adapter must actively prove this narrower
     * boundary before attesting. If the runtime cannot prove it, it returns ISOLATION_LOST.
     */
    network: "provider-only";
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
  /**
   * The stable control-plane reason when a requested packet boundary was not enforced.
   * It complements the boolean so adapter callers can surface an auditable refusal rather
   * than reducing every failed isolation setup to a provider error string.
   */
  isolationReasonCode?: typeof ReasonCode.ISOLATION_LOST;
  /**
   * Non-empty only for an invocation whose provider-only boundary was actively measured.
   * The blind-review gate copies these immutable JSONL records into its evidence artifact.
   */
  egressEvidence?: ReviewerEgressRecord[];
  /**
   * The adapter accepted and applied the requested effort through a provider-supported
   * invocation setting. Used only by adapters that can make this a measured fact.
   */
  effortAttested?: boolean;
}

export interface SessionSpec {
  model: string;
  effort?: string | null;
  workdir: string;
  purpose: string;
  /**
   * Present only while constituting a packet-only reviewer. Some runtimes can create
   * the provider conversation before the first verdict; carrying the exact boundary
   * here lets them prove that provider-issued identity under the same confinement that
   * will later produce the answer.
   */
  isolation?: InvocationRequest["isolation"];
  /**
   * Records that a future invocation may request a managed write. It is intentionally
   * descriptive only: session creation never grants filesystem access, and every effect
   * still needs `InvocationRequest.managedWrite` at launch time.
   */
  writeMode?: "READ_ONLY" | "MANAGED_PER_INVOCATION";
}

export interface SessionHandle {
  externalSessionId: string;
  provider: string;
  model: string;
  effort: string | null;
  /**
   * True only when the adapter observed this id from the provider while creating the
   * session. A locally generated correlation id is deliberately not enough for a
   * packet-only reviewer that cannot pass an id into the provider.
   */
  providerSessionProven?: boolean;
  pid: number | null;
  /** Constrained worktree used for the provider operation that constituted this session. */
  workdir?: string;
}

/**
 * A provider adapter may distinguish a lost reviewer boundary from ordinary runtime
 * failure. The blind-review gate must never reinterpret the former as permission to
 * silently route the mandatory GPT review to Claude.
 */
export class ProviderSessionProvisionError extends Error {
  constructor(
    readonly reasonCode: typeof ReasonCode.ISOLATION_LOST,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSessionProvisionError";
  }
}

/** PRD §14.3 — one bucket of a provider's quota. */
export interface CapacityBucket {
  id: string;
  remainingPercent: number | null;
  resetAt: string | null;
  capabilities: string[];
  /**
   * How the provider stated the number this bucket carries.
   *
   * `remaining` is the value as read. `used` means the CLI reported consumption and
   * `remainingPercent` is `100 - used` — arithmetic on a stated quantity, not an inference
   * about an unstated one (#570). Recorded as evidence rather than as a branch: nothing
   * downstream decides differently on it, but when a derived figure later disagrees with a
   * provider's own view, this says which side of the subtraction it came from.
   *
   * Optional so existing readings, including operator observations, stay valid unchanged.
   */
  measuredAs?: "remaining" | "used";
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
  /** Digest of the provider's interactive output; raw provider text is never persisted. */
  rawOutputDigest?: string;
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
  /** A packet reviewer must have a provider-issued session id before it is bound. */
  readonly requiresReviewerProviderSessionProof?: boolean;
  /** This adapter can attest that its reviewer effort setting was accepted. */
  readonly supportsReviewerEffortAttestation?: boolean;
  /** Provider may contribute only optional adversarial work, never a required role. */
  readonly optionalAdversarialOnly?: boolean;

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
 * PRD §14.2 — provider failure belongs to a provider operation rather than to a
 * control-plane decision. Blind-review allocation is admitted by `BlindReviewGate`: a
 * bare runtime observer can refresh but cannot deny a `startSession` without turning a
 * capacity decision into an exception.
 *
 * Declared here as a narrow port instead of importing the capacity monitor, because the
 * monitor reads *this* module: the runtime must not depend on the component that measures
 * it. The literal trigger names are the monitor's own `RefreshTrigger` values.
 */
export type RuntimeRefreshTrigger = "PROVIDER_SWITCH_OR_FAILURE";

export interface RuntimeCapacityObserver {
  refresh(trigger: RuntimeRefreshTrigger, providerIds?: readonly string[]): Promise<unknown>;
}

/**
 * Wraps an adapter so provider failures cannot escape without a §14.2 refresh.
 *
 * Handing this wrapper out from the registry is what makes the failure refresh mandatory:
 * the review gate, the CTO lifecycle and the continuity kernel all obtain their adapters
 * from the registry. Blind-review refresh and admission live one layer higher, where a
 * denial can be returned as a stable `Decision` rather than ignored.
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

  get requiresReviewerProviderSessionProof(): boolean | undefined {
    return this.inner.requiresReviewerProviderSessionProof;
  }

  get supportsReviewerEffortAttestation(): boolean | undefined {
    return this.inner.supportsReviewerEffortAttestation;
  }

  get optionalAdversarialOnly(): boolean | undefined {
    return this.inner.optionalAdversarialOnly;
  }

  async startSession(spec: SessionSpec): Promise<SessionHandle> {
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
