import { randomUUID } from "node:crypto";

import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

import type { IngressGuard, IngressRequest, TurnClaim, TurnIdentity } from "./ingress-guard.ts";

/**
 * The only recipient this path will turn a Buzz event into a conversational turn for.
 *
 * The CEO room is not owner-exclusive — `run-ceo-bridge.sh` puts the orchestrator in it, and
 * SSOT §114 records that a CEO↔CTO exchange in that room is the journal of a conversation that
 * already happened, not a second CEO turn. Re-injecting one as a user turn is the loop this
 * whole issue exists to close, so the recipient is part of the signed envelope: the relay has
 * to say, under the shared secret, that this event was addressed to the CEO.
 */
export const BUZZ_MESSAGE_RECIPIENT_CEO = "CEO";

/**
 * Nonces for this path are prefixed so they cannot collide with the actor-binding path's.
 *
 * Both paths are the `buzz` channel and therefore share one `(channel, nonce)` dedup space in
 * `inbound_messages`. The binding path takes its nonce straight from the relay, so without a
 * namespace of its own a message could consume a binding's nonce (or the reverse) and the
 * second one would be refused as a replay of something it has nothing to do with.
 */
export const BUZZ_MESSAGE_NONCE_PREFIX = "buzz-message:";

/** One Buzz event the relay is asking the daemon to deliver as a turn. */
export interface BuzzMessageIngressInput {
  /** Buzz channel identity (the relay's authenticated pubkey), not a role. */
  actor: string;
  /** The Buzz room/thread the event arrived on, and the one its answer goes back to. */
  conversation: string;
  /** The relay's own event id; the durable replay key for this message. */
  eventId: string;
  /**
   * The recipient class the relay put on the event.
   *
   * It is the address only for the CEO room, where the recipient has no `p` tag of its own on
   * this path. When `mention` is present that tag is the address and this string is a label;
   * both are inside the signature either way, so neither can be rewritten in flight.
   */
  addressedTo: string;
  /**
   * The relay's own resolved `p` tag — the Buzz channel identity this event named (`#760` B4).
   *
   * The wire form of a Buzz mention is a `p` tag holding a pubkey, and the relay reports which
   * ones it actually resolved (`mention_pubkeys`). That resolved value is what arrives here: a
   * channel identity, never a role name. Turning it into a role is this daemon's job and happens
   * at delivery time, because the session holding a role is replaced as ordinary operation and
   * the sender must not have to learn a new address when it is (B0/B0b).
   */
  mention?: string | null;
  text: string;
  signature?: string | null;
}

/** The durable replay key for one Buzz event. */
export const buzzMessageNonce = (eventId: string): string =>
  `${BUZZ_MESSAGE_NONCE_PREFIX}${eventId}`;

/**
 * The envelope the relay signs.
 *
 * The text is inside it, so a captured signature cannot be replayed over different words. The
 * guard stores only `digestOf(payload)` in the audit trail, so the message body itself never
 * becomes durable ACP evidence — it belongs in the CEO's canonical transcript, which is the
 * point of the whole path.
 */
export const buzzMessagePayload = (
  input: Pick<BuzzMessageIngressInput, "conversation" | "addressedTo" | "mention" | "text">,
): Record<string, unknown> => ({
  type: "BUZZ_MESSAGE",
  conversation: input.conversation,
  addressedTo: input.addressedTo,
  // Inside the signature, and always present rather than only when set: an absent field and a
  // field carrying `null` would otherwise be the same bytes, and a captured CEO envelope could be
  // replayed with a `p` tag bolted on to redirect it at another role.
  mention: input.mention ?? null,
  text: input.text,
});

/** The exact signed request for one Buzz message; the relay computes its HMAC over this. */
export const buzzMessageSigningRequest = (
  input: Pick<
    BuzzMessageIngressInput,
    "actor" | "conversation" | "eventId" | "addressedTo" | "mention" | "text"
  >,
): IngressRequest => ({
  channel: "buzz",
  actor: input.actor,
  conversation: input.conversation,
  nonce: buzzMessageNonce(input.eventId),
  payload: buzzMessagePayload(input),
});

/**
 * Who one admitted envelope is for, once its address has been resolved.
 *
 * A role key rather than a session id, and that is the whole of B0: the session holding a role is
 * replaced routinely, and an address that named one would go stale the moment it did. The key is
 * resolved here and re-checked against the registry again at delivery, so a holder that moves
 * between the two moments loses the message rather than a former holder receiving it.
 */
export type BuzzMessageTarget =
  | { readonly kind: "CEO" }
  | { readonly kind: "ROLE"; readonly roleKey: string };

/** One `p` tag this path could not turn into an address, as the journal records it. */
export interface UnboundMentionRecord {
  actor: string;
  conversation: string;
  eventId: string;
  /** The `p` tag as presented. */
  mention: string;
  /** Every role the tag did resolve to — none, or more than one. */
  candidates: readonly string[];
}

