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
  /** Re-admit a retained decision only when its durable consumption names this candidate. */
  assertConsumedApproval(receipt: OwnerApprovalReceipt, candidateSnapshotDigest: string): Decision<void>;
  /**
   * Atomically consume an admitted receipt for the candidate (or null for a non-candidate
   * owner operation). Retained artifacts use assertApproval; only an authorising write calls
   * this one-way transition.
   */
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

    // This check is deliberately before consumption: a first presentation after candidate
    // promotion must be stale, rather than becoming the first consumption of new work.
    if (receipt.runId !== null) {
      const currentCandidate = this.db.get<{ current_candidate_digest: string | null }>(
        `SELECT current_candidate_digest FROM runs WHERE run_id = ?`,
        [receipt.runId],
      )?.current_candidate_digest ?? null;
      if (receipt.candidateSnapshotDigest !== currentCandidate) {
        return deny(
          ReasonCode.EVIDENCE_STALE,
          "owner approval receipt is stale because the run's candidate moved after it was minted",
          {
            runId: receipt.runId,
            approvedCandidateSnapshotDigest: receipt.candidateSnapshotDigest,
            currentCandidateSnapshotDigest: currentCandidate,
          },
        );
      }
    } else if (receipt.candidateSnapshotDigest !== null) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "an owner receipt without a run cannot bind a candidate",
        { candidateSnapshotDigest: receipt.candidateSnapshotDigest },
      );
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

  /**
   * Consume the receipt exactly once and bind that consumption to the candidate it authorised.
   * The append-only audit ledger is durable and survives a restarted OwnerAuthority; the
   * enclosing caller transaction makes the consumption and the decision one atomic commit.
   */
  consumeApproval(
    receipt: OwnerApprovalReceipt,
    candidateSnapshotDigest: string | null,
  ): Decision<void> {
    return this.db.tx(() => {
      const admitted = this.assertApproval(receipt);
      if (!admitted.allowed) return admitted;

      const receiptDigest = digestOf(receipt);
      const prior = this.consumedReceipt(receiptDigest);
      if (prior) {
        if (prior.candidateSnapshotDigest !== candidateSnapshotDigest) {
          return deny(
            ReasonCode.EVIDENCE_STALE,
            "owner approval receipt was consumed for a different candidate",
            {
              receiptDigest,
              approvedCandidateSnapshotDigest: prior.candidateSnapshotDigest,
              presentedCandidateSnapshotDigest: candidateSnapshotDigest,
            },
          );
        }
        return deny(
          ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
          "owner approval receipt has already been consumed",
          { receiptDigest, candidateSnapshotDigest },
        );
      }

      this.db.run(
        `INSERT INTO audit_events
           (at, kind, reason_code, run_id, actor, evidence_json)
         VALUES (?, 'OWNER_APPROVAL_CONSUMED', NULL, ?, ?, ?)`,
        [
          this.clock?.nowIso() ?? new Date().toISOString(),
          receipt.runId,
          `${receipt.channel}:${receipt.actor}`,
          // Self-describing on purpose. This row is the durable authority for "the owner
          // approved this candidate", read long after the ingress replay window has been
          // pruned, so it carries the decision rather than pointing at something that can
          // expire.
          JSON.stringify({
            receiptDigest,
            candidateSnapshotDigest,
            channel: receipt.channel,
            actor: receipt.actor,
            operation: receipt.operation,
            approved: receipt.approved,
            runId: receipt.runId,
            consumedAt: this.clock?.nowIso() ?? new Date().toISOString(),
          }),
        ],
      );
      return allow(ReasonCode.OK, undefined);
    });
  }

  /**
   * Whether this exact receipt was consumed for this candidate.
   *
   * It deliberately does **not** call `assertApproval`. That asks a different question —
   * "is there a currently admitted approval" — and answers it from `inbound_messages`, a
   * replay-protection cache with a 24h TTL that is pruned on the next successful admit. A
   * cache cannot be the authority for a durable fact: an owner decision that had been
   * correctly admitted *and consumed* stopped satisfying the gate as soon as any later
   * message arrived after the window, and because GitHub merge re-reads this gate, an
   * approved run silently became unapproved.
   *
   * Admission was already required at consumption time, and the consumption row records it.
   * The receipt digest covers channel, actor, nonce, operation, parameters and the decision,
   * so matching it proves the same authenticated receipt — not merely a similar one.
   */
  assertConsumedApproval(
    receipt: OwnerApprovalReceipt,
    candidateSnapshotDigest: string,
  ): Decision<void> {
    const prior = this.consumedReceipt(digestOf(receipt));
    if (!prior) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval has not been consumed by an authorising decision",
        { candidateSnapshotDigest },
      );
    }
    if (prior.candidateSnapshotDigest !== candidateSnapshotDigest) {
      return deny(
        ReasonCode.EVIDENCE_STALE,
        "retained owner decision belongs to a different candidate",
        {
          approvedCandidateSnapshotDigest: prior.candidateSnapshotDigest,
          currentCandidateSnapshotDigest: candidateSnapshotDigest,
        },
      );
    }
    return allow(ReasonCode.OK, undefined);
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
