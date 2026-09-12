import { describe, expect, it } from "vitest";

import {
  deriveHumanGate,
  HUMAN_GATE_TRIGGERS,
  type HumanGateInput,
} from "../../src/ceo/human-gate.ts";
import { ExecutionMode } from "../../src/domain/types.ts";

/**
 * `deriveHumanGate` decides whether a run needs the owner. Its two conditions carry five
 * `&&`/`||` operands, and the census had all of them unanswered because this whole file was on
 * the exclusion list. Each case below is an input the *other* operands cannot answer for.
 *
 * The gate is fail-closed by construction: `required` is a disjunction, so every case that should
 * need the owner must be driven by exactly one of the three reasons, or removing that reason
 * changes nothing and the operand is untested.
 */
const input = (over: Partial<HumanGateInput> = {}): HumanGateInput => ({
  executionMode: ExecutionMode.STANDARD,
  goal: "",
  scope: [],
  declaredItems: [],
  ...over,
});

describe("each reason the human gate fires has an input only it explains", () => {
  it("requires the owner for a GUARDED run with nothing declared and nothing triggered", () => {
    // The one case where the item list is deliberately empty and the gate is still required —
    // callers must fail closed rather than read the empty list as an opt-out.
    const gate = deriveHumanGate(input({ executionMode: ExecutionMode.GUARDED }));

    expect(gate.required).toBe(true);
    expect(gate.items).toEqual([]);
  });

  it("requires the owner for a declared item on a STANDARD run with no trigger text", () => {
    const gate = deriveHumanGate(input({ declaredItems: ["rotate the signing key"] }));

    expect(gate.required).toBe(true);
    expect(gate.items).toEqual(["rotate the signing key"]);
  });

  it("requires the owner for triggering text alone, with nothing declared and a STANDARD mode", () => {
    const gate = deriveHumanGate(input({ goal: "delete the stale run rows" }));

    // Nothing was declared and the mode is STANDARD, so this is the trigger operand's own work.
    expect(gate.required).toBe(true);
    expect(gate.items).toEqual(["destructive data migration or delete"]);
  });

  it("does not require the owner for a STANDARD run with no trigger and nothing declared", () => {
    // The control. Without it the three cases above pass against a gate that always fires.
    const gate = deriveHumanGate(input({ goal: "add a unit test", scope: ["tests/"] }));

    expect(gate.required).toBe(false);
    expect(gate.items).toEqual([]);
  });

  it("matches a short phrase that is not the trigger's own name", () => {
    // `matches` is `text.includes(trigger) || phrases.some(...)`. This is the phrase half's
    // independent witness: "public api" fires the trigger while the full trigger name
    // ("public api or protocol breaking change") never appears in the text.
    const goal = "expose the run receipt over the public api";
    expect(goal).not.toContain("public api or protocol breaking change");

    const gate = deriveHumanGate(input({ goal }));

    expect(gate.required).toBe(true);
    expect(gate.items).toEqual(["public api or protocol breaking change"]);
  });

  it("fires every trigger in the table from its own name", () => {
    // The census cannot be answered for the `text.includes(normalise(trigger))` half of
    // `matches`: measured across the table, every trigger's normalised name contains at least
    // one of its own phrases, so that operand can never be the only one that fires. It carries
    // an UNANSWERED reason rather than a falsifiability row, and the reason states the
    // measurement.
    //
    // What is testable is the contract both halves serve, for every entry rather than for the
    // one a row would have sampled: a trigger named in a run's goal requires the owner.
    for (const trigger of HUMAN_GATE_TRIGGERS) {
      const gate = deriveHumanGate(input({ goal: trigger }));
      expect(gate.required, trigger).toBe(true);
      expect(gate.items, trigger).toContain(trigger);
    }
    expect(HUMAN_GATE_TRIGGERS.length).toBe(10);
  });
});
