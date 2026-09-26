import type { Role } from "../domain/types.ts";

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
  /**
   * The socket neither connected nor was refused by the sandbox — it timed out, or the name
   * never resolved. Distinct from `blocked: false`, which used to carry this case and made a
   * probe that could not tell indistinguishable from one that watched the socket open.
   */
  indeterminate?: boolean;
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
    /**
     * Narrow on purpose: provisioning may fail for exactly two reasons a caller can act on.
     *
     * `ISOLATION_LOST` is the boundary itself — no isolation proof, no egress evidence, or a
     * non-zero exit before either could be established. The other two are failures *after* that
     * boundary was proved, and they send an operator somewhere else than the sandbox:
     * `REVIEWER_SESSION_HANDSHAKE_TIMEOUT` is the reviewer answering nothing, which points at the
     * credential and the provider; `REVIEWER_SESSION_UNREADABLE_ANSWER` is the reviewer answering
     * in a shape with no resumable session id in it, which points at the provider's output
     * contract. Widening this to `ReasonCode` would let any code arrive here and leave the caller
     * nothing to branch on.
     */
    readonly reasonCode:
      | typeof ReasonCode.ISOLATION_LOST
      | typeof ReasonCode.REVIEWER_SESSION_HANDSHAKE_TIMEOUT
      | typeof ReasonCode.REVIEWER_SESSION_UNREADABLE_ANSWER,
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
  /**
   * The path this adapter will hand to `execve` — the pin, exactly as the adapter holds it.
   *
   * Optional because most adapters spawn nothing: `ScriptedAdapter` answers from a queued script,
   * and an absent value means "this adapter has no executable", never "its executable is fine".
   * A reader that stats this must not canonicalise it first. The pin is what an operator set and
   * what an operator repairs, and #954's case — a stable name whose versioned target the
   * provider's own updater pruned — has no realpath left to report.
   */
  readonly executablePath?: string;

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

  /**
   * Forwarded, and not optional to forward. `list()`/`production()` hand out this wrapper, so
   * every caller that asks the registry for a provider asks *this* object. A wrapper that did not
   * carry the pin would answer `undefined` for all three CLI adapters, and `undefined` is read as
   * "no executable" — the doctor's readback would then be silent on exactly the deployment it
   * exists for, with nothing failing anywhere to say so.
   */
  get executablePath(): string | undefined {
    return this.inner.executablePath;
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

/**
 * `(provider, role)` as one key. NUL because it cannot occur in either part, so no provider name
 * plus role can collide with a different pair — the classic separator bug this avoids by picking a
 * byte the inputs cannot contain rather than one that merely looks unlikely.
 */
const roleScopedKey = (provider: string, role: Role): string => `${provider}\u0000${role}`;

export interface RoleCapacityBinding {
  readonly provider: string;
  readonly role: Role;
  readonly generation: number;
  readonly adapter: ProviderAdapter;
}

export class ProviderRegistry {
  readonly #capacityBindings = new Map<string, RoleCapacityBinding>();
  #capacityGeneration = 0;
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #roleScoped = new Map<string, ProviderAdapter>();
  #capacity: RuntimeCapacityObserver | null = null;

  /**
   * §14.2 — routes every adapter this registry hands out through the refresh wrapper.
   * Wired by the composition root; until it is, adapters are returned unwrapped so that a
   * unit exercise of the registry itself does not need a capacity monitor.
   */
  attachCapacity(capacity: RuntimeCapacityObserver): void {
    this.#capacity = capacity;
  }

  /**
   * A role-scoped registration, for a provider whose adapter must differ by who is using it.
   *
   * #512. One `ClaudeCliAdapter` served every role, and its `providerCredentialDir` came from
   * `ACP_CLAUDE_REVIEWER_CONFIG_DIR` — the blind reviewer's scope, which exists so a review runs
   * under an identity that cannot read the producer's transcript store. Every caller shared it,
   * so the probe asking whether the *CTO* session was alive authenticated as the reviewer and the
   * dispatch refused with `SESSION_NOT_READY`, naming the session for a failure about identity.
   *
   * Keyed by `(provider, role)` rather than by provider. `insert` already refuses a duplicate
   * provider, so two Claude adapters could not both be registered under the old key — the failure
   * would have been a throw at composition rather than one silently overwriting the other, and
   * neither is the behaviour wanted.
   */
  registerForRole(adapter: ProviderAdapter, role: Role): void {
    if (!adapter.isProduction) {
      throw new Error(`non-production adapter '${adapter.provider}' cannot be registered for production`);
    }
    const key = roleScopedKey(adapter.provider, role);
    if (this.#roleScoped.has(key)) {
      throw new Error(`provider '${adapter.provider}' is already registered for role '${role}'`);
    }
    this.#roleScoped.set(key, adapter);
    this.#capacityBindings.set(key, Object.freeze({
      provider: adapter.provider, role, generation: ++this.#capacityGeneration, adapter,
    }));
  }

  /**
   * Explicit scope-change notification. This generation is process-local registration
   * evidence, NOT automatic detection of a credential/account change. The owner must
   * invalidate before changing scope; a fresh probe is required before reusing capacity.
   */
  invalidateCapacityForRole(provider: string, role: Role): void {
    const binding = this.capacityBindingForRole(provider, role);
    if (!binding) return;
    this.#capacityBindings.set(roleScopedKey(provider, role), Object.freeze({
      ...binding, generation: ++this.#capacityGeneration,
    }));
  }

  /** Capacity never falls back to a default or another role's adapter. */
  capacityBindingForRole(provider: string, role: Role): RoleCapacityBinding | null {
    return this.#capacityBindings.get(roleScopedKey(provider, role)) ?? null;
  }

  /**
   * The adapter for this provider *in this role*.
   *
   * Falls back to an unscoped registration, which is what a provider with no role-specific
   * identity has. It does **not** fall back the other way: asking for a provider that has
   * role-scoped adapters without naming a role is refused by `require`, because picking one of
   * them arbitrarily is how the identity confusion above happened.
   */
  requireForRole(provider: string, role: Role): ProviderAdapter {
    const scoped = this.#roleScoped.get(roleScopedKey(provider, role));
    if (scoped) return this.observed(scoped);
    const shared = this.#adapters.get(provider);
    if (!shared) {
      throw new Error(`no adapter registered for provider '${provider}' in role '${role}'`);
    }
    return this.observed(shared);
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

  /**
   * Refuses on the same terms as `require`, and for a sharper reason: this one answers `null` for
   * "not registered", and callers read that as a refusal they can report. Returning `null` for
   * "registered, but you did not say as whom" would make an ambiguity indistinguishable from an
   * absence — the caller would deny with `NOT_FOUND` and nobody would learn that an identity was
   * there to be chosen. The first version of this unit guarded only `require` and left that hole;
   * `cto-lifecycle.ts:838` and `:944` both reach the registry through `get`.
   */
  get(provider: string): ProviderAdapter | null {
    if (this.hasRoleScoped(provider)) {
      throw new Error(
        `provider '${provider}' has role-scoped adapters; use requireForRole(provider, role)`,
      );
    }
    const adapter = this.#adapters.get(provider);
    return adapter ? this.observed(adapter) : null;
  }

  /**
   * Refuses when the provider has role-scoped adapters. Answering here would mean choosing one of
   * them for a caller that did not say which identity it is acting as, and that choice is exactly
   * what #512 got wrong.
   *
   * This used to add that a role-less caller "keeps working, because such providers have no
   * role-scoped registration to be ambiguous about". That sentence was false the moment #917
   * registered Claude per role, and being written down is what made the gap look closed: the
   * capacity monitor does not call this, it calls `list()`, and `list()` had lost the provider
   * entirely. A role-less caller that wants the provider *set* uses `list()`, which enumerates
   * role-scoped providers too; one that wants an adapter to act through still has to say which
   * role it is acting as.
   */
  require(provider: string): ProviderAdapter {
    if (this.hasRoleScoped(provider)) {
      throw new Error(
        `provider '${provider}' has role-scoped adapters; use requireForRole(provider, role)`,
      );
    }
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new Error(`no adapter registered for provider '${provider}'`);
    return this.observed(adapter);
  }

  /** Whether any role-scoped adapter exists for this provider. */
  hasRoleScoped(provider: string): boolean {
    for (const key of this.#roleScoped.keys()) {
      if (key.startsWith(`${provider}\u0000`)) return true;
    }
    return false;
  }

  /**
   * Every provider this deployment has, once each — **not** which adapter answers for a role.
   *
   * Those are two different questions and this method answers only the first. `require`/`get`
   * answer the second and refuse without a role, deliberately; enumerating has no such ambiguity
   * to refuse, because a provider is present or it is not.
   *
   * Reading `#adapters` alone was correct until a provider existed *only* under role-scoped keys.
   * #917 made that real — the CTO and reviewer Claude adapters are registered per role and never
   * unscoped — and `list()` silently lost `claude`. Measured on that head: the production default
   * registry returned `['gpt','grok']`, and the failure reached past the test. Every consumer of
   * `list()`/`production()` asks for the provider *set*:
   *
   *   capacity-monitor.ts   which providers to collect capacity for
   *   daemon.ts             providerCount, and the sweep budget derived from its length
   *   continuity-kernel.ts  `.map(a => a.provider)` twice, for coverage
   *   doctor.ts             `adapter.provider`, for capacity-file age
   *
   * None of them dispatches work through the adapter, so none of them needs the role-correct one.
   * They need to know `claude` is here.
   *
   * Deduplicated by provider, and that is not an implementation detail: the two Claude adapters
   * share one `capacityFile`, so enumerating both would collect the same provider's capacity twice
   * and inflate `providerCount` and the sweep budget with it. The unscoped registration wins when
   * both exist, because a deployment that registered one unscoped said which adapter represents
   * the provider.
   */
  /**
   * One adapter that stands for this provider, role-scoped or not — for **provider-level facts
   * only**, never to act through.
   *
   * `require`/`get` refuse without a role on purpose: choosing an identity for a caller that did
   * not name one is what #512 got wrong. But several callers do not want an identity at all. They
   * want `isProduction`, or whether the provider can be probed for liveness — facts that are true
   * of the provider, not of the role. Before this existed they called `require()` and got the
   * refusal, and the refusal then had to be swallowed somewhere: `daemon.ts` caught it and recorded
   * `runtimeHealth: "UNAVAILABLE"`, so *you asked without a role* was persisted as *this provider
   * is dead*, permanently and with no error anywhere.
   *
   * Separating the two questions is what keeps that from happening again. A caller that wants to
   * dispatch still has to say which role it is acting as, and this returns nothing it could
   * legitimately dispatch with — the docstring is the contract, and `requireForRole` is the door.
   */
  representative(provider: string): ProviderAdapter | null {
    const shared = this.#adapters.get(provider);
    if (shared) return this.observed(shared);
    for (const [key, adapter] of this.#roleScoped) {
      if (key.startsWith(`${provider}\u0000`)) return this.observed(adapter);
    }
    return null;
  }

  list(): ProviderAdapter[] {
    const byProvider = new Map<string, ProviderAdapter>(this.#adapters);
    for (const adapter of this.#roleScoped.values()) {
      if (!byProvider.has(adapter.provider)) byProvider.set(adapter.provider, adapter);
    }
    return [...byProvider.values()].map((adapter) => this.observed(adapter));
  }

  /**
   * Adapters eligible for real work **without a role named**. Excludes anything that fabricates
   * responses, and excludes role-scoped providers.
   *
   * This is the shared production inventory, and a role-scoped provider is deliberately not in it:
   * its adapters exist per identity, so answering "use this one" to a caller that named no role is
   * the choice #512 got wrong. Coverage for such a provider comes through its role binding
   * (`capacityBindingForRole`, continuity-kernel.ts:549), which is what
   * `covers a bound role-only provider absent from the shared production inventory` pins.
   *
   * `list()` is the other question and keeps the other answer: it enumerates every provider this
   * deployment has, role-scoped included, because `providerCount`, the sweep budget derived from
   * its length, and doctor's per-provider reads are facts about the provider set and go wrong when
   * a provider silently leaves it. #917 collapsed the two — role-scoped Claude vanished from both
   * — and the two tests that disagreed about it were each right about their own question.
   */
  production(): ProviderAdapter[] {
    return this.list().filter((a) => a.isProduction && !this.hasRoleScoped(a.provider));
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
