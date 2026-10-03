import { randomBytes } from "node:crypto";

import { decode } from "nostr-tools/nip19";
import { verifyEvent } from "nostr-tools/pure";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isAdmittedRuntime, type AdmittedRuntime } from "../session/runtime-lineage.ts";
import type { BuzzMentionEvent } from "./buzz-mention-subscriber.ts";

/**
 * The adopted CEO binding its Buzz channel identity by proving it holds that identity's key.
 *
 * The CEO's runtime holds no session secret and no signer for the deployment's Buzz ingress secret,
 * so neither existing proof of `SessionRegistry.bindBuzzActor` is one it can produce. What it does
 * hold is its own Nostr key. So the binding is a challenge and a signed answer:
 *
 *   1. the admitted CEO tool connection asks for a challenge (`buzz_actor_bind({actor})`), and this
 *      store mints one bound to that connection's admitted runtime, the CEO binding generation in
 *      force, and the actor's x-only public key;
 *   2. the CEO posts an ordinary Buzz mention, signed with its key, carrying the challenge token;
 *   3. the mention subscriber, after `verifyEvent`, hands an event carrying exactly one token here
 *      instead of to admission, and only a matching author, inside the challenge's window, while the
 *      runtime is still the current CEO binding's at the same generation, gets a possession proof —
 *      which the one writer of `sessions.buzz_actor_id` accepts as the issuer's word, the way it
 *      accepts an `AdmittedRuntime`.
 *
 * A public key alone authenticates nothing: anyone can name one. The signature over a fresh nonce is
 * what this adds, and the admission is what says which runtime asked.
 *
 * Pending challenges are held in memory only. A restart loses them and the CEO asks again.
 */

