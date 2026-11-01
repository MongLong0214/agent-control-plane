import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Identifies the owner's canonical text; not an approval or synchronization check. */
export const FRONTIER_SIMPLIFY_DIGEST = "sha256:0d788506f84b87b92294db38263dacd7334880d72f4ddc0fb28b04750d50a0e4";

/**
 * Where the vendored method came from (#1270): the upstream file at this revision has exactly these
 * bytes. A new snapshot ships as a code change that updates the file, its digest and this revision together.
 */
export const FRONTIER_SIMPLIFY_SOURCE = Object.freeze({
  repository: "github.com/MongLong0214/frontier-simplify",
  revision: "96b07ad17e90fd4e69e1a7748641d7f30c06fcf0",
  path: "skills/frontier-simplify/SKILL.md",
  digest: FRONTIER_SIMPLIFY_DIGEST,
});
export type FrontierSimplifySource = { -readonly [K in keyof typeof FRONTIER_SIMPLIFY_SOURCE]: string };

/**
 * Whether a stored review packet records that its reviewers were given this method. A PASS that records
 * none, or another source, predates the method's delivery check; CONFIRM, merge and activation read it as
 * stale and the candidate needs a fresh review. The stored packet itself is never changed.
 */
export const METHOD_REVIEW_STALE = "the blind review does not record the current frontier-simplify method; the candidate needs a fresh review";
export const reviewedUnderCurrentMethod = (packet: unknown): boolean => {
  const methodology = (packet as { inputManifest?: { methodology?: Record<string, unknown> } } | null)?.inputManifest?.methodology;
  return methodology != null && Object.entries(FRONTIER_SIMPLIFY_SOURCE).every(([key, value]) => methodology[key] === value);
};

// The shipped asset must be the vendored bytes: a missing or altered file stops every consumer at load
// rather than handing any of them a different method under this source's name.
const method = readFileSync(new URL("./frontier-simplify.md", import.meta.url), "utf8");
if (`sha256:${createHash("sha256").update(method, "utf8").digest("hex")}` !== FRONTIER_SIMPLIFY_DIGEST) {
  throw new Error(`frontier-simplify.md is not ${FRONTIER_SIMPLIFY_SOURCE.path} at ${FRONTIER_SIMPLIFY_SOURCE.revision}`);
}

/** Design, planning and every ACP review use the original method verbatim. There are no rubric overrides. */
export function frontierReviewPolicy(...overrides: never[]): string {
  if (overrides.length > 0) throw new TypeError("Review policy does not accept overrides");
  const { repository, revision, path, digest } = FRONTIER_SIMPLIFY_SOURCE;
  return "ACP design, planning and implementation decisions, and every ACP review including CEO and CTO reviews, " +
    "use frontier-simplify below as their only methodology.\n" +
    `Source: ${repository} at revision ${revision}, file ${path}, ${digest}.\n\n` + method;
}
