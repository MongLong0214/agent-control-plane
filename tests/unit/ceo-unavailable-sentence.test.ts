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
