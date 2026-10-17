import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { withAccountDigest } from "../../src/capacity/usage-collectors.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * Review round 1 of #1099/#1101, the reviewer's two blocker reproductions, kept as written apart
 * from paths, isolation (every database lives under `tempDir`) and lint.
 *
 * ACP-S2-R1-01: a registration generation is process-local and restarts at the same number, so it
 * is not an account identity. Account A's persisted reading must not complete account B's burn.
 *
 * ACP-S2-R1-02: an `observed_at` the old writer stored without a parseable time must not let an
 * older healthy row become the current reading.
 */
const CTO_ROLES = [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER] as const;
const START = "2026-08-12T00:00:00.000Z";
const RESET_AT = "2026-08-12T05:00:00.000Z";

const reading = (clock: ManualClock, remainingPercent: number): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "restart-fixture",
  buckets: [{ id: "five_hour", remainingPercent, resetAt: RESET_AT, capabilities: ["cto", "ceo", "blind-review", "worker"] }],
});

const boot = (clock: ManualClock, root = tempDir("acp-review-s2-r1-"), roles: readonly Role[] = CTO_ROLES) => {
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [],
  });
  const claude = new TestProductionAdapter(clock, "claude");
  for (const role of roles) cp.providers.registerForRole(claude, role);
  return { cp, claude, root };
};

