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
import type { Clock } from "../core/clock.ts";
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
  /** Retained consumption is used by destructive repair recovery, not run finalization. */
  assertConsumedApproval(receipt: OwnerApprovalReceipt, candidateSnapshotDigest: string | null): Decision<void>;
  consumeApproval(receipt: OwnerApprovalReceipt, candidateSnapshotDigest: string | null): Decision<void>;
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
  /** Candidate current when the authenticated owner ingress receipt was minted. */
  candidateSnapshotDigest: string | null;
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
    private readonly clock: Clock | null = null,
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

    const inbound = this.db.get<{ actor: string; payload_json: string | null }>(
      `SELECT actor, payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
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
    // #246 C3, review 1076-R1-02 — the issuance evidence is the payload the ingress message was
    // admitted with: that row cannot be inserted by a connection ACP did not open, and its payload is
    // write-once. The INGRESS_ADMITTED audit row checked below is an ordinary row such a connection can
    // insert, so on its own it would let a forged envelope ride on any recent message of the owner's.
    let admittedPayload: string | null = null;
    try {
      admittedPayload = inbound.payload_json === null ? null : digestOf(JSON.parse(inbound.payload_json));
    } catch {
      admittedPayload = null;
    }
    if (admittedPayload !== expected) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval receipt is not the payload its ingress message was admitted with",
        { channel: receipt.channel, actor: receipt.actor, inboundNonce: receipt.inboundNonce },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** Record an admitted decision once; repeating it does not require new consent. */
  consumeApproval(receipt: OwnerApprovalReceipt, candidateSnapshotDigest: string | null): Decision<void> {
    const admitted = this.assertApproval(receipt);
    if (!admitted.allowed) return admitted;
    if (this.consumedReceipt(digestOf(receipt)) !== null) return allow(ReasonCode.OK, undefined);
    this.db.run(
      `INSERT INTO audit_events (at, kind, reason_code, run_id, actor, evidence_json)
       VALUES (?, 'OWNER_APPROVAL_CONSUMED', NULL, ?, ?, ?)`,
      [this.clock?.nowIso() ?? new Date().toISOString(), receipt.runId,
        `${receipt.channel}:${receipt.actor}`, JSON.stringify({ receiptDigest: digestOf(receipt), candidateSnapshotDigest, channel: receipt.channel,
          actor: receipt.actor, operation: receipt.operation, approved: receipt.approved, runId: receipt.runId,
          consumedAt: this.clock?.nowIso() ?? new Date().toISOString() })],
    );
    return allow(ReasonCode.OK, undefined);
  }

  /** A retained approval is a fact already authenticated when it was recorded. */
  assertConsumedApproval(
    receipt: OwnerApprovalReceipt,
    _candidateSnapshotDigest: string | null,
  ): Decision<void> {
    return this.consumedReceipt(digestOf(receipt)) !== null
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "owner approval has not been recorded");
  }

  /** Doctor input: a deployment with no owner identity cannot satisfy a human gate. */
  configured(): number {
    return this.#identities.length;
  }

  private consumedReceipt(receiptDigest: string): { candidateSnapshotDigest: string | null } | null {
    const rows = this.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events
        WHERE kind = 'OWNER_APPROVAL_CONSUMED'
        ORDER BY event_id DESC`,
    );
    for (const row of rows) {
      try {
        const evidence = JSON.parse(row.evidence_json) as {
          receiptDigest?: unknown;
          candidateSnapshotDigest?: unknown;
        };
        if (
          evidence.receiptDigest === receiptDigest &&
          (typeof evidence.candidateSnapshotDigest === "string" || evidence.candidateSnapshotDigest === null)
        ) {
          return { candidateSnapshotDigest: evidence.candidateSnapshotDigest };
        }
      } catch {
        // A malformed historical event cannot prove consumption of this receipt.
      }
    }
    return null;
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
    candidateSnapshotDigest: receipt.candidateSnapshotDigest,
    operation: receipt.operation,
    parameterDigest: receipt.parameterDigest,
    idempotencyKey: receipt.idempotencyKey,
    approved: receipt.approved,
  });
