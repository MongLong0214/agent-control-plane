import { afterAll, afterEach, describe, expect, it } from "vitest";

import { configuredBuzzActorIngressPolicy } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  buzzActorBindingSigningRequest,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Role authority does not float. It is always an allowlisted actor, grounded through a binding and
 * an assignment.
 *
 * The predicate this serves used to read "deployment policy confirms the CEO and CTO role aliases
 * have allowlist entries". That cannot be observed, because the deployment allowlist —
 * `ACP_BUZZ_ALLOWED_ACTORS`, resolved by `configuredBuzzActorIngressPolicy` — is a **flat list of
 * actors with no role dimension at all**. Reading it for "the CEO's entry" requires inventing a
 * naming convention, and a convention would pass as a string while enforcement kept looking at the
 * flat list. That is the defect the gate exists to catch, written into the gate.
 *
 * So the two observable halves are negative, and they are what these tests pin:
 *
 *   (i)  an actor absent from the deployment allowlist cannot bind at all;
 *   (ii) an actor present in it, and successfully bound, still holds no role authority.
 *
 * Both drive the production path — `configuredBuzzActorIngressPolicy` → `IngressGuard.admit` →
 * `BuzzActorIngress.bindActor` → `SessionRegistry.bindBuzzActor`, and `ProductionGate` for the
 * authority half. A test that built its own allowlist would prove `IngressGuard` enforces whatever
 * list it is handed, which was never in question — the same mistake #423 shipped.
 *
 * Two more pin the actor→session mapping those halves both quantify over. Each reasons from "the
 * actor that spoke is *this* session", so a mapping that admitted two live holders would leave
 * that phrase without a referent and authority would float again, below the level either half can
 * see:
 *
 *   (iii) a live session cannot take an identity another live session holds;
 *   (iv)  a session that is no longer live releases it, so the actor can reconnect.
 *
 * (iv) is not a nicety. Without it the rule is "one session per actor per deployment lifetime" and
 * every reconnect fails closed — and (iii) alone cannot tell the two apart, since both refuse the
 * second bind. The schema states this as a partial unique index; these drive it through the same
 * production path, because a constraint has to arrive as a refusal rather than a raw SqliteError.
 */
const KEYS = ["ACP_BUZZ_INGRESS_SECRET", "ACP_BUZZ_ALLOWED_ACTORS"] as const;
const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const previous = saved.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

/** A session's secret is nullable on the record; binding requires a real one. */
const secretOf = (session: { sessionId: string; sessionSecret: string | null }) => {
  if (!session.sessionSecret) throw new Error("session was created without a secret");
  return { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
};

const SECRET = "deployment-ingress-secret";
const ALLOWED = "buzz-actor-allowlisted";
/** A second allowlisted actor, so "this actor is taken" is separable from "this session cannot bind". */
const ALLOWED_OTHER = "buzz-actor-allowlisted-other";

/** Configure the deployment, then read it back through the resolver the daemon uses. */
const deploymentPolicy = () => {
  process.env["ACP_BUZZ_INGRESS_SECRET"] = SECRET;
  process.env["ACP_BUZZ_ALLOWED_ACTORS"] = `${ALLOWED},${ALLOWED_OTHER}`;
  const policy = configuredBuzzActorIngressPolicy();
  if (!policy) throw new Error("the deployment resolver returned no policy");
  return policy;
};

const bindThrough = (
  harness: ReturnType<typeof makeHarness>,
  actor: string,
  session: { sessionId: string; sessionSecret: string },
  nonce: string,
) => {
  const policy = deploymentPolicy();
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, { buzz: policy });
  const ingress = new BuzzActorIngress(guard, harness.cp.sessions);
  const request = { actor, sessionId: session.sessionId, sessionSecret: session.sessionSecret, nonce };
  const signature = ingressSignature(SECRET, buzzActorBindingSigningRequest(request));
  return ingress.bindActor({ ...request, signature });
};

