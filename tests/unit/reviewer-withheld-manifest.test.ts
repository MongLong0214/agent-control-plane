import { describe, expect, it } from "vitest";

import {
  LOGICAL_WITHHELD_INPUTS,
  reviewerWithheldIsLogicalOnly,
} from "../../src/review/blind-review.ts";

/**
 * The withheld manifest may only claim things it can see.
 *
 * #360 was filed because it had drifted into advertising `network: "provider-only"` and
 * `tools: "none"` that the seatbelt did not implement — a static list asserting facts about a
 * runtime boundary it has no access to. The list has since been narrowed back to logical
 * prompt inputs, and a comment says not to let it drift again. Nothing enforced that comment.
 *
 * The distinction is what makes the current entries defensible. Worker reasoning, CTO
 * reasoning, chat history and producer self-assessment are not fields of `BlindReviewRequest`,
 * so `buildPrompt` has nothing to serialise them from — they are true by construction. A
 * sandbox fact is not: it belongs to a profile, and asserting it here would be a claim about
 * something this code cannot observe. The seatbelt claims are proved separately, against the
 * real profile, in `reviewer-transcript-isolation.test.ts`.
 */
describe("the withheld manifest claims only what it can see (#360)", () => {
  it("ships a list that is entirely logical prompt inputs", () => {
    expect(reviewerWithheldIsLogicalOnly(LOGICAL_WITHHELD_INPUTS)).toBe(true);
  });

  it("rejects a sandbox claim added back to the list", () => {
    // The specific regression #360 describes. Each of these is a runtime boundary, provable
    // only by measuring a profile — never by a constant in the packet builder.
    for (const drift of [
      "network access",
      "filesystem reads outside the packet",
      "tools",
      "provider-only network",
      "producer checkout paths",
      "process execution",
    ]) {
      expect(
        reviewerWithheldIsLogicalOnly([...LOGICAL_WITHHELD_INPUTS, drift]),
        `"${drift}" is a sandbox fact and should not be assertable here`,
      ).toBe(false);
    }
  });

  it("still accepts a new genuinely logical input", () => {
    // The converse: a guard that rejected every addition would be a freeze, not a rule, and
    // would push the next author to bypass it rather than use it.
    expect(reviewerWithheldIsLogicalOnly([...LOGICAL_WITHHELD_INPUTS, "reviewer notes"])).toBe(
      true,
    );
  });

  it("names each withheld input as something absent from the request, not from a sandbox", () => {
    // Anchors the four current entries so a silent replacement is visible in review.
    expect([...LOGICAL_WITHHELD_INPUTS]).toEqual([
      "worker reasoning",
      "CTO reasoning",
      "chat history",
      "producer self-assessment",
    ]);
  });
});
