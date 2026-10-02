import { join } from "node:path";

import { git } from "../../src/git/git.ts";

/**
 * Issue #246 — a GitHub with real git underneath, standing in for `GitHubWritePort`.
 *
 * Each repository it "creates" is a bare repository under `root`, so a push moves a real ref and
 * a commit SHA in a receipt is one a real `git rev-parse` produced. Node ids are minted here,
 * never by a plan, which is what lets a test tell a receipted value from a copied one. Every
 * write is logged in `writes` and every read in `reads`: "writes 0" is only an assertion when
 * something counts them.
 */

export type WriteMethod = "createRepository" | "pushBranch" | "setDefaultBranch" | "protectBranch";

export interface Target {
  owner: string;
  name: string;
}

export interface Protection {
  requiredStatusChecks: string[];
  enforceAdmins: boolean;
  requiredApprovingReviewCount: number | null;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

export interface FakeRepository {
  nodeId: string;
  owner: string;
  name: string;
  visibility: string;
  defaultBranch: string | null;
  bare: string;
  protections: Map<string, Protection>;
}

export class FakeGitHub {
  readonly writes: Array<{ method: WriteMethod; target: string }> = [];
  readonly reads: string[] = [];
  private readonly repositories = new Map<string, FakeRepository>();
  private minted = 0;
  /** Inject one remote failure on the next call of this write method. */
  failNext: WriteMethod | null = null;
  /** GitHub's own spelling of an owner, which need not be the plan's. */
  canonicalOwner: string | null = null;
  /** Simulates a create that lands somewhere other than where it was asked to. */
  createUnderOwner: string | null = null;
  /** Simulates a create whose visibility is not the one requested. */
  createWithVisibility: string | null = null;
  /** GitHub makes the first pushed branch the default; `false` simulates it not doing so. */
  pushSetsDefault = true;

  constructor(private readonly root: string) {}

  private key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  private async mint(owner: string, name: string, visibility: string, prefix: string): Promise<FakeRepository> {
    this.minted += 1;
    const bare = join(this.root, `${prefix}-${this.minted}.git`);
    await git(this.root, ["init", "--bare", "-q", bare]);
    const repository: FakeRepository = {
      nodeId: `${prefix}_kgDO${this.minted}`,
      owner,
      name,
      visibility,
      defaultBranch: null,
      bare,
      protections: new Map(),
    };
    this.repositories.set(this.key(owner, name), repository);
    return repository;
  }

  /** A repository someone else made — exists, and no receipt of ours names it. */
  seedForeign(owner: string, name: string, visibility = "public"): Promise<FakeRepository> {
    return this.mint(owner, name, visibility, "R_foreign");
  }

  /** Delete and recreate under the same name: the name is reused, the node id is not. */
  async replace(owner: string, name: string): Promise<FakeRepository> {
    this.repositories.delete(this.key(owner, name));
    return this.mint(owner, name, "public", "R_replacement");
  }

  repository(owner: string, name: string): FakeRepository | undefined {
    return this.repositories.get(this.key(owner, name));
  }

  private failIfInjected(method: WriteMethod): void {
    if (this.failNext === method) {
      this.failNext = null;
      throw new Error(`HTTP 502 injected on ${method}`);
    }
  }

  private shape(repository: FakeRepository) {
    return {
      nodeId: repository.nodeId,
      fullName: `${repository.owner}/${repository.name}`,
      visibility: repository.visibility,
      defaultBranch: repository.defaultBranch,
    };
  }

  async observeRepository(target: Target) {
    this.reads.push(`repository ${target.owner}/${target.name}`);
    const repository = this.repository(target.owner, target.name);
    return repository ? this.shape(repository) : null;
  }

  async createRepository(target: Target, visibility: string) {
    this.writes.push({ method: "createRepository", target: `${target.owner}/${target.name}` });
    this.failIfInjected("createRepository");
    if (this.repository(target.owner, target.name)) throw new Error("HTTP 422 name already exists on this account");
    const owner = this.createUnderOwner ?? this.canonicalOwner ?? target.owner;
    const created = await this.mint(owner, target.name, this.createWithVisibility ?? visibility, "R");
    return this.shape(created);
  }

  async observeBranch(target: Target, branch: string) {
    this.reads.push(`branch ${target.owner}/${target.name}#${branch}`);
    const repository = this.repository(target.owner, target.name);
    if (!repository) return null;
    const head = await git(repository.bare, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], {
      allowFailure: true,
    });
    return head.exitCode === 0 ? { name: branch, headSha: head.stdout.trim() } : null;
  }

  async pushBranch(target: Target, branch: string, checkoutPath: string, commitSha: string) {
    this.writes.push({ method: "pushBranch", target: `${target.owner}/${target.name}#${branch}` });
    this.failIfInjected("pushBranch");
    const repository = this.repository(target.owner, target.name);
    if (!repository) throw new Error("HTTP 404 repository not found");
    await git(checkoutPath, ["push", "-q", repository.bare, `${commitSha}:refs/heads/${branch}`]);
    // GitHub's own behaviour: the first branch pushed to an empty repository becomes its default.
    if (this.pushSetsDefault && repository.defaultBranch === null) repository.defaultBranch = branch;
  }

  async fetchBranch(target: Target, branch: string, checkoutPath: string) {
    this.reads.push(`fetch ${target.owner}/${target.name}#${branch}`);
    const repository = this.repository(target.owner, target.name);
    if (!repository) throw new Error("HTTP 404 repository not found");
    await git(checkoutPath, ["fetch", "-q", repository.bare, `refs/heads/${branch}`]);
  }

  async setDefaultBranch(target: Target, branch: string) {
    this.writes.push({ method: "setDefaultBranch", target: `${target.owner}/${target.name}` });
    this.failIfInjected("setDefaultBranch");
    const repository = this.repository(target.owner, target.name);
    if (!repository) throw new Error("HTTP 404 repository not found");
    repository.defaultBranch = branch;
  }

  async observeBranchProtection(target: Target, branch: string) {
    this.reads.push(`protection ${target.owner}/${target.name}#${branch}`);
    const stored = this.repository(target.owner, target.name)?.protections.get(branch);
    return stored ? { ...stored, requiredStatusChecks: [...stored.requiredStatusChecks] } : null;
  }

  async protectBranch(target: Target, branch: string, desired: Protection) {
    this.writes.push({ method: "protectBranch", target: `${target.owner}/${target.name}#${branch}` });
    this.failIfInjected("protectBranch");
    const repository = this.repository(target.owner, target.name);
    if (!repository) throw new Error("HTTP 404 repository not found");
    repository.protections.set(branch, { ...desired, requiredStatusChecks: [...desired.requiredStatusChecks] });
  }
}
