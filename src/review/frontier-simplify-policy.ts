import { readFileSync } from "node:fs";

/** Identifies the owner's canonical text; not an approval or synchronization check. */
export const FRONTIER_SIMPLIFY_DIGEST = "sha256:0d788506f84b87b92294db38263dacd7334880d72f4ddc0fb28b04750d50a0e4";
const method = readFileSync(new URL("./frontier-simplify.md", import.meta.url), "utf8");

/** All ACP reviews use the original method verbatim. There are no rubric overrides. */
export function frontierReviewPolicy(...overrides: never[]): string {
  if (overrides.length > 0) throw new TypeError("Review policy does not accept overrides");
  return "Every ACP review, including CEO and CTO reviews, uses frontier-simplify below as its only methodology.\n\n" + method;
}
