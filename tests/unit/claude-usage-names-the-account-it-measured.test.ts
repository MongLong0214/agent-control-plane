import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_ACCOUNT_IDENTITY_ARGS,
  CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS,
  COLLECTOR_TIMEOUT_MS,
  ClaudeUsageCollector,
  type NonInteractiveUsageProbe,
  accountDigestOfSource,
  claudeAccountDigest,
  claudeCollectionBudgetMs,
  withAccountDigest,
} from "../../src/capacity/usage-collectors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { CAPACITY_SWEEP_BUDGET_MS } from "../../src/doctor/doctor.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";

/**
 * #1099 review r1 — a persisted capacity reading may count after a restart only for the account it
 * measured, so the Claude collector states that account: the digest of the organization id and the
 * signed-in address `claude auth status --json` names, read on both sides of the `/usage` read.
 * Nothing here runs a real CLI; both commands are injected.
 */
const clock = () => new ManualClock("2026-08-13T00:00:00.000Z");
// Fixture values only; neither names a real account.
const ORG = "00000000-0000-4000-8000-000000000001";
const ADDRESS = "fixture.owner@example.invalid";

const USAGE = JSON.stringify({
  is_error: false,
  num_turns: 0,
  total_cost_usd: 0,
  result: "Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)",
});

type Outcome = Awaited<ReturnType<NonInteractiveUsageProbe["run"]>>;

const answering = (...outcomes: Outcome[]) => {
  const calls: { binary: string }[] = [];
  const probe: NonInteractiveUsageProbe = {
    run: async (input) => {
      calls.push({ binary: input.binary });
      const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
      return next;
    },
  };
  return { probe, calls };
};

const status = (fields: Record<string, unknown>): Outcome => ({ stdout: JSON.stringify(fields), stderr: "", code: 0 });
const signedIn = (orgId = ORG, email = ADDRESS) =>
  status({ loggedIn: true, authMethod: "claude.ai", orgId, email, subscriptionType: "max" });

const collect = (identity: NonInteractiveUsageProbe | null | undefined, usage: Outcome = { stdout: USAGE, stderr: "", code: 0 }) =>
  new ClaudeUsageCollector({
    clock: clock(),
    binary: "claude",
    nonInteractive: answering(usage).probe,
    ...(identity === undefined ? {} : { accountIdentity: identity }),
  }).collect();

describe("the Claude collector states the account it measured, as a digest", () => {
  it("asks the CLI's own `auth status`, and only its JSON form", () => {
    expect(CLAUDE_ACCOUNT_IDENTITY_ARGS).toEqual(["auth", "status", "--json"]);
  });

  it("a signed-in account is stated in the reading's source as a digest, and no raw value is kept", async () => {
    const { probe, calls } = answering(signedIn());
    const reading = await collect(probe);
    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    const digest = claudeAccountDigest(signedIn());
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(accountDigestOfSource(reading.source)).toBe(digest);
    // Read before and after the usage read, through the same configured CLI.
    expect(calls).toEqual([{ binary: "claude" }, { binary: "claude" }]);
    const kept = JSON.stringify(reading);
    expect(kept).not.toContain(ADDRESS);
    expect(kept).not.toContain(ORG);
  });

  it("the digest separates accounts: another organization or another address is another account", () => {
    const a = claudeAccountDigest(signedIn());
    expect(claudeAccountDigest(signedIn("00000000-0000-4000-8000-000000000002"))).not.toBe(a);
    expect(claudeAccountDigest(signedIn(ORG, "someone.else@example.invalid"))).not.toBe(a);
    // The provider treats the address case-insensitively, and so does the digest.
    expect(claudeAccountDigest(signedIn(ORG, ADDRESS.toUpperCase()))).toBe(a);
  });

  it.each([
    ["signed out", status({ loggedIn: false })],
    ["no organization", status({ loggedIn: true, email: ADDRESS })],
    ["no address", status({ loggedIn: true, orgId: ORG })],
    ["an empty organization", signedIn("  ")],
    ["output that is not JSON", { stdout: "Logged in as someone", stderr: "", code: 0 }],
    ["a failed run", { ...signedIn(), code: 1 }],
    ["a run that timed out", { ...signedIn(), code: null, timedOut: true }],
    ["a CLI that never started", { stdout: "", stderr: "", code: null, spawnError: { code: "ENOENT", message: "spawn claude ENOENT" } }],
  ] as [string, Outcome][])("%s establishes no account, and the reading is still read", async (_label, outcome) => {
    expect(claudeAccountDigest(outcome)).toBeNull();
    const reading = await collect(answering(outcome).probe);
    expect(reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(reading.source)).toBeNull();
  });

  it("an account that changed across the usage read binds the reading to neither", async () => {
    const reading = await collect(answering(signedIn(), signedIn("00000000-0000-4000-8000-000000000002")).probe);
    expect(reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(reading.source)).toBeNull();
  });

  it("an identity read that throws establishes no account", async () => {
    const reading = await collect({ run: () => Promise.reject(new Error("spawn EAGAIN")) });
    expect(reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(reading.source)).toBeNull();
  });

  it("a failed usage read states no account: there is no measurement to bind", async () => {
    const reading = await collect(answering(signedIn()).probe, { stdout: "", stderr: "", code: 1 });
    expect(reading.sensorHealth).toBe("ERROR");
    expect(accountDigestOfSource(reading.source)).toBeNull();
  });

  it("an injected usage read with no injected identity reads none, never the host's real account", async () => {
    const reading = await collect(undefined);
    expect(reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(reading.source)).toBeNull();
  });

  it("a source states one account digest or none: absent, repeated or malformed is none", () => {
    const digest = claudeAccountDigest(signedIn())!;
    expect(accountDigestOfSource(withAccountDigest("collector:claude;raw-output-digest:sha256:00", digest))).toBe(digest);
    expect(withAccountDigest("collector:claude", null)).toBe("collector:claude");
    expect(accountDigestOfSource("collector:claude")).toBeNull();
    expect(accountDigestOfSource(`collector:claude;account-digest:${digest};account-digest:${digest}`)).toBeNull();
    expect(accountDigestOfSource("collector:claude;account-digest:sha256:XYZ")).toBeNull();
    expect(accountDigestOfSource("collector:claude-account-digest:" + digest)).toBeNull();
  });
});

