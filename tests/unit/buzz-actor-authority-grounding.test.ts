import { afterAll, afterEach, describe, expect, it } from "vitest";

import { configuredBuzzActorIngressPolicy } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
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

/** Configure the deployment, then read it back through the resolver the daemon uses. */
const deploymentPolicy = () => {
  process.env["ACP_BUZZ_INGRESS_SECRET"] = SECRET;
  process.env["ACP_BUZZ_ALLOWED_ACTORS"] = ALLOWED;
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
});
