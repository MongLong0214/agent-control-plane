import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { CapacityBucket, CapacityReading, ProviderRegistry } from "../runtime/provider.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import { USAGE_PROVIDERS } from "./usage-collectors.ts";

export type AllocationAdmission = "OPEN" | "CONSERVE" | "SUSPENDED";

/**
 * The daemon, not a caller-supplied JSON field, names the operator surface that carried
 * an observation. Keeping this distinct from a collector source lets admission use a
 * current human observation without mistaking an arbitrary local file for one.
 */
export const AGENTCTL_CAPACITY_OBSERVATION_SOURCE = "agentctl capacity observe";

const OPERATOR_OBSERVATION_SOURCE_PREFIX = "operator-observation:v1:";

export interface OperatorObservationProvenance {
  /** Authenticated operator identity supplied by the daemon socket binding. */
  actor: string;
  /** Named surface through which the operator supplied the reading. */
  source: string;
}

/** A human-read quota observation before it enters the normal capacity-reading path. */
export interface OperatorCapacityObservation {
  provider: string;
  observedAt: string;
  buckets: CapacityBucket[];
  runtimeHealth: CapacityReading["runtimeHealth"];
  provenance: OperatorObservationProvenance;
}

/** §14.3 — a bucket is routable only when its remaining quota is a usable number. */
const isRoutableBucket = (
  bucket: { remainingPercent: number | null },
  exhaustedPercent: number,
): boolean => typeof bucket.remainingPercent === "number" && bucket.remainingPercent > exhaustedPercent;

/** The only lower-priority allocation capabilities defined by §14.5. */
const isWorkerCapability = (capability: string): boolean =>
  capability === "worker" || capability === "luna-worker";
/**
 * `UNKNOWN` is not a degree of low. It means no bucket was read at all, and it exists because
 * the absence used to be reported as `EXHAUSTED` — the strongest possible claim about a number
 * nobody had. A grok billing token that expires every six hours produced exactly that: the
 * doctor said the quota was exhausted with `confidence: "HIGH"` and advised waiting for a reset,
 * while the provider was in fact usable and the reset would never come.
 *
 * Routing was never wrong — `allocationAdmission` distinguishes the two and suspends either way.
 * What was wrong is what a reader is told, and a reader acting on "exhausted" waits.
 */
export type AdvisoryCapacityState = "HEALTHY" | "CONSERVE" | "CRITICAL" | "EXHAUSTED" | "UNKNOWN";

export interface ProviderCapacity extends CapacityReading {
  allocationAdmission: AllocationAdmission;
  advisoryState: AdvisoryCapacityState;
  ageMs: number;
  /** Buckets whose remaining quota is unknown. §14.3 forbids routing against these. */
  unknownBuckets: string[];
  /** Present only for a daemon-authenticated operator observation. */
  operatorObservation?: OperatorObservationProvenance;
  /**
   * The collector reading this one was kept in place of, when a probe failed while an
   * unexpired operator observation was current.
   *
   * It exists so that preserving the observation for *admission* cannot also hide the probe
   * failure from anything that reports sensor health. A doctor that showed a healthy sensor
   * because a human had typed a number would be presenting a probe failure as a pass.
   */
  supersededCollectorError?: { source: string; error: string | null };
}

/** PRD §14.2 — the six points at which a refresh is mandatory. */
export const RefreshTrigger = {
  DISPATCH_ADMISSION: "DISPATCH_ADMISSION",
  WORKER_FANOUT: "WORKER_FANOUT",
  BLIND_REVIEW: "BLIND_REVIEW",
  CONTINUITY_EVALUATION: "CONTINUITY_EVALUATION",
  DOCTOR_CAPACITY_REPORT: "DOCTOR_CAPACITY_REPORT",
  PROVIDER_SWITCH_OR_FAILURE: "PROVIDER_SWITCH_OR_FAILURE",
} as const;
export type RefreshTrigger = (typeof RefreshTrigger)[keyof typeof RefreshTrigger];

export interface CapacityOptions {
  /** How long a reading is treated as current. */
  freshnessMs?: number;
  /** Additional grace during which a STALE reading is still usable (§14.3). */
  staleGraceMs?: number;
  conservePercent?: number;
  criticalPercent?: number;
  exhaustedPercent?: number;
  /** Sensor clocks may lead the daemon by this much before their evidence is refused. */
  maxClockSkewMs?: number;
}

