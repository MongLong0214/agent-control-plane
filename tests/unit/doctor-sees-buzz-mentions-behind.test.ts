import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import {
  BuzzAdapter,
  BuzzCliTransport,
  InMemoryBuzzTransport,
  type BuzzCliMessage,
} from "../../src/buzz/buzz-adapter.ts";
import { BuzzMentionWatch, type BuzzMentionSource, type WatchTarget } from "../../src/buzz/mention-watch.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";

afterAll(cleanupTempDirs);

/**
 * #674 — a session's ad hoc, session-local poll for Buzz mentions can die silently, and three
 * separate times in one incident a dead poller and "nothing new arrived" were indistinguishable.
 * This is the delivery-silence-only read side: a durable cursor plus tick health, so Doctor can
 * report channel traffic without depending on that poller's own liveness. It does not inspect
 * `mentions` versus `needs_action`; an arrived-but-unclassified message remains out of scope.
 *
 * Re-keyed by #710: a blind review found the original `channel_id`-keyed state let one
 * session's reconnect corrupt another session's baseline whenever they shared a channel, plus a
 * write-ordering race between an in-flight tick and a concurrent reconnect, plus an
 * indistinguishable-from-exact count once a tick's read hit its per-check cap. This file's
 * doubles and helpers below were changed to drive those production shapes rather than avoid
 * them — see each test's own comment for which finding it covers.
 *
 * Every test here drives the real production path — `BuzzAdapter.connect()` (which resets the
 * cursor), `BuzzMentionWatch.tick()` (the periodic measurement), and `doctor.run("system")` (the
 * tool every runbook opens with) — rather than hand-inserting a `buzz_mention_watch` row.
 */

let messageSeq = 0;
const message = (createdAt: number): BuzzCliMessage => {
  messageSeq += 1;
  return {
    id: `msg-${messageSeq}`,
    content: "<redacted>",
    pubkey: "some-pubkey",
    created_at: createdAt,
    kind: 9,
    tags: [],
  };
};

/**
 * A channel that answers `messages get --since` the way a real one would: whatever was last
 * enqueued is "what's actually there right now" and is returned again on a repeat ask, until a
 * throw is enqueued to simulate the relay or CLI becoming unreachable.
 *
 * Respects the CLI's exclusive `since` and its `limit` (#710): the previous double ignored both
 * and returned the full enqueued array regardless of what was asked for, which is exactly why a
 * review of the real CLI reached production with nothing here able to reproduce it.
 */
class ScriptedMentionSource implements BuzzMentionSource {
  readonly calls: Array<{ channel: string; since: number; limit: number }> = [];
  #current: BuzzCliMessage[] = [];
  #throwing: Error | null = null;

  respondWith(messages: BuzzCliMessage[]): void {
    this.#current = messages;
    this.#throwing = null;
  }

  failNextWith(error: Error): void {
    this.#throwing = error;
  }

  async messagesSince(channel: string, since: number, limit: number): Promise<BuzzCliMessage[]> {
    this.calls.push({ channel, since, limit });
    if (this.#throwing) {
      const err = this.#throwing;
      this.#throwing = null;
      throw err;
    }
    return this.#current.filter((message) => message.created_at > since).slice(0, limit);
  }
}

/**
 * An executable boundary double for the installed CLI, not a `BuzzMentionSource` model. It
 * applies the installed command's real rule (`created_at > --since`), honors `--limit`, and
 * preserves whatever order and repeats the relay returned. The production `BuzzCliTransport`
 * has to cross this process boundary and parse its JSON before the watch sees a message.
 */
class ExclusiveSinceBuzzCli {
  readonly binary: string;
  readonly channel = "00000000-0000-0000-0000-000000000674";
  readonly #messages: string;
  readonly #calls: string;
  readonly #blockNext: string;
  readonly #blocked: string;
  readonly #release: string;

