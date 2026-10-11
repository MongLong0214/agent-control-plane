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
/**
 * The binding marker in any spelling a reader would take for it: any case, with whitespace, dashes
 * or underscores (or nothing) between the words, matched after NFKC folding with format characters
 * removed, so full-width letters and zero-width joiners do not hide it. Loose on purpose: content
 * this matches is never delivered, and a false match costs a message, never a binding.
 */
const BIND_MARKER = /acp[\s\p{Pd}_]*buzz[\s\p{Pd}_]*bind/giu;
/** The one form that binds: the exact token `mint` issues, standing alone. */
const WELL_FORMED_TOKEN = /(?<![0-9A-Za-z])acp-buzz-bind:([0-9a-f]{32})(?![0-9A-Za-z])/g;
const X_ONLY_HEX = /^[0-9a-f]{64}$/;

/**
 * What an event's content says about binding (ACP1055-01), in three answers:
 *
 *   - `NONE`: no binding marker in any spelling — admission's, as it always was;
 *   - `TOKEN`: exactly one marker, and it is a well-formed token — the binding's;
 *   - `MALFORMED`: any other content carrying a marker — two tokens, a token beside a mangled
 *     prefix, a prefix with no usable nonce. Refused: neither delivered nor bound.
 *
 * Only `NONE` may reach admission. Reading "not exactly one token" as "not a binding event" is what
 * once delivered `${token} ${token}` to the CTO as a message.
 */
export type BuzzBindContent =
  | { readonly kind: "NONE" }
  | { readonly kind: "TOKEN"; readonly nonce: string }
  | { readonly kind: "MALFORMED" };

export const buzzBindContentOf = (content: string): BuzzBindContent => {
  const folded = content.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const markers = folded.match(BIND_MARKER)?.length ?? 0;
  if (markers === 0) return { kind: "NONE" };
  const tokens = [...content.matchAll(WELL_FORMED_TOKEN)];
  const nonce = tokens.length === 1 ? tokens[0]?.[1] : undefined;
  if (markers !== 1 || nonce === undefined) return { kind: "MALFORMED" };
  return { kind: "TOKEN", nonce };
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
  /**
   * The CEO binding generation the challenge was minted under. The writer re-reads the CEO binding
   * inside its write transaction and binds only while it is still this runtime at this generation,
   * because a re-adoption can commit between this store's own check and the write.
   */
  readonly ceoBindingGeneration: number;
  /**
   * The verified answer's signed `created_at`, in seconds: inside the challenge's window and no later
   * than the daemon's clock plus `BUZZ_BIND_SIGNED_SKEW_SECONDS`. A recovery records it as part of the
   * boundary its key's peer events are counted from, so it is bounded here: an answer dated far ahead
   * would otherwise hold back the CEO's ordinary messages until that time.
   */
  readonly answerSignedAt: number;
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
  /**
   * The event that consumed it and the writer's answer to that event, once one did. Consumption and
   * success are separate facts (ACP1055-02): a consumed nonce never binds again, and only a binding
   * the writer accepted is answered as already applied when its event comes back.
   */
  consumed: { readonly eventId: string; settlement: Decision<unknown> } | null;
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
      consumed: null,
      refusalsRecorded: new Set(),
    });
    this.#pendingBySession.set(runtime.sessionId, nonce);
    return allow(ReasonCode.OK, {
      challenge: `${BUZZ_BIND_TOKEN_PREFIX}${nonce}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  /**
   * A verified event's answer to a challenge: null only when its content carries no binding marker
   * at all (admission's, as before), otherwise the binding's decision — a refusal for anything but
   * one well-formed token. The nonce is consumed before the writer is called, so no second event can
   * reach the writer on it.
   */
  settle(event: BuzzMentionEvent): Decision<unknown> | null {
    const content = buzzBindContentOf(event.content);
    if (content.kind === "NONE") return null;
    // The subscriber verified this event; the proof is minted only by code that verified it itself.
    if (!verifyEvent(plainCopy(event))) {
      return deny(ReasonCode.INGRESS_SIGNATURE_INVALID, "the binding event's signature does not verify");
    }
    if (content.kind === "MALFORMED") {
      // Nothing is looked up or recorded: like an unknown nonce, it names no challenge for certain.
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "a message carrying the binding marker must carry exactly one well-formed token and nothing else like it",
      );
    }
    const nonce = content.nonce;
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
    const consumed = challenge.consumed;
    if (consumed !== null) {
      if (consumed.eventId !== event.id) {
        return refuse(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED, "challenge-consumed", "the binding challenge was already used");
      }
      // The same event again. Only a binding the writer accepted is answered as already applied —
      // the one answer the subscriber trusts with its cursor. A refused or unfinished write is
      // answered with that refusal again, so a replay cannot turn it into durability.
      if (!consumed.settlement.allowed) return consumed.settlement;
      return refuse(ReasonCode.INGRESS_REPLAY_IGNORED, "event-replayed", "this binding event was already applied");
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
    if (event.created_at * 1000 > now + BUZZ_BIND_SIGNED_SKEW_SECONDS * 1000) {
      return refuse(
        ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
        "signed-ahead-of-clock",
        "the binding event is dated further ahead of this daemon's clock than the signing skew allows",
      );
    }
    if (!this.#isCurrentCeo(this.#ports.currentCeo(), challenge.runtime, challenge.ceoBindingGeneration)) {
      return refuse(
        ReasonCode.BINDING_GENERATION_STALE,
        "ceo-binding-moved",
        "the CEO binding's runtime or generation changed since the challenge was minted",
      );
    }

    // Consumed before the writer runs, with a refusal standing in for its answer until it returns:
    // a writer that throws leaves the nonce spent and its event answered as not bound.
    const consumedNow = {
      eventId: event.id,
      settlement: deny(ReasonCode.CONFLICT, "the binding write for this event did not complete") as Decision<unknown>,
    };
    challenge.consumed = consumedNow;
    if (this.#pendingBySession.get(challenge.runtime.sessionId) === nonce) {
      this.#pendingBySession.delete(challenge.runtime.sessionId);
    }
    const possession: BuzzKeyPossession = Object.freeze({
      runtime: challenge.runtime,
      buzzActorId: challenge.actor,
      ceoBindingGeneration: challenge.ceoBindingGeneration,
      answerSignedAt: event.created_at,
    });
    POSSESSIONS.add(possession);
    const bound = this.#ports.bind(possession);
    consumedNow.settlement = bound;
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
