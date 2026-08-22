import { describe, expect, it } from "vitest";

import {
  SETTLEMENT_EVIDENCE_VERSION,
  type DispatchObservation,
  settlementFor,
} from "../../src/conversation/settle-from-contact.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ReasonCode as ReasonCodeValue } from "../../src/core/reason-codes.ts";

/**
 * The decision in #663, as a table.
 *
 * ACP settles what it observed, under an authority that says so. The tests that matter are the
 * ones where it must *not* settle — a timeout, a closed socket, a killed child. Each of those is
 * a state where "did the turn commit" is unanswerable, and turning any of them into a settlement
 * legalises a retry against a turn that may still be committing. That is the duplicate the whole
 * ledger exists to prevent, so these are the counterexamples, not the happy path.
 */
const peer = { sessionId: "ses-1", incarnation: "inc-1" } as const;

const observed = (contact: DispatchObservation["contact"]): DispatchObservation => ({
  contact,
  promptDigest: "sha256:prompt",
  peer,
});

describe("a success ACP watched end to end settles, under its own name", () => {
  it("settles COMPLETED when contact was made and a reply came back", () => {
    const intent = settlementFor(observed({ contact: "REACHED", answered: allow(ReasonCode.OK, "the answer") }));

    expect(intent.settle).toBe(true);
    if (!intent.settle) return;
    expect(intent.outcome.kind).toBe("COMPLETED");
    expect(intent.outcome.authority).toBe("ACP_OBSERVED_HERMES_REPLY");
  });

  it("does not claim the target's own receipt", () => {
    // The one substitution that would undo the decision. `HERMES_TARGET` means the target proved
    // it; this authority means ACP watched it. Stretching the first over the second is the
    // laundering the design keeps having to remove.
    const intent = settlementFor(observed({ contact: "REACHED", answered: allow(ReasonCode.OK, "a") }));

    expect(intent.settle && intent.outcome.authority).not.toBe("HERMES_TARGET");
  });

  it("binds the evidence to this prompt, this peer, and this answer", () => {
    // An evidence digest that does not name what it is about is a value satisfying a NOT NULL
    // constraint. Each input has to move it, or it is not evidence of that input.
    const base = observed({ contact: "REACHED", answered: allow(ReasonCode.OK, "answer one") });
    const digestOfIntent = (o: DispatchObservation): string => {
      const intent = settlementFor(o);
      if (!intent.settle || intent.outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
      return intent.outcome.evidenceDigest;
    };

    const original = digestOfIntent(base);
    expect(digestOfIntent({ ...base, promptDigest: "sha256:other" })).not.toBe(original);
    expect(digestOfIntent({ ...base, peer: { ...peer, incarnation: "inc-2" } })).not.toBe(original);
    expect(
      digestOfIntent({ ...base, contact: { contact: "REACHED", answered: allow(ReasonCode.OK, "answer two") } }),
    ).not.toBe(original);
  });

  it("carries a version, so a later evidence shape is not silently re-derived", () => {
    expect(SETTLEMENT_EVIDENCE_VERSION).toBe(1);
  });
});

describe("a refusal that never reached the peer is itself evidence", () => {
  it("settles NEVER_ADMITTED under pre-dispatch authority", () => {
    const intent = settlementFor(
      observed({
        contact: "NEVER_REACHED",
        answered: deny(ReasonCode.CEO_CONVERSATION_UNAVAILABLE, "no peer"),
      }),
    );

    expect(intent.settle).toBe(true);
    if (!intent.settle) return;
    expect(intent.outcome.kind).toBe("NEVER_ADMITTED");
    expect(intent.outcome.authority).toBe("ACP_PRE_DISPATCH");
    expect(intent.outcome.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
  });

  it("refuses to settle a contact boundary that contradicts itself", () => {
    // No peer contact, and also an answer. Picking either reading would produce a settlement
    // that looks decided and rests on an observation that cannot be true.
    const intent = settlementFor(
      observed({ contact: "NEVER_REACHED", answered: allow(ReasonCode.OK, "an answer") }),
    );

    expect(intent.settle).toBe(false);
  });
});

describe("nothing after contact settles unless a reply came back", () => {
  const afterContact: readonly [string, ReasonCodeValue][] = [
    ["a timeout", ReasonCode.CEO_CONVERSATION_TIMEOUT],
    ["a stale binding", ReasonCode.CEO_CONVERSATION_STALE],
    ["a non-text result", ReasonCode.CEO_CONVERSATION_NOT_TEXT],
    ["a busy conversation", ReasonCode.CEO_CONVERSATION_BUSY],
    ["an unavailable peer mid-turn", ReasonCode.CEO_CONVERSATION_UNAVAILABLE],
    ["an unsupported peer", ReasonCode.CEO_CONVERSATION_UNSUPPORTED],
  ];

  it.each(afterContact)("does not settle after %s", (_name, reasonCode) => {
    const intent = settlementFor(observed({ contact: "REACHED", answered: deny(reasonCode, "failed") }));

    expect(intent.settle).toBe(false);
  });

  it("says why it did not settle, naming the reason it saw", () => {
    // The turn stays in doubt, so the operator's only handle on it is this sentence plus the
    // doctor's age. "Could not settle" would send them looking with nothing.
    const intent = settlementFor(
      observed({ contact: "REACHED", answered: deny(ReasonCode.CEO_CONVERSATION_TIMEOUT, "timed out") }),
    );

    expect(intent.settle).toBe(false);
    if (intent.settle) return;
    expect(intent.because).toContain(ReasonCode.CEO_CONVERSATION_TIMEOUT);
  });

  it("has no branch that turns a timeout into NEVER_ADMITTED", () => {
    // The decision's load-bearing refusal, stated as a property rather than left to a reader of
    // the table. "We stopped waiting" and "it did not run" are different facts, and treating them
    // as one legalises a retry against a turn that may still be committing.
    const timedOut = settlementFor(
      observed({ contact: "REACHED", answered: deny(ReasonCode.CEO_CONVERSATION_TIMEOUT, "t") }),
    );
    expect(timedOut.settle).toBe(false);
  });

  it("has no branch that turns any post-contact failure into ABORTED", () => {
    // ABORTED is what legalises attempt 2, and it requires a fence. ACP cannot produce one: a
    // dead child proves only that *that process* writes nothing further, not that the turn did
    // not already commit. So no reason code reaches an ABORTED settlement here.
    const everyOutcome = [
      ...afterContact.map(([, code]) =>
        settlementFor(observed({ contact: "REACHED", answered: deny(code, "x") })),
      ),
      settlementFor(observed({ contact: "NEVER_REACHED", answered: deny(ReasonCode.CONFLICT, "x") })),
      settlementFor(observed({ contact: "REACHED", answered: allow(ReasonCode.OK, "a") })),
    ];

    const kinds = everyOutcome.filter((i) => i.settle).map((i) => (i.settle ? i.outcome.kind : ""));
    expect(kinds).not.toContain("ABORTED");
  });
});
