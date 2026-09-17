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
  {
    id: "merged-without-preserving-the-branchs-records",
    what:
      "A pull request is squash-merged with a tool that does not call `commitlore squash-preserve`, " +
      "and git stores only the last paragraph -- so every earlier commit's records are dropped by " +
      "the merge itself, on a `main` that must not be rewritten. The merge commit is composed on " +
      "GitHub's servers, where no hook in this repository runs.",
    occurrences: [
      {
        at: "2026-08-22",
        where: "scripts/merge-pr.mjs",
        evidence:
          "That script's own header records three merges measured at the time: 8ab3342 kept 3 of " +
          "19 record lines, 108ab1a 0 of 30, 74c37fa 0 of 83. `commitlore squash-preserve` " +
          "existed and was not called.",
      },
      {
        at: "2026-09-15",
        where: "scripts/verify-merge-preserved-records.mjs",
        evidence:
          "Twelve merges went through `gh pr merge --squash`. The three multi-commit branches lost " +
          "4, 4 and 9 record lines (#937, #935, #932), and the `CommitLore squash inheritance` " +
          "action reported success with records=0 on each -- its 'already carried' test searches " +
          "the message text while git will not store the line (MongLong0214/commitlore#1029). " +
          "`pnpm trailers` went red only because the dropped lines happened to remain in the text.",
      },
    ],
    // Not `pnpm merge`: `merge-pr.mjs` already records that nothing forces a merge through it and
    // `gh pr merge` still works (0da07459). A guard naming a path an author can simply not take is
    // the shape this file's header refuses. What refuses the *outcome* is the check below, which
    // asks whether every record line the branch carried is reachable from the merge commit --
    // through its message or through the notes mirror, since the sanctioned path puts them there.
    guard: "merge-records",
  },
  {
    id: "a-record-a-note-carries-reported-as-lost",
    what:
      "A gate that asks whether a record survived reads only the commit message, while the " +
      "repair this repository sanctions for a squash merge attaches the record to the commit as " +
      "a note. The gate then reports a preserved record as lost, and the refusal cannot be acted " +
      "on: the message is pushed history.",
    occurrences: [
      {
        at: "2026-09-12",
        where: ".github/workflows/ci.yml",
        evidence:
          "573f7eab (the #867 squash) carries eleven record-trailer lines, of which git parses " +
          "three; commitlore-preserve had attached the rest as notes. It turned two green pull " +
          "requests red at once, for a commit neither of them authored. Answered by narrowing " +
          "ACP_TRAILERS_RANGE to base.sha..head.sha, which moved the range and left the question.",
      },
      {
        at: "2026-09-15",
        where: "scripts/verify-trailers-are-parsable.mjs",
        evidence:
          "8b38c9d6 on main lost four record lines to the squash, and `git notes --ref=commitlore " +
          "show 8b38c9d6` returns all four. `pnpm trailers HEAD~1..HEAD` failed on both matrix " +
          "legs. The range is already the narrowest one there is, so the answer used in #867 does " +
          "not exist here.",
      },
    ],
    guard: "trailers",
  },
  {
    id: "the-index-routes-a-reader-to-a-closed-issue",
    what:
      "The production-readiness index keeps a hand-written list of what is open. It is a copy of " +
      "the tracker with nothing reconciling it, so it drifts on the tracker's schedule rather " +
      "than on anyone's attention, and a reader who opens a listed issue finds it green and " +
      "concludes the area is finished.",
    // The surface is a URL rather than a repository path, because that is where this class lives:
    // the list is in the tracker, not in the tree. `where` is required to be nameable — a slash or
    // a dot, so that two occurrences can be compared at all — and a stable link to the exact
    // section satisfies that for the reason the requirement exists, not by accident of punctuation.
    //
    // Four dated drifts, all in one document, because the class is a property of that document.
    // `independentOccurrences` counts distinct surfaces and therefore reads this as one, which
    // understates it: the guard below is added on the strength of the four measurements rather
    // than on the count this module derives. The first three are the index's own record of
    // correcting itself, which is the clearest evidence a correction is not a fix.
    occurrences: [
      {
        at: "2026-09-12",
        where: "github.com/MongLong0214/agent-control-plane/issues/306#what-is-actually-open",
        evidence:
          "The section said \"all 16\" and named seven issues that were already closed: #778, " +
          "#780, #779, #756, #757, #575, #245 — plus #241/#418, cited as the owner-gated action, " +
          "closed 2026-08-31.",
      },
      {
        at: "2026-09-13",
        where: "github.com/MongLong0214/agent-control-plane/issues/306#what-is-actually-open",
        evidence:
          "It happened again on the corrected list: #674, #777, #859 and #784 were all named and " +
          "all closed, and #778/#864 were cited as live references when both were finished. " +
          "Fourteen became twelve.",
      },
      {
        at: "2026-09-15",
        where: "github.com/MongLong0214/agent-control-plane/issues/306#what-is-actually-open",
        evidence:
          "The heading read \"11 at 2026-09-15\" while the section carried nine live bullets, so " +
          "the count and the list it counted disagreed with each other as well as with the tracker.",
      },
      {
        at: "2026-09-18",
        where: "github.com/MongLong0214/agent-control-plane/issues/306#what-is-actually-open",
        evidence:
          "Six of nine live bullets named closed issues (#510, #655, #858, #833, #872, #885) and " +
          "three open issues had no bullet at all (#954, #758, #246) — #954 absent while the " +
          "deployment was waiting on the decision it carries.",
      },
    ],
    // A daily scheduled check, not a merge gate, for `tracker-loci.yml`'s reason: this is a fact
    // about the tracker rather than about any diff, so it is already red on an unedited `main`
    // whenever the tracker moves, and a required check in that state blocks every merge on
    // something no diff touched. `pnpm index:open-list` is the same script an operator runs.
    guard: "index:open-list",
  },
];
