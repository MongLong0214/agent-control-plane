import { describe, expect, it } from "vitest";

import { canonicalJson, isDigest } from "../../src/core/digest.ts";
import { processStartedAt } from "../../src/core/process-identity.ts";
import { legalTargets } from "../../src/domain/run-state.ts";
import { RunKind, RunState } from "../../src/domain/types.ts";

/**
 * #833 — the pure guards in the small excluded files. Each of these is a function with no
 * fixture cost, so its operands are answerable with a row rather than owed, and the files were
 * excluded for the list's one shared reason rather than for anything about them.
 *
 * Every case below is chosen so that only its own operand refuses it. Where a neighbour masks an
 * operand, it is answered in refusal-operands-unanswered.mjs instead and said so there.
 */
describe("the small guards have witnesses", () => {
  it("canonicalJson allows a null-prototype object and refuses a class instance", () => {
    // `proto !== Object.prototype` is witnessed by the existing Date and Map cases in
    // core-hardening. This is the other operand: a null-prototype object has no own prototype to
    // compare, and it *is* canonically encodable — so `proto !== null` is the only thing keeping
    // the refusal off it.
    const bare = Object.create(null) as Record<string, unknown>;
    bare["b"] = 1;
    bare["a"] = 2;
    expect(canonicalJson({ n: bare })).toBe('{"n":{"a":2,"b":1}}');
    expect(() => canonicalJson({ at: new Date(0) })).toThrowError(/only plain objects/);
  });

  it("isDigest accepts one shape and refuses everything adjacent to it", () => {
    expect(isDigest("sha256:" + "a".repeat(64))).toBe(true);
    // One input per operand: a non-string reaches only the typeof half (it has no `.test` subject
    // of the right type), and a string of the wrong shape reaches only the pattern.
    expect(isDigest(12345)).toBe(false);
    expect(isDigest("sha256:" + "A".repeat(64))).toBe(false);
    expect(isDigest("sha256:" + "a".repeat(63))).toBe(false);
  });

  it("processStartedAt resolves a live pid and refuses the shapes that are not one", () => {
    // Kept, but it is deliberately *not* claimed as a witness for the four argument operands —
    // measured, those mutants SURVIVE. Every rejection path here returns null, the `catch`
    // included, so a fractional pid that gets past the guard reaches `ps -p 1.5`, ps fails, and
    // the caller sees the same null. The guards avoid spawning ps at all, which this function's
    // return value cannot show. They are answered in refusal-operands-unanswered.mjs.
    expect(processStartedAt(process.pid)).not.toBeNull();
    expect(processStartedAt(1.5)).toBeNull();
    expect(processStartedAt(0)).toBeNull();
    expect(processStartedAt(-1)).toBeNull();
  });

  it("a bootstrap run at CEO review may complete, and nothing else may", () => {
    const review = RunState.READY_FOR_CEO_REVIEW;
    // Both operands of the same condition, separated: the state alone is not enough, and the kind
    // alone is not enough. Only the pair adds COMPLETED to the legal targets.
    expect(legalTargets(review, RunKind.PROJECT_BOOTSTRAP)).toContain(RunState.COMPLETED);
    expect(legalTargets(review, RunKind.CONTRACT_CHANGE)).not.toContain(RunState.COMPLETED);
    expect(legalTargets(RunState.ACTIVE, RunKind.PROJECT_BOOTSTRAP)).not.toContain(RunState.COMPLETED);
  });
});
