import { afterAll, describe, expect, it } from "vitest";

import { executeCanonicalSelfClaimOperator, type CanonicalSelfClaimOperatorDeps } from "../../src/daemon/canonical-self-claim-operator.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { OwnerAuthority } from "../../src/ceo/owner-authority.ts";
import { SELF_CLAIM_OPERATION, canonicalSelfClaimParameterDigest } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #833. `src/daemon/canonical-self-claim-operator.ts` was excluded from the refusal-operand census
 * on the same per-file boilerplate as the rest of the PRIMARY_CTO authority path. Its twenty
 * operands are three clusters, and two of them decide whether a stored owner approval is one:
 *
 *   `isNonEmptyString` and the four request-field checks   — what the claimant may say
 *   `isStoredOwnerApprovalPayload`                          — what storage must hold
 *   `loadAdmittedOwnerApproval`'s row guard                 — whether there is a row at all
 *
 * Every case here enters through `executeCanonicalSelfClaimOperator`, the production handler the
 * listener calls. Both refusal clusters run *before* `CanonicalSelfClaim` is constructed, so no
 * real claude process, socket, or executor image is needed — and nothing in `config` below is
 * read on these paths. The control at the end is what makes that safe to rely on: it proves a
 * well-formed envelope gets *past* this validator, so a handler that denied at its first line
 * would fail it.
 *
 * The malformed rows are inserted directly rather than written and then corrupted.
 * `inbound_messages_payload_immutable` refuses an UPDATE of `payload_json` — which is the
 * property #646 left behind — so the only way to hold a bad envelope is to have stored one.
 */
const PEER = { peerPid: process.pid, uid: process.geteuid?.() ?? -1 };

const REQUEST = {
  claimedSessionUuid: "41439a5d-47af-4325-b63b-36643fdd384f",
  projectId: "prj_fixture",
  expectedBindingGeneration: 1,
};

/**
 * The operation and the digest are read out of the product, not written here.
 *
 * The first revision of this file typed a plausible `sha256:aaa…` and the control case caught it:
 * a well-formed-looking envelope whose `parameterDigest` does not bind this exact attempt is
 * refused `OWNER_AUTHORITY_NOT_DELEGABLE` too, by a clause four checks further on. Every case in
 * this file would then have passed on one generic code while claiming per-field coverage — which
 * is the shape the control exists to refuse.
 */
const VALID_ENVELOPE = {
  type: "OWNER_APPROVAL",
  runId: null,
  candidateSnapshotDigest: null,
  operation: SELF_CLAIM_OPERATION,
  parameterDigest: canonicalSelfClaimParameterDigest(REQUEST),
  idempotencyKey: "claim-canonical-cto:fixture",
  approved: true,
} as const;

let seq = 0;

