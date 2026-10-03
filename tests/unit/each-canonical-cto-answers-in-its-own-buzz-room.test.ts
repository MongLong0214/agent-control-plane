import { afterAll, afterEach, describe, expect, it } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { configuredCanonicalSessions } from "../../src/daemon/agentcpd.ts";
import {
  CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED,
  createCanonicalCtoReattach,
  type CanonicalCtoBuzzAddressOptions,
} from "../../src/registry/canonical-cto-reattach.ts";
import type { CanonicalAdoptableSession } from "../../src/registry/canonical-self-claim.ts";
import { snapshot } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  claudeProcess,
  CLAUDE,
  CONVERSATION,
  CTO,
  OTHER_CLAUDE,
  OTHER_CONVERSATION,
  PROJECT,
  RELAY,
  RESTARTED_TOKEN,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * Each canonical CTO is written into its own project's CEO room (2026-10-03).
 *
 * Measured live that day: three canonical CTOs, three projects, three rooms, and every one of their
 * session rows carried the one deployment channel, because the claim wrote `ACP_BUZZ_CHANNEL` for
 * all of them. The peer rule admits a CEO mention only on the addressed CTO's own `buzz_address`, so
 * mentions to two of the three were refused or delivered under the wrong room.
 *
 * Two halves. An adoptable-session entry may name its room (`buzzAddress`), validated where the set
 * is parsed. And a holder already bound under the wrong room is corrected in place by the reattach
 * that proves it is the same live holder — one write, one audit row, nothing else moved — because
 * replacing its row would mean a revoke, a re-claim the same-live recovery refuses for a changed
 * address, and so a restart of the CTO's `claude`.
 */

/** The room the live rows were written into, standing in for the deployment channel. */
const WRONG_ROOM = "c37e88d0-0000-4000-8000-000000000001";
/** The room this project's CEO actually writes in. */
const ROOM = "6dcb2a67-0000-4000-8000-000000000002";
const ACTOR = "buzz:fixture-cto";

const entry = (overrides: Partial<CanonicalAdoptableSession> = {}): CanonicalAdoptableSession => ({
  sessionUuid: CONVERSATION,
  projectId: PROJECT,
  buzzActorId: ACTOR,
  buzzAddress: ROOM,
  ...overrides,
});

describe("ACP_CANONICAL_SESSIONS_JSON: an entry may name its own room, and only a channel UUID", () => {
  it("keeps a well-formed room, admits an entry without one, and refuses every malformed room", () => {
    const parsed = configuredCanonicalSessions(JSON.stringify([
      entry(),
      { sessionUuid: OTHER_CONVERSATION, projectId: "prj_other", buzzActorId: "buzz:other" },
    ]));
    expect(parsed).toEqual([
      entry(),
      { sessionUuid: OTHER_CONVERSATION, projectId: "prj_other", buzzActorId: "buzz:other" },
    ]);
    for (const malformed of [
      "not-a-channel",
      ROOM.toUpperCase(),
      ` ${ROOM}`,
      `${ROOM} `,
      "",
      null,
      42,
    ]) {
      expect(() => configuredCanonicalSessions(JSON.stringify([{ ...entry(), buzzAddress: malformed }])), String(malformed))
        .toThrow(/^ACP_CANONICAL_SESSIONS_JSON is invalid$/);
    }
  });
});

const fixtures: CanonicalCtoFixture[] = [];
afterEach(() => {
  for (const made of fixtures.splice(0)) made.h.cp.close();
});
afterAll(cleanupTempDirs);

/** A resolver that opens whichever room it is asked for, and records each ask. */
const openingResolver = () => {
  const asked: string[] = [];
  const resolve = async (_purpose: string, channelId: string): Promise<Decision<string>> => {
    asked.push(channelId);
    return allow(ReasonCode.OK, channelId);
  };
  return { asked, resolve };
};

/**
 * The live shape: the canonical CTO bound at generation 1 by the claim, its row carrying the
 * deployment channel rather than its project's room.
 */
const misaddressedHolder = (sessions: readonly CanonicalAdoptableSession[] = [entry()]) => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  subject.h.cp.sessions.setBuzzAddress(subject.sessionId, WRONG_ROOM);
  const resolver = openingResolver();
  const options = (overrides: Partial<CanonicalCtoBuzzAddressOptions> = {}) => ({
    buzzAddress: { canonicalSessions: sessions, resolveBuzzAddress: resolver.resolve, buzzPurpose: "continuity:PRIMARY_CTO", ...overrides },
  });
  return { subject, resolver, reattach: subject.reattach(options()), options };
};