describe("review scope identity and legacy rows", () => {
  it("a different account with the same registration order and reset time cannot restore account A", async () => {
    const clock = new ManualClock(START);
    const first = boot(clock);
    // Account A and B are distinct credential scopes exposed by separate adapters. Their weekly
    // reset time is shared, which is possible for independent subscription accounts.
    first.claude.setCapacity({ ...reading(clock, 81), source: "credential-scope-account-A" });
    expect((await first.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode)
      .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    const generationA = first.cp.providers.capacityBindingForRole("claude", Role.WORKER)!.generation;
    // An explicit withdrawal before shutdown must also survive a process restart.
    first.cp.providers.invalidateCapacityForRole("claude", Role.WORKER);
    expect(first.cp.providers.capacityBindingForRole("claude", Role.WORKER)!.generation).not.toBe(generationA);
    first.cp.close();
    clock.advance(120000);
    const accountB = boot(clock, first.root);
    expect(accountB.claude).not.toBe(first.claude);
    accountB.claude.setCapacity({ ...reading(clock, 80), source: "credential-scope-account-B" });
    const generationB = accountB.cp.providers.capacityBindingForRole("claude", Role.WORKER)!.generation;
    expect(generationB).toBe(generationA);
    try {
      const actual = await accountB.cp.tasks.admitWorkerFanout("claude", "opus");
      expect(actual.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    } finally {
      accountB.cp.close();
    }
  });

  it("a malformed observation persisted by the old writer cannot revive a previous healthy reading", () => {
    const clock = new ManualClock(START);
    const p = boot(clock);
    const gpt = new TestProductionAdapter(clock, "gpt");
    p.cp.providers.register(gpt);
    const rows = [
      { at: new Date(Date.parse(START) - 60000).toISOString(), health: "HEALTHY", quota: 90 },
      { at: START, health: "HEALTHY", quota: 80 },
      // The base writer stores this spelling after enrich marks it ERROR; no schema constraint.
      { at: "not-a-date", health: "ERROR", quota: 80 },
    ];
    for (const r of rows) {
      p.cp.db.run(
        `INSERT INTO capacity_snapshots
          (snapshot_id,provider,bucket_id,remaining_percent,reset_at,capabilities_json,sensor_health,
           runtime_health,allocation_admission,observed_at,source) VALUES (?, 'gpt','weekly',?,?,'["cto"]',?,'HEALTHY',?,?, 'legacy-collector')`,
        ["legacy:" + r.at, r.quota, RESET_AT, r.health, r.health === "ERROR" ? "SUSPENDED" : "OPEN", r.at],
      );
    }
    clock.advance(60000);
    try {
      const actual = p.cp.capacity.current("gpt");
      expect(actual?.allocationAdmission).toBe("SUSPENDED");
    } finally {
      p.cp.close();
    }
  });
});

/**
 * ACP-S2-R1-02, upgrade state: rows stored by the writer before #1101, read by the current code after
 * a restart onto the same database. The rule (`CapacityMonitor.newestObservedAt`): a row whose time
 * does not parse is placed by the order it was stored in; stored after the newest parseable reading,
 * it is the current reading (an ERROR, SUSPENDED) and burn is unknown, and only a reading stored after
 * it supersedes it.
 */
describe("ACP-S2-R1-02: legacy rows with an unparseable observed_at, after an upgrade", () => {
  const LEGACY_ROWS = [
    { at: new Date(Date.parse(START) - 60000).toISOString(), health: "HEALTHY", quota: 90 },
    { at: START, health: "HEALTHY", quota: 80 },
    { at: "not-a-date", health: "ERROR", quota: 80 },
  ];

  /** A database the old writer left `rows` in, in that storage order, reopened by the current code. */
  const upgraded = (clock: ManualClock, rows: typeof LEGACY_ROWS) => {
    const old = boot(clock);
    for (const r of rows) {
      old.cp.db.run(
        `INSERT INTO capacity_snapshots
          (snapshot_id,provider,bucket_id,remaining_percent,reset_at,capabilities_json,sensor_health,
           runtime_health,allocation_admission,observed_at,source) VALUES (?, 'gpt','weekly',?,?,'["cto"]',?,'HEALTHY',?,?, 'legacy-collector')`,
        ["gpt:weekly:" + r.at, r.quota, RESET_AT, r.health, r.health === "ERROR" ? "SUSPENDED" : "OPEN", r.at],
      );
    }
    old.cp.close();
    clock.advance(60000);
    const p = boot(clock, old.root);
    const gpt = new TestProductionAdapter(clock, "gpt");
    p.cp.providers.register(gpt);
    return { ...p, gpt };
  };

  const burnOf = (p: ReturnType<typeof upgraded>) => p.cp.capacity.workerReserveDemand("gpt");

  it("stored last, the unparseable row is the current reading: SUSPENDED, not routed, burn unknown", () => {
    const p = upgraded(new ManualClock(START), LEGACY_ROWS);
    try {
      expect(p.cp.capacity.current("gpt")?.allocationAdmission).toBe("SUSPENDED");
      expect(p.cp.capacity.providersFor("cto").map((r) => r.provider)).not.toContain("gpt");
      expect(burnOf(p).burnRatePercentPerHour).toBeNaN();
      expect(Number.isFinite(burnOf(p).burnRatePercentPerHourByBucket?.["weekly"])).toBe(false);
    } finally {
      p.cp.close();
    }
  });

  it("stored before the healthy rows, it is superseded by them: the order decides, not the text", () => {
    const p = upgraded(new ManualClock(START), [LEGACY_ROWS[2]!, LEGACY_ROWS[0]!, LEGACY_ROWS[1]!]);
    try {
      const current = p.cp.capacity.current("gpt")!;
      expect(current.observedAt).toBe(START);
      expect(current.allocationAdmission).toBe("OPEN");
      expect(burnOf(p).burnRatePercentPerHourByBucket?.["weekly"]).toBeCloseTo(600);
    } finally {
      p.cp.close();
    }
  });

  it("a reading the current writer stores after it supersedes it", async () => {
    const clock = new ManualClock(START);
    const p = upgraded(clock, LEGACY_ROWS);
    try {
      p.gpt.setCapacity({
        provider: "gpt",
        sensorHealth: "HEALTHY",
        runtimeHealth: "HEALTHY",
        observedAt: clock.nowIso(),
        source: "current-collector",
        buckets: [{ id: "weekly", remainingPercent: 79, resetAt: RESET_AT, capabilities: ["cto"] }],
      });
      await p.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
      const current = p.cp.capacity.current("gpt")!;
      expect(current.observedAt).toBe(clock.nowIso());
      expect(current.allocationAdmission).toBe("OPEN");
      // 80% at 00:00, 79% at 00:01: one point a minute.
      expect(burnOf(p).burnRatePercentPerHourByBucket?.["weekly"]).toBeCloseTo(60);
    } finally {
      p.cp.close();
    }
  });
});

/**
 * ACP-S2-R1-01, durable invalidation: an explicit `invalidateCapacityForRole` withdraws every reading
 * taken before it, and a restart must not bring one back, even for the same account. The
 * invalidation is recorded (CAPACITY_ROLE_INVALIDATED) and restoration refuses any observation that
 * does not postdate the latest one for the provider and role.
 */
describe("ACP-S2-R1-01: an explicit invalidation survives a restart", () => {
  const ACCOUNT = sha256("fixture account A");
  const sameAccount = (clock: ManualClock, remainingPercent: number): CapacityReading => ({
    ...reading(clock, remainingPercent),
    source: withAccountDigest("restart-fixture", ACCOUNT),
  });
  const notRestored = (cp: ControlPlane) =>
    cp.audit.byKind("CAPACITY_ROLE_OBSERVATION_NOT_RESTORED").map((row) => row.evidence["reason"]);

  it("same account: invalidated before shutdown, the reading is not restored after the restart", async () => {
    const clock = new ManualClock(START);
    const first = boot(clock);
    first.claude.setCapacity(sameAccount(clock, 81));
    expect((await first.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode)
      .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    clock.advance(1000);
    first.cp.providers.invalidateCapacityForRole("claude", Role.WORKER);
    first.cp.close();
    clock.advance(119000);
    const again = boot(clock, first.root);
    again.claude.setCapacity(sameAccount(clock, 80));
    try {
      expect((await again.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode)
        .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
      expect(notRestored(again.cp)).toEqual(["INVALIDATED"]);
    } finally {
      again.cp.close();
    }
  });

  it("control: a reading taken after the invalidation is restored by a later restart", async () => {
    const clock = new ManualClock(START);
    const first = boot(clock);
    first.claude.setCapacity(sameAccount(clock, 82));
    await first.cp.tasks.admitWorkerFanout("claude", "opus");
    clock.advance(1000);
    first.cp.providers.invalidateCapacityForRole("claude", Role.WORKER);
    first.cp.close();
    clock.advance(60000);
    const second = boot(clock, first.root);
    second.claude.setCapacity(sameAccount(clock, 81));
    try {
      expect((await second.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode)
        .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    } finally {
      second.cp.close();
    }
    clock.advance(120000);
    const third = boot(clock, first.root);
    third.claude.setCapacity(sameAccount(clock, 80));
    try {
      expect((await third.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode).toBe(ReasonCode.OK);
      // The one refusal on record is the second process's, of the reading taken before the invalidation.
      expect(notRestored(third.cp)).toEqual(["INVALIDATED"]);
    } finally {
      third.cp.close();
    }
  });
});
