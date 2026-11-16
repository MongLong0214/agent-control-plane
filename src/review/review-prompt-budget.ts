/**
 * #1421 — how much of one reviewer prompt the attached private review evidence may take.
 *
 * The evidence section is repeated whole in every chunk prompt and in the final prompt, so a bundle whose section
 * leaves `BlindReview.chunkedReview` no chunk budget makes it refuse every review of every candidate of the run, and
 * nothing a resubmission changes can help. The stage and the attach ask the question the review asks, of the review's
 * own sizing of the run's prompt (`BlindReviewGate.privateEvidencePromptProbe`), never of a constant.
 */

/** The complete reviewer input bound, in characters (blind-review.ts plans chunks against it). */
export const REVIEW_PROMPT_BUDGET_CHARS = 120_000;
/** Room `chunkedReview` reserves for the repository and file fences and the chunk heading around a chunk's diff. */
export const REVIEW_CHUNK_ENVELOPE_CHARS = 4_096;
/** The fixed marker a deny and its BLIND_REVIEW_UNAVAILABLE row carry when the prompt's own metadata leaves no chunk budget. */
export const REVIEW_PROMPT_BUDGET_PROBLEM = "REVIEW_PROMPT_BUDGET_EXCEEDED";

/** What the review would do with one evidence section in a run's prompt (`BlindReviewGate.privateEvidencePromptProbe`). */
export interface ReviewPromptCheck {
  /** The review would refuse every review of the run for want of a chunk budget. */
  refused: boolean;
  /** The prompt metadata as `chunkedReview` counts it, this section in it. */
  overhead: number;
  /** The fewest characters the section must lose to leave a chunk budget; at least 1. */
  reduceBy: number;
}
/**
 * `CANDIDATE` is the review's own sizing run on the run's current candidate; `CONTRACT` is the fixed prompt around the
 * run's pinned contract when no candidate can be read, a lower bound that refuses only what no review could take.
 */
export interface ReviewPromptProbe { basis: "CANDIDATE" | "CONTRACT"; check(section: readonly string[]): ReviewPromptCheck }

/** The room left for one chunk's diff, exactly as `chunkedReview` computes it; at or below zero the review refuses. */
export const chunkBudgetChars = (overhead: number): number => REVIEW_PROMPT_BUDGET_CHARS - overhead - REVIEW_CHUNK_ENVELOPE_CHARS;

/**
 * The characters an evidence section adds to a prompt. A prompt is its non-empty lines joined by one newline, so each
 * non-empty line adds its length and one newline, and an empty line adds nothing: the addition is exact.
 */
export const renderedSectionChars = (lines: readonly string[]): number =>
  lines.reduce((sum, line) => sum + (line.length === 0 ? 0 : line.length + 1), 0);

/**
 * Whether a denial's evidence is the review's own prompt-budget refusal: the fixed marker, and counts that by
 * themselves leave no chunk budget under the review's bound. A marker without such counts is no proof that the same
 * input is refused again, so nothing is exempted by it.
 */
export const isPromptBudgetRefusal = (evidence: Record<string, unknown> | null | undefined): evidence is { problem: string; overhead: number; budget: number } => {
  const overhead = evidence?.["overhead"];
  const budget = evidence?.["budget"];
  return evidence?.["problem"] === REVIEW_PROMPT_BUDGET_PROBLEM && typeof overhead === "number" && Number.isSafeInteger(overhead) && overhead >= 0
    && budget === REVIEW_PROMPT_BUDGET_CHARS && chunkBudgetChars(overhead) <= 0;
};
