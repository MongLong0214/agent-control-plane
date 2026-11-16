import { frontierReviewPolicy } from "./frontier-simplify-policy.ts";

/**
 * #1421 — how much of one reviewer prompt the attached private review evidence may take.
 *
 * The evidence section is repeated whole in every chunk prompt and in the final prompt, so a bundle whose rendered
 * section leaves no room for the run's other fixed text and for any diff makes `BlindReview.chunkedReview` refuse
 * every review of every candidate of the run, and nothing a resubmission changes can help. The stage and the attach
 * ask the same question here, so that bundle never becomes a review input.
 */

/** The complete reviewer input bound, in characters (blind-review.ts plans chunks against it). */
export const REVIEW_PROMPT_BUDGET_CHARS = 120_000;
/** Room `chunkedReview` reserves for the repository and file fences and the chunk heading around a chunk's diff. */
export const REVIEW_CHUNK_ENVELOPE_CHARS = 4_096;
/**
 * A conservative allowance for the prompt text that is not private evidence and not the diff: the contract, the
 * candidate manifest, the verification report, the instructions and response schema, and the transport separator.
 * It is a constant because no run exists at the stage; `tests/unit/i1421-review-evidence-budget.test.ts` keeps it
 * above what a real review of a plain run measures. The frontier-simplify method itself is added from the text the
 * review sends (`frontierReviewPolicy`).
 */
export const REVIEW_PROMPT_OTHER_ALLOWANCE_CHARS = 24_000;
/** The least diff room a chunk must keep once the evidence and the fixed text are in; below it no change can be reviewed. */
export const REVIEW_MIN_CHUNK_ROOM_CHARS = 8_000;
/** The fixed marker a deny and its BLIND_REVIEW_UNAVAILABLE row carry when the prompt's own metadata leaves no chunk room. */
export const REVIEW_PROMPT_BUDGET_PROBLEM = "REVIEW_PROMPT_BUDGET_EXCEEDED";

/** What the rendered evidence section may be: the budget less the envelope, the fixed text and the least chunk room. */
export const reviewEvidenceLimitChars = (): number =>
  REVIEW_PROMPT_BUDGET_CHARS - REVIEW_CHUNK_ENVELOPE_CHARS - REVIEW_MIN_CHUNK_ROOM_CHARS - REVIEW_PROMPT_OTHER_ALLOWANCE_CHARS - frontierReviewPolicy().length;

/** The characters an evidence section takes in a prompt: every line and its newline, empty lines included (an over-count by design). */
export const renderedSectionChars = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);
