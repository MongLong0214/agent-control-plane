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
   * Which recipient class the relay addressed the event to, and the only thing that decides
   * whether this envelope is for the CEO room or for a role.
   *
   * The CEO room is the one recipient reachable without a `p` tag, so `"CEO"` here means the CEO
   * and `mention` is not consulted. Anything else means the event was addressed to a role, and
   * then the `p` tag is the address — a role-addressed envelope that carries no usable tag names
   * nobody and is refused rather than falling back to the CEO.
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
   *
   * Typed `unknown`, and that is the point rather than laziness. This value is inside the
   * signature, so it has to reach `buzzMessagePayload` exactly as the relay sent it — a parser
   * that refused a number or an object here would be deciding something about the *address*
   * before anything had authenticated the *sender*, which is the ordering B4's review rejected.
   * A tag of the wrong shape is therefore admitted as data and refused as an address.
   */
  mention?: unknown;
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
  // Inside the signature, always present rather than only when set, and carrying whatever the
  // relay sent rather than a normalized copy. This line is the whole of what stops a captured
  // CEO envelope from being replayed with a `p` tag bolted on to redirect it at another role:
  // remove it and that tampered envelope verifies.
  mention: input.mention ?? null,
  text: input.text,
});

/**
 * The whole of what an `OWNER_MESSAGE` outbox row carries: a pointer, and nothing that is the
 * message.
 *
 * `inbound_messages.payload_json` is the only durable copy of an owner's envelope. Writing the
 * text into the outbox payload as well would make two copies that can disagree — and the one a
 * holder reads at claim time would be the copy nothing authenticated, since only the ingress row
 * is the thing the relay's signature was checked against.
 *
 * `sourcePayloadDigest` binds the **full signed payload**, not only the text. A digest over the
 * text alone would still verify after `addressedTo` or `mention` had been rewritten, which is
 * exactly the substitution `buzzMessagePayload` puts inside the signature to refuse.
 */
export interface OwnerMessagePointer {
  readonly sourceChannel: "buzz";
  readonly sourceNonce: string;
  readonly sourcePayloadDigest: string;
}

/** The pointer for one admitted envelope. Derived, never supplied by a caller. */
export const ownerMessagePointer = (
  input: Pick<BuzzMessageIngressInput, "conversation" | "addressedTo" | "mention" | "text">,
  nonce: string,
): OwnerMessagePointer => ({
  sourceChannel: "buzz",
  sourceNonce: nonce,
  sourcePayloadDigest: digestOf(buzzMessagePayload(input)),
});

/**
 * Reads a stored outbox payload back as a pointer, or answers `null`.
 *
 * Structural, and deliberately strict about the extra key: a payload carrying anything beyond
 * these three is not a pointer this path wrote, and treating it as one would let a second copy of
 * the message ride along in a field nobody checks.
 */
export const ownerMessagePointerOf = (payload: unknown): OwnerMessagePointer | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { sourceChannel, sourceNonce, sourcePayloadDigest } = payload as Record<string, unknown>;
  if (sourceChannel !== "buzz") return null;
  if (typeof sourceNonce !== "string" || sourceNonce.length === 0) return null;
  if (typeof sourcePayloadDigest !== "string" || sourcePayloadDigest.length === 0) return null;
  if (Object.keys(payload as Record<string, unknown>).length !== 3) return null;
  return { sourceChannel, sourceNonce, sourcePayloadDigest };
};

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

/** How a role-addressed envelope failed to name exactly one reachable role. */
export type UnboundMentionShape =
  /** No `p` tag at all: the field was absent or null on a role-addressed envelope. */
  | "missing"
  /** A `p` tag of a shape that cannot be a channel identity — a number, an object, an array. */
  | "not-a-string"
  /** A `p` tag that is a string and empty once trimmed. */
  | "blank"
  /** A well-formed tag bound to no live session, or to one holding no role. */
  | "unknown"
  /** A well-formed tag bound to a session that currently holds more than one role. */
  | "ambiguous";