export const BUZZ_BIND_TOKEN_PREFIX = "acp-buzz-bind:";
/** How long a minted challenge may be answered. */
export const BUZZ_BIND_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** How far before the challenge was minted the answering event may be dated (a signer's clock skew). */
export const BUZZ_BIND_SIGNED_SKEW_SECONDS = 60;

/** 128 bits, as lowercase hex. */
const NONCE_BYTES = 16;
const NONCE_TOKEN = /acp-buzz-bind:([0-9a-f]{32})(?![0-9A-Za-z])/;
const X_ONLY_HEX = /^[0-9a-f]{64}$/;

/**
 * The nonce an event's content carries, when it carries exactly one well-formed token and the token
 * prefix nowhere else. Anything else is not a binding event and goes to admission as it always did.
 */
export const buzzBindNonceIn = (content: string): string | null => {
  if (content.split(BUZZ_BIND_TOKEN_PREFIX).length !== 2) return null;
  return NONCE_TOKEN.exec(content)?.[1] ?? null;
};

/** A lowercase 64-hex x-only public key from hex in either case or an `npub`, or null. */
export const normalizeBuzzActor = (actor: string): string | null => {
  const text = actor.trim();
  const lower = text.toLowerCase();
  if (X_ONLY_HEX.test(lower)) return lower;
  if (!text.startsWith("npub1")) return null;
  try {
    const decoded = decode(text);
    if (decoded.type !== "npub") return null;
    return X_ONLY_HEX.test(decoded.data) ? decoded.data : null;
  } catch {
    return null;
  }
};

/**
 * Proof that the key behind `buzzActorId` signed this runtime's challenge, as a value only this
 * module mints (`isBuzzKeyPossession`). A structurally identical object built anywhere else is not
 * one, so holding one means the verification below happened.
 */
export interface BuzzKeyPossession {
  readonly runtime: AdmittedRuntime;
  readonly buzzActorId: string;
}

const POSSESSIONS = new WeakSet<object>();

export const isBuzzKeyPossession = (value: unknown): value is BuzzKeyPossession => {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return POSSESSIONS.has(value);
};

/** The CEO binding as it stands now, read by the daemon. */
export interface BuzzBindCeoBinding {
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly bindingGeneration: number;
  /** The runtime row is READY or DRAINING. */
  readonly live: boolean;
}

/** One refused binding attempt, for the audit log; at most one per challenge and cause. */
export interface BuzzBindRefusal {
  readonly reasonCode: ReasonCode;
  readonly cause: string;
  readonly sessionId: string;
  readonly ceoBindingGeneration: number;
  /** The event's author. */
  readonly author: string;
  readonly eventId: string;
}

export interface BuzzBindChallengePorts {
  nowMs(): number;
  currentCeo(): BuzzBindCeoBinding | null;
  /** Reads only: the refusal binding `actor` to `sessionId` would meet now, before a challenge is minted. */
  bindable(sessionId: string, actor: string): Decision<void>;
  /** The one writer, given a proof this store minted. */
  bind(possession: BuzzKeyPossession): Decision<unknown>;
  recordRefusal(refusal: BuzzBindRefusal): void;
  randomNonce?(): string;
}

interface Challenge {
  readonly nonce: string;
  readonly runtime: AdmittedRuntime;
  readonly ceoBindingGeneration: number;
  readonly actor: string;
  readonly mintedAtMs: number;
  readonly expiresAtMs: number;
  /** The event that consumed it, once one did. */
  consumedBy: string | null;
  readonly refusalsRecorded: Set<string>;
}

export interface BuzzBindChallenge {
  readonly challenge: string;
  readonly expiresAt: string;
}

export class BuzzBindChallenges {
  readonly #ports: BuzzBindChallengePorts;
  readonly #byNonce = new Map<string, Challenge>();
  /** The one pending challenge per session. */
  readonly #pendingBySession = new Map<string, string>();

  constructor(ports: BuzzBindChallengePorts) {
    this.#ports = ports;
  }

  /**
   * A one-time challenge for the admitted runtime, when it is the current CEO binding's runtime.
   * Writes nothing durable. A new challenge for the same session replaces the pending one.
   */
  mint(runtime: unknown, actor: string): Decision<BuzzBindChallenge> {
    if (!isAdmittedRuntime(runtime)) {
      return deny(ReasonCode.CONFLICT, "the session proof was not issued by a lineage admission");
    }
    const normalized = normalizeBuzzActor(actor);
    if (normalized === null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the actor must be a 64-hex x-only public key or an npub");
    }
    const ceo = this.#ports.currentCeo();
    if (!this.#isCurrentCeo(ceo, runtime)) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "this runtime is not the current CEO binding's runtime");
    }
    const bindable = this.#ports.bindable(runtime.sessionId, normalized);
    if (!bindable.allowed) return bindable as Decision<BuzzBindChallenge>;

    const now = this.#ports.nowMs();
    this.#prune(now);
    const replaced = this.#pendingBySession.get(runtime.sessionId);
    if (replaced !== undefined) this.#byNonce.delete(replaced);
    const nonce = this.#ports.randomNonce?.() ?? randomBytes(NONCE_BYTES).toString("hex");
    const expiresAtMs = now + BUZZ_BIND_CHALLENGE_TTL_MS;
    this.#byNonce.set(nonce, {
      nonce,
      runtime,
      ceoBindingGeneration: ceo.bindingGeneration,
      actor: normalized,
      mintedAtMs: now,
      expiresAtMs,
      consumedBy: null,
      refusalsRecorded: new Set(),
    });
    this.#pendingBySession.set(runtime.sessionId, nonce);
    return allow(ReasonCode.OK, {
      challenge: `${BUZZ_BIND_TOKEN_PREFIX}${nonce}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  /**
   * A verified event's answer to a challenge: null when it carries no single token (admission's, as
   * before), otherwise the binding's decision. The nonce is consumed before the writer is called, so
   * no second event can reach the writer on it.
   */
  settle(event: BuzzMentionEvent): Decision<unknown> | null {
    const nonce = buzzBindNonceIn(event.content);
    if (nonce === null) return null;
    // The subscriber verified this event; the proof is minted only by code that verified it itself.
    if (!verifyEvent(plainCopy(event))) {
      return deny(ReasonCode.INGRESS_SIGNATURE_INVALID, "the binding event's signature does not verify");
    }
    const now = this.#ports.nowMs();
    this.#prune(now);
    const challenge = this.#byNonce.get(nonce);
    if (challenge === undefined) {
      // Unknown, replaced, or lost to a restart. Nothing names a session, and a stranger guessing
      // nonces must not be able to make this daemon write anything, so it is not recorded.
      return deny(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED, "no pending binding challenge has this nonce");
    }
    const refuse = (reasonCode: ReasonCode, cause: string, message: string): Decision<unknown> => {
      this.#recordOnce(challenge, event, reasonCode, cause);
      return deny(reasonCode, message, { channel: "buzz" });
    };
    if (challenge.consumedBy !== null) {
      return challenge.consumedBy === event.id
        ? refuse(ReasonCode.INGRESS_REPLAY_IGNORED, "event-replayed", "this binding event was already applied")
        : refuse(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED, "challenge-consumed", "the binding challenge was already used");
    }
    if (now > challenge.expiresAtMs) {
      return refuse(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED, "challenge-expired", "the binding challenge expired");
    }
    // Not consumed: whoever reads the token in the channel can post it under another key, and that
    // must not spend the CEO's challenge.
    if (event.pubkey !== challenge.actor) {
      return refuse(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "actor-mismatch",
        "the binding event was not signed by the key the challenge names",
      );
    }
    const mintedAtSeconds = Math.floor(challenge.mintedAtMs / 1000);
    if (
      event.created_at < mintedAtSeconds - BUZZ_BIND_SIGNED_SKEW_SECONDS ||
      event.created_at * 1000 > challenge.expiresAtMs
    ) {
      return refuse(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "signed-outside-challenge",
        "the binding event was not signed while the challenge was open",
      );
    }
    if (!this.#isCurrentCeo(this.#ports.currentCeo(), challenge.runtime, challenge.ceoBindingGeneration)) {
      return refuse(
        ReasonCode.BINDING_GENERATION_STALE,
        "ceo-binding-moved",
        "the CEO binding's runtime or generation changed since the challenge was minted",
      );
    }

    challenge.consumedBy = event.id;
    if (this.#pendingBySession.get(challenge.runtime.sessionId) === nonce) {
      this.#pendingBySession.delete(challenge.runtime.sessionId);
    }
    const possession: BuzzKeyPossession = Object.freeze({ runtime: challenge.runtime, buzzActorId: challenge.actor });
    POSSESSIONS.add(possession);
    const bound = this.#ports.bind(possession);
    if (!bound.allowed) this.#recordOnce(challenge, event, bound.reasonCode, "write-refused");
    return bound;
  }

  #isCurrentCeo(
    ceo: BuzzBindCeoBinding | null,
    runtime: AdmittedRuntime,
    generation?: number,
  ): ceo is BuzzBindCeoBinding {
    if (ceo === null) return false;
    if (!ceo.live) return false;
    if (ceo.sessionId !== runtime.sessionId) return false;
    if (ceo.sessionIncarnation !== runtime.sessionIncarnation) return false;
    return generation === undefined || ceo.bindingGeneration === generation;
  }

  /** One audit row per challenge and cause: a relay re-sending an event, or a stranger repeating one, adds none. */
  #recordOnce(challenge: Challenge, event: BuzzMentionEvent, reasonCode: ReasonCode, cause: string): void {
    if (challenge.refusalsRecorded.has(cause)) return;
    challenge.refusalsRecorded.add(cause);
    this.#ports.recordRefusal({
      reasonCode,
      cause,
      sessionId: challenge.runtime.sessionId,
      ceoBindingGeneration: challenge.ceoBindingGeneration,
      author: event.pubkey,
      eventId: event.id,
    });
  }

  /** A challenge is forgotten one TTL after it expired; until then a replay is still recognised. */
  #prune(now: number): void {
    for (const [nonce, challenge] of this.#byNonce) {
      if (now <= challenge.expiresAtMs + BUZZ_BIND_CHALLENGE_TTL_MS) continue;
      this.#byNonce.delete(nonce);
      if (this.#pendingBySession.get(challenge.runtime.sessionId) === nonce) {
        this.#pendingBySession.delete(challenge.runtime.sessionId);
      }
    }
  }
}

/** The seven signed fields on a fresh object, so `verifyEvent` checks rather than reads a cached verdict. */
const plainCopy = (event: BuzzMentionEvent) => ({
  id: event.id,
  pubkey: event.pubkey,
  created_at: event.created_at,
  kind: event.kind,
  tags: event.tags.map((tag) => [...tag]),
  content: event.content,
  sig: event.sig,
});