  constructor() {
    const root = tempDir("acp-buzz-exclusive-since-");
    this.binary = join(root, "buzz");
    this.#messages = join(root, "messages.json");
    this.#calls = join(root, "calls.jsonl");
    this.#blockNext = join(root, "block-next");
    this.#blocked = join(root, "blocked");
    this.#release = join(root, "release");
    writeFileSync(this.#messages, "[]", "utf8");
    writeFileSync(this.#calls, "", "utf8");
    writeFileSync(
      this.binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(this.#calls)}, JSON.stringify(argv) + "\\n");
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
};
const die = (message) => {
  process.stderr.write(JSON.stringify({ error: "user_error", message, retryable: false }));
  process.exit(1);
};
if (argv[0] === "channels" && argv[1] === "get") {
  const channel = flag("--channel");
  if (!channel) die("--channel is required");
  process.stdout.write(JSON.stringify({ channel_id: channel }));
  process.exit(0);
}
if (argv[0] === "messages" && argv[1] === "get") {
  if (!flag("--channel")) die("--channel is required");
  const since = Number(flag("--since"));
  const limit = Number(flag("--limit"));
  const response = JSON.parse(fs.readFileSync(${JSON.stringify(this.#messages)}, "utf8"))
    .filter((message) => message.created_at > since)
    .slice(0, limit);
  if (fs.existsSync(${JSON.stringify(this.#blockNext)})) {
    fs.renameSync(${JSON.stringify(this.#blockNext)}, ${JSON.stringify(this.#blocked)});
    while (!fs.existsSync(${JSON.stringify(this.#release)})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}
die("unsupported argv: " + argv.join(" "));
`,
      "utf8",
    );
    chmodSync(this.binary, 0o755);
  }

  respondWith(messages: readonly BuzzCliMessage[]): void {
    writeFileSync(this.#messages, JSON.stringify(messages), "utf8");
  }

  blockNextMessagesRead(): void {
    writeFileSync(this.#blockNext, "block", "utf8");
  }

  async waitUntilBlocked(): Promise<void> {
    while (!existsSync(this.#blocked)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  releaseBlockedRead(): void {
    writeFileSync(this.#release, "release", "utf8");
  }

  calls(): string[][] {
    return readFileSync(this.#calls, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  }
}

const behindFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "BUZZ_DELIVERY_SILENCE_TRAFFIC_FOUND");
const neverCheckedFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "BUZZ_DELIVERY_SILENCE_NEVER_CHECKED");
const unavailableFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "BUZZ_DELIVERY_SILENCE_WATCH_UNAVAILABLE");

/** `BuzzMentionWatch.tick()` now takes one target per live session, not one per channel (#710). */
const target = (sessionId: string, channelId: string): WatchTarget => ({ sessionId, channelId });

/** A live session, bound to a Buzz channel through the real `connect()` path. */
const connectedSession = async (
  harness: ReturnType<typeof makeHarness>,
  adapter: BuzzAdapter,
  model: string,
  purpose?: string,
): Promise<{ sessionId: string; channel: string }> => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test session");
  const connected = await adapter.connect(session.sessionId, purpose ?? `cto:${model}`);
  if (!connected.allowed) throw new Error(`fixture setup failed: connect refused (${JSON.stringify(connected)})`);
  return { sessionId: session.sessionId, channel: connected.value };
};

describe("what doctor says about a silent buzz channel-traffic watch (#674)", () => {
  it("says nothing when a check just succeeded and found nothing new", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { sessionId, channel } = await connectedSession(harness, adapter, "silence-session");

    source.respondWith([]);
    await mentionWatch.tick([target(sessionId, channel)]);

    const report = await harness.cp.doctor.run("system");
    expect(behindFinding(report)).toBeUndefined();
    expect(neverCheckedFinding(report)).toBeUndefined();
    expect(unavailableFinding(report)).toBeUndefined();
  });

  it("reports delivery-silence-only traffic and names arrived but unclassified as out of scope", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { sessionId, channel } = await connectedSession(harness, adapter, "behind-session");
    const baselineEpoch = Math.floor(harness.clock.now().getTime() / 1000);

    harness.clock.advance(60_000);
    // The incident this closes: exactly four messages arrived while nothing was watching.
    source.respondWith([
      message(baselineEpoch + 10),
      message(baselineEpoch + 20),
      message(baselineEpoch + 30),
      message(baselineEpoch + 40),
    ]);
    await mentionWatch.tick([target(sessionId, channel)]);

    const report = await harness.cp.doctor.run("system");
    const finding = behindFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.blocking).toBe(false);
    expect(finding?.observedEvidence).toMatchObject({
      sessionId,
      channel,
      measurementScope: "DELIVERY_SILENCE_ONLY",
      classificationCoverage: "ARRIVED_BUT_UNCLASSIFIED_OUT_OF_SCOPE_674",
      channelMessagesSinceBaseline: 4,
      atLeast: false,
      sinceIso: new Date(baselineEpoch * 1000).toISOString(),
      checkedAt: harness.clock.nowIso(),
    });

    // A crash between the CLI read and the write loses nothing and double-counts nothing: the
    // next tick re-asks the same question against the same baseline and gets the same answer.
    harness.clock.advance(1_000);
    await mentionWatch.tick([target(sessionId, channel)]);
    const second = await harness.cp.doctor.run("system");
    expect(behindFinding(second)?.observedEvidence).toMatchObject({ channelMessagesSinceBaseline: 4 });
  });

  it("never checked is not zero behind — a session with no watch history says so distinctly", async () => {
    const harness = makeHarness();
    const session = harness.cp.sessions.create({ provider: "scripted", model: "unwatched-session" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test session");
    // Bypasses connect()/resetCursor entirely: the channel is bound but the watch has never
    // ticked it, which must not read the same as a verified zero.
    harness.cp.sessions.setBuzzAddress(session.sessionId, "channel-nobody-ticked");

    const report = await harness.cp.doctor.run("system");
    const finding = neverCheckedFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.observedEvidence).toMatchObject({
      sessionId: session.sessionId,
      channel: "channel-nobody-ticked",
    });
    expect(behindFinding(report)).toBeUndefined();
  });

  it("a session that just connected but was never ticked is never-checked, not a verified zero", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    // `connect()` alone establishes the row via `resetCursor` — `last_attempt_at` stays NULL
    // until a tick actually runs. That row-exists-but-never-attempted state must read the same
    // as no row at all, not as a verified zero.
    const { sessionId, channel } = await connectedSession(harness, adapter, "just-connected-session");

    const report = await harness.cp.doctor.run("system");
    const finding = neverCheckedFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.observedEvidence).toMatchObject({ sessionId, channel });
    expect(behindFinding(report)).toBeUndefined();
    expect(unavailableFinding(report)).toBeUndefined();
  });

  it("a failed check reports unavailable, never a false zero standing in for it", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { sessionId, channel } = await connectedSession(harness, adapter, "flaky-session");

    // One good check first, so there is a last-known-good to distinguish the failure from.
    source.respondWith([]);
    await mentionWatch.tick([target(sessionId, channel)]);
    const lastGoodAt = harness.clock.nowIso();

    harness.clock.advance(30_000);
    source.failNextWith(new Error("buzz messages get --since returned unparseable output: <html>502"));
    await mentionWatch.tick([target(sessionId, channel)]);

    const report = await harness.cp.doctor.run("system");
    expect(behindFinding(report)).toBeUndefined();
    const finding = unavailableFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.observedEvidence).toMatchObject({
      sessionId,
      channel,
      lastKnownGoodAt: lastGoodAt,
    });
    expect(String(finding?.observedEvidence["error"])).toContain("unparseable output");
  });

  it("reconnecting is the cursor's way back — it clears an accumulated backlog", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const session = harness.cp.sessions.create({ provider: "scripted", model: "reconnect-session" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test session");
    const purpose = "cto:reconnect-session";
    const first = await adapter.connect(session.sessionId, purpose);
    if (!first.allowed) throw new Error("fixture setup failed: first connect refused");
    const channel = first.value;
    const baselineEpoch = Math.floor(harness.clock.now().getTime() / 1000);

    harness.clock.advance(60_000);
    source.respondWith([message(baselineEpoch + 10), message(baselineEpoch + 20)]);
    await mentionWatch.tick([target(session.sessionId, channel)]);
    expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
      channelMessagesSinceBaseline: 2,
    });

    // A harness restart reconnects the (new) session — #674's own incident. `connect()` is the
    // one production call site that re-arms the baseline.
    const reconnected = await adapter.connect(session.sessionId, purpose);
    expect(reconnected.allowed).toBe(true);

    source.respondWith([]);
    await mentionWatch.tick([target(session.sessionId, channel)]);
    expect(behindFinding(await harness.cp.doctor.run("system"))).toBeUndefined();
  });

  it("a reset session reads as never-checked, not a verified zero, until the next tick actually runs", async () => {
    // The reconnect window #710 also found: `resetCursor` used to leave a stale
    // `last_attempt_at`/`last_success_at` behind, so a session that just reconnected but has not
    // yet been ticked could read as "checked, found nothing" off a check that ran against the
    // OLD baseline. resetCursor now clears attempt/success bookkeeping too.
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const purpose = "cto:reset-then-check-session";
    const { sessionId, channel } = await connectedSession(harness, adapter, "reset-then-check-session", purpose);

    source.respondWith([]);
    await mentionWatch.tick([target(sessionId, channel)]);
    const beforeReset = await harness.cp.doctor.run("system");
    expect(behindFinding(beforeReset)).toBeUndefined();
    expect(neverCheckedFinding(beforeReset)).toBeUndefined();

    // Reconnect — the baseline re-arms, and (this is the fix) so does "never checked".
    const reconnected = await adapter.connect(sessionId, purpose);
    expect(reconnected.allowed).toBe(true);

    const report = await harness.cp.doctor.run("system");
    expect(neverCheckedFinding(report)).toBeDefined();
    expect(behindFinding(report)).toBeUndefined();
  });
});

describe("#710 — shared-channel and concurrency findings from the blind review", () => {
  it("an event after reset in the same epoch second reaches Doctor through the exclusive-since CLI", async () => {
    const harness = makeHarness();
    harness.clock.advance(200);
    const relay = new ExclusiveSinceBuzzCli();
    const transport = new BuzzCliTransport(relay.binary, relay.channel);
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, transport);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      transport, mentionWatch,
    );
    const priorKey = process.env["BUZZ_PRIVATE_KEY"];
    process.env["BUZZ_PRIVATE_KEY"] = "test-key";
    try {
      const { sessionId, channel } = await connectedSession(harness, adapter, "same-second-session");
      const resetSecond = Math.floor(harness.clock.now().getTime() / 1000);

      // Reset happened at .200. This event arrives at .900 but, like the real relay payload,
      // carries only epoch-second precision. An exclusive `--since resetSecond` drops it.
      relay.respondWith([{ ...message(resetSecond), id: "same-second-after-reset" }]);
      harness.clock.advance(800);
      await mentionWatch.tick([target(sessionId, channel)]);

      expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
        sessionId,
        channelMessagesSinceBaseline: 1,
      });
      expect(relay.calls()).toContainEqual([
        "messages", "get", "--channel", channel,
        "--since", String(resetSecond - 1), "--limit", "201",
      ]);
    } finally {
      if (priorKey === undefined) delete process.env["BUZZ_PRIVATE_KEY"];
      else process.env["BUZZ_PRIVATE_KEY"] = priorKey;
    }
  });

  it("the reset second uses event identity to exclude traffic already present at reset", async () => {
    const harness = makeHarness();
    harness.clock.advance(200);
    const relay = new ExclusiveSinceBuzzCli();
    const transport = new BuzzCliTransport(relay.binary, relay.channel);
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, transport);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      transport, mentionWatch,
    );
    const priorKey = process.env["BUZZ_PRIVATE_KEY"];
    process.env["BUZZ_PRIVATE_KEY"] = "test-key";
    try {
      const resetSecond = Math.floor(harness.clock.now().getTime() / 1000);
      const beforeReset = { ...message(resetSecond), id: "same-second-before-reset" };
      relay.respondWith([beforeReset]);
      const { sessionId, channel } = await connectedSession(harness, adapter, "identity-boundary-session");

      relay.respondWith([
        { ...message(resetSecond), id: "same-second-after-reset" },
        beforeReset,
      ]);
      harness.clock.advance(800);
      await mentionWatch.tick([target(sessionId, channel)]);

      expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
        channelMessagesSinceBaseline: 1,
      });
    } finally {
      if (priorKey === undefined) delete process.env["BUZZ_PRIVATE_KEY"];
      else process.env["BUZZ_PRIVATE_KEY"] = priorKey;
    }
  });

  it("event ids make repeated and out-of-order relay rows one count each", async () => {
    const harness = makeHarness();
    harness.clock.advance(200);
    const relay = new ExclusiveSinceBuzzCli();
    const transport = new BuzzCliTransport(relay.binary, relay.channel);
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, transport);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      transport, mentionWatch,
    );
    const priorKey = process.env["BUZZ_PRIVATE_KEY"];
    process.env["BUZZ_PRIVATE_KEY"] = "test-key";
    try {
      const { sessionId, channel } = await connectedSession(harness, adapter, "replay-session");
      const resetSecond = Math.floor(harness.clock.now().getTime() / 1000);
      const first = { ...message(resetSecond + 1), id: "event-first" };
      const second = { ...message(resetSecond + 2), id: "event-second" };
      relay.respondWith([second, first, second]);
      harness.clock.advance(3_000);

      await mentionWatch.tick([target(sessionId, channel)]);
      expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
        channelMessagesSinceBaseline: 2,
      });
    } finally {
      if (priorKey === undefined) delete process.env["BUZZ_PRIVATE_KEY"];
      else process.env["BUZZ_PRIVATE_KEY"] = priorKey;
    }
  });

  it("a reconnect generation rejects a stale tick even when the wall clock does not advance", async () => {
    const harness = makeHarness();
    harness.clock.advance(200);
    const relay = new ExclusiveSinceBuzzCli();
    const transport = new BuzzCliTransport(relay.binary, relay.channel);
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, transport);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      transport, mentionWatch,
    );
    const priorKey = process.env["BUZZ_PRIVATE_KEY"];
    process.env["BUZZ_PRIVATE_KEY"] = "test-key";
    try {
      const purpose = "cto:same-second-race";
      const { sessionId, channel } = await connectedSession(harness, adapter, "same-second-race", purpose);
      const resetSecond = Math.floor(harness.clock.now().getTime() / 1000);

      relay.respondWith([{ ...message(resetSecond + 10), id: "stale-event" }]);
      relay.blockNextMessagesRead();
      const staleTick = mentionWatch.tick([target(sessionId, channel)]);
      await relay.waitUntilBlocked();

      // No clock advance: the old timestamp CAS token is identical on both resets.
      relay.respondWith([]);
      const reconnected = await adapter.connect(sessionId, purpose);
      expect(reconnected.allowed).toBe(true);
      await mentionWatch.tick([target(sessionId, channel)]);

      relay.releaseBlockedRead();
      await staleTick;

      const report = await harness.cp.doctor.run("system");
      expect(behindFinding(report)).toBeUndefined();
      expect(neverCheckedFinding(report)).toBeUndefined();
      expect(unavailableFinding(report)).toBeUndefined();
    } finally {
      if (priorKey === undefined) delete process.env["BUZZ_PRIVATE_KEY"];
      else process.env["BUZZ_PRIVATE_KEY"] = priorKey;
    }
  });

  it("finding 1: a second session connecting to the same channel does not erase the first session's backlog", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );

    // Same purpose for both sessions resolves to the same channel through
    // InMemoryBuzzTransport (`channel:${purpose}`) — the production shape the review named:
    // multiple sessions sharing one `ACP_BUZZ_CHANNEL` (its `defaultChannel` path,
    // buzz-adapter.ts:164). Two sessions colliding on one channel_id is the observable fact
    // that matters here, however the collision comes about.
    const sharedPurpose = "cto:shared-room";
    const sessionA = await connectedSession(harness, adapter, "session-a", sharedPurpose);
    const baselineEpoch = Math.floor(harness.clock.now().getTime() / 1000);

    harness.clock.advance(60_000);
    source.respondWith([
      message(baselineEpoch + 10),
      message(baselineEpoch + 20),
      message(baselineEpoch + 30),
      message(baselineEpoch + 40),
    ]);
    await mentionWatch.tick([target(sessionA.sessionId, sessionA.channel)]);
    expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
      sessionId: sessionA.sessionId,
      channelMessagesSinceBaseline: 4,
    });

    // Session B connects to the SAME channel. Nothing about session A changed.
    const sessionB = await connectedSession(harness, adapter, "session-b", sharedPurpose);
    expect(sessionB.channel).toBe(sessionA.channel);

    const report = await harness.cp.doctor.run("system");
    const findingForA = report.findings.find(
      (f) => f.code === "BUZZ_DELIVERY_SILENCE_TRAFFIC_FOUND" && f.observedEvidence["sessionId"] === sessionA.sessionId,
    );
    // Session A's 4-message backlog must still be reported: session B connecting to the same
    // channel re-arms only session B's own (until now nonexistent) baseline.
    expect(findingForA).toBeDefined();
    expect(findingForA?.observedEvidence).toMatchObject({ channelMessagesSinceBaseline: 4 });

    // Session B, having just connected, has its own clean slate — never-checked, not "0 behind"
    // and not session A's 4.
    const findingForB = report.findings.find((f) => f.observedEvidence["sessionId"] === sessionB.sessionId);
    expect(findingForB?.code).toBe("BUZZ_DELIVERY_SILENCE_NEVER_CHECKED");
  });

  it("finding 3: a tick that hits the per-check read cap reports a floor, not an exact count", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { sessionId, channel } = await connectedSession(harness, adapter, "saturated-session");
    const baselineEpoch = Math.floor(harness.clock.now().getTime() / 1000);

    harness.clock.advance(60_000);
    // 201 messages: one more than the per-tick cap. The real CLI's `--limit` truncates; this
    // double now honors `limit` (see its own comment) so this reproduces that truncation.
    const messages = Array.from({ length: 201 }, (_, i) => message(baselineEpoch + i + 1));
    source.respondWith(messages);
    await mentionWatch.tick([target(sessionId, channel)]);

    const report = await harness.cp.doctor.run("system");
    const finding = behindFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.observedEvidence).toMatchObject({
      sessionId,
      channelMessagesSinceBaseline: 200,
      atLeast: true,
    });
    // The over-fetch is what makes the distinction possible: asking for exactly 200 could never
    // tell "200 exactly" apart from "201 or more, truncated".
    expect(source.calls.at(-1)).toMatchObject({ limit: 201 });
  });

  it("finding 3 (boundary): exactly 200 messages is an exact count, not a floor", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { sessionId, channel } = await connectedSession(harness, adapter, "exactly-capped-session");
    const baselineEpoch = Math.floor(harness.clock.now().getTime() / 1000);

    harness.clock.advance(60_000);
    const messages = Array.from({ length: 200 }, (_, i) => message(baselineEpoch + i + 1));
    source.respondWith(messages);
    await mentionWatch.tick([target(sessionId, channel)]);

    const finding = behindFinding(await harness.cp.doctor.run("system"));
    expect(finding?.observedEvidence).toMatchObject({ channelMessagesSinceBaseline: 200, atLeast: false });
  });
});