describe("role authority is grounded in an allowlisted actor, never floating", () => {
  it("refuses to bind an actor the deployment allowlist does not name", () => {
    const harness = makeHarness();
    const session = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));

    const refused = bindThrough(
      harness,
      "buzz-actor-not-allowlisted",
      session,
      "nonce-unlisted",
    );

    expect(
      refused.allowed,
      "an actor the deployment never allowlisted was able to bind an identity",
    ).toBe(false);
    if (refused.allowed) return;
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);

    // The allowlist is the deployment's, not this test's: the same call with the configured actor
    // succeeds against the identical guard. Without this line the assertion above would also pass
    // if binding were broken for every actor.
    const admitted = bindThrough(
      harness,
      ALLOWED,
      session,
      "nonce-listed",
    );
    expect(admitted.allowed, admitted.allowed ? "" : `${admitted.reasonCode}: ${admitted.message}`).toBe(true);
  });

  it("gives a bound, allowlisted actor no CEO authority without the assignment", async () => {
    // The half that matters. Being on the allowlist and holding a bound Buzz identity is exactly
    // what a role-keyed reading of the config would treat as "the CEO entry is present and valid".
    // It is not authority: authority comes from the assignment, and `assertCurrentCeo` reads that.
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness, { workBranch: "feature/F1-grounding" });

    // A real CEO already exists (the fixture binds one) and is a different session, so the refusal
    // below is "you are not the bound CEO" rather than "nobody is" — the weaker of the two would
    // also pass with the role left unbound entirely.
    const boundCeo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
    if (!boundCeo) throw new Error("fixture CEO binding missing");

    const impostor = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));
    const bound = bindThrough(
      harness,
      ALLOWED,
      impostor,
      "nonce-authority",
    );
    expect(bound.allowed, bound.allowed ? "" : `${bound.reasonCode}: ${bound.message}`).toBe(true);
    expect(impostor.sessionId).not.toBe(boundCeo.sessionId);

    await harness.cp.continuity.evaluate("buzz actor authority grounding");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);

    const decided = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: impostor.sessionId,
      rationale: "an allowlisted actor should not be able to decide",
    });

    expect(
      decided.allowed,
      "an allowlisted, bound Buzz actor confirmed a run without holding the CEO assignment",
    ).toBe(false);
    if (decided.allowed) return;
    expect(decided.reasonCode).toBe(ReasonCode.GATE_AUTHORITY_DENIED);
  });

  it("refuses to give a live session an actor identity another live session already holds", () => {
    // (iii). The grounding above is only worth as much as the actor→session mapping underneath it:
    // both halves reason from "the actor that spoke is *this* session". If one allowlisted actor
    // could be held by two live sessions at once, that premise has no referent — the same actor
    // resolves to two sessions, and whichever the lookup reaches first lends its role. Authority
    // would float again, this time below the level the allowlist and the assignment can see.
    //
    // The schema states the rule as a partial unique index over live lifecycles, which is a rule
    // about the *database*. This drives the production path instead, because that is where the
    // constraint has to arrive as a refusal rather than an unhandled exception.
    const harness = makeHarness();
    const first = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));
    const second = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));
    expect(first.sessionId).not.toBe(second.sessionId);

    const held = bindThrough(harness, ALLOWED, first, "nonce-transfer-first");
    expect(held.allowed, held.allowed ? "" : `${held.reasonCode}: ${held.message}`).toBe(true);

    const stolen = bindThrough(harness, ALLOWED, second, "nonce-transfer-second");
    expect(
      stolen.allowed,
      "two live sessions were able to hold the same Buzz actor identity at once",
    ).toBe(false);
    if (stolen.allowed) return;
    expect(stolen.reasonCode).toBe(ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND);

    // Two controls, because the refusal above passes for two wrong reasons as well as the right one.
    // The second session is not simply unbindable — a *different* allowlisted actor binds to it:
    const other = bindThrough(harness, ALLOWED_OTHER, second, "nonce-transfer-other");
    expect(other.allowed, other.allowed ? "" : `${other.reasonCode}: ${other.message}`).toBe(true);

    // ...and the rule is "non-transferable", not "bind once ever": the session that already holds
    // the identity can re-present it. Without this, a guard that refused every second bind would
    // pass, and re-delivery of a binding would break in production.
    const again = bindThrough(harness, ALLOWED, first, "nonce-transfer-idempotent");
    expect(again.allowed, again.allowed ? "" : `${again.reasonCode}: ${again.message}`).toBe(true);
  });

  it("releases the actor identity once the holding session is no longer live", () => {
    // The other side of the same index, and the reason it is written as a *partial* one. The
    // exclusion above has to end when the session does, or an actor gets exactly one session per
    // deployment lifetime and every reconnect after the first is refused — the relay's normal case,
    // failing closed. "Non-transferable" and "permanently consumed" are indistinguishable from the
    // refusal test alone; this is what separates them.
    const harness = makeHarness();
    const held = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));
    const bound = bindThrough(harness, ALLOWED, held, "nonce-release-first");
    expect(bound.allowed, bound.allowed ? "" : `${bound.reasonCode}: ${bound.message}`).toBe(true);

    // While the holder is live, the identity is taken — this is the precondition, not the claim.
    const reconnect = secretOf(harness.cp.sessions.create({ provider: "claude", model: "sonnet" }));
    const early = bindThrough(harness, ALLOWED, reconnect, "nonce-release-early");
    expect(early.allowed, "the identity was transferable while its holder was still live").toBe(false);

    const stopped = harness.cp.sessions.transition(held.sessionId, SessionLifecycle.STOPPED, "released");
    expect(stopped.allowed, stopped.allowed ? "" : `${stopped.reasonCode}: ${stopped.message}`).toBe(true);

    const rebound = bindThrough(harness, ALLOWED, reconnect, "nonce-release-after");
    expect(
      rebound.allowed,
      rebound.allowed
        ? ""
        : `a stopped session kept its actor identity, so the actor can never reconnect: ${rebound.reasonCode}`,
    ).toBe(true);
  });
});