/**
 * How a `p` tag becomes a role, and what happens when it does not.
 *
 * Supplied rather than reached for, because both halves belong to the daemon's registries and
 * this module must not acquire database authority to answer a routing question. The contract is
 * deliberately "every role, unfiltered": collapsing a multi-role answer to its first element is
 * the defect `MENTION_TARGET_UNBOUND` exists to refuse, and a resolver that returned one role
 * could not tell "the CTO of one project" from "the CTO of two".
 */
export interface BuzzMentionRouter {
  /** Every canonical role the mentioned identity holds right now. Order is not significant. */
  rolesFor(mention: string): readonly string[];
  /** Records one unresolvable tag. Called once per refused envelope, before any turn exists. */
  journalUnbound(record: UnboundMentionRecord): void;
}

/** An admitted Buzz message, in the shape the turn machinery needs it. */
export interface AdmittedBuzzMessage {
  text: string;
  actor: string;
  conversation: string;
  nonce: string;
  /** Fixed at admission and carried forward, so nothing downstream re-resolves the address. */
  target: BuzzMessageTarget;
}

/**
 * PRD §27.1 for the Buzz surface, message half.
 *
 * `BuzzActorIngress` is the other half and does something different: it binds a Buzz channel
 * identity to a local session, and is the only production writer of `sessions.buzz_actor_id`.
 * Nothing on that path takes an owner's *message* anywhere, which is what #627 measured — the
 * socket was open and served bindings only.
 *
 * Shaped after `TelegramIngress` deliberately: the channel string is fixed here, beside the
 * nonce, so no caller can pass the two inconsistently.
 */
export class BuzzMessageIngress {
  readonly #ownerActors: ReadonlySet<string>;

  /**
   * `ownerActors` is a second allowlist, and it is the point of this class.
   *
   * The guard's `buzz` policy says which channel identities the relay may present at all — the
   * same credential the actor-binding half uses, and one every ACTIVE Buzz channel identity in
   * the deployment is on. Speaking to the owner's CEO *as the owner* is a different authority,
   * and
   * an allowlist that admits the first cannot be the one that grants the second: an otherwise
   * valid ACTIVE non-owner could sign a CEO-addressed envelope and get a turn. So the owner
   * identities are supplied separately, from `owner-identities` (#245) rather than from the
   * relay credential, and an empty set is refused here rather than defaulting to the guard's.
   */
  constructor(
    private readonly guard: IngressGuard,
    ownerActors: readonly string[],
    private readonly router: BuzzMentionRouter,
  ) {
    const owners = ownerActors.map((actor) => actor.trim()).filter((actor) => actor.length > 0);
    if (owners.length === 0) {
      throw new Error("buzz message ingress requires at least one declared buzz owner identity");
    }
    this.#ownerActors = new Set(owners);
  }

  nonceFor(eventId: string): string {
    return buzzMessageNonce(eventId);
  }

