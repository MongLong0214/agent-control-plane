import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { CapacityReading, ProviderRegistry } from "../runtime/provider.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";

export type AllocationAdmission = "OPEN" | "CONSERVE" | "SUSPENDED";

/** §14.3 — a bucket is routable only when its remaining quota is a usable number. */
const isRoutableBucket = (
  bucket: { remainingPercent: number | null },
  exhaustedPercent: number,
): boolean => typeof bucket.remainingPercent === "number" && bucket.remainingPercent > exhaustedPercent;

/** The only lower-priority allocation capabilities defined by §14.5. */
const isWorkerCapability = (capability: string): boolean =>
  capability === "worker" || capability === "luna-worker";
export type AdvisoryCapacityState = "HEALTHY" | "CONSERVE" | "CRITICAL" | "EXHAUSTED";

export interface ProviderCapacity extends CapacityReading {
  allocationAdmission: AllocationAdmission;
  advisoryState: AdvisoryCapacityState;
  ageMs: number;
  /** Buckets whose remaining quota is unknown. §14.3 forbids routing against these. */
  unknownBuckets: string[];
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
        const reading = await adapter.probeCapacity();
        const enriched = this.enrich(reading);
        this.persist(enriched);
        readings.push(enriched);

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
    return this.enrich({
      provider,
      sensorHealth: first.sensor_health,
      runtimeHealth: first.runtime_health,
      observedAt: first.observed_at,
      source: first.source,
      buckets: rows.map((row) => ({
        id: row.bucket_id,
        remainingPercent: row.remaining_percent,
        resetAt: row.reset_at,
        capabilities: JSON.parse(row.capabilities_json) as string[],
      })),
    });
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
      if (lowest === null) return "EXHAUSTED";
      if (lowest <= this.#options.exhaustedPercent) return "EXHAUSTED";
      if (lowest <= this.#options.criticalPercent) return "CRITICAL";
      if (lowest <= this.#options.conservePercent) return "CONSERVE";
      return "HEALTHY";
    })();

    return { ...reading, allocationAdmission: admission, advisoryState, ageMs, unknownBuckets };
  }

  private persist(reading: CapacityReading): void {
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
            admission, reading.observedAt, reading.source,
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
            reading.observedAt, reading.source,
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