/** One `p` tag this path could not turn into an address, as the journal records it. */
export interface UnboundMentionRecord {
  actor: string;
  conversation: string;
  eventId: string;
  /** The `p` tag as presented, trimmed; empty when there was none or it was not a string. */
  mention: string;
  /** Every role the tag did resolve to — none, or more than one. */
  candidates: readonly string[];
  /**
   * Which of the five ways it failed.
   *
   * All five are one refusal to the sender, and they are five different things for whoever reads
   * the journal: "the relay stopped attaching tags" and "the CTO of two projects has no single
   * address" need different work, and a single count of unbound events tells them apart from
   * neither.
   */
  shape: UnboundMentionShape;
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
   * Owner allowlist, HMAC, nonce dedup, then address — in that order, before anything is asked
   * of anyone. The address is last on purpose; see the comment at the `guard.admit` call.
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
    // Authentication and replay first, addressing second — the order B4's review demanded, and
    // the reason is that every step below writes something an unauthenticated caller must not be
    // able to cause. `guard.admit` is the only authority for the HMAC, the relay allowlist and
    // the `(channel, nonce)` replay slot; nothing here re-implements any of the three. Running
    // the target lookup ahead of it meant a forged signature could still journal a target, and a
    // duplicate event id with a rewritten `p` tag could journal a second one for a turn that had
    // already been answered.
    const request = buzzMessageSigningRequest(input);
    const admitted = this.guard.admit({ ...request, signature: input.signature ?? null });
    if (!admitted.allowed) return admitted as Decision<AdmittedBuzzMessage>;