const depsWith = (core: ReturnType<typeof makeCore>): CanonicalSelfClaimOperatorDeps => ({
  db: core.db,
  clock: core.clock,
  sessions: core.sessions,
  bindings: core.bindings,
  // Constructed here rather than taken from the harness: `makeCore` does not build one, and
  // these cases refuse before it is consulted. The `cli:isaac` identity matches the `actor`
  // column the fixture rows carry, so the control case fails for a claim-clause reason rather
  // than for an allowlist one.
  ownerAuthority: new OwnerAuthority(core.db, [{ channel: "cli", actor: "isaac" }], core.clock),
  buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
    buzz: { allowedActors: ["fixture-actor"] },
  }),
  resolveBuzzAddress: async (): Promise<Decision<string>> => allow(ReasonCode.OK, "buzz://fixture"),
  config: {
    expectedCwd: "/tmp/fixture-cwd",
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

/** Stores one `cli` row holding exactly this payload, and returns the nonce that names it. */
const storeEnvelope = (core: ReturnType<typeof makeCore>, payload: unknown): string => {
  const nonce = `fixture-nonce-${(seq += 1)}`;
  core.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json)
     VALUES ('cli', ?, 'isaac', ?, ?)`,
    [nonce, "2026-09-13T00:00:00.000Z", payload === undefined ? null : JSON.stringify(payload)],
  );
  return nonce;
};

const claimWith = async (
  core: ReturnType<typeof makeCore>,
  ownerApprovalNonce: unknown,
  overrides: Record<string, unknown> = {},
): Promise<Decision<unknown>> =>
  executeCanonicalSelfClaimOperator(PEER, { ...REQUEST, ownerApprovalNonce, ...overrides }, depsWith(core));

describe("a stored owner approval envelope is checked field by field (#833)", () => {
  describe("what storage must hold", () => {
    // One case per operand of `isStoredOwnerApprovalPayload`. Each breaks exactly one field and
    // leaves the rest valid, so a case that passes says something about its own field rather than
    // about the first check that happens to run.
    const broken: ReadonlyArray<readonly [string, unknown]> = [
      ["a payload that is not an object at all", "OWNER_APPROVAL"],
      ["a payload that is null", null],
      ["a payload that is an array", [VALID_ENVELOPE]],
      ["a type that is not OWNER_APPROVAL", { ...VALID_ENVELOPE, type: "OWNER_REJECTION" }],
      ["a runId that is neither null nor a string", { ...VALID_ENVELOPE, runId: 7 }],
      ["a candidateSnapshotDigest that is neither null nor a string", { ...VALID_ENVELOPE, candidateSnapshotDigest: 7 }],
      ["an operation that is not a string", { ...VALID_ENVELOPE, operation: 7 }],
      ["a parameterDigest that is not a string", { ...VALID_ENVELOPE, parameterDigest: null }],
      ["an idempotencyKey that is not a string", { ...VALID_ENVELOPE, idempotencyKey: 7 }],
      ["an approved that is not a boolean", { ...VALID_ENVELOPE, approved: "true" }],
    ];

    it.each(broken)("refuses %s", async (_label, payload) => {
      const core = makeCore();
      const nonce = storeEnvelope(core, payload);

      const refused = await claimWith(core, nonce);

      expect(refused.allowed).toBe(false);
      if (refused.allowed) return;
      // One code for every shape. The envelope either is an owner's decision or it is not, and a
      // per-field code would tell a caller which field to forge next.
      expect(refused.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      // The message is what says *this* gate answered. Four later clauses share the code, so the
      // code alone cannot distinguish "the envelope is not one" from "the envelope is one and
      // something else about the attempt is wrong" — and a file asserting only the code would
      // report per-field coverage it does not have. The control at the end is the other half.
      expect(refused.message).toContain("no admitted owner approval exists");
    });

    it("refuses a row whose payload_json is NULL", async () => {
      const core = makeCore();
      const nonce = storeEnvelope(core, undefined);

      const refused = await claimWith(core, nonce);

      expect(refused.allowed).toBe(false);
    });

    it("refuses a nonce no row names", async () => {
      const core = makeCore();

      const refused = await claimWith(core, "never-stored");

      expect(refused.allowed).toBe(false);
    });

    it("refuses a payload that is stored but not JSON", async () => {
      const core = makeCore();
      const nonce = `fixture-nonce-${(seq += 1)}`;
      core.db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json)
         VALUES ('cli', ?, 'isaac', ?, ?)`,
        [nonce, "2026-09-13T00:00:00.000Z", "{not json"],
      );

      const refused = await claimWith(core, nonce);

      expect(refused.allowed).toBe(false);
    });
  });

  describe("what the claimant may say", () => {
    // `isNonEmptyString` and the four field checks in `parseCanonicalSelfClaimOperatorRequest`.
    // These refuse with INVALID_ARGUMENT rather than OWNER_AUTHORITY_NOT_DELEGABLE, and the
    // difference matters: one says the request was malformed, the other says the authority was
    // not there. A single code would make a typo indistinguishable from a forged handle.
    const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["an empty claimedSessionUuid", { claimedSessionUuid: "" }],
      ["a non-string claimedSessionUuid", { claimedSessionUuid: 7 }],
      ["an empty projectId", { projectId: "" }],
      ["a non-string projectId", { projectId: 7 }],
      ["a fractional expectedBindingGeneration", { expectedBindingGeneration: 1.5 }],
      ["a non-numeric expectedBindingGeneration", { expectedBindingGeneration: "1" }],
      ["an empty ownerApprovalNonce", { ownerApprovalNonce: "" }],
      ["a non-string ownerApprovalNonce", { ownerApprovalNonce: 7 }],
    ];

    it.each(malformed)("refuses %s", async (_label, overrides) => {
      const core = makeCore();
      const nonce = storeEnvelope(core, VALID_ENVELOPE);

      const refused = await claimWith(core, nonce, overrides);

      expect(refused.allowed).toBe(false);
      if (refused.allowed) return;
      expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    });
  });

  it("lets a well-formed envelope past this validator — the control", async () => {
    // Without this, every case above would pass against a handler that denied on its first line,
    // and the file would report coverage of a validator it never reached. A valid envelope is
    // refused *later*, by the claim's own clauses, and the reason code is what proves which
    // gate answered: not OWNER_AUTHORITY_NOT_DELEGABLE and not INVALID_ARGUMENT.
    const core = makeCore();
    const nonce = storeEnvelope(core, VALID_ENVELOPE);

    const refused = await claimWith(core, nonce);

    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    // A raw-inserted row can never be an *admitted* approval: admission also writes the
    // `INGRESS_ADMITTED` audit event `OwnerAuthority.assertApproval` joins against. So the
    // well-formed envelope is refused too — but by a gate four checks further on, and its message
    // says so. That difference is the control: it proves the envelope validator passed this
    // payload along rather than stopping it, which is what makes every case above a statement
    // about its own field.
    expect(refused.message).toContain("not minted by admitted ingress");
    expect(refused.message).not.toContain("no admitted owner approval exists");
  });
});
