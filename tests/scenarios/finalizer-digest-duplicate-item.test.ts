import { afterAll, describe, expect, it, vi } from "vitest";

import type * as HumanGateModule from "../../src/ceo/human-gate.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { driveToReviewedCandidate, makeHarness, ownerDecisionReceipt } from "../helpers/harness.ts";

/**
 * FIX-FINALIZER-DIGEST — every required item is bound once, by its stable id. This witness supplies a
 * duplicate through the derived definition itself, to show that the resolver refuses it rather than
 * binding one decision twice. It is not coverage of a task contract that declares a question twice:
 * `deriveHumanGate` drops that repeat from the items, which is why review r1 found it accepted
 * (FD-R1-DUP). That case is witnessed through the durable contract in
 * finalizer-digest-duplicate-declaration.test.ts.
 */
const duplicate = vi.hoisted(() => ({ on: false }));

vi.mock("../../src/ceo/human-gate.ts", async (importOriginal) => {
  const original = await importOriginal<typeof HumanGateModule>();
  return {
    ...original,
    deriveHumanGate: (input: Parameters<typeof original.deriveHumanGate>[0]) => {
      const derived = original.deriveHumanGate(input);
      return duplicate.on ? { ...derived, items: [...derived.items, derived.items.at(-1)!] } : derived;
    },
  };
});

afterAll(cleanupTempDirs);

const ITEMS = ["irreversible production action", "undelegated public release"] as const;

/** A reviewed candidate whose definition is derived with `duplicate.on` as given, every item approved. */
const approvedRun = async (withDuplicate: boolean) => {
  const harness = makeHarness({ githubClient: new FakeGitHub() });
  const driven = await driveToReviewedCandidate(harness, { workBranch: "feature/F1-duplicate-item", humanGate: ITEMS });
  duplicate.on = withDuplicate;
  for (const item of ITEMS) {
    const recorded = harness.cp.ceo.recordOwnerDecision({
      runId: driven.runId,
      item,
      approved: true,
      note: `approve ${item}`,
      receipt: ownerDecisionReceipt(harness, driven.runId, item, true, `approve ${item}`),
    });
    expect(recorded.allowed, JSON.stringify(recorded)).toBe(true);
  }
  return { gate: harness.cp.ceo, runId: driven.runId };
};

describe("FIX-FINALIZER-DIGEST: an item named twice is refused, never bound twice", () => {
  it("FINALIZER-DIGEST-DUPLICATE the resolver refuses a definition that names an item twice, though each item has its approval", async () => {
    try {
      const { gate, runId } = await approvedRun(true);
      expect(gate.humanGateStatus(runId)).toEqual({ required: true, items: [...ITEMS, ITEMS[1]], satisfied: false });
      expect(gate.currentHumanGateDecisionDigest(runId)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED,
        message: "the human-gate definition names an item more than once",
      });
      expect(gate.humanGateBinding(runId)).toMatchObject({ satisfied: false, humanGateDigest: null });
    } finally {
      duplicate.on = false;
    }
  });

  it("FINALIZER-DIGEST-DUPLICATE control: the same approvals of the definition as derived bind the gate", async () => {
    const { gate, runId } = await approvedRun(false);
    expect(gate.humanGateStatus(runId)).toEqual({ required: true, items: [...ITEMS], satisfied: true });
    expect(gate.currentHumanGateDecisionDigest(runId).allowed).toBe(true);
  });
});
