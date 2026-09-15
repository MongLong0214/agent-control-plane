/**
 * A defect that has happened twice is a defect the next person will meet, and a note about it is
 * not a guard.
 *
 * This repository already records failure classes in three places -- commit trailers, review
 * catalogues, a memory file -- and all three are prose a reader has to remember to consult.
 * Measured over one session on 2026-09-15: the same class was met four times, each time by a
 * different surface, and each time the record that described it existed and had been read.
 * Reading is not the enforcement point.
 *
 * So recurrence is a state here, with one transition that matters: **the second independent
 * occurrence makes a guard mandatory**, and a class that has recurred without one is a defect in
 * its own right rather than a backlog item. `scripts/verify-recurrence-is-guarded.mjs` fails on
 * that state, so the obligation lands in CI rather than in someone's judgement.
 *
 * Two things this deliberately refuses to accept as evidence:
 *
 * 1. **A second occurrence in the same place.** A rerun, a rename, a second finding id against one
 *    change -- the review skill's own words, "a rerun, rename, second finding ID or unfixed
 *    instance is not independent recurrence". Counting those would make every unfixed bug look
 *    like a class and bury the real ones.
 * 2. **A guard the entry names for itself.** `guard` is a string this module never trusts; the
 *    verifier resolves it against things that actually exist -- a package script, a falsifiability
 *    row, a hook -- and refuses an entry that points at nothing. An exemption that names a guard
 *    nobody can run is the shape this whole file exists to stop.
 */

/** One observation of the class, in a place, with what was measured rather than what was felt. */
export interface DefectOccurrence {
  /** When it was observed. */
  readonly at: string;
  /**
   * The surface it happened on. Two occurrences count as independent only when these differ:
   * this is the field that separates a class from an unfixed instance.
   */
  readonly where: string;
  /** What was measured, in enough detail that a reader can go and re-measure it. */
  readonly evidence: string;
}

export interface RecurringDefect {
  readonly id: string;
  /** One falsifiable sentence: what goes wrong, not how it felt. */
  readonly what: string;
  readonly occurrences: readonly DefectOccurrence[];
  /**
   * The thing that now refuses it. `null` means nothing does yet, which after two independent
   * occurrences is the state this module is built to make loud.
   *
   * Never trusted from here. The verifier resolves it; see this file's header.
   */
  readonly guard: string | null;
}

export type RecurrenceStatus =
  | "OBSERVED_ONCE"
  | "RECURRED_UNGUARDED"
  | "GUARDED";

/** Occurrences on distinct surfaces. One place seen twice is one occurrence of the class. */
export const independentOccurrences = (defect: RecurringDefect): number =>
  new Set(defect.occurrences.map((occurrence) => occurrence.where)).size;

/**
 * The one transition that matters, stated so a test can hold it.
 *
 * `GUARDED` before the count: a class someone guarded after a single occurrence is guarded, and
 * demanding a second before the state can say so would reward waiting for the repeat.
 */
export const classifyRecurrence = (defect: RecurringDefect): RecurrenceStatus => {
  if (defect.guard !== null && defect.guard.trim().length > 0) return "GUARDED";
  return independentOccurrences(defect) >= 2 ? "RECURRED_UNGUARDED" : "OBSERVED_ONCE";
};

/**
 * Every class this repository has met twice, with the two places it was met.
 *
 * An entry earns its place by measurement, not by feeling. Adding one is cheap and removing one
 * requires the class to have become impossible -- not merely quiet, which is the retirement rule
 * the review catalogue already states and the reason a quiet-period tally is not used here.
 */
export const RECURRING_DEFECTS: readonly RecurringDefect[] = [
  {
    id: "pushed-without-the-gate-manifest",
    what:
      "A change is pushed for review after running a hand-picked subset of checks, and CI fails " +
      "on a gate the author would not have chosen. Every instance so far was about a removal, " +
      "which is the shape least visible in a diff.",
    occurrences: [
      {
        at: "2026-09-15",
        where: "tests/process/a-turn-claim-outlives-the-process-that-made-it.test.ts",
        evidence:
          "Ran tests/unit only. The failing file was named in the killedBy of the falsifiability " +
          "row edited in the same change, and was read without being run.",
      },
      {
        at: "2026-09-15",
        where: "scripts/lib/unbounded-subprocess-exclusions.mjs",
        evidence:
          "Ran the one changed guard. Gate 12 of 24 failed with STALE EXCLUSION " +
          "src/tools/traceability.ts:477, because deleting a spawnSync leaves its exclusion entry " +
          "naming nothing.",
      },
      {
        at: "2026-09-15",
        where: "src/tools/traceability.ts",
        evidence:
          "Ran tsc and the one affected test file. Gate 3 of 24, pnpm lint, failed on a parameter " +
          "left unused by the change -- which tsc does not treat as an error.",
      },
    ],
    guard: ".githooks/pre-push",
  },
];
