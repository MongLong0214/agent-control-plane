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
  /** Recent observed quota burn; zero is a measured absence of burn, not an unknown bucket. */
  burnRatePercentPerHour?: number;
}

/** The allocation selected by the caller after role routing, before it is activated. */
export interface DispatchCapacityTarget {
  provider: string;
  capabilities: readonly string[];
  /** Only lower-priority worker fan-out may consume the dynamic reserve. */
  priority?: "critical" | "worker";
  reserveDemand?: DynamicReserveDemand;
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

  async refresh(trigger: RefreshTrigger, providerIds?: readonly string[]): Promise<ProviderCapacity[]> {
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
  }

  /**
   * §14.2 first bullet — dispatch admission refreshes first, then decides. Admission is
   * granted when at least one production provider can still serve the roles a run
   * needs; if every production sensor is unusable the answer is suspend, not guess.
   */
  async refreshForDispatch(target?: DispatchCapacityTarget): Promise<Decision<void>> {
    const readings = await this.refresh(
      RefreshTrigger.DISPATCH_ADMISSION,
      target ? [target.provider] : undefined,
    );
    const production = readings.filter((r) => this.providers.require(r.provider).isProduction);
    if (production.length === 0) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "no production provider is registered for dispatch admission",
        { target: target ?? null },
      );
    }

    if (target) {
      const selected = production.find((reading) => reading.provider === target.provider);
      if (!selected) {
        return deny(
          ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
          "the selected provider is not production-eligible",
          { provider: target.provider, capabilities: target.capabilities },
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
      if (target.priority === "worker") {
        const reserve = this.dynamicReserve(selected.provider, target.reserveDemand ?? {
          criticalRoleInvocations: 0,
          expectedReviews: 0,
          inFlightRuns: 0,
        });
        const applicable = selected.buckets.filter((bucket) => target.capabilities.some((c) => bucket.capabilities.includes(c)));
        if (applicable.some((bucket) => bucket.remainingPercent === null || bucket.remainingPercent / 100 <= reserve)) {
          return deny(
            ReasonCode.CAPACITY_ADMISSION_CONSERVE,
            "worker allocation would consume capacity reserved for critical roles",
            { provider: selected.provider, reserve, capabilities: target.capabilities },
          );
        }
      }
      return allow(ReasonCode.OK, undefined, {
        admitted: [{ provider: selected.provider, admission: selected.allocationAdmission }],
      });
    }

    const usable = production.filter((r) => r.allocationAdmission !== "SUSPENDED");
    if (usable.length === 0) {
      const failed = production.filter((r) => r.sensorHealth === "ERROR");
      return deny(
        failed.length > 0 ? ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE : ReasonCode.CAPACITY_ADMISSION_SUSPENDED,
        "no production provider can admit new allocation",
        {
          providers: production.map((r) => ({
            provider: r.provider,
            sensorHealth: r.sensorHealth,
            runtimeHealth: r.runtimeHealth,
            admission: r.allocationAdmission,
            error: r.error ?? null,
          })),
        },
      );
    }
    return allow(ReasonCode.OK, undefined, {
      admitted: usable.map((r) => ({ provider: r.provider, admission: r.allocationAdmission })),
    });
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
    const weighted =
      demand.criticalRoleInvocations * 2 + demand.expectedReviews * 3 + demand.inFlightRuns;
    const nowMs = new Date(this.clock.nowIso()).getTime();
    const burn = Math.max(0, demand.burnRatePercentPerHour ?? 0);
    return capacity.buckets.map((bucket) => {
      // Unknown quota is never imagined as headroom. Lower-priority work must preserve
      // the whole window until a usable observation exists.
      if (bucket.remainingPercent === null) return { bucketId: bucket.id, reserve: 1 };
      const resetMs = bucket.resetAt ? new Date(bucket.resetAt).getTime() : Number.NaN;
      // A source without a reset horizon is treated conservatively as a one-day window;
      // it remains dynamic with measured burn instead of pretending the quota never resets.
      const horizonHours = Number.isFinite(resetMs)
        ? Math.max(0, (resetMs - nowMs) / (60 * 60 * 1000))
        : 24;
      const expectedBurn = burn * horizonHours;
      const demandShare = weighted / (weighted + Math.max(1, bucket.remainingPercent));
      const burnShare = expectedBurn / Math.max(1, bucket.remainingPercent + expectedBurn);
      return {
        bucketId: bucket.id,
        // Preserve a modest floor even when there is no current critical demand. This is
        // a guard band for the next mandatory review rather than a fixed global reserve.
        reserve: Math.max(0.05, Math.min(0.95, demandShare + burnShare)),
      };
    });
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
