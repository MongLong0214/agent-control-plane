import { afterAll, afterEach, describe, expect, it } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  assertCanonicalRoomsAreSubscribed,
  configuredCanonicalSessions,
  subscribedBuzzRoomsFrom,
} from "../../src/daemon/agentcpd.ts";
import {
  CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED,
  createCanonicalCtoReattach,
  type CanonicalCtoBuzzAddressOptions,
} from "../../src/registry/canonical-cto-reattach.ts";
import type {
  CanonicalAdoptableSession,
  HostSessionRegistryReader,
  SubscribedBuzzRooms,
} from "../../src/registry/canonical-self-claim.ts";
import type { ProcessLineageReader } from "../../src/session/runtime-lineage.ts";
import { snapshot } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  claudeProcess,
  CLAUDE,
  CLAUDE_TOKEN,
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

/** The subscriber listening as the fixture's actor in exactly `rooms`, and as nobody else. */
const listeningIn = (rooms: readonly string[]): SubscribedBuzzRooms =>
  (buzzActorId) => (buzzActorId === ACTOR ? rooms : null);

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

  it("corrects the row when its subscriber identity listens in the entry's room, or does not listen as it at all", async () => {
    const listeningAsNobody: SubscribedBuzzRooms = () => null;
    for (const subscribedBuzzRooms of [listeningIn([WRONG_ROOM, ROOM]), listeningAsNobody]) {
      const { subject, options } = misaddressedHolder();
      const reattach = subject.reattach(options({ subscribedBuzzRooms }));
      expect(await reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 })).toMatchObject({
        allowed: true, value: { outcome: "CORRECTED" },
      });
      expect(roomOf(subject)).toBe(ROOM);
    }
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
    expected: { allowed: boolean; reasonCode?: string; message?: string; value?: unknown },
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

  /**
   * PR1060-R1-01. The write admits the holder again inside its transaction, and that admission
   * derives the conversation first and probes the lineage after, reading the runtime's native start
   * before it walks the relay's parents. A change landing during that walk was invisible to the
   * tuple it returned, so the row moved under a holder that was no longer the one admitted.
   *
   * `change` runs inside the transaction's `parentOf(RELAY)`, the first one after the room opened.
   * The conversation comes from the host registry here, as it does for a `/resume`d claude.
   */
  const probedHolder = (change: (registered: { conversation: string }) => void) => {
    const { subject, options } = misaddressedHolder();
    subject.processes.set(CLAUDE, { ...claudeProcess(CONVERSATION, CLAUDE_TOKEN), argv: ["/Users/fixture/.local/bin/claude"] });
    const registered = { conversation: CONVERSATION };
    const registryReader: HostSessionRegistryReader = {
      read: () => allow(ReasonCode.OK, { sessionUuid: registered.conversation }),
    };
    let opened = false;
    const processes: ProcessLineageReader = {
      parentOf: (pid) => {
        if (opened && pid === RELAY) {
          opened = false;
          change(registered);
        }
        return subject.processes.get(pid)?.ppid ?? null;
      },
      startToken: (pid) => subject.processes.get(pid)?.startedAt ?? null,
    };
    const reattach = subject.reattach({
      ...options({
        resolveBuzzAddress: async (_purpose, channelId) => {
          opened = true;
          return allow(ReasonCode.OK, channelId);
        },
      }),
      processes,
      registryReader,
    });
    return { subject, reattach };
  };

  it("refuses when the claude process's conversation changes while the write admits it again", async () => {
    const { subject, reattach } = probedHolder((registered) => {
      registered.conversation = OTHER_CONVERSATION;
    });
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CONFLICT, message: "the admitted holder changed while its room was opened",
    });
    // What the write would have stood on: the same pid and start, now running another conversation.
    expect(reattach.admit({ peerPid: RELAY, uid: 501 })).toMatchObject({
      allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND,
    });
  });

  it("refuses when the claude process's native start changes while the write admits it again", async () => {
    const { subject, reattach } = probedHolder(() => {
      subject.processes.set(CLAUDE, { ...claudeProcess(CONVERSATION, RESTARTED_TOKEN), argv: ["/Users/fixture/.local/bin/claude"] });
    });
    await expectUntouched(subject, () => reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CONFLICT, message: "the admitted holder changed while its room was opened",
    });
  });

  it("corrects once when nothing changes while the write admits it again", async () => {
    let probed = 0;
    const { subject, reattach } = probedHolder(() => {
      probed += 1;
    });
    expect(await reattach.correctBuzzAddress({ peerPid: RELAY, uid: 501 })).toMatchObject({
      allowed: true, value: { outcome: "CORRECTED", sessionId: subject.sessionId },
    });
    expect(probed).toBe(1);
    expect(roomOf(subject)).toBe(ROOM);
    expect(correctionRows(subject)).toHaveLength(1);
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

  it("refuses to move the row into a room its subscriber identity does not listen in, before opening it", async () => {
    // PR1060-R2-01. The holder's identity listens in WRONG_ROOM alone, so moving its row to ROOM
    // would leave it answering CEO mentions only from a room it never hears.
    const { subject, resolver, options } = misaddressedHolder();
    const deafened = subject.reattach(options({ subscribedBuzzRooms: listeningIn([WRONG_ROOM]) }));
    const refused = await deafened.correctBuzzAddress({ peerPid: RELAY, uid: 501 });
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    if (refused.allowed) return;
    expect(refused.message).toContain(`project ${PROJECT}`);
    expect(refused.message).toContain(`Buzz room ${ROOM}`);
    expect(refused.message).toContain(`listens only in ${WRONG_ROOM}`);
    expect(refused.message).not.toContain(ACTOR);
    await expectUntouched(subject, () => deafened.correctBuzzAddress({ peerPid: RELAY, uid: 501 }), {
      allowed: false, reasonCode: ReasonCode.CONFLICT,
    });
    expect(resolver.asked).toEqual([]);
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

describe("startup refuses an adopted CTO routed to a room its own subscriber identity does not listen in", () => {
  // PR1060-R2-01: the startup cross-check compared ACP_BUZZ_CHANNEL with the union of every
  // identity's rooms, so an entry routed to ROOM whose identity listens in the default room alone
  // started cleanly and then never heard a mention in ROOM.
  const DEFAULT_ROOM = WRONG_ROOM;
  const OTHER_ACTOR = "buzz:fixture-other-cto";
  const OTHER_ROOM = "9a1f0c3e-0000-4000-8000-000000000003";

  it("refuses an entry whose own room its identity does not listen in, naming the project and both rooms", () => {
    const check = () => assertCanonicalRoomsAreSubscribed(
      [entry()],
      DEFAULT_ROOM,
      subscribedBuzzRoomsFrom([{ actorId: ACTOR, rooms: [DEFAULT_ROOM] }]),
    );
    expect(check).toThrow(
      `ACP_CANONICAL_SESSIONS_JSON does not match the Buzz mention subscriber: the canonical CTO for project ${PROJECT} ` +
        `is routed to Buzz room ${ROOM}, but its mention subscriber identity listens only in ${DEFAULT_ROOM}; ` +
        "it would answer in one room and listen in another",
    );
  });

  it("checks each entry against its own identity, not the union of every identity's rooms", () => {
    // ROOM is in the union (OTHER_ACTOR listens there), which is what let this start before.
    expect(() => assertCanonicalRoomsAreSubscribed(
      [entry(), { sessionUuid: OTHER_CONVERSATION, projectId: "prj_other", buzzActorId: OTHER_ACTOR, buzzAddress: OTHER_ROOM }],
      DEFAULT_ROOM,
      subscribedBuzzRoomsFrom([
        { actorId: ACTOR, rooms: [DEFAULT_ROOM] },
        { actorId: OTHER_ACTOR, rooms: [OTHER_ROOM, ROOM] },
      ]),
    )).toThrow(`project ${PROJECT} is routed to Buzz room ${ROOM}`);
  });

  it("checks an entry without a room of its own against the deployment's room", () => {
    const withoutRoom = { sessionUuid: CONVERSATION, projectId: PROJECT, buzzActorId: ACTOR };
    expect(() => assertCanonicalRoomsAreSubscribed(
      [withoutRoom], DEFAULT_ROOM, subscribedBuzzRoomsFrom([{ actorId: ACTOR, rooms: [ROOM] }]),
    )).toThrow(`is routed to Buzz room ${DEFAULT_ROOM}, but its mention subscriber identity listens only in ${ROOM}`);
    expect(() => assertCanonicalRoomsAreSubscribed(
      [withoutRoom], DEFAULT_ROOM, subscribedBuzzRoomsFrom([{ actorId: ACTOR, rooms: [DEFAULT_ROOM] }]),
    )).not.toThrow();
  });

  it("starts when every subscribed entry's room is its identity's, and checks nothing no identity listens as", () => {
    expect(() => assertCanonicalRoomsAreSubscribed(
      [entry()], DEFAULT_ROOM, subscribedBuzzRoomsFrom([{ actorId: ACTOR, rooms: [DEFAULT_ROOM, ROOM] }]),
    )).not.toThrow();
    // No subscriber configured: nothing listens, so nothing can be deaf.
    expect(() => assertCanonicalRoomsAreSubscribed([entry()], DEFAULT_ROOM, subscribedBuzzRoomsFrom([]))).not.toThrow();
    // A subscriber that listens as someone else entirely.
    expect(() => assertCanonicalRoomsAreSubscribed(
      [entry()], DEFAULT_ROOM, subscribedBuzzRoomsFrom([{ actorId: OTHER_ACTOR, rooms: [DEFAULT_ROOM] }]),
    )).not.toThrow();
  });
});
