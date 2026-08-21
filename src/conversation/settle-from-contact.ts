import { digestOf } from "../core/digest.ts";
import type { Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CeoTurnOutcome } from "../mcp/ceo-conversation.ts";

import type { TurnOutcome } from "./turn-coordinator.ts";

/**
 * What a dispatch observed, turned into a settlement — or into nothing.
 *
 * Separated from the dispatch path on purpose. The mapping is the whole of the design decision
 * (#663) and it is three lines of judgement wrapped in an integration nobody can test cheaply;
 * left inline, the judgement would be exercised only through a live CEO turn, which is exactly
 * the shape of test this project keeps discovering was never really running.
 *
 * The rule the table encodes: **ACP settles what it observed, under an authority that says so.**
 * A success it watched end to end is a settlement. Anything after contact that did not end in a
 * correlated reply is not — not a timeout, not a closed socket, not a killed child, not a
 * non-text result. Those leave the turn `IN_DOUBT`, which is the honest record of an outcome
 * nobody established.
 *
 * Returning "no settlement" is a first-class answer here rather than an error. The temptation it
 * exists to refuse is the one that produces duplicates: turning *we stopped waiting* into *it did
 * not run*, which legalises a retry against a turn that may still be committing.
 */
export type SettlementIntent =
  | { readonly settle: true; readonly outcome: TurnOutcome }
  | { readonly settle: false; readonly because: string };

/** What the dispatch knew when it stopped. */
export interface DispatchObservation {
  /** The typed contact boundary from the CEO conversation port (#652). */
  readonly contact: CeoTurnOutcome;
  /** The permit's prompt digest, so the evidence names the turn it is about. */
  readonly promptDigest: string;
  /** The authenticated peer this dispatch spoke to, as the runtime reported it. */
  readonly peer: { readonly sessionId: string; readonly incarnation: string };
}

/** Bumped if the evidence shape changes, so an old digest is never silently re-derived. */
export const SETTLEMENT_EVIDENCE_VERSION = 1;

/**
 * Decides what, if anything, this observation settles.
 *
 * Exhaustive over the contact boundary rather than defensive: every branch is named, and the
 * default is not to settle. A new contact state added later fails to compile here, which is the
 * point of keeping the union narrow.
 */
export const settlementFor = (observation: DispatchObservation): SettlementIntent => {
  const { contact, answered } = { contact: observation.contact.contact, answered: observation.contact.answered };

  if (contact === "NEVER_REACHED") {
    if (answered.allowed) {
      // Contradictory: the port says nothing reached the peer, and also that it has an answer.
      // Refusing here rather than picking one is deliberate — a settlement built on a
      // self-contradicting observation is worse than no settlement, because it looks decided.
      return {
        settle: false,
        because: "the contact boundary reported no peer contact alongside an answer",
      };
    }
    // Positively established that execution never started. This is the one refusal that is
    // itself evidence, and #651 is why it settles rather than lingering.
    return {
      settle: true,
      outcome: {
        kind: "NEVER_ADMITTED",
        authority: "ACP_PRE_DISPATCH",
        reasonCode: answered.reasonCode,
      },
    };
  }

  if (!answered.allowed) {
    // Reached the peer, then something went wrong: a timeout, a closed socket, a rejection, a
    // result that was not text. Every one of them leaves "did the turn commit" unanswered, and
    // the answer to an unanswerable question is not a settlement.
    return {
      settle: false,
      because: `contact was made and the turn did not return an answer (${answered.reasonCode})`,
    };
  }

  // Reached, and a correlated reply came back. The strongest thing ACP can say on its own.
  return {
    settle: true,
    outcome: {
      kind: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      reasonCode: ReasonCode.OK,
      evidenceDigest: digestOf({
        version: SETTLEMENT_EVIDENCE_VERSION,
        promptDigest: observation.promptDigest,
        peerSessionId: observation.peer.sessionId,
        peerIncarnation: observation.peer.incarnation,
        answerDigest: digestOf(answered.value),
      }),
    },
  };
};

/**
 * Whether a settlement failure is one the dispatch path should surface rather than swallow.
 *
 * `CONFLICT` means the turn was already settled — reachable when a late authority arrives after
 * an earlier one, and not this caller's problem to resolve. Everything else means the ledger
 * refused a settlement it should have accepted, which is a defect and has to be loud.
 */
export const settlementFailureIsExpected = (decision: Decision<void>): boolean =>
  !decision.allowed && decision.reasonCode === ReasonCode.CONFLICT;
