import { BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES, type ReviewEvidenceFile } from "./bootstrap-review-evidence.ts";
import { parseGitHubIdentity } from "./github-write-port.ts";
import type { ProjectManifest } from "../contracts/manifest.ts";
import { sha256 } from "../core/digest.ts";
import { observeApprovedWorkflowChecks, type GitHubClient } from "../github/github-kernel.ts";

export interface ReviewRecordVerification {
  status: "attributed" | "ACP-verified";
  reason: string;
  facts: Array<{ path: string; response: unknown }>;
}
/** Read only public GitHub facts. A CTO's requested head is a lookup target, never a trusted
 * verification contract: required workflows and coverage come from an ACP active manifest.
 * The merged-main gate's helper proves suite -> run -> repository -> exact SHA -> approved file.
 */
export async function verifyReviewGithubEntry(client: GitHubClient, file: ReviewEvidenceFile, manifest: ProjectManifest | null): Promise<ReviewRecordVerification> {
  const attributed = (reason: string): ReviewRecordVerification => ({ status: "attributed", reason, facts: [] });
  const request = file.github;
  if (file.grade !== "github-api-original" || !request) return attributed("ACP did not independently query this original");
  const target = parseGitHubIdentity(request.repositoryIdentity);
  const repository = manifest?.repositories.find(r => r.remote.toLowerCase() === request.repositoryIdentity.toLowerCase());
  if (!/^[a-f0-9]{40}$/.test(request.sha) || !target || target.ref || !repository || !manifest) return attributed("No ACP-approved repository/workflow coverage contract is available");
  const declared = manifest.ciWorkflows.filter(w => w.repositoryRole === repository.role);
  if (declared.some(w => !w.approvedDigest)) return attributed("Actions workflow approval is missing");
  const workflows = declared.map(w => ({ path: w.path, checkName: w.checkName, approvedDigest: w.approvedDigest! }));
  const requiredChecks = [...new Set([...workflows.map(w => w.checkName), ...manifest.postMergeCommands,
    ...manifest.verificationCommands.filter(c => c.repositoryRole === repository.role && c.required && c.evidenceMode !== "LOCAL_COMMAND").map(c => c.id)])];
  if (!workflows.length) return attributed("No ACP-approved Actions workflows are available");
  const root = `/repos/${target.owner}/${target.name}`;
  const facts: ReviewRecordVerification["facts"] = [];
  let factBudgetExceeded = false;
  const budgetRefusal = () => attributed("ACP API facts exceed the 512 KiB review evidence observation bound");
  const withinBudget = () => {
    factBudgetExceeded = Buffer.byteLength(JSON.stringify(facts)) > BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES;
    return !factBudgetExceeded;
  };
  const summarize = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (Array.isArray(v["check_runs"])) return { check_runs: v["check_runs"].map(summarize) };
    if (v["encoding"] === "base64" && typeof v["content"] === "string") return { type: v["type"], encoding: "base64", workflowDigest: sha256(Buffer.from(v["content"].replace(/\s/g, ""), "base64")) };
    const keys = ["id", "number", "full_name", "visibility", "private", "sha", "merged", "merge_commit_sha", "name", "head_sha", "check_suite_id", "status", "conclusion", "path", "details_url"];
    const result: Record<string, unknown> = Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
    for (const key of ["repository", "check_suite", "app", "base", "repo"]) if (v[key]) result[key] = key === "app" ? { slug: (v[key] as { slug?: unknown }).slug } : summarize(v[key]);
    return result;
  };
  const observed: GitHubClient = { async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (method !== "GET") throw new Error("review evidence uses GET only");
    const result = await client.request<T>(method, path, body);
    facts.push({ path, response: summarize(result) });
    if (!withinBudget()) throw new Error("API facts exceed review evidence observation bound");
    return result;
  } };
  try {
    const repo = await observed.request<{ id: number; full_name: string; visibility: string; private?: boolean }>("GET", root);
    if (!Number.isSafeInteger(repo.id) || repo.id < 1 || repo.full_name.toLowerCase() !== `${target.owner}/${target.name}`.toLowerCase()
        || repo.visibility !== "public" || repo.private === true) return attributed("ACP verification requires the exact public repository");
    const pull = await observed.request<{ number: number; merged: boolean; merge_commit_sha: string; base: { repo: { full_name: string } } }>("GET", `${root}/pulls/${request.pullNumber}`);
    if (pull.number !== request.pullNumber || pull.merged !== true || pull.merge_commit_sha !== request.sha
        || pull.base.repo.full_name.toLowerCase() !== repo.full_name.toLowerCase()) return attributed("Merged PR repository or full merge SHA differs");
    const commit = await observed.request<{ sha: string }>("GET", `${root}/git/commits/${request.sha}`);
    if (commit.sha !== request.sha) return attributed("GitHub commit identity differs");
    const checks = await observeApprovedWorkflowChecks(observed, { root, owner: target.owner, repo: target.name,
      head: request.sha, workflows, requiredChecks });
    if (factBudgetExceeded) return budgetRefusal();
    if (checks.state !== "success") return attributed(`Required exact-head Actions provenance/coverage is ${checks.state}`);
    facts.push({ path: "ACP active manifest coverage", response: { repositoryIdentity: request.repositoryIdentity, sha: request.sha, requiredChecks, workflows } });
    if (!withinBudget()) return budgetRefusal();
    return { status: "ACP-verified", reason: "Only the API facts below were independently confirmed; the attached file and bundle remain attributed",
      facts };
  } catch { return factBudgetExceeded ? budgetRefusal() : attributed("ACP could not confirm public GitHub provenance and complete required coverage"); }
}
