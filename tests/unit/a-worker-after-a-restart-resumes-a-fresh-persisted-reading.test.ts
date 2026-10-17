import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CAPACITY_DEFAULTS } from "../../src/capacity/capacity-monitor.ts";
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
 * #1099 — a WORKER's burn needs two readings of the WORKER binding, and its history used to live
 * only in memory, so the first `task_worker_provision` after every restart was refused
 * CAPACITY_ADMISSION_CONSERVE. The owner's ruling: a reading persisted before the restart may count
 * as the first of the two only when provider, account and measurement target match and it is still
 * inside the freshness window measured from its original observation time. Anything else refuses.
 *
 * Each row is a real restart: the first control plane is closed and a second opens the same
 * database with a freshly composed registry, then asks the admission `task_worker_provision` asks
 * (`TaskGraph.admitWorkerFanout`).
 *
 * Every fixture reading states the account it measured the way a collector that established one
 * does (`withAccountDigest`), so each refusal below is its own condition's; a reading with no account
 * identity is refused for that alone (review r1).
 */
const CTO_ROLES = [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER] as const;
const KIND = "CAPACITY_ROLE_OBSERVATION";
const NOT_RESTORED = "CAPACITY_ROLE_OBSERVATION_NOT_RESTORED";
const START = "2026-08-12T00:00:00.000Z";
const RESET_AT = "2026-08-12T05:00:00.000Z";
const ACCOUNT_A = sha256("fixture account A");
const ACCOUNT_B = sha256("fixture account B");

const reading = (clock: ManualClock, remainingPercent: number, account: string | null = ACCOUNT_A): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: withAccountDigest("restart-fixture", account),
  buckets: [{ id: "five_hour", remainingPercent, resetAt: RESET_AT, capabilities: ["cto", "ceo", "blind-review", "worker"] }],
});