  /**
   * Allowlist, address, HMAC and nonce dedup, in that order, before anything is asked of anyone.
   *
   * Signature is required rather than optional: an unsigned Buzz channel would let anything
   * that can reach this socket speak to the owner's CEO as the owner. `bindActor` makes the
   * same refusal for the same reason.
   */
  admit(input: BuzzMessageIngressInput): Decision<AdmittedBuzzMessage> {
    if (!this.guard.requiresSignature("buzz")) {
      return deny(
        ReasonCode.INGRESS_SIGNATURE_INVALID,
        "buzz message ingress requires a signed ingress policy",
      );
    }
    if (
      input.actor.trim().length === 0 ||
      input.conversation.trim().length === 0 ||
      input.eventId.trim().length === 0 ||
      input.text.length === 0
    ) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "buzz message ingress requires an actor, conversation, event id and text",
      );
    }
    if (!this.#ownerActors.has(input.actor.trim())) {
      // Before admission, and for a second reason beyond who may speak: a non-owner on the
      // relay allowlist can produce a *valid* signature, so letting the guard admit it first
      // would consume the `(buzz, nonce)` slot for that event id. The owner's own message for
      // the same event would then be refused as a replay of a turn that never ran.
      //
      // It is also ahead of address resolution on purpose. Resolving a `p` tag writes a journal
      // row when it fails, and a stranger must not be able to make this daemon write one — the
      // sender's authority and the recipient's address are two separate questions, and answering
      // the second first would let the second answer the first.
      return deny(
        ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
        "buzz message ingress delivers only messages from a declared buzz owner identity",
        { channel: "buzz", actor: input.actor },
      );
    }
    const target = this.#targetFor(input);
    if (!target.allowed) return target as Decision<AdmittedBuzzMessage>;

    const request = buzzMessageSigningRequest(input);
    const admitted = this.guard.admit({ ...request, signature: input.signature ?? null });
    if (!admitted.allowed) return admitted as Decision<AdmittedBuzzMessage>;

    return allow(ReasonCode.UNTRUSTED_CONTENT_IS_DATA, {
      text: input.text,
      actor: input.actor,
      conversation: input.conversation,
      nonce: request.nonce,
      target: target.value,
    });
  }

  /**
   * Who this envelope is for — resolved before admission, so an address nobody holds costs
   * nothing and consumes nothing.
   *
   * Everything the relay says about the recipient is inside the signature, so the question here
   * is never "is this envelope authentic" but "does this address name exactly one role this
   * daemon can reach". Anything else — no role, or several — is refused rather than narrowed: a
   * `find` over the candidates would answer with whichever role the registry happened to return
   * first, which is delivery by accident rather than by address.
   */
  #targetFor(input: BuzzMessageIngressInput): Decision<BuzzMessageTarget> {
    // Presence, not content. A relay that put a `p` tag on the envelope has stated the event was
    // addressed, and a blank tag is that statement failing rather than an absent one: reading it
    // as "no mention" would silently hand a message meant for some role to the CEO room.
    if (typeof input.mention === "string") {
      const mention = input.mention.trim();
      const candidates = mention.length === 0 ? [] : [...new Set(this.router.rolesFor(mention))];
      const roleKey = candidates.length === 1 ? candidates[0] : undefined;
      if (roleKey === undefined) {
        // The one journal row B4 asks for, written here because this is the only place that
        // knows both the tag and what it resolved to, and because after this point there is
        // nothing left to record: no nonce is consumed, no turn is claimed, nothing is sent.
        this.router.journalUnbound({
          actor: input.actor,
          conversation: input.conversation,
          eventId: input.eventId,
          mention,
          candidates,
        });
        return deny(
          ReasonCode.MENTION_TARGET_UNBOUND,
          "the mentioned buzz channel identity does not name exactly one role this daemon can address",
          { channel: "buzz", target: mention, candidates: candidates.length },
        );
      }
      return allow(ReasonCode.OK, { kind: "ROLE", roleKey });
    }
    if (input.addressedTo !== BUZZ_MESSAGE_RECIPIENT_CEO) {
      // Refused before admission, so a journal event does not even consume a nonce: it was
      // never a turn for this daemon to run. An event with no `p` tag has no other address —
      // the CEO room is the one recipient this path can reach without one.
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "buzz message ingress delivers only events addressed to the CEO or carrying a resolved mention",
        { addressedTo: input.addressedTo },
      );
    }
    return allow(ReasonCode.OK, { kind: "CEO" });
  }

  /**
   * What this message's turn is, fixed before the CEO is asked. See `TelegramIngress`.
   *
   * The id is a fresh UUID rather than derived from the event, so two attempts at the same
   * message cannot share one identity; the digests say what was attempted, and
   * `bindingDigest` is the fence against a receipt from a later CEO generation (#639).
   */
  turnIdentityFor(input: { conversation: string; text: string }, bindingGeneration: number | null): TurnIdentity {
    return {
      turnRequestId: randomUUID(),
      sessionDigest: digestOf({ channel: "buzz", conversation: input.conversation }),
      promptDigest: digestOf(input.text),
      bindingDigest: digestOf({ bindingGeneration }),
    };
  }

  /** Takes the right to run this message's handler, once. See `IngressGuard.claimTurn`. */
  claimTurn(nonce: string, identity: TurnIdentity): Decision<TurnClaim> {
    return this.guard.claimTurn("buzz", nonce, identity);
  }

  /** Records that ACP handed this message's turn a reply for the originating Buzz thread. */
  resolveTurn(nonce: string): Decision<void> {
    return this.guard.resolveTurn("buzz", nonce);
  }
}

/**
 * What a delivery route reports back about one turn it tried to hand over.
 *
 * Named for the CEO because that was the only route when `#750` wrote it; the role route answers
 * in the same three values, and the field name below is load-bearing in two falsifiability rows
 * that mutate the line reading it, so it stays as it is rather than being widened by rename.
 */
export interface CeoTurnDelivery {
  /** The text to hand the relay for the originating Buzz thread. */
  answer: string;
  /** The port's own contact boundary: whether the request crossed to the addressed peer (#652). */
  reachedCeo: boolean;
  /** `OK` for an answer, or the route's refusal code for a sentence. */
  reasonCode: ReasonCode;
}

