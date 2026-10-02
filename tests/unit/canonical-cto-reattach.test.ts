import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { snapshot, count } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture as makeFixture,
  claudeProcess,
  CLAUDE,
  CLAUDE_TOKEN,
  CONVERSATION,
  CTO,
  OTHER_CLAUDE,
  OTHER_CONVERSATION,
  RELAY,
  RESTARTED_TOKEN,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The canonical CTO's reattach decision (#1037), against the real registries and the claim's own
 * identity derivation, with the process tree stated by the test. Admission writes nothing, so every
 * case — admitted or refused — is asserted against a snapshot of every table it could have written.
 */

const fixtures: CanonicalCtoFixture[] = [];
const fixture = (): CanonicalCtoFixture => {
  const made = makeFixture();
  fixtures.push(made);
  return made;
};
afterEach(() => {
  for (const made of fixtures.splice(0)) made.h.cp.close();
});
afterAll(cleanupTempDirs);

const generation = (subject: CanonicalCtoFixture) =>
  subject.h.cp.db.all("SELECT assignment_id, binding_generation, status, session_id FROM assignments WHERE role_key = ?", [CTO]);

const expectUnbound = (subject: CanonicalCtoFixture, peerPid = RELAY): void => {
  const before = snapshot(subject.h);
  const decision = subject.reattach().admit({ peerPid, uid: 501 });
  expect(decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND });
  expect(snapshot(subject.h)).toEqual(before);
};

describe("canonical CTO reattach — admitted", () => {
  it("admits the live claimant's relay again, with no claim, generation, session or secret", () => {
    const subject = fixture();
    const before = snapshot(subject.h);
    const assignments = generation(subject);
    const reattach = subject.reattach();
    const first = reattach.admit({ peerPid: RELAY, uid: 501 });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.value).toMatchObject({ roleKey: CTO, bindingGeneration: 1, sessionId: subject.sessionId });
    // A respawned relay is just another child of the same claude.
    subject.processes.set(RELAY + 1, { ppid: CLAUDE, startedAt: "darwin-tv:1790000300.000003", argv: ["node"] });
    expect(reattach.admit({ peerPid: RELAY + 1, uid: 501 })).toEqual(first);
    expect(reattach.admit({ peerPid: RELAY, uid: 501 })).toEqual(first);
    expect(snapshot(subject.h)).toEqual(before);
    expect(generation(subject)).toEqual(assignments);
    expect(count(subject.h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    expect(reattach.authenticate(first.value)).toMatchObject({ allowed: true, value: { sessionId: subject.sessionId } });
    expect(reattach.connection(first.value)).toMatchObject({ allowed: true });
  });
});

describe("canonical CTO reattach — refusals write nothing", () => {
  it("refuses another claude process running the same conversation", () => {
    const subject = fixture();
    subject.processes.set(OTHER_CLAUDE, claudeProcess(CONVERSATION, "darwin-tv:1790000400.000004"));
    subject.processes.set(RELAY, { ppid: OTHER_CLAUDE, startedAt: "darwin-tv:1790000200.000002", argv: ["node"] });
    expectUnbound(subject);
  });

  it("refuses a relay under a nested claude running the same conversation below the bound one", () => {
    const subject = fixture();
    // The bound claude is an ancestor, but the claude the conversation is derived from is not it.
    subject.processes.set(OTHER_CLAUDE, { ...claudeProcess(CONVERSATION, "darwin-tv:1790000400.000004"), ppid: CLAUDE });
    subject.processes.set(RELAY, { ppid: OTHER_CLAUDE, startedAt: "darwin-tv:1790000200.000002", argv: ["node"] });
    expectUnbound(subject);
  });

  it("refuses a pid reused by a later start of claude", () => {
    const subject = fixture();
    subject.processes.set(CLAUDE, claudeProcess(CONVERSATION, RESTARTED_TOKEN));
    expectUnbound(subject);
  });

  it("refuses when the binding's runtime is another session's process", () => {
    const subject = fixture();
    expect(subject.h.cp.bindings.revoke(CTO, "moved to another runtime").allowed).toBe(true);
    subject.bindTo(OTHER_CLAUDE, CLAUDE_TOKEN);
    expectUnbound(subject);
  });

  it("refuses a REVOKED binding", () => {
    const subject = fixture();
    expect(subject.h.cp.bindings.revoke(CTO, "revoked").allowed).toBe(true);
    expectUnbound(subject);
  });

  it("refuses a claude now running another conversation", () => {
    const subject = fixture();
    subject.processes.set(CLAUDE, claudeProcess(OTHER_CONVERSATION, CLAUDE_TOKEN));
    expectUnbound(subject);
  });

  it("refuses, as the claim would and without sending the relay to it, a peer with no claude ancestor", () => {
    const subject = fixture();
    subject.processes.set(RELAY, { ppid: 1, startedAt: "darwin-tv:1790000200.000002", argv: ["node"] });
    const before = snapshot(subject.h);
    const decision = subject.reattach().admit({ peerPid: RELAY, uid: 501 });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).not.toBe(ReasonCode.CTO_REATTACH_UNBOUND);
    expect(snapshot(subject.h)).toEqual(before);
  });

  it("stops authenticating an admitted connection once its binding is revoked", () => {
    const subject = fixture();
    const reattach = subject.reattach();
    const admitted = reattach.admit({ peerPid: RELAY, uid: 501 });
    if (!admitted.allowed) throw new Error(JSON.stringify(admitted));
    expect(subject.h.cp.bindings.revoke(CTO, "revoked under an open connection").allowed).toBe(true);
    expect(reattach.authenticate(admitted.value)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
    });
  });
});
