import { describe, expect, it } from "vitest";

import { ceoUnavailableSentence } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

/**
 * These sentences are the whole of what the owner sees when the CEO route refuses. They are
 * written into a chat, so a claim in one of them reads as a fact the system checked.
 *
 * One of them was not. "Nothing was lost; ask again" is unobservable from this seam: the reply
 * command resumes the owner's own conversation, so at the moment the deadline passes the CEO may
 * already have written part of an answer into it, and "ask again" continues on top of that.
 */
describe("what the owner is told when the CEO route refuses", () => {
  it("does not claim nothing was lost on a timeout, because this seam cannot see that", () => {
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_TIMEOUT);

    expect(sentence).not.toMatch(/nothing was lost/i);
    // And it points the owner at the one place the truth is visible, rather than only hedging.
    expect(sentence).toMatch(/conversation/i);
  });

  it("does not invite the resend, because the resend is the duplicate", () => {
    // "ask again" read as advice and worked as a mechanism. A resent message is a new update
    // with a new nonce and a new turn id, so nothing in the duplicate protection treats it as
    // the same turn — the sentence meant to help the owner recover was the path by which the
    // thing being prevented happened (#641).
    //
    // Asking again is still the owner's call. It is not something this sentence asks for on
    // their behalf, before anyone knows whether the first turn landed.
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_TIMEOUT);

    expect(sentence).not.toMatch(/ask(ing)? again|send it again|try again|다시/i);
  });

  it("says the turn is unresolved rather than failed", () => {
    // "Unresolved" is why a retry is not simply the fix: the turn may still be arriving.
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_TIMEOUT);

    expect(sentence).toMatch(/unresolved/i);
  });

  it("does not promise a hold, because nothing holds anything yet", () => {
    // An earlier draft said a later message "is held rather than run". The gate that would hold
    // it is #641 and does not exist, so the sentence would have stated a false fact about the
    // system — the same defect as "Nothing was lost", pointed the other way. A sentence may
    // only describe behaviour that is there.
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_TIMEOUT);

    expect(sentence).not.toMatch(/\bheld\b|\bqueued\b|\bwill wait\b/i);
  });

  it("says a resend is a second turn, which is true now and after the gate lands", () => {
    // The owner needs a reason not to resend reflexively that does not depend on machinery that
    // is still to come. That a resend is a new turn rather than a retry is a fact about how
    // turns are identified, and it does not change when #641 adds the gate.
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_TIMEOUT);

    expect(sentence).toMatch(/second turn/i);
  });

  it("tells a busy owner their message was not started, so resending is the right move", () => {
    // The turn was refused before reaching the session (#630). If the sentence were vague the
    // owner would not know whether resending duplicates the message or is required.
    const sentence = ceoUnavailableSentence(ReasonCode.CEO_CONVERSATION_BUSY);

    expect(sentence).toMatch(/not started/i);
  });

  it("gives every CEO conversation reason code its own sentence", () => {
    // A new code added without a sentence falls through to the not-text default, which would tell
    // the owner the CEO answered with something undeliverable when in fact it never answered.
    const codes = Object.keys(ReasonCode).filter((k) => k.startsWith("CEO_CONVERSATION_"));
    const sentences = new Set(codes.map((c) => ceoUnavailableSentence(c)));

    expect(codes.length).toBeGreaterThan(4);
    expect(sentences.size).toBe(codes.length);
  });
});
