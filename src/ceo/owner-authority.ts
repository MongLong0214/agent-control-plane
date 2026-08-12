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
    if (!receipt || !this.isAllowedActor(receipt.channel, receipt.actor)) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval requires an admitted receipt from a configured owner identity",
        { channel: receipt?.channel ?? null, actor: receipt?.actor ?? null },
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

    const expected = digestOf({
      channel: receipt.channel,
      actor: receipt.actor,
      inboundNonce: receipt.inboundNonce,
      runId: receipt.runId,
      operation: receipt.operation,
      parameterDigest: receipt.parameterDigest,
      idempotencyKey: receipt.idempotencyKey,
      approved: receipt.approved,
    });
    const admitted = this.db
      .all<{ evidence_json: string }>(
        `SELECT evidence_json FROM audit_events
          WHERE kind = 'OWNER_APPROVAL_INGRESS' AND actor = ?
          ORDER BY event_id DESC`,
        [`${receipt.channel}:${receipt.actor}`],
      )
      .some((row) => {
        try {
          const evidence = JSON.parse(row.evidence_json) as { receiptDigest?: unknown };
          return evidence.receiptDigest === expected;
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
