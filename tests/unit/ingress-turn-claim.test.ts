import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard, TURN_CLAIMED } from "../../src/ingress/ingress-guard.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A handler that only produced a reply could be re-run after a crash for free, and the ingress
 * recovery path is built on that. The Telegram DIRECT handler stopped being one when it became a
 * CEO turn: its reply command resumes the owner's own conversation, so a second run appends the
 * same exchange twice to a transcript that is then carried forward as context.
 *
 * So the right to run is taken once, and the compare-and-set is the whole mechanism — an
 * unconditional write would let two claimers both proceed, which is the case it exists to refuse.
 */
const guardFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: {
      allowedActors: ["owner"],
      allowedConversations: ["chat"],
      recoverInFlight: true,
    },
  });

const admitOne = (guard: IngressGuard, nonce: string) =>
  guard.admit({
    channel: "telegram",
    actor: "owner",
    conversation: "chat",
    nonce,
    payload: { text: "어떻게 돼가?" },
  });

describe("taking the right to run a message's handler", () => {
  it("succeeds once and refuses the second claimer", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    expect(admitOne(guard, "n1").allowed).toBe(true);

    const first = guard.claimTurn("telegram", "n1");
    const second = guard.claimTurn("telegram", "n1");

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("refuses a claim on a message that was never admitted", () => {
    // Claiming a row that does not exist would write nothing and, on an unconditional update,
    // report success — a handler would then run for a message the guard never let in.
    const harness = makeHarness();

    const claimed = guardFor(harness).claimTurn("telegram", "never-seen");

    expect(claimed.allowed).toBe(false);
    expect(claimed.reasonCode).toBe(ReasonCode.NOT_FOUND);
  });

  it("stops the recovery path from re-admitting a claimed message", () => {
    // This is the property the claim exists for. `recoverInFlight` re-admits an update whose
    // workflow is still ADMITTED; once claimed it must not, or the handler runs again.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n2");
    expect(guard.claimTurn("telegram", "n2").allowed).toBe(true);

    const replayed = admitOne(guard, "n2");

    expect(replayed.allowed).toBe(false);
    // Not INGRESS_REPLAY_IGNORED. A replay means the work was done and this copy is redundant;
    // this means nobody knows whether it was, and the two need different responses.
    expect(replayed.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("records the unknown outcome in the audit log rather than only refusing", () => {
    // A refusal the caller may swallow is not a record. This is the one state that needs a
    // person, so it has to be visible after the fact without replaying the process.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n3");
    guard.claimTurn("telegram", "n3");

    admitOne(guard, "n3");

    const events = harness.cp.audit.all().filter((event) => event.kind === "INGRESS_TURN_OUTCOME_UNKNOWN");
    expect(events).toHaveLength(1);
    expect(events[0]?.evidence).toMatchObject({ channel: "telegram", nonce: "n3" });
  });

  it("names the claimed state so a reader can tell it from a delivery status", () => {
    expect(TURN_CLAIMED).toBe("TURN_CLAIMED");
  });
});
