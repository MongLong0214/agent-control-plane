import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { BuzzAdapter, InMemoryBuzzTransport, type BuzzCliMessage } from "../../src/buzz/buzz-adapter.ts";
import { BuzzMentionWatch, type BuzzMentionSource } from "../../src/buzz/mention-watch.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";

afterAll(cleanupTempDirs);

/**
 * #674 — a session's ad hoc, session-local poll for Buzz mentions can die silently, and three
 * separate times in one incident a dead poller and "nothing new arrived" were indistinguishable.
 * This is the read side of the fix: a durable cursor plus tick health, so Doctor can say
 * "N channel messages behind since T" without depending on that poller's own liveness.
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
    return this.#current;
  }
}

const behindFinding = (report: DoctorReport) => report.findings.find((f) => f.code === "BUZZ_MENTIONS_BEHIND");
const neverCheckedFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "BUZZ_MENTIONS_NEVER_CHECKED");
const unavailableFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "BUZZ_MENTIONS_WATCH_UNAVAILABLE");

/** A live session, bound to a Buzz channel through the real `connect()` path. */
const connectedSession = async (
  harness: ReturnType<typeof makeHarness>,
  adapter: BuzzAdapter,
  model: string,
): Promise<{ sessionId: string; channel: string }> => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test session");
  const connected = await adapter.connect(session.sessionId, `cto:${model}`);
  if (!connected.allowed) throw new Error(`fixture setup failed: connect refused (${JSON.stringify(connected)})`);
  return { sessionId: session.sessionId, channel: connected.value };
};

describe("what doctor says about a silent buzz mention watch (#674)", () => {
  it("says nothing when a check just succeeded and found nothing new", async () => {
    const harness = makeHarness();
    const source = new ScriptedMentionSource();
    const mentionWatch = new BuzzMentionWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
    const adapter = new BuzzAdapter(
      harness.cp.db, harness.cp.clock, harness.cp.audit,
      harness.cp.sessions, harness.cp.bindings, harness.cp.outbox,
      new InMemoryBuzzTransport(), mentionWatch,
    );
    const { channel } = await connectedSession(harness, adapter, "silence-session");

    source.respondWith([]);
    await mentionWatch.tick([channel]);

    const report = await harness.cp.doctor.run("system");
    expect(behindFinding(report)).toBeUndefined();
    expect(neverCheckedFinding(report)).toBeUndefined();
    expect(unavailableFinding(report)).toBeUndefined();
  });

  it("reports N channel messages behind since the baseline, and does not double-count on a repeat tick", async () => {
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
    await mentionWatch.tick([channel]);

    const report = await harness.cp.doctor.run("system");
    const finding = behindFinding(report);
    expect(finding).toBeDefined();
    expect(finding?.blocking).toBe(false);
    expect(finding?.observedEvidence).toMatchObject({
      sessionId,
      channel,
      channelMessagesSinceBaseline: 4,
      sinceIso: new Date(baselineEpoch * 1000).toISOString(),
      checkedAt: harness.clock.nowIso(),
    });

    // A crash between the CLI read and the write loses nothing and double-counts nothing: the
    // next tick re-asks the same question against the same baseline and gets the same answer.
    harness.clock.advance(1_000);
    await mentionWatch.tick([channel]);
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
    await mentionWatch.tick([channel]);
    const lastGoodAt = harness.clock.nowIso();

    harness.clock.advance(30_000);
    source.failNextWith(new Error("buzz messages get --since returned unparseable output: <html>502"));
    await mentionWatch.tick([channel]);

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
    await mentionWatch.tick([channel]);
    expect(behindFinding(await harness.cp.doctor.run("system"))?.observedEvidence).toMatchObject({
      channelMessagesSinceBaseline: 2,
    });

    // A harness restart reconnects the (new) session — #674's own incident. `connect()` is the
    // one production call site that re-arms the baseline.
    const reconnected = await adapter.connect(session.sessionId, purpose);
    expect(reconnected.allowed).toBe(true);

    source.respondWith([]);
    await mentionWatch.tick([channel]);
    expect(behindFinding(await harness.cp.doctor.run("system"))).toBeUndefined();
  });
});