/** The daemon-side capabilities this delivery needs, as functions rather than the ControlPlane. */
export interface BuzzMessageTurnPort {
  /** Delivers one turn to whoever currently holds the CEO binding. */
  deliverToCeo(text: string): Promise<CeoTurnDelivery>;
  /**
   * Delivers one turn to whoever currently holds `roleKey`, through B2's live peer.
   *
   * The same contract as `deliverToCeo`, including its contact boundary: the peer is asked, or
   * it is positively established that nothing was asked. Who the holder is gets re-read from the
   * registry inside the port, not taken from the address this ingress resolved a moment ago.
   */
  deliverToRole(roleKey: string, text: string): Promise<CeoTurnDelivery>;
  /** The CEO binding generation this turn is being claimed under, or null if there is none. */
  bindingGeneration(): number | null;
  /**
   * The same fence for a role-addressed turn: the generation `roleKey` is held at right now.
   *
   * Separate from `bindingGeneration` rather than a parameter on it, because the CEO's generation
   * is the wrong fence for a message addressed to the CTO — a receipt from a superseded CTO would
   * pass a claim stamped with whichever generation the CEO happened to be at.
   */
  roleBindingGeneration(roleKey: string): number | null;
}

/** What the relay gets back when a message became a turn. */
export interface BuzzMessageAnswer {
  answer: string;
  /**
   * True only when the CEO peer itself produced the text.
   *
   * Deliberately narrow: it stays false for a role-addressed message even when that role's peer
   * answered, because a caller reading it is asking about the CEO. `reasonCode === OK` is the
   * general "the addressed peer answered" fact and holds for both.
   */
  answeredByCeo: boolean;
  turnRequestId: string;
  conversation: string;
}

/**
 * An owner's Buzz message, delivered as one turn to whoever currently holds the addressed role.
 *
 * This is the receiving half #627 asks for, and the whole of its correctness is what it does
 * *not* do: nothing here starts a session, resumes one, or synthesises a reply. Both ports reach
 * a peer that is already connected and re-authenticated on every request — the mechanism
 * `ARCHITECTURE.md` accepts (peer UDS + transcript observer) rather than the three it rejects.
 *
 * The address was already resolved, once, inside `admit`. Nothing below re-derives it: an
 * envelope whose `p` tag named no role never reaches this point, so there is no state in which a
 * turn exists for a message that has nowhere to go.
 *
 * The turn is claimed before it runs, for the reason `IngressGuard.claimTurn` gives: the CEO's
 * reply command resumes the owner's own conversation, so running one message twice appends the
 * same exchange twice to a transcript the CEO then carries forward as context.
 */
export const deliverBuzzMessage = async (
  ingress: BuzzMessageIngress,
  port: BuzzMessageTurnPort,
  input: BuzzMessageIngressInput,
): Promise<Decision<BuzzMessageAnswer>> => {
  const admitted = ingress.admit(input);
  if (!admitted.allowed) return admitted as Decision<BuzzMessageAnswer>;

  const target = admitted.value.target;
  const identity = ingress.turnIdentityFor(
    { conversation: admitted.value.conversation, text: admitted.value.text },
    target.kind === "CEO" ? port.bindingGeneration() : port.roleBindingGeneration(target.roleKey),
  );
  const claimed = ingress.claimTurn(admitted.value.nonce, identity);
  if (!claimed.allowed) return claimed as Decision<BuzzMessageAnswer>;

  const delivered =
    target.kind === "CEO"
      ? await port.deliverToCeo(admitted.value.text)
      : await port.deliverToRole(target.roleKey, admitted.value.text);

  // Which outcomes close the claim, and which leave it outstanding.
  //
  //   answered              the CEO replied and the relay is being handed that reply.
  //   never reached         positively established that nothing was asked: the port refused
  //                         before `createMessage`, so no turn is running anywhere and the
  //                         owner is getting the refusal sentence instead.
  //   reached, no answer    a timeout, a dropped connection, an error from the peer. The CEO
  //                         may still be writing into the canonical transcript, and saying
  //                         otherwise is the unearned claim #633/#651 removed elsewhere.
  //
  // The last case leaves `turn_claim_json` unresolved on purpose. That is the honest record of
  // an outcome nobody established, and it is what `IngressGuard.unresolvedTurns` reads.
  const answered = delivered.reasonCode === ReasonCode.OK;
  const closes = delivered.reachedCeo ? answered : !answered;
  const resolution = closes ? ingress.resolveTurn(admitted.value.nonce) : null;

  return allow(
    delivered.reasonCode,
    {
      answer: delivered.answer,
      answeredByCeo: target.kind === "CEO" && delivered.reachedCeo && answered,
      turnRequestId: identity.turnRequestId,
      conversation: admitted.value.conversation,
    },
    {
      // A bookkeeping write that raced must not cost the owner the CEO's reply, so the answer
      // is returned either way and the refusal travels as evidence instead of as an error.
      turnResolution: resolution === null ? "OUTCOME_UNKNOWN" : resolution.reasonCode,
    },
  );
};