/**
 * #1099 review r2 (ACP-S2-R2-01) — identity, `/usage` and identity run under one deadline. Each
 * identity read used to get the usage read's own 20 s, so the collection could outlast the 45 s
 * collector bound and the doctor's 45 s capacity deadline. Every probe here is injected, and the
 * fake clock is the only time that passes.
 */
describe("review r2: one deadline for the whole Claude collection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // A probe that ignores the timeout it is handed: only the collector's own deadline can stop it.
  const never = () => new Promise<Outcome>(() => undefined);

  type Call = { timeoutMs: number; at: number };
  const recording = (answer: (call: Call, index: number) => Promise<Outcome>) => {
    const calls: Call[] = [];
    const probe: NonInteractiveUsageProbe = {
      run: (input) => {
        const call = { timeoutMs: input.timeoutMs, at: Date.now() };
        calls.push(call);
        return answer(call, calls.length - 1);
      },
    };
    return { probe, calls };
  };
  const usageAfter = (ms: number) =>
    recording(async () => {
      await after(ms);
      return { stdout: USAGE, stderr: "", code: 0 };
    });

  /** Run a collection on the fake clock: what it returned and how long it took, or null if it was still running. */
  const settle = async (options: { identity: NonInteractiveUsageProbe; usage: NonInteractiveUsageProbe; timeoutMs?: number }) => {
    vi.useFakeTimers();
    const started = Date.now();
    let settled: { reading: CapacityReading; elapsedMs: number } | null = null;
    void new ClaudeUsageCollector({
      clock: clock(),
      binary: "claude",
      nonInteractive: options.usage,
      accountIdentity: options.identity,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
      .collect()
      .then((reading) => {
        settled = { reading, elapsedMs: Date.now() - started };
      });
    // Past every caller's deadline: whatever has not settled by then has missed all of them.
    await vi.advanceTimersByTimeAsync(Math.max(COLLECTOR_TIMEOUT_MS, CAPACITY_SWEEP_BUDGET_MS) + 1);
    return settled as { reading: CapacityReading; elapsedMs: number } | null;
  };

  it("the budget covers identity, usage and identity, and stays inside the collector bound and the doctor's deadline", () => {
    // The production usage read's own timeout is 20 s.
    expect(claudeCollectionBudgetMs(20_000)).toBe(20_000 + 2 * CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS);
    expect(claudeCollectionBudgetMs(20_000)).toBeLessThan(COLLECTOR_TIMEOUT_MS);
    expect(claudeCollectionBudgetMs(20_000)).toBeLessThan(CAPACITY_SWEEP_BUDGET_MS);
    // A configured usage timeout cannot carry the whole past the collector bound.
    expect(claudeCollectionBudgetMs(COLLECTOR_TIMEOUT_MS)).toBe(COLLECTOR_TIMEOUT_MS);
  });

  it("identity reads that never answer cost the reading its account, not the reading, and the usage read keeps its whole timeout", async () => {
    const identity = recording(never);
    const usage = usageAfter(10_000);
    const settled = await settle({ identity: identity.probe, usage: usage.probe });
    expect(settled, "the collection outlasted every caller's deadline").not.toBeNull();
    expect(settled!.reading.sensorHealth, settled!.reading.error ?? "").toBe("HEALTHY");
    // No account was established, so this reading is never restored after a restart.
    expect(accountDigestOfSource(settled!.reading.source)).toBeNull();
    expect(identity.calls.map((call) => call.timeoutMs)).toEqual([CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS]);
    expect(usage.calls).toEqual([{ timeoutMs: 20_000, at: CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS + identity.calls[0]!.at }]);
    expect(settled!.elapsedMs).toBe(CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS + 10_000);
  });

  it("no account before the usage read: the read after it is skipped", async () => {
    const identity = recording(async () => status({ loggedIn: false }));
    const settled = await settle({ identity: identity.probe, usage: usageAfter(1_000).probe });
    expect(settled!.reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(settled!.reading.source)).toBeNull();
    expect(identity.calls).toHaveLength(1);
  });

  it("an identity read after the usage read gets only what the deadline has left, and running out leaves the reading unbound", async () => {
    // The slowest each step may be: an identity read that answers just inside its share, a usage read
    // just inside its timeout, then an identity read that never answers.
    const identity = recording((call, index) =>
      index === 0 ? after(call.timeoutMs - 1).then(() => signedIn()) : never(),
    );
    const usage = usageAfter(20_000 - 1);
    const settled = await settle({ identity: identity.probe, usage: usage.probe });
    expect(settled, "the collection outlasted every caller's deadline").not.toBeNull();
    expect(settled!.reading.sensorHealth, settled!.reading.error ?? "").toBe("HEALTHY");
    expect(accountDigestOfSource(settled!.reading.source)).toBeNull();
    expect(identity.calls).toHaveLength(2);
    expect(identity.calls[1]!.timeoutMs).toBeLessThanOrEqual(CLAUDE_ACCOUNT_IDENTITY_TIMEOUT_MS);
    expect(settled!.elapsedMs).toBeLessThanOrEqual(claudeCollectionBudgetMs(20_000));
    expect(settled!.elapsedMs).toBeLessThan(CAPACITY_SWEEP_BUDGET_MS);
  });

  it("an account named on both sides inside the deadline is still stated", async () => {
    const identity = recording(async (call) => {
      await after(call.timeoutMs - 1);
      return signedIn();
    });
    const settled = await settle({ identity: identity.probe, usage: usageAfter(1_000).probe });
    expect(accountDigestOfSource(settled!.reading.source)).toBe(claudeAccountDigest(signedIn()));
  });

  it("a usage read that never answers fails at its own timeout, inside the deadline", async () => {
    const identity = recording(async () => signedIn());
    const usage = recording(never);
    const settled = await settle({ identity: identity.probe, usage: usage.probe });
    expect(settled, "the collection outlasted every caller's deadline").not.toBeNull();
    expect(settled!.reading.sensorHealth).toBe("ERROR");
    expect(settled!.reading.error).toBe("non-interactive /usage did not finish in time");
    expect(settled!.elapsedMs).toBe(20_000);
    expect(identity.calls).toHaveLength(1);
  });

  it("a usage timeout that fills the collector bound leaves no time for identity: none is read, and the usage read is unshortened", async () => {
    const identity = recording(async () => signedIn());
    const usage = usageAfter(1_000);
    const settled = await settle({ identity: identity.probe, usage: usage.probe, timeoutMs: COLLECTOR_TIMEOUT_MS });
    expect(settled!.reading.sensorHealth).toBe("HEALTHY");
    expect(accountDigestOfSource(settled!.reading.source)).toBeNull();
    expect(identity.calls).toHaveLength(0);
    expect(usage.calls.map((call) => call.timeoutMs)).toEqual([COLLECTOR_TIMEOUT_MS]);
  });
});
