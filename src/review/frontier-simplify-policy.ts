import { readFileSync } from "node:fs";

/** Identifies the owner's canonical text; not an approval or synchronization check. */
export const FRONTIER_SIMPLIFY_DIGEST = "sha256:4f7ee0fa67e31ccb52c5ecffbd3cb0e06377ab62721bcec8fdeb1e229971f7cb";
const method = readFileSync(new URL("./frontier-simplify-review.md", import.meta.url), "utf8");

/** The existing JSON envelope's correspondence to canonical recommendations. */
export const FRONTIER_VERDICT_TRANSPORT =
  "Transport verdict PASS represents canonical PASS or PASS WITH NITS. " +
  "NITs go in findings with severity MINOR, with prose and stable IDs in detail. " +
  "Transport verdict REVISE represents canonical INCOMPLETE, or canonical BLOCK with a confirmed blocker that can be repaired. " +
  "Transport verdict BLOCK corresponds to canonical BLOCK and retains ACP's existing REVIEW_BLOCK outcome: revision is required and CEO-ready progression is prevented.";

export interface FrontierReviewInput {
  repository: string;
  base: string;
  head: string;
  attempt: number;
  requirements: string;
  fullSuiteStatus: string;
  toolNotes: string;
  preserved?: {
    head: string;
    digest: string;
    integrity: string;
  };
}

/** All ACP review instructions come from this method. There is no rubric override. */
export function frontierReviewPolicy(input?: FrontierReviewInput): string {
  if (input === undefined) return "Every ACP review, including CEO and CTO reviews, uses frontier-simplify below as its only methodology.\n\n" + method;
  const keys = new Set(["repository", "base", "head", "attempt", "requirements", "fullSuiteStatus", "toolNotes", "preserved"]);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new TypeError(`Unsupported review policy input: ${key}`);
  }
  const round = input.preserved === undefined ? 1 : 2;
  const template = method.split(`## Round ${round} prompt\n\n\`\`\`text\n`)[1]!.split("\n```")[0]!;
  const values: Record<string, string> = {
    ATTEMPT_NUMBER: String(input.attempt), MAX_ROUNDS: "3",
    REPOSITORY: input.repository, BASE_SHA: input.base,
    ROUND1_HEAD_SHA: input.preserved?.head ?? input.head, ROUND2_HEAD_SHA: input.head,
    REQUIREMENT_SOURCES_OR_NONE: input.requirements,
    KNOWN_ROUTED_OR_NONE: "none", PROJECT_CLASS_CATALOG_OR_NONE: "none",
    FULL_SUITE_STATUS_OR_UNKNOWN: input.fullSuiteStatus, TOOL_NOTES_OR_NONE: input.toolNotes,
    TRUSTED_INVENTORY_SHA256: input.preserved?.digest ?? "none",
    INVENTORY_INTEGRITY_RESULT: input.preserved?.integrity ?? "not applicable",
  };
  // Only placeholders are filled. Neither the portable questions nor the round text is rewritten.
  const prompt = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => values[key]!);
  return [
    method.split("## Round 1 prompt")[0]!,
    method.split("## Between rounds\n")[1]!.split("## Round 2 prompt")[0]!,
    method.split("## Runner and limits\n")[1]!,
    `## Round ${round} prompt`, prompt,
  ].join("\n\n");
}