const roomOf = (subject: CanonicalCtoFixture): string | null =>
  subject.h.cp.sessions.get(subject.sessionId)?.buzzAddress ?? null;

const correctionRows = (subject: CanonicalCtoFixture) =>
  subject.h.cp.db.all<{ session_id: string; role_key: string; project_id: string; reason_code: string; evidence_json: string }>(
    "SELECT session_id, role_key, project_id, reason_code, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id",
    [CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED],
  ).map(({ evidence_json, ...row }) => ({ ...row, evidence: JSON.parse(evidence_json) as unknown }));

describe("the same live holder's reattach corrects its own row's room", () => {
  it("moves buzz_address to the entry's room once, with one audit row, and moves nothing else", async () => {
    const { subject, resolver, reattach } = misaddressedHolder();
    const before = snapshot(subject.h);
    const admission = reattach.admit({ peerPid: RELAY, uid: 501 });

    const corrected = await reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 });

    expect(corrected).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.OK,
      value: { outcome: "CORRECTED", sessionId: subject.sessionId },
    });
    expect(roomOf(subject)).toBe(ROOM);
    expect(resolver.asked).toEqual([ROOM]);
    expect(correctionRows(subject)).toEqual([{
      session_id: subject.sessionId,
      role_key: CTO,
      project_id: PROJECT,
      reason_code: ReasonCode.OK,
      evidence: { identity: CONVERSATION, generation: 1, previousBuzzAddress: WRONG_ROOM, buzzAddress: ROOM },
    }]);
    // Everything but the corrected row and its one audit row is byte for byte what it was: the same
    // session, incarnation and secret, the same assignment at the same generation, no new actor.
    const after = snapshot(subject.h);
    const sessionBefore = JSON.parse(before["sessions"]![0]!) as Record<string, unknown>;
    expect(after["sessions"]!.map((row) => JSON.parse(row) as unknown)).toEqual([
      { ...sessionBefore, buzz_address: ROOM, updated_at: expect.any(String) },
    ]);
    expect(after["audit_events"]).toHaveLength(before["audit_events"]!.length + 1);
    expect({ ...after, sessions: [], audit_events: [] }).toEqual({ ...before, sessions: [], audit_events: [] });
    // The connection the holder already has is still admitted, under the same binding.
    expect(reattach.admit({ peerPid: RELAY, uid: 501 })).toEqual(admission);
  });

  it("is a no-op once the row is in its room: no Buzz call, no write, no second audit row", async () => {
    const { subject, resolver, reattach } = misaddressedHolder();
    expect((await reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 })).allowed).toBe(true);
    const corrected = snapshot(subject.h);

    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect(await reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 })).toMatchObject({
        allowed: true,
        value: { outcome: "ALREADY_CORRECT", sessionId: subject.sessionId },
      });
    }
    expect(resolver.asked).toEqual([ROOM]);
    expect(correctionRows(subject)).toHaveLength(1);
    expect(snapshot(subject.h)).toEqual(corrected);
  });

  it("writes once when two reattaches race to correct the same row", async () => {
    const { subject, reattach } = misaddressedHolder();
    const outcomes = await Promise.all([
      reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }),
      reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }),
    ]);
    expect(outcomes.map((outcome) => (outcome.allowed ? outcome.value.outcome : outcome.reasonCode)).sort())
      .toEqual(["ALREADY_CORRECT", "CORRECTED"]);
    expect(roomOf(subject)).toBe(ROOM);
    expect(correctionRows(subject)).toHaveLength(1);
  });
});

