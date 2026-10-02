import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { AdoptedCeoAdmission } from "../../src/bootstrap/adopted-ceo-tool-admission.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import {
  BuzzActorIngress,
  buzzActorBindingSigningRequest,
  IngressGuard,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import {
  adoptedFixture as makeAdoptedFixture,
  GATEWAY,
  snapshot,
  STRANGER,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The adopted CEO binding its own Buzz channel identity through the one writer of
 * `sessions.buzz_actor_id` (#1037): `BuzzActorIngress.bindActor`, with the tool connection's lineage
 * admission as the session proof in place of a secret, and the relay-signed envelope and its nonce
 * still the external signature boundary. Every refusal leaves every table as it was.
 */

const SECRET = "fixture-buzz-ingress-secret";
const CEO_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

const fixtures: AdoptedCeoFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
});
afterAll(cleanupTempDirs);

let nonces = 0;
const subject = async () => {
  const fixture = makeAdoptedFixture();
  fixtures.push(fixture);
  const guard = new IngressGuard(fixture.h.cp.db, fixture.h.cp.clock, fixture.h.cp.audit, {
    buzz: { secret: SECRET, allowedActors: [CEO_KEY, OTHER_KEY] },
  });
  const ingress = new BuzzActorIngress(guard, fixture.h.cp.sessions);
  const decision = await fixture.admit();
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  const admitted: AdoptedCeoAdmission = decision.value;
  /** An envelope the relay signed for `signedFor`, on this runtime's session, with a fresh nonce. */
  const envelope = (signedFor = CEO_KEY, nonce = `bind-${nonces++}`) => ({
    nonce,
    signature: ingressSignature(
      SECRET,
      buzzActorBindingSigningRequest({ actor: signedFor, sessionId: admitted.sessionId, nonce }),
    ),
  });
  const bind = (actor: string, signed = envelope(actor)) =>
    ingress.bindActor({ actor, admitted: admitted.runtime, ...signed });
  const boundActor = () => fixture.h.cp.sessions.get(admitted.sessionId)?.buzzActorId ?? null;
  return { fixture, ingress, admitted, envelope, bind, boundActor };
};

const expectNoWrites = <T>(fixture: AdoptedCeoFixture, run: () => { allowed: boolean; reasonCode: T }, reasonCode: T): void => {
  const before = snapshot(fixture.h);
  const decision = run();
  expect(decision.allowed).toBe(false);
  expect(decision.reasonCode).toBe(reasonCode);
  expect(snapshot(fixture.h)).toEqual(before);
};

describe("the adopted CEO binds its own Buzz channel identity", () => {
  it("binds once through the one writer, and answers a fresh retry of the same binding without writing", async () => {
    const { fixture, bind, boundActor, admitted } = await subject();
    expect(boundActor()).toBeNull();
    const first = bind(CEO_KEY);
    expect(first).toMatchObject({ allowed: true, value: { sessionId: admitted.sessionId, buzzActorId: CEO_KEY } });
    expect(fixture.h.cp.audit.byKind("SESSION_BUZZ_ACTOR_BOUND")).toHaveLength(1);
    const before = snapshot(fixture.h);
    expect(bind(CEO_KEY)).toMatchObject({ allowed: true, value: { buzzActorId: CEO_KEY } });
    expect(snapshot(fixture.h)).toEqual(before);
  });

  it("refuses an envelope signed for another identity than the one it would bind", async () => {
    const { fixture, bind, envelope, boundActor } = await subject();
    expectNoWrites(fixture, () => bind(CEO_KEY, envelope(OTHER_KEY)), ReasonCode.INGRESS_SIGNATURE_INVALID);
    expectNoWrites(fixture, () => bind(CEO_KEY, { nonce: "unsigned", signature: "" }), ReasonCode.INGRESS_SIGNATURE_INVALID);
    expect(boundActor()).toBeNull();
  });

  it("refuses a replayed envelope", async () => {
    const { fixture, bind, envelope } = await subject();
    const signed = envelope(CEO_KEY);
    expect(bind(CEO_KEY, signed).allowed).toBe(true);
    expectNoWrites(fixture, () => bind(CEO_KEY, signed), ReasonCode.INGRESS_REPLAY_IGNORED);
  });

  it("refuses an identity another live session already speaks as", async () => {
    const { fixture, bind, boundActor } = await subject();
    const other = fixture.h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    expect(fixture.h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    const guard = new IngressGuard(fixture.h.cp.db, fixture.h.cp.clock, fixture.h.cp.audit, {
      buzz: { secret: SECRET, allowedActors: [CEO_KEY] },
    });
    expect(fixture.h.cp.sessions.bindBuzzActor(
      { sessionId: other.sessionId, sessionSecret: other.sessionSecret!, buzzActorId: CEO_KEY },
      guard,
    ).allowed).toBe(true);
    expectNoWrites(fixture, () => bind(CEO_KEY), ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND);
    expect(boundActor()).toBeNull();
  });

  it("refuses a session that already speaks as a different identity", async () => {
    const { fixture, bind } = await subject();
    expect(bind(CEO_KEY).allowed).toBe(true);
    expectNoWrites(fixture, () => bind(OTHER_KEY), ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE);
  });

  it("refuses a proof no lineage admission minted, at the ingress and at the writer", async () => {
    const { fixture, ingress, admitted, envelope } = await subject();
    const forged = { sessionId: admitted.sessionId, sessionIncarnation: admitted.sessionIncarnation };
    expectNoWrites(fixture, () => ingress.bindActor({ actor: CEO_KEY, admitted: forged, ...envelope() }), ReasonCode.CONFLICT);
    expectNoWrites(
      fixture,
      () => fixture.h.cp.sessions.bindBuzzActor({ admitted: forged, buzzActorId: CEO_KEY }, { isAllowedActor: () => true }),
      ReasonCode.CONFLICT,
    );
  });

  it("mints no proof for another process or a reused pid, so neither can reach the writer", async () => {
    const { fixture } = await subject();
    // Another process: not a descendant of the Gateway.
    expect((await fixture.admit(STRANGER)).allowed).toBe(false);
    // A reused pid: the process at the Gateway's pid started at neither recorded moment.
    fixture.tokens.set(GATEWAY, "darwin-tv:1790000999.000002");
    fixture.starts.set(GATEWAY, "Fri Oct  2 08:00:00 2026");
    expect((await fixture.admit()).allowed).toBe(false);
  });

  it("refuses a runtime that has since stopped", async () => {
    const { fixture, bind, admitted } = await subject();
    expect(fixture.h.cp.sessions.transition(admitted.sessionId, SessionLifecycle.STOPPED).allowed).toBe(true);
    expectNoWrites(fixture, () => bind(CEO_KEY), ReasonCode.SESSION_NOT_READY);
  });
});
