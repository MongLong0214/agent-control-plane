import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { bytesDigest, type GenesisBundle } from "../../src/bootstrap/genesis-bundle.ts";
import { currentBootstrapPlan, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import type { GenesisPull } from "../../src/bootstrap/github-write-port.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { digestOf } from "../../src/core/digest.ts";
import { git } from "../../src/git/git.ts";
import {
  type ApprovedActionsWorkflow,
  type GitHubClient,
  mergeBootstrapGenesis,
  observeApprovedWorkflowChecks,
} from "../../src/github/github-kernel.ts";
import { FakeGitHub, type Target } from "./fake-github-write-port.ts";
import { tempDir } from "./fixtures.ts";
import { fixtureManifest } from "./harness.ts";

/** One genesis file, with the SHA-256 of its exact bytes. */
export const genesisFile = (path: string, content: string, mode: "100644" | "100755" = "100644") => ({
  path,
  mode,
  contentBase64: Buffer.from(content).toString("base64"),
  sha256: bytesDigest(Buffer.from(content)),
});

export const genesisBundle = (): GenesisBundle => ({
  schema: "acp.genesis-bundle.v1",
  commitMessage: "Create runnable project",
  files: [
    genesisFile("test.js", "const assert=require('node:assert');assert.equal(2+2,4);assert.equal(process.env.ACP_OPERATOR_TOKEN,undefined);assert.equal(process.env.GH_TOKEN,undefined);\n"),
    genesisFile(".github/workflows/ci.yml", "name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n      - run: node test.js\n"),
    genesisFile("bin/check", "#!/bin/sh\nexit 0\n", "100755"),
  ],
  branches: { main: "main", integration: "dev", genesis: "genesis" },
  labels: [{ name: "ready", color: "123abc", description: "ready" }],
  milestones: [{ key: "m1", title: "Develop", description: "first increment" }],
  issues: [{ key: "i1", title: "Implement feature", body: "Keep the owner reference", labels: ["ready"], milestoneKey: "m1" }],
  productIntent: { summary: "An immediately developable product", references: ["https://example.test/design"], ownerInstructions: ["Preserve this intent"] },
});

export function genesisPlanFixture(genesis: GenesisBundle = genesisBundle()) {
  const manifest = projectManifestSchema.parse(fixtureManifest("resident-test", {
    verificationCommands: [{ id: "test", argv: ["node", "test.js"], repositoryRole: "primary", cwd: ".", timeoutSeconds: 30, envAllowlist: [], network: "deny", networkAllowlist: [], required: true, evidenceMode: "LOCAL_COMMAND", maxOutputBytes: 1048576, maxMemoryMb: 1024, maxCpuSeconds: 30 }],
    verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
    ciWorkflows: [{ repositoryRole: "primary", path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: genesis.files[1]!.sha256, unapprovedFirstActivation: false }],
  }));
  const normalized = planForSubmission({ kind: "PROJECT_BOOTSTRAP", projectId: null }, { summary: "create", bootstrapOperationId: "genesis-op", requestDigest: digestOf("request"), projectManifest: manifest, projectManifestDigest: manifestDigest(manifest), genesis });
  if (!normalized.allowed) throw new Error(normalized.message);
  const artifact = { content: normalized.value, digest: digestOf(normalized.value) };
  const current = currentBootstrapPlan("run_genesis", artifact);
  if (!current.allowed) throw new Error(current.message);
  return { genesis, artifact, ...current.value };
}

/** Where an injected failure lands: after the effect (its answer lost) or before it (never sent). */
export type GenesisFault =
  | "create-repository" | "create-repository-readback" | "protect-main" | "push-genesis" | "open-pr" | "verify-ci"
  | "merge-pr" | "create-dev" | "protect-dev" | "set-default-branch" | "resources" | "open-pr-unsent" | "merge-pr-unsent";

/**
 * How the CI checks at a head were produced: by the approved workflow's own Actions run, by a run of
 * a different workflow that reports a check of the same name, or with no Actions suite/run at all.
 */
export type CiProvenance = "approved" | "other-workflow" | "none";

/**
 * A GitHub double for the PR-only genesis: bare repositories hold the commits, and one scripted REST
 * client answers the genesis PR, CI and merge requests the production kernel sends — check runs carry
 * a check suite and an Actions job URL, and the suite, run and workflow file at the exact head are
 * served from the repository itself, so the provenance proof is exercised, not assumed.
 */
export class GenesisGitHub extends FakeGitHub {
  resources: Record<string, unknown> | null = null;
  ciReady = true;
  mergeCiState: "success" | "pending" | "failure" | "cancelled" | "skipped" | "missing" | "wrong-sha" | "wrong-workflow" | "unknown" | "unrelated-run" | "missing-run-suite" = "success";
  mergeCiCheckName: string | null = null;
  ciProvenance: CiProvenance = "approved";
  ciHeads: string[] = [];
  pull: GenesisPull | null = null;
  opens = 0;
  merges = 0;
  creates = 0;
  events: string[] = [];
  marker = "";
  fault: GenesisFault | null = null;
  private readonly suites = new Map<number, { head: string; path: string }>();
  private readbackArmed = false;
  private nextId = 1;

  /** Throws once, at the named point. */
  private lose(at: GenesisFault): void {
    if (this.fault !== at) return;
    this.fault = null;
    throw new Error(`connection reset at ${at}`);
  }

  override async createRepository(target: Target, visibility: string, description?: string, autoInit?: boolean) {
    expect(autoInit).toBe(true);
    this.events.push("create-repository");
    this.creates++;
    await super.createRepository(target, visibility, description);
    const repo = this.repository(target.owner, target.name)!;
    const seed = tempDir("github-autoinit-");
    await git(seed, ["init", "-b", "main"]);
    writeFileSync(join(seed, "README.md"), "# GitHub initialization\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["-c", "user.name=GitHub", "-c", "user.email=github@local", "commit", "-m", "Initial commit"]);
    await git(seed, ["push", repo.bare, "HEAD:refs/heads/main"]);
    repo.defaultBranch = "main";
    const shaped = (await this.observeRepository(target))!;
    this.lose("create-repository");
    // The create is answered; the read of its initialized head that follows is what fails.
    if (this.fault === "create-repository-readback") {
      this.fault = null;
      this.readbackArmed = true;
    }
    return shaped;
  }

  override async observeBranch(target: Target, branch: string) {
    if (this.readbackArmed && branch === "main") {
      this.readbackArmed = false;
      throw new Error("HTTP 502 on the initialized-head read");
    }
    return super.observeBranch(target, branch);
  }

  override async protectBranch(target: Target, branch: string, desired: Parameters<FakeGitHub["protectBranch"]>[2]) {
    this.events.push("protect-" + branch);
    await super.protectBranch(target, branch, desired);
    this.lose(branch === "main" ? "protect-main" : "protect-dev");
  }

  override async pushBranch(target: Target, branch: string, path: string, head: string) {
    expect(branch).toBe("genesis");
    this.events.push("push-genesis-branch");
    await super.pushBranch(target, branch, path, head);
    this.lose("push-genesis");
  }

  override async setDefaultBranch(target: Target, branch: string) {
    this.events.push("set-default-branch");
    await super.setDefaultBranch(target, branch);
    this.lose("set-default-branch");
  }

  async createBranch(target: Target, branch: string, head: string) {
    expect(branch).toBe("dev");
    this.events.push("create-dev");
    await git(this.repository(target.owner, target.name)!.bare, ["update-ref", `refs/heads/${branch}`, head]);
    this.lose("create-dev");
  }

  async ensureGenesisResources(_target: Target, b: Pick<GenesisBundle, "labels" | "milestones" | "issues">) {
    this.events.push("resources");
    this.resources = b;
    this.lose("resources");
  }

  async observeGenesisResources(_target: Target, b: Pick<GenesisBundle, "labels" | "milestones" | "issues">) {
    if (!this.resources) return null;
    return (["labels", "milestones", "issues"] as const).every((key) =>
      b[key].every((x) => (this.resources![key] as unknown[]).some((y) => JSON.stringify(x) === JSON.stringify(y))))
      ? b
      : null;
  }

  /** Through the production observation: every check proven against the approved workflow. */
  async observeGenesisCi(target: Target, head: string, workflows: readonly ApprovedActionsWorkflow[]) {
    this.ciHeads.push(head);
    const checks = await observeApprovedWorkflowChecks(this.rest(target), { root: `/repos/${target.owner}/${target.name}`, owner: target.owner, repo: target.name, head, workflows });
    this.lose("verify-ci");
    return checks.state === "success";
  }

  async observeGenesisPostMergeCi(target: Target, head: string, workflows: readonly ApprovedActionsWorkflow[], requiredChecks: readonly string[]) {
    this.ciHeads.push(head);
    if (this.mergeCiState === "unknown") throw new Error("CI observation unavailable");
    const client = this.rest(target);
    return observeApprovedWorkflowChecks({request: async <T>(method: Parameters<GitHubClient["request"]>[0], path: string, body?: unknown): Promise<T> => {
      const answer = await client.request<T>(method, path, body);
      if (path.includes("/check-runs?")) {
        const result = answer as {check_runs: Array<Record<string, unknown>>};
        if (this.mergeCiState === "missing") result.check_runs = [];
        for (const check of result.check_runs) {
          if (this.mergeCiCheckName !== null && check["name"] !== this.mergeCiCheckName) continue;
          if (this.mergeCiState === "pending") check["status"] = "in_progress";
          if (["failure", "cancelled", "skipped"].includes(this.mergeCiState)) check["conclusion"] = this.mergeCiState;
          if (this.mergeCiState === "wrong-sha") check["head_sha"] = this.pull!.headSha;
        }
      }
      if (path.includes("/actions/runs/") && this.mergeCiState === "unrelated-run") (answer as {check_suite_id:number}).check_suite_id = 19_000;
      if (path.includes("/actions/runs/") && this.mergeCiState === "missing-run-suite") delete (answer as {check_suite_id?:number}).check_suite_id;
      if (path.includes("/actions/runs/") && this.mergeCiState === "wrong-workflow") (answer as {path:string}).path = ".github/workflows/unapproved.yml";
      return answer;
    }}, {root: `/repos/${target.owner}/${target.name}`, owner: target.owner, repo: target.name, head, workflows, requiredChecks});
  }

  async observeGenesisPull(_target: Target, marker: string) {
    if (this.pull) expect(marker).toBe(this.marker);
    return this.pull && { ...this.pull };
  }

  async openGenesisPull(target: Target, marker: string) {
    expect(this.pull).toBeNull();
    this.lose("open-pr-unsent");
    this.marker = marker;
    this.opens++;
    this.events.push("open");
    this.pull = { number: 1, headSha: (await this.observeBranch(target, "genesis"))!.headSha, baseSha: (await this.observeBranch(target, "main"))!.headSha, merged: false, mergeCommitSha: null };
    this.lose("open-pr");
  }

  async mergeGenesisPull(target: Target, pull: GenesisPull, workflows: readonly ApprovedActionsWorkflow[]) {
    if (!pull.merged) this.lose("merge-pr-unsent");
    await mergeBootstrapGenesis(this.rest(target), { owner: target.owner, repo: target.name, pullNumber: pull.number, headSha: pull.headSha, baseSha: pull.baseSha, workflows });
    this.lose("merge-pr");
  }

  /** The REST answers the production kernel reads and writes for the genesis PR. */
  rest(target: Target): GitHubClient {
    const bare = this.repository(target.owner, target.name)!.bare;
    const root = `/repos/${target.owner}/${target.name}`;
    const fileAt = async (head: string, path: string) =>
      (await git(bare, ["show", `${head}:${path}`], { allowFailure: true })).stdout;
    return {
      request: async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
        let answer: unknown;
        const pull = this.pull!;
        if (!path.startsWith(root)) throw new Error("unexpected repository " + path);
        const rest = path.slice(root.length);
        if (method === "PUT") {
          expect(rest).toBe("/pulls/1/merge");
          expect(body).toEqual({ sha: pull.headSha, merge_method: "merge" });
          const tree = (await git(bare, ["rev-parse", pull.headSha + "^{tree}"])).stdout.trim();
          const sha = (await git(bare, ["-c", "user.name=GitHub", "-c", "user.email=github@local", "commit-tree", tree, "-p", pull.baseSha, "-p", pull.headSha, "-m", "Merge genesis PR"])).stdout.trim();
          await git(bare, ["update-ref", "refs/heads/main", sha, pull.baseSha]);
          this.pull = { ...pull, merged: true, mergeCommitSha: sha };
          this.merges++;
          this.events.push("merge");
          answer = { merged: true, sha };
        } else if (method !== "GET") {
          throw new Error("unexpected kernel request " + method + " " + path);
        } else if (rest === "/pulls/1") {
          answer = { state: pull.merged ? "closed" : "open", merged: pull.merged, head: { ref: "genesis", sha: pull.headSha, repo: { full_name: `${target.owner}/${target.name}` } }, base: { ref: "main", sha: pull.baseSha }, merge_commit_sha: pull.mergeCommitSha };
        } else if (rest === "/branches/main/protection") {
          const p = await this.observeBranchProtection(target, "main");
          answer = { allow_force_pushes: { enabled: p!.allowForcePushes }, allow_deletions: { enabled: p!.allowDeletions }, enforce_admins: { enabled: p!.enforceAdmins }, required_status_checks: p!.requiredStatusChecks };
        } else if (/^\/commits\/[0-9a-f]{40}\/check-runs\?/.test(rest)) {
          const head = rest.split("/")[2]!;
          const name = new URLSearchParams(rest.split("?")[1]).get("check_name");
          const workflow = ".github/workflows/ci.yml";
          const id = this.nextId++;
          const runPath = this.ciProvenance === "other-workflow" ? ".github/workflows/unapproved.yml" : workflow;
          this.suites.set(id, { head, path: runPath });
          answer = { check_runs: [{
            id, name, head_sha: head, status: "completed", conclusion: this.ciReady ? "success" : "failure", app: { slug: "github-actions" },
            ...(this.ciProvenance === "none" ? {} : { check_suite: { id }, details_url: `https://github.com/${target.owner}/${target.name}/actions/runs/${id}/job/${id}` }),
          }] };
        } else if (/^\/check-suites\/\d+$/.test(rest)) {
          answer = { id:Number(rest.split("/")[2]), repository:{id:42,full_name:`${target.owner}/${target.name}`}, head_sha: this.suites.get(Number(rest.split("/")[2]))!.head, app: { slug: "github-actions" } };
        } else if (/^\/actions\/runs\/\d+$/.test(rest)) {
          const run = this.suites.get(Number(rest.split("/")[3]))!;
          answer = { id:Number(rest.split("/")[3]), repository:{id:42,full_name:`${target.owner}/${target.name}`}, check_suite_id:Number(rest.split("/")[3]), head_sha: run.head, path: run.path, status: "completed", conclusion: "success" };
        } else if (rest.startsWith("/contents/")) {
          const [file, query] = rest.slice("/contents/".length).split("?");
          const head = new URLSearchParams(query).get("ref")!;
          answer = { type: "file", encoding: "base64", content: Buffer.from(await fileAt(head, decodeURIComponent(file!))).toString("base64") };
        } else if (rest === "/git/ref/heads/main") {
          answer = { object: { sha: (await this.observeBranch(target, "main"))!.headSha } };
        } else if (rest.startsWith("/git/commits/")) {
          const parents = (await git(bare, ["rev-list", "--max-count=1", "--parents", rest.split("/").at(-1)!])).stdout.trim().split(/\s+/).slice(1);
          answer = { parents: parents.map((sha) => ({ sha })) };
        } else {
          throw new Error("unexpected kernel request " + method + " " + path);
        }
        return answer as T;
      },
    };
  }
}
