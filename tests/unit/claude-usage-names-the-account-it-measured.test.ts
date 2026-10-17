import { describe, expect, it } from "vitest";

import {
  CLAUDE_ACCOUNT_IDENTITY_ARGS,
  ClaudeUsageCollector,
  type NonInteractiveUsageProbe,
  accountDigestOfSource,
  claudeAccountDigest,
  withAccountDigest,
} from "../../src/capacity/usage-collectors.ts";
import { ManualClock } from "../../src/core/clock.ts";

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
