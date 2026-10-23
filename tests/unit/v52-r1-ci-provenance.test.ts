import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executablePlanOf } from "../../src/bootstrap/bootstrap-plan.ts";
import { bytesDigest } from "../../src/bootstrap/genesis-bundle.ts";
import { createGitHubApiWritePort } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { type GitHubClient, mergeBootstrapGenesis } from "../../src/github/github-kernel.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { type CiProvenance, GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R1-02 — a successful check of the required name at the genesis head is not evidence that
 * the approved workflow passed: any workflow can report that name. Genesis verification, the genesis
 * merge and the published-head observation accept a check only through the suite -> Actions run ->
 * workflow path -> exact-head digest proof the kernel's own merges use.
 */
const target = { owner: "acme", name: "fixture" };
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const workflowBytes = "name: ci\n";
const workflows = [{ path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: bytesDigest(Buffer.from(workflowBytes)) }];

function scripted(provenance: CiProvenance) {
  const calls: Array<{ method: string; path: string }> = [];
  let merged = false;
  const check = {
    id: 7, name: "test", head_sha: head, status: "completed", conclusion: "success", app: { slug: "github-actions" },
    ...(provenance === "none" ? {} : { check_suite: { id: 9 }, details_url: "https://github.com/acme/fixture/actions/runs/11/job/7" }),
  };
  const client: GitHubClient = {
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string): Promise<T> {
      calls.push({ method, path });
      const p = path.replace(/^\//, "");
      let answer: unknown;
      if (method === "PUT") { merged = true; answer = { merged: true, sha: merge }; }
      else if (p.endsWith("/pulls/1")) answer = { state: merged ? "closed" : "open", merged, merge_commit_sha: merged ? merge : null, head: { ref: "genesis", sha: head, repo: { full_name: "acme/fixture" } }, base: { ref: "main", sha: base } };
      else if (p.endsWith("/protection")) answer = { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ["test"] } };
      else if (p.includes("/check-runs")) answer = { check_runs: [check] };
      else if (p.includes("/check-suites/9")) answer = { head_sha: head, app: { slug: "github-actions" } };
      // The other workflow's run reports the same check name, at the same head, successfully.
      else if (p.includes("/actions/runs/11")) answer = { head_sha: head, path: provenance === "other-workflow" ? ".github/workflows/unapproved.yml" : ".github/workflows/ci.yml", status: "completed", conclusion: "success" };
      else if (p.includes("/contents/")) answer = { type: "file", encoding: "base64", content: Buffer.from(workflowBytes).toString("base64") };
      else if (p.includes("/git/commits/")) answer = { parents: [{ sha: base }, { sha: head }] };
      else if (p.endsWith("/git/ref/heads/main")) answer = { object: { sha: merged ? merge : base } };
      else throw new Error("unexpected " + method + " " + path);
      return answer as T;
    },
  };
  return { calls, client, port: createGitHubApiWritePort({ client }) };
}
const pull = { number: 1, headSha: head, baseSha: base, merged: false, mergeCommitSha: null };

describe("V52-R1-02 genesis CI is accepted only from the approved workflow's own Actions run", () => {
  it("accepts a check whose suite, run, workflow path and workflow bytes are the approved ones", async () => {
    const f = scripted("approved");
    expect(await f.port.observeGenesisCi!(target, head, workflows)).toBe(true);
    await f.port.mergeGenesisPull!(target, pull, workflows);
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("refuses a same-name successful check produced by a different workflow, at verification and at merge", async () => {
    const f = scripted("other-workflow");
    expect(await f.port.observeGenesisCi!(target, head, workflows)).toBe(false);
    await expect(f.port.mergeGenesisPull!(target, pull, workflows)).rejects.toThrow("genesis exact-head CI refused");
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("refuses to send the merge when a same-name check carries no Actions provenance", async () => {
    const f = scripted("none");
    await expect(mergeBootstrapGenesis(f.client, { owner: "acme", repo: "fixture", pullNumber: 1, headSha: head, baseSha: base, workflows })).rejects.toThrow("genesis exact-head CI refused");
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(await f.port.observeGenesisCi!(target, head, workflows)).toBe(false);
  });

  it.each(["other-workflow", "none"] as const)("a genesis whose CI is %s is refused at the PR head and nothing merges or reaches dev", async (provenance) => {
    const f = genesisPlanFixture();
    const root = tempDir("v52-ci-provenance-");
    const port = new GenesisGitHub(root);
    port.ciProvenance = provenance;
    const result = await produceRepoFactoryResult({
      plan: executablePlanOf(f.outputs, f.binding.planDigest),
      workDir: join(root, "work"),
      approvedFiles: f.outputs.files,
      github: { port, authority: { owner: "acme", visibility: "public" as const, approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })) } },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.evidence["refusal"]).toBe("GENESIS_PR_CI_REFUSED");
    expect(port.ciHeads).toEqual([port.pull!.headSha]);
    expect(port.merges).toBe(0);
    expect(await port.observeBranch(target, "dev")).toBeNull();
  });
});
