import { describe, expect, it } from "vitest";

import {
  RECURRING_DEFECTS,
  type RecurringDefect,
  classifyRecurrence,
  independentOccurrences,
} from "../../src/quality/recurring-defects.ts";

/**
 * The transition this module exists for: a second occurrence **on a different surface** makes a
 * guard mandatory. Everything else about recurrence is bookkeeping.
 *
 * These cases are about the classifier. Whether the guard a class names actually exists is
 * `scripts/verify-recurrence-is-guarded.mjs`'s question, because resolving a name needs the
 * filesystem and the package manifest rather than a pure function.
 */
const occurrence = (where: string) => ({
  at: "2026-09-15",
  where,
  evidence: `measured on ${where}`,
});

const defect = (overrides: Partial<RecurringDefect> = {}): RecurringDefect => ({
  id: "fixture",
  what: "a fixture class",
  occurrences: [occurrence("src/one.ts")],
  guard: null,
  ...overrides,
});

describe("a defect that recurs earns a gate", () => {
  it("one occurrence is a regression test, not a standing rule", () => {
    expect(classifyRecurrence(defect())).toBe("OBSERVED_ONCE");
  });

  it("two occurrences on different surfaces make a guard mandatory", () => {
    const recurred = defect({ occurrences: [occurrence("src/one.ts"), occurrence("src/two.ts")] });

    expect(classifyRecurrence(recurred)).toBe("RECURRED_UNGUARDED");
  });

  it("the same surface twice is one occurrence, not a class", () => {
    // The distinction the review skill states in words: "a rerun, rename, second finding ID or
    // unfixed instance is not independent recurrence". Counting those would make every unfixed
    // bug look like a class and bury the real ones.
    const twice = defect({ occurrences: [occurrence("src/one.ts"), occurrence("src/one.ts")] });

    expect(independentOccurrences(twice)).toBe(1);
    expect(classifyRecurrence(twice)).toBe("OBSERVED_ONCE");
  });

  it("a guard after a single occurrence is still guarded", () => {
    // Demanding a second occurrence before the state can say GUARDED would reward waiting for the
    // repeat, which is the opposite of what this is for.
    expect(classifyRecurrence(defect({ guard: "pnpm lint" }))).toBe("GUARDED");
  });

  it("whitespace is not a guard", () => {
    const blank = defect({
      occurrences: [occurrence("src/one.ts"), occurrence("src/two.ts")],
      guard: "   ",
    });

    expect(classifyRecurrence(blank)).toBe("RECURRED_UNGUARDED");
  });

  it("every registered class is guarded or has been seen once", () => {
    // The registry's own invariant, held here as well as in CI: this file fails in a second and
    // the gate fails in the pipeline, and the two disagree only if one of them stops running.
    const unguarded = RECURRING_DEFECTS.filter(
      (entry) => classifyRecurrence(entry) === "RECURRED_UNGUARDED",
    );

    expect(unguarded.map((entry) => entry.id)).toEqual([]);
  });

  it("every entry names the places it was met, and they are real paths", () => {
    for (const entry of RECURRING_DEFECTS) {
      expect(entry.occurrences.length, entry.id).toBeGreaterThan(0);
      for (const seen of entry.occurrences) {
        // A surface has to be nameable for two of them to be comparable at all. An entry whose
        // `where` is a mood rather than a place cannot distinguish a class from a repeat.
        expect(seen.where, entry.id).toMatch(/[/.]/);
        expect(seen.evidence.length, entry.id).toBeGreaterThan(20);
      }
    }
  });
});