const DEFAULTS = {
  freshnessMs: 5 * 60 * 1000,
  staleGraceMs: 15 * 60 * 1000,
  conservePercent: 25,
  criticalPercent: 10,
  exhaustedPercent: 2,
  maxClockSkewMs: 60_000,
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const runtimeHealthIsValid = (value: unknown): value is CapacityReading["runtimeHealth"] =>
  value === "HEALTHY" || value === "DEGRADED" || value === "UNAVAILABLE" || value === "UNKNOWN";

const parseObservationBuckets = (value: unknown): CapacityBucket[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  const buckets: CapacityBucket[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return null;
    const id = candidate["id"];
    const remainingPercent = candidate["remainingPercent"];
    const resetAt = candidate["resetAt"];
    const capabilities = candidate["capabilities"];
    if (typeof id !== "string" || id.trim().length === 0 || ids.has(id)) return null;
    if (
      remainingPercent !== null &&
      (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100)
    ) {
      return null;
    }
    if (
      resetAt !== null &&
      (typeof resetAt !== "string" || !Number.isFinite(new Date(resetAt).getTime()))
    ) {
      return null;
    }
    if (
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.some((capability) => typeof capability !== "string" || capability.trim().length === 0)
    ) {
      return null;
    }
    ids.add(id);
    buckets.push({
      id,
      remainingPercent,
      resetAt,
      capabilities: [...capabilities] as string[],
    });
  }
  return buckets;
};

const parseOperatorObservation = (input: unknown): Decision<OperatorCapacityObservation> => {
  if (!isPlainRecord(input)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "capacity observation must be an object", {});
  }
  const provider = input["provider"];
  const observedAt = input["observedAt"];
  const actor = input["actor"];
  const source = input["source"];
  const runtimeHealth = input["runtimeHealth"];
  if (typeof actor !== "string" || actor.trim().length === 0 || typeof source !== "string" || source.trim().length === 0) {
    return deny(
      ReasonCode.CAPACITY_OBSERVATION_PROVENANCE_REQUIRED,
      "capacity observation requires an authenticated actor and named source",
      {},
    );
  }
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "capacity observation provider is invalid", {});
  }
  if (typeof observedAt !== "string" || !Number.isFinite(new Date(observedAt).getTime())) {
    return deny(ReasonCode.INVALID_ARGUMENT, "capacity observation observedAt is invalid", { provider });
  }
  if (!runtimeHealthIsValid(runtimeHealth)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "capacity observation runtimeHealth is invalid", { provider });
  }
  const buckets = parseObservationBuckets(input["buckets"]);
  if (!buckets) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "capacity observation requires non-empty, well-formed quota buckets",
      { provider },
    );
  }
  return allow(ReasonCode.OK, {
    provider,
    observedAt,
    buckets,
    runtimeHealth,
    provenance: { actor: actor.trim(), source: source.trim() },
  });
};

const storedOperatorObservationSource = (provenance: OperatorObservationProvenance): string =>
  `${OPERATOR_OBSERVATION_SOURCE_PREFIX}${encodeURIComponent(JSON.stringify(provenance))}`;

const operatorObservationFromSource = (source: string): OperatorObservationProvenance | null => {
  if (!source.startsWith(OPERATOR_OBSERVATION_SOURCE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(source.slice(OPERATOR_OBSERVATION_SOURCE_PREFIX.length)));
    if (
      isPlainRecord(parsed) &&
      typeof parsed["actor"] === "string" && parsed["actor"].trim().length > 0 &&
      typeof parsed["source"] === "string" && parsed["source"].trim().length > 0
    ) {
      return { actor: parsed["actor"], source: parsed["source"] };
    }
  } catch {
    // A malformed stored provenance marker is never treated as an operator observation.
  }
  return null;
};

export interface DynamicReserveDemand {
  criticalRoleInvocations: number;
  expectedReviews: number;
  inFlightRuns: number;
  /** Recent observed quota burn; zero is a measured absence of burn, not an unknown input. */
  burnRatePercentPerHour: number;
  /**
   * Current critical-role coverage demand. This stays separate from raw invocation
   * count: a provider must preserve capacity for the roles it may need to cover, not
   * merely for work that has already started.
   */
  roleDemand: {
    ceo: number;
    cto: number;
    reviewer: number;
  };
  /**
   * When a worker allocator has historical readings, use the bucket's own measured
   * burn rather than smoothing a short rolling window into a weekly one. An absent
   * entry is unknown and reserves that bucket completely.
   */
  burnRatePercentPerHourByBucket?: Readonly<Record<string, number>>;
}

/** The allocation selected by the caller after role routing, before it is activated. */
export interface DispatchCapacityTarget {
  provider: string;
  capabilities: readonly string[];
  /** Only lower-priority worker fan-out may consume the dynamic reserve. */
  priority?: "critical" | "worker";
  reserveDemand?: DynamicReserveDemand;
}

/** The exact target a lower-priority worker allocator is about to activate. */
export interface WorkerFanoutCapacityTarget extends DispatchCapacityTarget {
  priority: "worker";
  reserveDemand: DynamicReserveDemand;
}

/** Provider failure has to re-evaluate continuity after the new reading is persisted. */
export interface ProviderFailureContinuity {
  evaluate(reason: string): Promise<unknown>;
}

/**
 * PRD §14.
 *
 * Sensor health, runtime health and allocation admission stay three separate signals
 * because collapsing them loses the case that actually matters: a broken sensor over a
 * healthy runtime. Refresh is event-driven at the six mandatory points rather than
 * polled (§14.2), and a reading that cannot be obtained suspends new allocation instead
 * of routing on an unknown quota (§14.3).
 */