describe("nobody but that holder can move the row, and a refusal writes nothing", () => {
  const expectUntouched = async (
    subject: CanonicalCtoFixture,
    attempt: () => Promise<Decision<unknown>>,
    expected: { allowed: boolean; reasonCode?: string; value?: unknown },
  ): Promise<void> => {
    const before = snapshot(subject.h);
    expect(await attempt()).toMatchObject(expected);
    expect(snapshot(subject.h)).toEqual(before);
    expect(roomOf(subject)).toBe(WRONG_ROOM);
    expect(correctionRows(subject)).toEqual([]);
  };

  it("refuses another claude process running the same conversation", async () => {
    const { subject, resolver, reattach } = misaddressedHolder();
    subject.processes.set(OTHER_CLAUDE, claudeProcess(CONVERSATION, "darwin-tv:1790000400.000004"));
    subject.processes.set(RELAY + 7, { ppid: OTHER_CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY + 7, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND,
    });
    expect(resolver.asked).toEqual([]);
  });

  it("refuses the same pid restarted as a new claude process", async () => {
    const { subject, resolver, reattach } = misaddressedHolder();
    subject.processes.set(CLAUDE, claudeProcess(CONVERSATION, RESTARTED_TOKEN));
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND,
    });
    expect(resolver.asked).toEqual([]);
  });

  it("refuses a holder whose binding was revoked", async () => {
    const { subject, reattach } = misaddressedHolder();
    expect(subject.h.cp.bindings.revoke(CTO, "revoked before the correction").allowed).toBe(true);
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND,
    });
  });

  it("refuses when the conversation's entry names another project than the binding holds", async () => {
    const { subject, resolver, reattach } = misaddressedHolder([entry({ projectId: "prj_not_this_binding" })]);
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CONFLICT,
    });
    expect(resolver.asked).toEqual([]);
  });

  it("refuses when the holder is replaced while its room is being opened", async () => {
    const { subject, options } = misaddressedHolder();
    // The Buzz CLI is the await that hands control away; the claude process restarts during it.
    const reattach = subject.reattach(options({
      resolveBuzzAddress: async (_purpose, channelId) => {
        subject.processes.set(CLAUDE, claudeProcess(CONVERSATION, RESTARTED_TOKEN));
        return allow(ReasonCode.OK, channelId);
      },
    }));
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND,
    });
  });

  it("refuses when the room cannot be opened, or opens as another room", async () => {
    const { subject, options } = misaddressedHolder();
    const unavailable = subject.reattach(options({
      resolveBuzzAddress: async () => deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", {}),
    }));
    await expectUntouched(subject, () => unavailable.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.PROBE_FAILED,
    });
    const elsewhere = subject.reattach(options({ resolveBuzzAddress: async () => allow(ReasonCode.OK, WRONG_ROOM) }));
    await expectUntouched(subject, () => elsewhere.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CONFLICT,
    });
  });

  it("leaves a row alone when its entry names no room, or the conversation has no entry", async () => {
    const withoutRoom = misaddressedHolder([{ sessionUuid: CONVERSATION, projectId: PROJECT, buzzActorId: ACTOR }]);
    await expectUntouched(withoutRoom.subject, () => withoutRoom.reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: true, value: { outcome: "NOT_CONFIGURED" },
    });
    const notInSet = misaddressedHolder([entry({ sessionUuid: OTHER_CONVERSATION })]);
    await expectUntouched(notInSet.subject, () => notInSet.reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: true, value: { outcome: "NOT_CONFIGURED" },
    });
    expect(withoutRoom.resolver.asked).toEqual([]);
    expect(notInSet.resolver.asked).toEqual([]);
  });

  it("refuses to construct with a malformed room, so one is never written", () => {
    const subject = canonicalCtoFixture();
    fixtures.push(subject);
    const before = snapshot(subject.h);
    for (const malformed of ["not-a-channel", ROOM.toUpperCase(), ` ${ROOM}`, ""]) {
      expect(() => subject.reattach({
        buzzAddress: {
          canonicalSessions: [entry({ buzzAddress: malformed })],
          resolveBuzzAddress: openingResolver().resolve,
          buzzPurpose: "continuity:PRIMARY_CTO",
        },
      }), malformed).toThrow(/buzzAddress must be a lower-case channel UUID/);
    }
    expect(snapshot(subject.h)).toEqual(before);
    // `createCanonicalCtoReattach` itself, not only the fixture's wrapper.
    expect(() => createCanonicalCtoReattach(subject.h.cp, {
      buzzAddress: {
        canonicalSessions: [entry({ buzzAddress: "nope" })],
        resolveBuzzAddress: openingResolver().resolve,
        buzzPurpose: "continuity:PRIMARY_CTO",
      },
    })).toThrow(/buzzAddress/);
  });
});