    // Past this line the sender is authenticated and this event id is being seen for the first
    // time, so the address may be looked up and one journal row may be written. The nonce is
    // spent either way: the event was admitted, and a later copy of it is a replay whatever its
    // tag says — which is what stops a repeated unbound event from journalling repeatedly.
    const target = this.#targetFor(input);
    if (!target.allowed) return target as Decision<AdmittedBuzzMessage>;

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
    if (input.addressedTo !== BUZZ_MESSAGE_RECIPIENT_CEO) {
      // Role-addressed, so the `p` tag is the address and there is no second place to look. The
      // five ways it can fail to be one are one outcome to the sender and one journal row each:
      // an absent tag is not "therefore the CEO", because reading it that way would hand a
      // message meant for some role to the owner's own conversation.
      const presented = input.mention;
      const mention = typeof presented === "string" ? presented.trim() : "";
      const candidates = mention.length === 0 ? [] : [...new Set(this.router.rolesFor(mention))];
      const roleKey = candidates.length === 1 ? candidates[0] : undefined;
      if (roleKey === undefined) {
        const shape: UnboundMentionShape =
          presented === undefined || presented === null
            ? "missing"
            : typeof presented !== "string"
              ? "not-a-string"
              : mention.length === 0
                ? "blank"
                : candidates.length === 0
                  ? "unknown"
                  : "ambiguous";
        // The one journal row B4 asks for, written here because this is the only place that
        // knows both the tag and what it resolved to, and after this point there is nothing left
        // to record: no turn is claimed and nothing is sent to anyone.
        this.router.journalUnbound({
          actor: input.actor,
          conversation: input.conversation,
          eventId: input.eventId,
          mention,
          candidates,
          shape,
        });
        return deny(
          ReasonCode.MENTION_TARGET_UNBOUND,
          "the mentioned buzz channel identity does not name exactly one role this daemon can address",
          { channel: "buzz", target: mention, candidates: candidates.length, shape },
        );
      }
      return allow(ReasonCode.OK, { kind: "ROLE", roleKey });
    }
    return allow(ReasonCode.OK, { kind: "CEO" });
  }

  /**
   * What this message's turn is, fixed before anyone is asked. See `TelegramIngress`.
   *
   * `turnRequestId` is a parameter rather than a fresh UUID minted here, and that is the whole of
   * §2's "the outbox messageId *is* the turn request identity". A role-addressed message's turn is
   * held open by exactly one durable outbox row, and an id minted independently of that row would
   * read identically on a passing run while leaving the ingress claim unable to name what is
   * holding it open — so the claim could not be settled from the row, and pruning could not be
   * told which row was still pending. The CEO path has no such row and mints a fresh id.
   *
   * The digests say what was attempted, and `bindingDigest` is the fence against a receipt from a
   * later generation (#639) — the *addressed role's* generation, never a bystander's.
   */
  turnIdentityFor(
    input: { conversation: string; text: string },
    bindingGeneration: number | null,
    turnRequestId: string,
  ): TurnIdentity {
    return {
      turnRequestId,
      sessionDigest: digestOf({ channel: "buzz", conversation: input.conversation }),
      promptDigest: digestOf(input.text),
      bindingDigest: digestOf({ bindingGeneration }),
    };
  }

  /** A fresh turn identity for a turn no durable row names — the CEO's. */
  freshTurnRequestId(): string {
    return randomUUID();
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

/** The exact runtime a role-addressed envelope is admitted against, as the registry holds it. */
export interface ActiveRoleTarget {
  bindingGeneration: number;
  targetSessionId: string;
}

/** The daemon-side capabilities this path needs, as functions rather than the ControlPlane. */
export interface BuzzMessageTurnPort {
  /** Delivers one turn to whoever currently holds the CEO binding. */
  deliverToCeo(text: string): Promise<CeoTurnDelivery>;
  /** The CEO binding generation this turn is being claimed under, or null if there is none. */
  bindingGeneration(): number | null;
  /**
   * Runs `body` as **one outer write transaction**, joining nothing and opening nothing else.
   *
   * §2's atomicity lives here rather than in three well-placed calls: the inbound row, the outbox
   * row and the turn claim are three writes in three modules, and any ordering of three separate
   * commits has two windows a crash can land in. A `Decision` returned from `body` commits — that
   * is how a refused *address* keeps its spent nonce and its journal row — and a throw rolls
   * everything back, which is how a refused *enqueue* leaves nothing half-admitted behind.
   */
  atomically<T>(body: () => T): T;
  /**
   * The exact active target of `roleKey` right now, from the binding registry alone.
   *
   * Also the fence the turn claim is stamped with: the CEO's generation is the wrong fence for a
   * message addressed to the CTO, because a receipt from a superseded CTO would then pass a claim
   * stamped with whichever generation the CEO happened to be at.
   */
  activeRoleTarget(roleKey: string): ActiveRoleTarget | null;
  /**
   * The one non-retargetable outbox row this admission produces, carrying only the pointer.
   *
   * Called inside `atomically`, so a denial here is a denial of the whole admission rather than a
   * message admitted with nowhere to go.
   */
  enqueueOwnerMessage(input: {
    roleKey: string;
    bindingGeneration: number;
    targetSessionId: string;
    nonce: string;
    pointer: OwnerMessagePointer;
  }): Decision<{ messageId: string }>;
  /**
   * One constant wake to the role's live peer — **after commit, and only after commit**.
   *
   * A wake sent from inside the transaction would tell a holder to come and look at a row that
   * does not exist yet, and a holder fast enough to claim before the commit would be told there is
   * nothing there. Its outcome never resolves or rejects the durable row: an absent, stale,
   * unsupported or failed wake leaves the message exactly where it is, queued for whoever attaches
   * next, which is why no polling path is needed.
   */
  wakeRole(roleKey: string): Promise<Decision<void>>;
}

/** What the relay gets back when a message became a turn. */
export interface BuzzMessageAnswer {
  answer: string;
  /**
   * True only when the CEO peer itself produced the text.
   *
   * Always false for a role-addressed message, and now for a stronger reason than before: nobody
   * answered one. `reasonCode === OK` remains the "the addressed peer answered" fact and is
   * reachable only on the CEO path; a queued role message reports
   * `UNTRUSTED_CONTENT_IS_DATA` instead, so a relay cannot read stored as answered.
   */
  answeredByCeo: boolean;
  turnRequestId: string;
  conversation: string;
}

/**
 * What one admitted envelope turned out to be, once its address was resolved.
 *
 * The role arm carries the outbox row's id because that id *is* the turn request identity, and the
 * caller past this point has nothing else to name the durable row with.
 */
type BuzzMessageAdmission =
  | { readonly kind: "CEO"; readonly admitted: AdmittedBuzzMessage }
  | {
      readonly kind: "ROLE";
      readonly admitted: AdmittedBuzzMessage;
      readonly roleKey: string;
      readonly messageId: string;
    };

/**
 * The rollback signal, thrown to undo a half-finished role admission.
 *
 * A thrown object rather than a denied return, because the outer frame is `atomically` and a
 * *returned* denial there commits — which is exactly what the address refusals below need and
 * exactly what an enqueue refusal must not get. Deliberately not an `Error`: `Db.translate`
 * inspects an `Error`'s message for SQLite constraint text and would rewrite a message that
 * happened to contain it, so the signal is a plain object that passes through untouched.
 */
const ADMISSION_ROLLBACK = Symbol("buzz-owner-message-admission-rollback");
interface AdmissionRollback {
  readonly [ADMISSION_ROLLBACK]: Decision<never>;
}
const rollingBack = (decision: Decision<unknown>): AdmissionRollback => ({
  [ADMISSION_ROLLBACK]: decision as Decision<never>,
});
const rolledBackDecision = (err: unknown): Decision<never> | null =>
  typeof err === "object" && err !== null && ADMISSION_ROLLBACK in err
    ? (err as AdmissionRollback)[ADMISSION_ROLLBACK]
    : null;

/**
 * §2 — role admission produces the inbound row, the exact role target and the outbox row together,
 * or produces none of them.
 *
 * Two kinds of refusal live in one transaction here and they must not be treated alike:
 *
 *   returned      the sender or the address was refused. `admit` has already spent the
 *                 `(buzz, nonce)` slot and, for an unresolvable `p` tag, written its one journal
 *                 row — and both of those are the authenticated unbound-address semantics this
 *                 slice preserves exactly. A returned `Decision` commits, so they survive.
 *   thrown        the envelope was admitted and then something after it refused: no active
 *                 target, a refused enqueue, a refused claim. Committing any of that would leave a
 *                 spent nonce addressed to nobody, or a queued message no claim holds open. So it
 *                 is thrown, and the whole admission is rolled back as if the event had never
 *                 arrived — the relay may then send it again.
 */
const admitBuzzMessage = (
  ingress: BuzzMessageIngress,
  port: BuzzMessageTurnPort,
  input: BuzzMessageIngressInput,
): Decision<BuzzMessageAdmission> => {
  try {
    return port.atomically((): Decision<BuzzMessageAdmission> => {
      const admitted = ingress.admit(input);
      if (!admitted.allowed) return admitted as Decision<BuzzMessageAdmission>;
      const target = admitted.value.target;
      if (target.kind === "CEO") {
        return allow(admitted.reasonCode, { kind: "CEO", admitted: admitted.value });
      }

      // The registry, once, inside the transaction — and the same answer is used for the outbox
      // row's fence and for the claim's `bindingDigest`. Reading it twice would let the two
      // disagree across a failover that landed between them.
      const active = port.activeRoleTarget(target.roleKey);
      if (!active) {
        throw rollingBack(
          deny(
            ReasonCode.ROLE_PEER_ABSENT,
            "no session holds the addressed role, so there is nothing to address the message to",
            { roleKey: target.roleKey },
          ),
        );
      }
      const enqueued = port.enqueueOwnerMessage({
        roleKey: target.roleKey,
        bindingGeneration: active.bindingGeneration,
        targetSessionId: active.targetSessionId,
        nonce: admitted.value.nonce,
        pointer: ownerMessagePointer(input, admitted.value.nonce),
      });
      if (!enqueued.allowed) throw rollingBack(enqueued);

      // The claim last, carrying the outbox id. Its unresolved presence is what keeps `prune` off
      // the one row the pointer resolves to while the outbox row is PENDING or SENT.
      const claimed = ingress.claimTurn(
        admitted.value.nonce,
        ingress.turnIdentityFor(
          { conversation: admitted.value.conversation, text: admitted.value.text },
          active.bindingGeneration,
          enqueued.value.messageId,
        ),
      );
      if (!claimed.allowed) throw rollingBack(claimed);

      return allow(admitted.reasonCode, {
        kind: "ROLE",
        admitted: admitted.value,
        roleKey: target.roleKey,
        messageId: enqueued.value.messageId,
      });
    });
  } catch (err) {
    const rolledBack = rolledBackDecision(err);
    if (rolledBack) return rolledBack;
    throw err;
  }
};

/**
 * §3 — the durable row is committed, so now, and only now, the holder is told to come and look.
 *
 * Nothing here resolves or rejects the message whatever the wake says. A wake is not a delivery:
 * the message is durable and addressed either way, and the only thing a failed wake costs is
 * promptness — the next `registerEndpoint` on this role sends one unconditionally and drains
 * whatever accumulated, which is why this path needs no poller and no retry timer.
 */
const queuedForRole = async (
  port: BuzzMessageTurnPort,
  admission: Extract<BuzzMessageAdmission, { kind: "ROLE" }>,
): Promise<Decision<BuzzMessageAnswer>> => {
  const woken = await port.wakeRole(admission.roleKey);
  return allow(
    // Not `OK`. `OK` on this surface has always meant "the addressed peer answered", and nobody
    // has answered — the envelope was taken as durable data, which is precisely what `admit`
    // itself reports. Reusing the admission's own code keeps a relay from reading a queued
    // message as a delivered one.
    ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
    {
      answer: ownerMessageQueuedSentence(woken.allowed ? null : woken.reasonCode),
      answeredByCeo: false,
      turnRequestId: admission.messageId,
      conversation: admission.admitted.conversation,
    },
    { queued: true, messageId: admission.messageId, wake: woken.reasonCode },
  );
};

/**
 * What the owner is told once their message is durable.
 *
 * Three facts, and this seam observed all three: the row is stored, nobody has read it, and this is
 * what happened when the wake was attempted. Nothing else is knowable from here.
 *
 * **No sentence may say that anyone takes the message.** Not the holder now, not a holder later,
 * not a successor. That is not a rule about phrasing, it is what the row can keep: the message is
 * addressed to one generation and one runtime, it reaches a successor only if a takeover carries it
 * — once, and only from `PENDING` — it is closed outright by a revoke or a second takeover, and a
 * hand-over that is never acknowledged ends terminal rather than repeated. Every one of those is a
 * path on which the owner would have been promised something that did not happen.
 *
 * The first attempt at this removed one phrase, "the next holder", and put the same promise back in
 * other words — "its holder takes it over its own connection whenever it next attaches". So the
 * sentences below are held to a *closed vocabulary* in `buzz-message-ingress.test.ts` rather than to
 * a list of forbidden phrases: they may use only words enumerated there, and that enumeration is
 * itself asserted to contain no modal, no forward-looking time word, no verb of receipt and none of
 * the actor nouns a promise needs a subject from. A synonym is caught for being a new word, not for
 * having been guessed at in advance.
 *
 * `null` means the wake was sent, which is still not a read. And a wake refusal says nothing about
 * the message at all: `ROLE_PEER_ABSENT` here means no live peer was registered to nudge, not that
 * the role has no holder — a message is only ever enqueued against an active binding.
 */
export const ownerMessageQueuedSentence = (wakeRefusal: string | null): string => {
  if (wakeRefusal === null) {
    return "Stored for the role, and a wake was sent to its registered peer. Nobody has read it yet.";
  }
  if (wakeRefusal === ReasonCode.ROLE_PEER_ABSENT || wakeRefusal === ReasonCode.ROLE_PEER_STALE) {
    return "Stored for the role. No peer is attached, so no wake was sent. Nobody has read it yet.";
  }
  if (wakeRefusal === ReasonCode.ROLE_PEER_UNSUPPORTED) {
    return "Stored for the role. No wake endpoint is registered, so no wake was sent. Nobody has read it yet.";
  }
  return "Stored for the role. The wake did not land. Nobody has read it yet.";
};

/**
 * An owner's Buzz message, admitted as one durable turn for whoever holds the addressed role.
 *
 * This is the receiving half #627 asks for, and the whole of its correctness is what it does
 * *not* do: nothing here starts a session, resumes one, or synthesises a reply.
 *
 * The two addresses are answered by two different mechanisms, and that asymmetry is deliberate.
 * The CEO's is a *conversation*: the owner waits on this connection while the CEO answers, and the
 * answer goes back down it. A role's is a *message*: it is written to the durable outbox, its
 * holder is woken, and the holder comes and takes it over its own authenticated connection — so
 * nothing is waited on here, and a role that is between holders costs the message nothing.
 *
 * The address was already resolved, once, inside `admit`. Nothing below re-derives it: an
 * envelope whose `p` tag named no role never reaches this point, so there is no state in which a
 * turn exists for a message that has nowhere to go.
 *
 * The turn is claimed before anything runs, for the reason `IngressGuard.claimTurn` gives: the
 * CEO's reply command resumes the owner's own conversation, so running one message twice appends
 * the same exchange twice to a transcript the CEO then carries forward as context.
 */
export const deliverBuzzMessage = async (
  ingress: BuzzMessageIngress,
  port: BuzzMessageTurnPort,
  input: BuzzMessageIngressInput,
): Promise<Decision<BuzzMessageAnswer>> => {
  const admission = admitBuzzMessage(ingress, port, input);
  if (!admission.allowed) return admission as Decision<BuzzMessageAnswer>;
  if (admission.value.kind === "ROLE") return queuedForRole(port, admission.value);

  const admitted = admission.value.admitted;
  const identity = ingress.turnIdentityFor(
    { conversation: admitted.conversation, text: admitted.text },
    port.bindingGeneration(),
    ingress.freshTurnRequestId(),
  );
  const claimed = ingress.claimTurn(admitted.nonce, identity);
  if (!claimed.allowed) return claimed as Decision<BuzzMessageAnswer>;

  const delivered = await port.deliverToCeo(admitted.text);

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
  const resolution = closes ? ingress.resolveTurn(admitted.nonce) : null;

  return allow(
    delivered.reasonCode,
    {
      answer: delivered.answer,
      answeredByCeo: delivered.reachedCeo && answered,
      turnRequestId: identity.turnRequestId,
      conversation: admitted.conversation,
    },
    {
      // A bookkeeping write that raced must not cost the owner the CEO's reply, so the answer
      // is returned either way and the refusal travels as evidence instead of as an error.
      turnResolution: resolution === null ? "OUTCOME_UNKNOWN" : resolution.reasonCode,
    },
  );
};
