/**
 * PRD §21, §27.2 — who counts as the owner.
 *
 * Owner authority is the one authority the control plane cannot derive from its own
 * state: a human gate exists precisely because no agent may satisfy it. So the identities
 * that may act as owner are configured out of band, per channel, and every owner-only
 * decision is checked against this list. An empty list fails closed — an unconfigured
 * deployment has no owner, rather than an implicit one.
 */
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";

export interface OwnerIdentity {
  /** Channel the owner acts through: "telegram", "buzz", "mcp", "cli". */
  channel: string;
  /** Channel-scoped actor id: telegram user id, buzz pubkey, OS user for the CLI. */
  actor: string;
}

export interface OwnerAuthorityPort {
  isAllowedActor(channel: string, actor: string): boolean;
  assertApproval(receipt: OwnerApprovalReceipt): Decision<void>;
}

/**
 * An owner decision is evidence from an admitted ingress envelope, not a tuple that a
 * caller can type into an RPC request. `parameterDigest` names the canonical operation
 * parameters that the ingress router verified before minting this receipt.
 */
export interface OwnerApprovalReceipt {
  channel: string;
  actor: string;
  inboundNonce: string;
  runId: string | null;
  operation: string;
  parameterDigest: string;
  idempotencyKey: string;
  approved: boolean;
}

export class OwnerAuthority implements OwnerAuthorityPort {
  readonly #identities: readonly OwnerIdentity[];

  constructor(
    private readonly db: Db,
    identities: readonly OwnerIdentity[] = [],
  ) {
    this.#identities = [...identities];
  }

  isAllowedActor(channel: string, actor: string): boolean {
    return this.#identities.some((i) => i.channel === channel && i.actor === actor);
  }

  /**
   * CP-HI-07 — receiving an allowlisted name is not authority. The exact receipt must
   * trace to the immutable admission record written by IngressGuard for this operation.
   */
  assertApproval(receipt: OwnerApprovalReceipt): Decision<void> {
    if (!receipt) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval requires an admitted ingress receipt",
        { channel: null, actor: null },
      );
    }
    // A receipt naming someone this deployment never allowlisted is a different failure
    // from a caller that cannot hold owner authority at all: the actor is simply not an
    // owner here, which is the ingress allowlist's answer.
    if (!this.isAllowedActor(receipt.channel, receipt.actor)) {
      return deny(
        ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
        "the owner approval receipt names a channel identity that is not an allowlisted owner",
        { channel: receipt.channel, actor: receipt.actor },
      );
    }
    if (
      !receipt.inboundNonce ||
      !receipt.operation ||
      !receipt.parameterDigest ||
      !receipt.idempotencyKey
    ) {
      return deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "owner approval receipt is incomplete", {
        channel: receipt.channel,
        actor: receipt.actor,
      });
    }

    const inbound = this.db.get<{ actor: string }>(
      `SELECT actor FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [receipt.channel, receipt.inboundNonce],
    );
    if (!inbound || inbound.actor !== receipt.actor) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval receipt has no matching admitted ingress message",
        { channel: receipt.channel, actor: receipt.actor, inboundNonce: receipt.inboundNonce },
      );
    }

    const expected = admittedEnvelopeDigest(receipt);
    const admitted = this.db
      .all<{ evidence_json: string }>(
        `SELECT evidence_json FROM audit_events
          WHERE kind = 'INGRESS_ADMITTED' AND actor = ?
          ORDER BY event_id DESC`,
        [receipt.actor],
      )
      .some((row) => {
        try {
          const evidence = JSON.parse(row.evidence_json) as {
            channel?: unknown;
            nonce?: unknown;
            payloadDigest?: unknown;
          };
          return (
            evidence.channel === receipt.channel &&
            evidence.nonce === receipt.inboundNonce &&
            evidence.payloadDigest === expected
          );
        } catch {
          return false;
        }
      });
    if (!admitted) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval receipt was not minted by admitted ingress",
        { channel: receipt.channel, actor: receipt.actor, inboundNonce: receipt.inboundNonce },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** Doctor input: a deployment with no owner identity cannot satisfy a human gate. */
  configured(): number {
    return this.#identities.length;
  }
}

/**
 * The digest IngressGuard recorded for the envelope it verified, recomputed from the
 * receipt. It has to be derived here rather than by calling `ownerApprovalPayload`: a
 * receipt carries the parameter *digest*, not the parameters, so the shape below must stay
 * identical to that function's output. Checking the admitted envelope — rather than the
 * receipt digest the guard also audits — is what makes the proof durable: the admission
 * record holds only fields the audit evidence allowlist accepts, so it survives storage.
 */
const admittedEnvelopeDigest = (receipt: OwnerApprovalReceipt): string =>
  digestOf({
    type: "OWNER_APPROVAL",
    runId: receipt.runId,
    operation: receipt.operation,
    parameterDigest: receipt.parameterDigest,
    idempotencyKey: receipt.idempotencyKey,
    approved: receipt.approved,
  });
