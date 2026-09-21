import { afterAll, describe, expect, it } from "vitest";

import { executeCanonicalSelfClaimOperator, type CanonicalSelfClaimOperatorDeps } from "../../src/daemon/canonical-self-claim-operator.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `parseCanonicalSelfClaimOperatorRequest` is the first thing `actor.claimCanonicalCto` runs, and
 * `isNonEmptyString` is `typeof value === "string" && value.length > 0`. The two halves are
 * enforced in different places: TypeScript enforces the first, because removing it leaves an
 * `unknown` flowing into a `string` field and the mutant will not compile. Nothing but a test can
 * enforce the second, and these are it.
 *
 * An empty string that gets past this parser is not caught by an equivalent refusal further on —
 * it becomes a `projectId` of `""` carried into derivation and a `claimedSessionUuid` of `""`
 * compared against a derived UUID, so the caller is told the identity did not match rather than
 * that they sent nothing. That is the reading that sends an operator looking for a session.
 *
 * These cases refuse before `CanonicalSelfClaim` is constructed, so no real claude process,
 * socket or executor image is needed and nothing in `config` below is read. The control at the
 * end is what makes that safe to rely on: it proves a well-formed request gets *past* this
 * parser, so a handler that denied at its first line would fail it.
 */
const PEER = { peerPid: process.pid, uid: process.geteuid?.() ?? -1 };

const REQUEST = {
  claimedSessionUuid: "41439a5d-47af-4325-b63b-36643fdd384f",
  projectId: "prj_fixture",
  expectedBindingGeneration: 1,
};

const depsWith = (core: ReturnType<typeof makeCore>): CanonicalSelfClaimOperatorDeps => ({
  db: core.db,
  clock: core.clock,
  sessions: core.sessions,
  bindings: core.bindings,
  buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
    buzz: { allowedActors: ["fixture-actor"] },
  }),
  resolveBuzzAddress: async (): Promise<Decision<string>> => allow(ReasonCode.OK, "buzz://fixture"),
  config: {
    expectedPeerProtocolVersion: "fixture-protocol",
    expectedPeerIdentity: `uid:${PEER.uid}`,
    canonicalSessionUuid: REQUEST.claimedSessionUuid,
    requiredExecutorVersion: "0.0.0",
    canonicalBuzzChannelId: "fixture-channel",
    expectedExecutorRealpath: "/tmp/fixture-claude",
    expectedExecutorSha256: `sha256:${"b".repeat(64)}`,
    peerProtocolVersion: "fixture-protocol",
    buzzChannelId: "fixture-channel",
    buzzActorId: "fixture-actor",
    buzzPurpose: "fixture-purpose",
  },
});

const claimWith = async (overrides: Record<string, unknown>): Promise<Decision<unknown>> =>
  executeCanonicalSelfClaimOperator(PEER, { ...REQUEST, ...overrides }, depsWith(makeCore()));

describe("an empty string is not a request field", () => {
  // One case per string field the parser requires. Each breaks exactly one and leaves the rest
  // valid, so a case that passes says something about its own field rather than about the first
  // check that happens to run.
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["refuses an empty claimedSessionUuid", { claimedSessionUuid: "" }],
    ["refuses an empty projectId", { projectId: "" }],
    ["refuses a non-string claimedSessionUuid", { claimedSessionUuid: 7 }],
    ["refuses a non-string projectId", { projectId: null }],
  ];

  for (const [name, overrides] of cases) {
    it(name, async () => {
      const result = await claimWith(overrides);
      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      expect(result.message).toContain("missing a required field");
    });
  }

  it("the control: a well-formed request gets past this parser and is refused by a later clause", async () => {
    const result = await claimWith({});
    expect(result.allowed, JSON.stringify(result)).toBe(false);
    if (result.allowed) return;
    // Whatever this deployment's next refusal is, it is not the parser's — the point of the
    // control is that every case above names its own field rather than sharing one generic code
    // with a request that is in fact well formed.
    expect(result.reasonCode).not.toBe(ReasonCode.INVALID_ARGUMENT);
  });
});