export class CapacityMonitor {
  readonly #options: Required<CapacityOptions>;
  #providerFailureContinuity: ProviderFailureContinuity | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly providers: ProviderRegistry,
    private readonly telemetry: Telemetry,
    options: CapacityOptions = {},
  ) {
    this.#options = { ...DEFAULTS, ...options };
  }

  /**
   * The monitor owns the fresh observation, while the continuity kernel owns the plan
   * derived from it. Keeping this as a narrow port avoids a monitor → kernel import cycle.
   */
  attach(ports: { providerFailureContinuity?: ProviderFailureContinuity }): void {
    if (ports.providerFailureContinuity) this.#providerFailureContinuity = ports.providerFailureContinuity;
  }

  async refresh(trigger: RefreshTrigger, providerIds?: readonly string[]): Promise<ProviderCapacity[]> {
    try {
      const adapters = providerIds
        ? providerIds.map((id) => this.providers.require(id))
        : this.providers.list();

      const readings: ProviderCapacity[] = [];
      for (const adapter of adapters) {
        let reading: CapacityReading;
        try {
          reading = await adapter.probeCapacity();
        } catch (error) {
          // A collector crash is not permission to keep a previous favorable reading.
          // Persist an explicit unknown observation so every allocation path sees
          // SUSPENDED immediately, even when a provider adapter failed before it could
          // construct its own ERROR reading.
          reading = {
            provider: adapter.provider,
            sensorHealth: "ERROR",
            runtimeHealth: "UNKNOWN",
            observedAt: this.clock.nowIso(),
            buckets: [],
            source: "capacity-collector-exception",
            error: error instanceof Error ? error.message : "capacity collector threw a non-error value",
          };
        }
        // A collector ERROR means the sensor could not read quota — it is the absence of
        // information, not information. On a host whose `/usage` surface is not automatable
        // that is the answer *every* time, and the daemon asks every four minutes
        // (`Daemon.refreshCapacitySensors`, again via `ContinuityKernel.evaluate`). Letting
        // it persist over an operator observation that has not yet expired would erase the
        // only reading this deployment can obtain, seconds after it was recorded.
        //
        // This is not a favourable-reading fallback: a *successful* collector reading always
        // wins, because a measurement is better evidence than a recollection, and the
        // observation still expires on the same stale-grace rule with nothing to renew it.
        const preserved = this.observationOutlivingError(reading);
        const enriched = preserved ?? this.record(reading);
        readings.push(enriched);

        if (preserved) {
          // The collector still failed, and that has to stay visible: a silent preservation
          // would make a permanently broken sensor look like a working one for as long as
          // somebody kept refreshing the observation.
          this.telemetry.record({
            scope: "capacity",
            name: "collector_error_over_observation",
            text: preserved.allocationAdmission,
            dims: {
              provider: reading.provider,
              collectorSource: reading.source,
              collectorError: reading.error ?? null,
              observationAgeMs: preserved.ageMs,
              observedBy: preserved.operatorObservation?.actor ?? null,
            },
          });
          this.audit.record({
            kind: "CAPACITY_PROBE",
            reasonCode: ReasonCode.PROBE_FAILED,
            evidence: {
              provider: reading.provider,
              outcome: "collector error did not replace a current operator observation",
              collectorError: reading.error ?? null,
              observationAgeMs: preserved.ageMs,
              staleGraceMs: this.#options.staleGraceMs,
            },
          });
          continue;
        }

        this.telemetry.record({
          scope: "capacity",
          name: "reading",
          text: enriched.allocationAdmission,
          dims: {
            provider: enriched.provider,
            sensorHealth: enriched.sensorHealth,
            runtimeHealth: enriched.runtimeHealth,
            advisoryState: enriched.advisoryState,
            trigger,
            buckets: enriched.buckets.map((b) => ({ id: b.id, remainingPercent: b.remainingPercent })),
          },
        });

        if (enriched.sensorHealth === "ERROR" || enriched.allocationAdmission === "SUSPENDED") {
          this.audit.record({
            kind: "CAPACITY_PROBE",
            reasonCode:
              enriched.sensorHealth === "ERROR"
                ? ReasonCode.PROBE_FAILED
                : ReasonCode.CAPACITY_ADMISSION_SUSPENDED,
            evidence: {
              provider: enriched.provider,
              trigger,
              sensorHealth: enriched.sensorHealth,
              runtimeHealth: enriched.runtimeHealth,
              error: enriched.error ?? null,
            },
          });
        }
      }
      return readings;
    } finally {
      // A provider operation is not handled merely because its failed probe was stored. The
      // persisted facts must immediately drive a fresh coverage plan, otherwise SURVIVAL can
      // remain stale until some unrelated caller happens to ask for continuity (§14.2/§15.6).
      // `finally` matters here: a thrown probe is failure evidence too, not an excuse to
      // leave the previous coverage plan in force.
      if (trigger === RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE && this.#providerFailureContinuity) {
        await this.#providerFailureContinuity.evaluate(
          `capacity refresh after provider switch or allocation failure${providerIds?.length ? `: ${providerIds.join(", ")}` : ""}`,
        );
      }
    }
  }

  /**
   * Records a quota reading an authenticated human saw on their own provider surface.
   *
   * It deliberately creates the same `CapacityReading` a collector would, and sends it
   * through `record()` below, so admission cannot treat the two differently.
   *
   * The `source` must be the daemon's own constant. That is what makes this method unable
   * to mint a routable reading on its own: the actor and the surface are stamped by
   * `Daemon.observeCapacity` from the authenticated socket peer after it has probed runtime
   * health itself, and a caller that supplies its own `source` — the shape a local JSON file
   * would take — is refused here rather than trusted to have been well-behaved.
   */
  async observe(input: unknown): Promise<Decision<ProviderCapacity>> {
    const parsed = parseOperatorObservation(input);
    if (!parsed.allowed) return parsed;
    const observation = parsed.value;
    if (observation.provenance.source !== AGENTCTL_CAPACITY_OBSERVATION_SOURCE) {
      return deny(
        ReasonCode.CAPACITY_OBSERVATION_PROVENANCE_REQUIRED,
        "capacity observation source must be stamped by the daemon operator surface",
        { provider: observation.provider, source: observation.provenance.source },
      );
    }
    if (!this.providers.has(observation.provider)) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "capacity observation provider is not registered",
        { provider: observation.provider },
      );
    }
    const reading: CapacityReading = {
      provider: observation.provider,
      sensorHealth: "HEALTHY",
      runtimeHealth: observation.runtimeHealth,
      observedAt: observation.observedAt,
      buckets: observation.buckets,
      source: observation.provenance.source,
    };
    const enriched = this.record(reading, storedOperatorObservationSource(observation.provenance));

    // A refusal used to stand here for an observation older than the newest stored reading,
    // on the reasoning that `current()` is MAX(observed_at) so such a row would be written
    // and never read. It was removed: `docs/capacity-source.md` instructs the operator to
    // submit the *provider-reported* observedAt, which is necessarily in the past, while the
    // collectors stamp an ERROR every four minutes — so the documented, honest input was
    // rejected, with the very reason code #424 was filed under. When new code refuses the
    // documented path, the new code is what is wrong.
    //
    // The underlying concern is real and still unaddressed: selection is purely
    // MAX(observed_at), so a valid observation can be shadowed by a newer ERROR. Fixing that
    // belongs in selection — a receipt time distinct from the observed time, or a preference
    // for a live observation within its window — not in a refusal at the write boundary.

    const recorded: ProviderCapacity = { ...enriched, operatorObservation: observation.provenance };
    this.telemetry.record({
      scope: "capacity",
      name: "operator_observation",
      text: recorded.allocationAdmission,
      dims: {
        provider: recorded.provider,
        sensorHealth: recorded.sensorHealth,
        runtimeHealth: recorded.runtimeHealth,
        source: observation.provenance.source,
      },
    });
    // An observation changes an input to the coverage judgement, so the judgement is
    // recomputed here rather than left for whoever asks next. This is the same rule the
    // refresh path states for a failed probe, in the opposite direction: on this host every
    // provider is SUSPENDED, which makes every required role uncoverable, which is
    // NO_VALID_COVERAGE and therefore SURVIVAL — and `RunEngine.dispatch` reads that stored
    // mode before it ever looks at capacity. Without this the observation makes capacity
    // routable while dispatch keeps refusing against a mode nothing has revisited.
    if (this.#providerFailureContinuity) {
      await this.#providerFailureContinuity.evaluate(
        `capacity observation recorded for ${recorded.provider}`,
      );
    }

    this.audit.record({
      kind: "CAPACITY_OPERATOR_OBSERVATION",
      reasonCode: ReasonCode.OK,
      actor: observation.provenance.actor,
      evidence: {
        provider: recorded.provider,
        observedAt: recorded.observedAt,
        source: observation.provenance.source,
        runtimeHealth: recorded.runtimeHealth,
        sensorHealth: recorded.sensorHealth,
      },
    });
    return allow(ReasonCode.OK, recorded);
  }

  /**
   * §14.2 first bullet — dispatch admission refreshes first, then decides about the
   * concrete allocation. An omitted target is not a safe substitute for "any healthy
   * provider": it loses the provider and capability facts the caller is about to use.
   */
  async refreshForDispatch(target?: DispatchCapacityTarget): Promise<Decision<void>> {
    return this.refreshForAllocation(RefreshTrigger.DISPATCH_ADMISSION, target, "dispatch");
  }

  /**
   * §14.2/§14.5 — worker fan-out is a separate allocation class. Requiring both the
   * explicit worker priority and measured demand stops a caller from presenting the same
   * lower-priority work as an ordinary dispatch to consume the critical-role reserve.
   */
  async refreshForWorkerFanout(target?: WorkerFanoutCapacityTarget): Promise<Decision<void>> {
    return this.refreshForAllocation(RefreshTrigger.WORKER_FANOUT, target, "worker fan-out");
  }

  /** Mandatory reviewer constitution and every reviewer invocation admit this exact role. */
  async refreshForBlindReview(target?: DispatchCapacityTarget): Promise<Decision<void>> {
    return this.refreshForAllocation(RefreshTrigger.BLIND_REVIEW, target, "blind review");
  }

  /**
   * §14.2 — a continuity replacement is an allocation on a newly selected provider, not
   * merely a coverage calculation. Re-probe and admit the exact replacement target before
   * a fresh session is constituted; a prior CONTINUITY_EVALUATION cannot be treated as a
   * lease across the provider switch.
   */
  async refreshForProviderSwitch(target?: DispatchCapacityTarget): Promise<Decision<void>> {
    return this.refreshForAllocation(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, target, "provider switch");
  }

  private async refreshForAllocation(
    trigger: RefreshTrigger,
    target: DispatchCapacityTarget | undefined,
    operation: string,
  ): Promise<Decision<void>> {
    if (!target) {
      await this.refresh(trigger);
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        `${operation} capacity admission requires an exact allocation target`,
        { target: null },
      );
    }
    if (!this.providers.has(target.provider)) {
      await this.refresh(trigger);
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "the selected provider is not registered",
        { provider: target.provider, capabilities: target.capabilities },
      );
    }
    if (target.capabilities.length === 0) {
      await this.refresh(trigger, [target.provider]);
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        `${operation} capacity admission requires at least one required capability`,
        { provider: target.provider, capabilities: [] },
      );
    }

    // §14.2 says this gate refreshes, so it refreshes — always, including when the newest
    // reading is an operator observation. An earlier version skipped the probe while an
    // observation was current, which made every allocation gate a cache: a collector that
    // had come back and now reported exhaustion could not refuse the run, and a collector
    // that had started working could not be noticed until some unrelated timer called
    // `refresh()`.
    //
    // Skipping is no longer needed for the reason it was introduced. `refresh` itself is
    // what protects an unexpired observation from a collector that cannot read quota, so
    // probing here costs a failed probe and changes nothing — while a probe that *succeeds*
    // is a live measurement, and a live measurement is exactly what this gate exists to ask
    // for.
    const readings = await this.refresh(trigger, [target.provider]);

    const production = readings.filter((r) => this.providers.require(r.provider).isProduction);
    if (production.length === 0) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        `no production provider is registered for ${operation} capacity admission`,
        { target },
      );
    }

    const selected = production.find((reading) => reading.provider === target.provider);
    if (!selected) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "the selected provider is not production-eligible",
        { provider: target.provider, capabilities: target.capabilities },
      );
    }
    if (
      trigger === RefreshTrigger.WORKER_FANOUT &&
      (!target.capabilities.some(isWorkerCapability) || target.priority !== "worker")
    ) {
      return deny(
        ReasonCode.CAPACITY_ADMISSION_CONSERVE,
        "worker fan-out must name a worker capability and worker priority",
        { provider: selected.provider, capabilities: target.capabilities, priority: target.priority ?? null },
      );
    }
    if (
      trigger === RefreshTrigger.BLIND_REVIEW &&
      (!target.capabilities.includes("blind-review") || target.priority !== "critical")
    ) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "blind-review admission must name the critical blind-review capability",
        { provider: selected.provider, capabilities: target.capabilities, priority: target.priority ?? null },
      );
    }
    const unroutable = target.capabilities.filter((capability) => !this.isRoutableFor(selected, capability));
    if (unroutable.length > 0) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "the selected provider lacks current routable capacity for a required capability",
        { provider: selected.provider, capabilities: unroutable, admission: selected.allocationAdmission },
      );
    }

    if (target.capabilities.some(isWorkerCapability) && target.priority !== "worker") {
      return deny(
        ReasonCode.CAPACITY_ADMISSION_CONSERVE,
        "worker allocation must declare worker priority so it cannot bypass the dynamic reserve",
        { provider: selected.provider, capabilities: target.capabilities, priority: target.priority ?? null },
      );
    }

    if (target.priority === "worker") {
      if (!target.reserveDemand) {
        return deny(
          ReasonCode.CAPACITY_ADMISSION_CONSERVE,
          "worker allocation lacks the dynamic-reserve demand needed to protect critical roles",
          { provider: selected.provider, capabilities: target.capabilities },
        );
      }
      const reserves = new Map(
        this.dynamicReserveByBucket(selected, target.reserveDemand).map((reserve) => [reserve.bucketId, reserve.reserve]),
      );
      const applicable = selected.buckets.filter((bucket) =>
        target.capabilities.some((capability) => bucket.capabilities.includes(capability)),
      );
      const constrained = applicable.filter((bucket) => {
        const reserve = reserves.get(bucket.id) ?? 1;
        return bucket.remainingPercent === null || bucket.remainingPercent / 100 <= reserve;
      });
      if (constrained.length > 0) {
        return deny(
          ReasonCode.CAPACITY_ADMISSION_CONSERVE,
          "worker allocation would consume capacity reserved for critical roles",
          {
            provider: selected.provider,
            capabilities: target.capabilities,
            reserves: constrained.map((bucket) => ({ bucketId: bucket.id, reserve: reserves.get(bucket.id) ?? 1 })),
          },
        );
      }
    }

    return allow(ReasonCode.OK, undefined, {
      admitted: [{ provider: selected.provider, admission: selected.allocationAdmission }],
    });
  }

  /**
   * §14.5 production input. Counts are read from durable state immediately before the
   * worker allocator asks for admission; callers cannot manufacture a zero-demand reserve.
   */
  workerReserveDemand(provider: string): DynamicReserveDemand {
    const roles = this.db.all<{ role: string; n: number }>(
      `SELECT role, COUNT(*) AS n
         FROM assignments
        WHERE status = 'ACTIVE'
          AND role IN ('CEO', 'PRIMARY_CTO', 'BOOTSTRAP_CTO', 'BLIND_REVIEWER')
        GROUP BY role`,
    );
    const roleDemand = { ceo: 0, cto: 0, reviewer: 0 };
    for (const row of roles) {
      if (row.role === "CEO") roleDemand.ceo += row.n;
      else if (row.role === "PRIMARY_CTO" || row.role === "BOOTSTRAP_CTO") roleDemand.cto += row.n;
      else if (row.role === "BLIND_REVIEWER") roleDemand.reviewer += row.n;
    }
    const expectedReviews = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM runs r
        WHERE r.state IN ('ACTIVE', 'BLOCKED', 'READY_FOR_CEO_REVIEW', 'REVISION_REQUIRED', 'AWAITING_HUMAN')
          AND NOT EXISTS (
            SELECT 1 FROM run_artifacts a
             WHERE a.run_id = r.run_id AND a.kind = 'BLIND_REVIEW' AND a.superseded = 0
          )`,
    )?.n ?? 0;
    const inFlightRuns = this.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT run_id) AS n FROM task_executions WHERE status = 'RUNNING'`,
    )?.n ?? 0;
    const rates = this.measuredBurnRateByBucket(provider);
    const knownRates = Object.values(rates).filter((rate) => Number.isFinite(rate));
    return {
      criticalRoleInvocations: roleDemand.ceo + roleDemand.cto + roleDemand.reviewer,
      expectedReviews,
      inFlightRuns,
      // The per-bucket map is authoritative when present. This aggregate is retained for
      // callers that need a compact fact and remains unknown when no window was measured.
      burnRatePercentPerHour: knownRates.length > 0 ? Math.max(...knownRates) : Number.NaN,
      roleDemand,
      burnRatePercentPerHourByBucket: rates,
    };
  }

  /** Latest known state for a provider, recomputed from the newest stored buckets. */
  current(provider: string): ProviderCapacity | null {
    const rows = this.db.all<RawCapacity>(
      `SELECT * FROM capacity_snapshots
        WHERE provider = ? AND observed_at = (
          SELECT MAX(observed_at) FROM capacity_snapshots WHERE provider = ?)`,
      [provider, provider],
    );
    if (rows.length === 0) return null;
    const first = rows[0]!;
    const operatorObservation = operatorObservationFromSource(first.source);
    const enriched = this.enrich({
      provider,
      sensorHealth: first.sensor_health,
      runtimeHealth: first.runtime_health,
      observedAt: first.observed_at,
      source: operatorObservation?.source ?? first.source,
      buckets: rows.map((row) => ({
        id: row.bucket_id,
        remainingPercent: row.remaining_percent,
        resetAt: row.reset_at,
        capabilities: JSON.parse(row.capabilities_json) as string[],
      })),
    });
    return operatorObservation ? { ...enriched, operatorObservation } : enriched;
  }

  all(): ProviderCapacity[] {
    return this.providers
      .list()
      .map((adapter) => this.current(adapter.provider))
      .filter((c): c is ProviderCapacity => c !== null);
  }

  /**
   * Providers that can actually serve a capability right now.
   *
   * §14.3 — a bucket whose remaining quota is unknown is not routable. Checking only the
   * capability string would route against `remainingPercent: null` whenever some *other*
   * bucket happened to carry a number.
   */
  providersFor(capability: string): ProviderCapacity[] {
    return this.all().filter(
      (c) =>
        this.providers.require(c.provider).isProduction &&
        c.allocationAdmission !== "SUSPENDED" &&
        c.runtimeHealth !== "UNAVAILABLE" &&
        c.runtimeHealth !== "UNKNOWN" &&
        this.isRoutableFor(c, capability),
    );
  }

  /** Exposed so the coverage planner applies the same routability rule. */
  /**
   * Whether capacity has anything to say about this provider at all.
   *
   * "no capacity reading" and "not covered" are different facts, and reading the first as the
   * second evicts a session whose provider was never quota-managed. The generation-1 CEO is
   * recorded as `provider: "hermes"`, no collector ever writes a snapshot for it, and the
   * reconciliation predicate therefore judged a healthy bound CEO uncovered on every pass.
   */
  manages(provider: string): boolean {
    // Registered adapters, plus every provider capacity has a vocabulary for. The second half
    // matters: a provider named in `UsageProvider` but not yet registered would otherwise land
    // on the "nothing to say" side and be exempted from the reading it genuinely needs. Only a
    // provider capacity was never built to measure — the bootstrap CEO runtime — is exempt.
    return this.providers.has(provider) || (USAGE_PROVIDERS as readonly string[]).includes(provider);
  }

  isRoutableFor(capacity: ProviderCapacity, capability: string): boolean {
    if (capacity.allocationAdmission === "SUSPENDED") return false;
    if (capacity.runtimeHealth === "UNAVAILABLE" || capacity.runtimeHealth === "UNKNOWN") return false;
    const applicable = capacity.buckets.filter((bucket) => bucket.capabilities.includes(capability));
    // Every quota window constraining this capability must be known and usable. A numeric
    // rolling window cannot certify routing when the weekly window for the same role is
    // unknown; buckets for other capabilities are deliberately irrelevant.
    return (
      applicable.length > 0 &&
      applicable.every((bucket) => isRoutableBucket(bucket, this.#options.exhaustedPercent))
    );
  }

  /**
   * §14.5 — priority order is fixed but the reserve is dynamic. The reserve is the
   * share of a bucket withheld from lower-priority demand, derived from how much
   * higher-priority demand is expected before the next reset. No fixed 30%.
   */
  dynamicReserve(
    provider: string,
    demand: DynamicReserveDemand,
  ): number {
    const capacity = this.current(provider);
    if (!capacity) return 1;
    const reserves = this.dynamicReserveByBucket(capacity, demand);
    return reserves.length === 0 ? 1 : Math.max(...reserves.map((reserve) => reserve.reserve));
  }

  /** Per-window reserve facts; callers must not erase distinct reset horizons into one minimum. */
  dynamicReserveByBucket(
    capacity: ProviderCapacity,
    demand: DynamicReserveDemand,
  ): Array<{ bucketId: string; reserve: number }> {
    // Types protect product callers, but evidence crossing a process boundary can still be
    // malformed at runtime. An absent role-demand object is unknown demand, never zero.
    const roleDemand = demand.roleDemand;
    if (!roleDemand) return capacity.buckets.map((bucket) => ({ bucketId: bucket.id, reserve: 1 }));
    const inputs = [
      demand.criticalRoleInvocations,
      demand.expectedReviews,
      demand.inFlightRuns,
      demand.burnRatePercentPerHour,
      roleDemand.ceo,
      roleDemand.cto,
      roleDemand.reviewer,
    ];
    if (inputs.some((input) => !Number.isFinite(input) || input < 0)) {
      // A malformed demand observation is not zero demand. Preserve every window until
      // the caller can provide the measured facts §14.5 requires.
      return capacity.buckets.map((bucket) => ({ bucketId: bucket.id, reserve: 1 }));
    }
    const weighted =
      demand.criticalRoleInvocations * 2 +
      demand.expectedReviews * 3 +
      demand.inFlightRuns +
      roleDemand.ceo * 5 +
      roleDemand.cto * 4 +
      roleDemand.reviewer * 3;
    const nowMs = new Date(this.clock.nowIso()).getTime();
    return capacity.buckets.map((bucket) => {
      // Unknown quota is never imagined as headroom. Lower-priority work must preserve
      // the whole window until a usable observation exists.
      if (bucket.remainingPercent === null) return { bucketId: bucket.id, reserve: 1 };
      const resetMs = bucket.resetAt ? new Date(bucket.resetAt).getTime() : Number.NaN;
      // A lower-priority router cannot manufacture a reset horizon. A missing, malformed,
      // or already elapsed reset must therefore protect the whole bucket until it is
      // observed again with a usable horizon.
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) return { bucketId: bucket.id, reserve: 1 };
      const horizonHours = (resetMs - nowMs) / (60 * 60 * 1000);
      const burn = demand.burnRatePercentPerHourByBucket
        ? (demand.burnRatePercentPerHourByBucket[bucket.id] ?? Number.NaN)
        : demand.burnRatePercentPerHour;
      // A known aggregate cannot certify a different, unmeasured quota window. Preserve
      // that bucket until it has its own burn observation.
      if (!Number.isFinite(burn) || burn < 0) return { bucketId: bucket.id, reserve: 1 };
      const expectedBurn = burn * horizonHours;
      const demandShare = weighted / (weighted + Math.max(1, bucket.remainingPercent));
      const burnShare = expectedBurn / Math.max(1, bucket.remainingPercent + expectedBurn);
      return { bucketId: bucket.id, reserve: Math.min(1, demandShare + burnShare) };
    });
  }

  /**
   * Recent, same-window deltas are the only burn evidence used for a worker reserve. A
   * first observation, a malformed timestamp, or a reset that increased quota is not a
   * measured zero; the caller receives NaN and the corresponding bucket is held back.
   */
  private measuredBurnRateByBucket(provider: string): Record<string, number> {
    const rows = this.db.all<{
      bucket_id: string;
      remaining_percent: number;
      reset_at: string | null;
      observed_at: string;
    }>(
      `SELECT bucket_id, remaining_percent, reset_at, observed_at
         FROM capacity_snapshots
        WHERE provider = ? AND remaining_percent IS NOT NULL
        ORDER BY bucket_id ASC, observed_at DESC`,
      [provider],
    );
    const byBucket = new Map<string, typeof rows>();
    for (const row of rows) {
      const entries = byBucket.get(row.bucket_id) ?? [];
      entries.push(row);
      byBucket.set(row.bucket_id, entries);
    }
    const rates: Record<string, number> = {};
    for (const [bucketId, entries] of byBucket) {
      const latest = entries[0];
      const previous = entries[1];
      if (!latest || !previous || latest.reset_at !== previous.reset_at) {
        rates[bucketId] = Number.NaN;
        continue;
      }
      const latestAt = new Date(latest.observed_at).getTime();
      const previousAt = new Date(previous.observed_at).getTime();
      const elapsedHours = (latestAt - previousAt) / (60 * 60 * 1000);
      if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
        rates[bucketId] = Number.NaN;
        continue;
      }
      // An increase under one reset window is inconsistent evidence. Treating it as no
      // burn would understate reserve, so hold the bucket rather than guessing a rate.
      const consumed = previous.remaining_percent - latest.remaining_percent;
      rates[bucketId] = consumed < 0 ? Number.NaN : consumed / elapsedHours;
    }
    return rates;
  }

  private enrich(input: CapacityReading): ProviderCapacity {
    const observed = new Date(input.observedAt).getTime();
    // An unparsable timestamp is not freshness evidence. NaN arithmetic would otherwise
    // classify it HEALTHY, so it is treated as a sensor error.
    if (!Number.isFinite(observed)) {
      const errored: CapacityReading = {
        ...input,
        sensorHealth: "ERROR",
        error: input.error ?? "capacity reading has no usable observedAt",
      };
      return {
        ...errored,
        allocationAdmission: "SUSPENDED",
        advisoryState: "EXHAUSTED",
        ageMs: Number.POSITIVE_INFINITY,
        unknownBuckets: errored.buckets.map((b) => b.id),
      };
    }
    const now = new Date(this.clock.nowIso()).getTime();
    if (observed > now + this.#options.maxClockSkewMs) {
      return {
        ...input,
        observedAt: this.clock.nowIso(),
        sensorHealth: "ERROR",
        runtimeHealth: "UNKNOWN",
        error: `observedAt exceeds clock-skew allowance by ${observed - now}ms`,
        allocationAdmission: "SUSPENDED",
        advisoryState: "EXHAUSTED",
        ageMs: Number.POSITIVE_INFINITY,
        unknownBuckets: input.buckets.map((bucket) => bucket.id),
      };
    }
    // A small permitted clock lead is normalized before persistence, so it cannot become
    // a future MAX(observed_at) row that hides every later real observation.
    const normalizedObservedAt = observed > now ? this.clock.nowIso() : input.observedAt;
    const ageMs = Math.max(0, now - observed);
    // The monitor decides staleness from the age it can see, so an adapter cannot label a
    // week-old file HEALTHY.
    const reading: CapacityReading = {
      ...input,
      observedAt: normalizedObservedAt,
      sensorHealth:
        input.sensorHealth === "ERROR"
          ? "ERROR"
          : ageMs > this.#options.freshnessMs
            ? "STALE"
            : input.sensorHealth,
    };
    const remaining = reading.buckets
      .map((b) => b.remainingPercent)
      .filter((p): p is number => typeof p === "number");
    const lowest = remaining.length > 0 ? Math.min(...remaining) : null;
    const unknownBuckets = reading.buckets
      .filter((b) => typeof b.remainingPercent !== "number")
      .map((b) => b.id);

    const admission = ((): AllocationAdmission => {
      if (reading.sensorHealth === "ERROR") return "SUSPENDED";
      // An unprobed runtime is not a routable one.
      if (reading.runtimeHealth === "UNAVAILABLE" || reading.runtimeHealth === "UNKNOWN") return "SUSPENDED";
      // A stale reading remains usable only inside the grace window (§14.3).
      if (reading.sensorHealth === "STALE" && ageMs > this.#options.staleGraceMs) return "SUSPENDED";
      if (lowest === null) return "SUSPENDED";
      // Every bucket unknown is the same as no reading at all.
      if (unknownBuckets.length === reading.buckets.length) return "SUSPENDED";
      if (lowest <= this.#options.exhaustedPercent) return "SUSPENDED";
      if (lowest <= this.#options.conservePercent) return "CONSERVE";
      return "OPEN";
    })();

    const advisoryState = ((): AdvisoryCapacityState => {
      // Said before the thresholds, because every one of them is a comparison against a number
      // that does not exist here. `admission` above already treats this case separately; this is
      // the same distinction, kept in the value the reader is shown.
      if (lowest === null) return "UNKNOWN";
      if (unknownBuckets.length === reading.buckets.length) return "UNKNOWN";
      if (lowest <= this.#options.exhaustedPercent) return "EXHAUSTED";
      if (lowest <= this.#options.criticalPercent) return "CRITICAL";
      if (lowest <= this.#options.conservePercent) return "CONSERVE";
      return "HEALTHY";
    })();

    return { ...reading, allocationAdmission: admission, advisoryState, ageMs, unknownBuckets };
  }

  /**
   * The stored operator observation that a failed collector reading must not overwrite, or
   * null when the reading should be persisted normally.
   *
   * Returns null once the observation is past its stale grace: at that point it is no more
   * informative than the ERROR, and the ERROR is the honest record of what the sensor did.
   * Both suspend, so nothing becomes routable either way — this only decides which reason
   * the operator is shown.
   */
  private observationOutlivingError(reading: CapacityReading): ProviderCapacity | null {
    if (reading.sensorHealth !== "ERROR") return null;
    const current = this.current(reading.provider);
    if (!current?.operatorObservation) return null;
    if (current.ageMs > this.#options.staleGraceMs) return null;
    return {
      ...current,
      supersededCollectorError: { source: reading.source, error: reading.error ?? null },
    };
  }

  /** One shared enrichment/persistence path for collectors and operator observations. */
  private record(reading: CapacityReading, persistedSource = reading.source): ProviderCapacity {
    const enriched = this.enrich(reading);
    this.persist(enriched, persistedSource);
    return enriched;
  }

  private persist(reading: CapacityReading, persistedSource = reading.source): void {
    // A reading is one atomic observation. Re-observing at the same instant must
    // replace the whole bucket set — leaving a bucket behind from a previous
    // observation would let a shrunken or failed sensor read as healthy.
    const admission = this.enrich(reading).allocationAdmission;
    this.db.tx(() => {
      this.db.run(`DELETE FROM capacity_snapshots WHERE provider = ? AND observed_at = ?`, [
        reading.provider,
        reading.observedAt,
      ]);
      for (const bucket of reading.buckets) {
        this.db.run(
          `INSERT OR REPLACE INTO capacity_snapshots
             (snapshot_id, provider, bucket_id, remaining_percent, reset_at, capabilities_json,
              sensor_health, runtime_health, allocation_admission, observed_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `${reading.provider}:${bucket.id}:${reading.observedAt}`,
            reading.provider, bucket.id, bucket.remainingPercent, bucket.resetAt,
            JSON.stringify(bucket.capabilities), reading.sensorHealth, reading.runtimeHealth,
            admission, reading.observedAt, persistedSource,
          ],
        );
      }
      if (reading.buckets.length === 0) {
        // A sensor failure is itself evidence and must be recorded, not dropped.
        this.db.run(
          `INSERT OR REPLACE INTO capacity_snapshots
             (snapshot_id, provider, bucket_id, remaining_percent, reset_at, capabilities_json,
              sensor_health, runtime_health, allocation_admission, observed_at, source)
           VALUES (?, ?, '__none__', NULL, NULL, '[]', ?, ?, 'SUSPENDED', ?, ?)`,
          [
            `${reading.provider}:__none__:${reading.observedAt}`,
            reading.provider, reading.sensorHealth, reading.runtimeHealth,
            reading.observedAt, persistedSource,
          ],
        );
      }
    });
  }
}

interface RawCapacity {
  provider: string;
  bucket_id: string;
  remaining_percent: number | null;
  reset_at: string | null;
  capabilities_json: string;
  sensor_health: CapacityReading["sensorHealth"];
  runtime_health: CapacityReading["runtimeHealth"];
  allocation_admission: AllocationAdmission;
  observed_at: string;
  source: string;
}