const boot = (clock: ManualClock, root = tempDir("acp-worker-restart-"), roles: readonly Role[] = CTO_ROLES) => {
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

/** The first worker admission of a process: refused, because its burn has one reading. */
const coldAdmission = async (clock: ManualClock, account: string | null = ACCOUNT_A) => {
  const first = boot(clock);
  first.claude.setCapacity(reading(clock, 81, account));
  const cold = await first.cp.tasks.admitWorkerFanout("claude", "opus");
  expect(cold.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  const persisted = first.cp.audit.byKind(KIND).map((row) => row.evidence);
  first.cp.close();
  return { root: first.root, persisted };
};

/** The reasons audited for persisted observations the restarted process did not count. */
let notRestored: unknown[] = [];

/** Restarts onto `root` `afterMs` later and asks for the first worker of the new process. */
const restartAndAdmit = async (
  clock: ManualClock,
  root: string,
  afterMs: number,
  roles?: readonly Role[],
  account: string | null = ACCOUNT_A,
) => {
  clock.advance(afterMs);
  const restarted = boot(clock, root, roles);
  restarted.claude.setCapacity(reading(clock, 80, account));
  try {
    return await restarted.cp.tasks.admitWorkerFanout("claude", "opus");
  } finally {
    notRestored = restarted.cp.audit.byKind(NOT_RESTORED).map((row) => row.evidence["reason"]);
    restarted.cp.close();
  }
};

/** A database holding exactly one persisted observation, `evidence`, then a restart onto it. */
const restartOnto = async (clock: ManualClock, evidence: Record<string, unknown>, afterMs = 2 * 60 * 1000) => {
  const seeded = boot(clock);
  seeded.cp.audit.record({ kind: KIND, reasonCode: ReasonCode.OK, evidence });
  seeded.cp.close();
  return restartAndAdmit(clock, seeded.root, afterMs);
};

describe("#1099: the first worker after a restart is admitted on a fresh persisted WORKER reading", () => {
  it("a reading persisted two minutes before the restart admits the first worker after it", async () => {
    const clock = new ManualClock(START);
    const { root } = await coldAdmission(clock);
    const admitted = await restartAndAdmit(clock, root, 2 * 60 * 1000);
    expect(admitted.reasonCode, admitted.allowed ? "" : admitted.message).toBe(ReasonCode.OK);
    expect(notRestored).toEqual([]);
  });

  describe("review r1: the account the reading measured has to be the account measured now", () => {
    it("another account, at the same registration and the same reset time, is refused and audited", async () => {
      const clock = new ManualClock(START);
      const { root } = await coldAdmission(clock, ACCOUNT_A);
      const refused = await restartAndAdmit(clock, root, 2 * 60 * 1000, undefined, ACCOUNT_B);
      expect(refused.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
      expect(notRestored).toEqual(["ACCOUNT_MISMATCH"]);
    });

    it.each([
      ["the persisted reading", null, ACCOUNT_A],
      ["the reading after the restart", ACCOUNT_A, null],
      ["either reading", null, null],
    ])("no account identity in %s refuses restoration (the pre-#1099 behaviour), audited", async (_label, before, after) => {
      const clock = new ManualClock(START);
      const { root } = await coldAdmission(clock, before);
      const refused = await restartAndAdmit(clock, root, 2 * 60 * 1000, undefined, after);
      expect(refused.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
      expect(notRestored).toEqual(["NO_ACCOUNT_IDENTITY"]);
    });

    it("a record written before the account was recorded (no accountDigest) is not restored", async () => {
      const clock = new ManualClock(START);
      const { persisted } = await coldAdmission(clock);
      const legacy = { ...(persisted[0] as Record<string, unknown>) };
      delete legacy["accountDigest"];
      expect((await restartOnto(clock, legacy)).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
      expect(notRestored).toEqual(["NO_ACCOUNT_IDENTITY"]);
    });

    it("without a restart too, a reading of one account never measures another's burn", async () => {
      const clock = new ManualClock(START);
      const p = boot(clock);
      try {
        p.claude.setCapacity(reading(clock, 81, ACCOUNT_A));
        expect((await p.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
        clock.advance(2 * 60 * 1000);
        p.claude.setCapacity(reading(clock, 80, ACCOUNT_B));
        expect((await p.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
        // Control: the same account two minutes later is a burn, and admits.
        clock.advance(2 * 60 * 1000);
        p.claude.setCapacity(reading(clock, 79, ACCOUNT_B));
        expect((await p.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode).toBe(ReasonCode.OK);
      } finally {
        p.cp.close();
      }
    });

    it("the record holds the account as a digest, never as a raw value", async () => {
      const clock = new ManualClock(START);
      const { persisted } = await coldAdmission(clock);
      expect(persisted[0]!["accountDigest"]).toBe(ACCOUNT_A);
    });
  });

  it("the freshness window is measured from the original observation: open at its end, refused 1 ms after", async () => {
    const atEnd = new ManualClock(START);
    const kept = await coldAdmission(atEnd);
    expect((await restartAndAdmit(atEnd, kept.root, CAPACITY_DEFAULTS.freshnessMs)).reasonCode).toBe(ReasonCode.OK);

    const past = new ManualClock(START);
    const expired = await coldAdmission(past);
    expect((await restartAndAdmit(past, expired.root, CAPACITY_DEFAULTS.freshnessMs + 1)).reasonCode)
      .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    expect(notRestored).toEqual(["EXPIRED"]);
  });

  it("a restart does not refresh the persisted reading, even when the collector answers the same observation again", async () => {
    const clock = new ManualClock(START);
    const { root } = await coldAdmission(clock);
    const observed = reading(clock, 81);
    // Four minutes later a restarted process reads the same observation once more (a source not yet
    // re-read): one observation, so still no burn, and it is re-recorded at its original time.
    clock.advance(4 * 60 * 1000);
    const again = boot(clock, root);
    again.claude.setCapacity(observed);
    expect((await again.cp.tasks.admitWorkerFanout("claude", "opus")).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    expect(again.cp.audit.byKind(KIND).map((row) => row.evidence["observedAt"])).toEqual([START, START]);
    again.cp.close();
    // Six minutes after the observation it has expired, however recently a process re-read it.
    expect((await restartAndAdmit(clock, root, 2 * 60 * 1000)).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  });

  it("another registration of the WORKER role (a recomposed account scope) does not inherit the reading", async () => {
    const clock = new ManualClock(START);
    const { root } = await coldAdmission(clock);
    // WORKER composed first: a different capacity registration than the one that measured.
    const reordered = [Role.WORKER, Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO];
    expect((await restartAndAdmit(clock, root, 2 * 60 * 1000, reordered)).reasonCode)
      .toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    expect(notRestored).toEqual(["REGISTRATION_MISMATCH"]);
  });

  describe("only the genuine record restores; one altered field refuses", () => {
    const genuine = async () => {
      const clock = new ManualClock(START);
      const { persisted } = await coldAdmission(clock);
      expect(persisted).toHaveLength(1);
      return { clock, evidence: persisted[0]! as Record<string, unknown> };
    };

    it("control: the genuine record, alone in a database, admits", async () => {
      const { clock, evidence } = await genuine();
      expect((await restartOnto(clock, evidence)).reasonCode).toBe(ReasonCode.OK);
      expect(notRestored).toEqual([]);
    });

    // The reason audited for each: a record of another provider or role is not this binding's at all,
    // so there is nothing to refuse and nothing is audited.
    it.each([
      ["another provider", (e: Record<string, unknown>) => ({ ...e, provider: "gpt" }), []],
      ["another role", (e: Record<string, unknown>) => ({ ...e, role: Role.PRIMARY_CTO }), []],
      ["another registration", (e: Record<string, unknown>) => ({ ...e, generation: Number(e["generation"]) + 1 }), ["REGISTRATION_MISMATCH"]],
      ["another account", (e: Record<string, unknown>) => ({ ...e, accountDigest: ACCOUNT_B }), ["ACCOUNT_MISMATCH"]],
      ["an account that is not a digest", (e: Record<string, unknown>) => ({ ...e, accountDigest: "account-a" }), ["NO_ACCOUNT_IDENTITY"]],
      // Three minutes ahead of a restart two minutes in, at a quota the fresh reading does not
      // exceed: counted, it would read as the newer of the two and measure a burn.
      ["a future observation time", (e: Record<string, unknown>) => ({
        ...e,
        observedAt: new Date(new Date(START).getTime() + 3 * 60 * 1000).toISOString(),
        buckets: (e["buckets"] as Record<string, unknown>[]).map((b) => ({ ...b, remainingPercent: 79 })),
      }), ["FUTURE_DATED"]],
      ["an unparseable observation time", (e: Record<string, unknown>) => ({ ...e, observedAt: "not-a-date" }), ["UNPARSEABLE_TIME"]],
      ["a quota that is not a number", (e: Record<string, unknown>) => ({
        ...e, buckets: (e["buckets"] as Record<string, unknown>[]).map((b) => ({ ...b, remainingPercent: "81" })),
      }), ["UNREADABLE"]],
      // Read as a number it would measure a burn against the fresh 80%.
      ["a quota that is not a percentage", (e: Record<string, unknown>) => ({
        ...e, buckets: (e["buckets"] as Record<string, unknown>[]).map((b) => ({ ...b, remainingPercent: 180 })),
      }), ["UNREADABLE"]],
      ["no quota", (e: Record<string, unknown>) => ({ ...e, buckets: [] }), ["UNREADABLE"]],
    ])("%s", async (_label, alter, reasons) => {
      const { clock, evidence } = await genuine();
      expect((await restartOnto(clock, alter(evidence))).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
      expect(notRestored).toEqual(reasons);
    });
  });

  it("a collector failure after the restart is not capacity: the persisted reading admits nothing on its own", async () => {
    const clock = new ManualClock(START);
    const { root } = await coldAdmission(clock);
    clock.advance(60 * 1000);
    const restarted = boot(clock, root);
    restarted.claude.setCapacity({ ...reading(clock, 80), sensorHealth: "ERROR", error: "collector failed" });
    try {
      const refused = await restarted.cp.tasks.admitWorkerFanout("claude", "opus");
      expect(refused.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
      expect(restarted.cp.audit.byKind(KIND)).toHaveLength(1);
    } finally {
      restarted.cp.close();
    }
  });
});
