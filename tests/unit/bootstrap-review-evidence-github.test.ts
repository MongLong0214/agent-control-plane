import { describe, expect, it } from "vitest";
import { verifyReviewGithubEntry } from "../../src/bootstrap/bootstrap-review-evidence-github.ts";
import type { ReviewEvidenceFile } from "../../src/bootstrap/bootstrap-review-evidence.ts";
import { sha256 } from "../../src/core/digest.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { fixtureManifest } from "../helpers/harness.ts";

const head = "a".repeat(40);
const workflow = "name: verified-ci\n";
const original = '{"conclusion":"success"}\n';
const entry: ReviewEvidenceFile = { path: "ci.json", origin: "gh api", grade: "github-api-original", sha256: sha256(original),
  bodyBase64: Buffer.from(original).toString("base64"), github: { repositoryIdentity: "github:acme/fixture", pullNumber: 59, sha: head } };
const manifest = fixtureManifest("approved", {
  ciWorkflows: [{ repositoryRole: "primary", path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: sha256(workflow), unapprovedFirstActivation: false }],
  postMergeCommands: ["acceptance"],
});
const client = (fault = "") => {
  const calls: string[] = [];
  const repository = { id: 4, full_name: "acme/fixture" };
  const api: GitHubClient = { async request<T>(method: string, path: string): Promise<T> {
    expect(method).toBe("GET"); calls.push(path);
    let result: unknown;
    if (path === "/repos/acme/fixture") result = { ...repository, visibility: fault === "private" ? "private" : "public", private: fault === "private" };
    else if (path.includes("/pulls/")) result = { number: 59, merged: fault !== "unmerged", merge_commit_sha: fault === "wrong merge" ? "b".repeat(40) : head, base: { repo: repository } };
    else if (path.includes("/git/commits/")) result = { sha: head };
    else if (path.includes("/check-runs?")) {
      const name = new URL("https://example.test" + path).searchParams.get("check_name")!;
      result = { check_runs: name === "acceptance" && fault === "missing coverage" ? [] : [{ id: 41, name, head_sha: fault === "wrong head" ? "b".repeat(40) : head,
        status: "completed", conclusion: fault === "failed" ? "failure" : "success", app: { slug: "github-actions" }, check_suite: { id: 51 },
        details_url: "https://github.com/acme/fixture/actions/runs/61/job/41" }] };
    } else if (path.includes("/check-suites/")) result = { id: 51, repository, head_sha: head, app: { slug: "github-actions" } };
    else if (path.includes("/actions/runs/")) result = { id: 61, repository: fault === "foreign repository" ? { id: 5, full_name: "other/repo" } : repository,
      check_suite_id: fault === "unrelated suite" ? 52 : 51, head_sha: head, path: fault === "wrong workflow" ? ".github/workflows/other.yml" : ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
    else if (path.includes("/contents/")) result = { type: "file", encoding: "base64", content: Buffer.from(fault === "unapproved bytes" ? "other bytes" : workflow).toString("base64") };
    else throw new Error("unexpected API path " + path);
    return result as T;
  } };
  return { api, calls };
};

describe("private review GitHub originals earn verification only for queried facts", () => {
  it("confirms public repository, full merge SHA, required coverage and Actions suite/run/workflow provenance", async () => {
    const f = client();
    const result = await verifyReviewGithubEntry(f.api, entry, manifest);
    expect(result.status).toBe("ACP-verified");
    expect(result.reason).toContain("bundle remain attributed");
    expect(result.facts).toContainEqual({ path: "ACP active manifest coverage", response: expect.objectContaining({ sha: head, requiredChecks: ["test", "acceptance"] }) });
    expect(f.calls.some(p => p.includes("check_name=acceptance"))).toBe(true);
    expect(result.facts.some(f => f.path.includes("/check-suites/51"))).toBe(true);
    expect(result.facts.some(f => f.path.includes("/actions/runs/61"))).toBe(true);
    expect(result.facts.some(f => f.path.includes("/contents/"))).toBe(true);
  });
  it.each(["private", "unmerged", "wrong merge", "missing coverage", "wrong head", "failed", "foreign repository", "unrelated suite", "wrong workflow", "unapproved bytes"])(
    "leaves %s attributed", async fault => {
      const f = client(fault);
      expect((await verifyReviewGithubEntry(f.api, entry, manifest)).status).toBe("attributed");
      if (fault === "private") expect(f.calls).toHaveLength(1);
    });
  it("never treats a bare success string, author contract or non-GitHub original as verified", async () => {
    const f = client();
    expect((await verifyReviewGithubEntry(f.api, entry, null)).status).toBe("attributed");
    expect((await verifyReviewGithubEntry(f.api, { ...entry, grade: "execution-log" }, manifest)).status).toBe("attributed");
    expect((await verifyReviewGithubEntry(f.api, { ...entry, github: { ...entry.github!, sha: "aaaa" } }, manifest)).status).toBe("attributed");
    expect(f.calls).toEqual([]);
  });
});
