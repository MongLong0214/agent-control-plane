import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { CapacityReading, ProviderRegistry } from "../runtime/provider.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";

export type AllocationAdmission = "OPEN" | "CONSERVE" | "SUSPENDED";
export type AdvisoryCapacityState = "HEALTHY" | "CONSERVE" | "CRITICAL" | "EXHAUSTED";

export interface ProviderCapacity extends CapacityReading {
  allocationAdmission: AllocationAdmission;
  advisoryState: AdvisoryCapacityState;
  ageMs: number;
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
}

const DEFAULTS = {
  freshnessMs: 5 * 60 * 1000,
  staleGraceMs: 15 * 60 * 1000,
  conservePercent: 25,
  criticalPercent: 10,
  exhaustedPercent: 2,
};

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
      this.persist(reading);
      const enriched = this.enrich(reading);
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
  async refreshForDispatch(): Promise<Decision<void>> {
    const readings = await this.refresh(RefreshTrigger.DISPATCH_ADMISSION);
    const production = readings.filter((r) => this.providers.require(r.provider).isProduction);
    if (production.length === 0) return allow(ReasonCode.OK, undefined);

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

  /** Providers whose buckets advertise a capability and can still be allocated. */
  providersFor(capability: string): ProviderCapacity[] {
    return this.all().filter(
      (c) =>
        c.allocationAdmission !== "SUSPENDED" &&
        c.runtimeHealth !== "UNAVAILABLE" &&
        c.buckets.some((b) => b.capabilities.includes(capability)),
    );
  }

  /**
   * §14.5 — priority order is fixed but the reserve is dynamic. The reserve is the
   * share of a bucket withheld from lower-priority demand, derived from how much
   * higher-priority demand is expected before the next reset. No fixed 30%.
   */
  dynamicReserve(
    provider: string,
    demand: { criticalRoleInvocations: number; expectedReviews: number; inFlightRuns: number },
  ): number {
    const capacity = this.current(provider);
    if (!capacity) return 1;
    const weighted =
      demand.criticalRoleInvocations * 2 + demand.expectedReviews * 3 + demand.inFlightRuns;
    const headroom = Math.min(
      ...capacity.buckets.map((b) => b.remainingPercent ?? 100),
      100,
    );
    if (headroom <= 0) return 1;
    // Reserve grows with demand and shrinks with headroom; clamped so it can never
    // consume the whole bucket or vanish entirely.
    return Math.max(0.05, Math.min(0.9, weighted / (weighted + headroom)));
  }

  private enrich(reading: CapacityReading): ProviderCapacity {
    const ageMs = Math.max(
      0,
      new Date(this.clock.nowIso()).getTime() - new Date(reading.observedAt).getTime(),
    );
    const remaining = reading.buckets
      .map((b) => b.remainingPercent)
      .filter((p): p is number => typeof p === "number");
    const lowest = remaining.length > 0 ? Math.min(...remaining) : null;

    const admission = ((): AllocationAdmission => {
      if (reading.sensorHealth === "ERROR") return "SUSPENDED";
      if (reading.runtimeHealth === "UNAVAILABLE") return "SUSPENDED";
      // A stale reading remains usable only inside the grace window (§14.3).
      if (reading.sensorHealth === "STALE" && ageMs > this.#options.staleGraceMs) return "SUSPENDED";
      if (lowest === null) return "SUSPENDED";
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

    return { ...reading, allocationAdmission: admission, advisoryState, ageMs };
  }

  private persist(reading: CapacityReading): void {
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
          this.enrich(reading).allocationAdmission, reading.observedAt, reading.source,
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
