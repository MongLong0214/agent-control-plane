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
 *
 * Failures come in two kinds, because they leave GitHub in two different states. `failNext`
 * refuses *before* the mutation — nothing changed. `failAfter` lets the mutation happen and then
 * loses either the write's own response or the read that follows it — GitHub changed and the
 * caller was not told (PR #1043 review, RF1043-02: a double that only fails before mutating
 * cannot exercise the recovery a real lost response needs).
 *
 * Branch protection is stored as given and returned as stored, whatever its shape, so the double
 * never supplies a field the caller did not send.
 */

export type WriteMethod = "createRepository" | "pushBranch" | "setDefaultBranch" | "protectBranch";

export interface Target {
  owner: string;
  name: string;
}

export interface Protection {
  requiredStatusChecks: { strict: boolean; contexts: string[] } | null;
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
  description: string | null;
  defaultBranch: string | null;
  bare: string;
  protections: Map<string, unknown>;
}

export class FakeGitHub {
  readonly writes: Array<{ method: WriteMethod; target: string }> = [];
  readonly reads: string[] = [];
  private readonly repositories = new Map<string, FakeRepository>();
  private minted = 0;
  /** Inject one remote failure on the next call of this write method, before it mutates. */
  failNext: WriteMethod | null = null;
  /**
   * After the next call of this write method has mutated: `response` throws from the write
   * itself (its answer was lost); `readback` lets it return and throws from the next read.
   */
  failAfter: { method: WriteMethod; mode: "response" | "readback" } | null = null;
  private failNextRead = false;
  /** GitHub's own spelling of an owner, which need not be the plan's. */
  canonicalOwner: string | null = null;
  /** Simulates a create that lands somewhere other than where it was asked to. */
  createUnderOwner: string | null = null;
  /** Simulates a create whose visibility is not the one requested. */
  createWithVisibility: string | null = null;
  /** GitHub makes the first pushed branch the default; `false` simulates it not doing so. */
  pushSetsDefault = true;
  /** Rewrites what protection GitHub keeps, as a server that weakens a request would. */
  keepProtection: ((requested: unknown) => unknown) | null = null;

  constructor(private readonly root: string) {}

  private key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  private async mint(
    owner: string,
    name: string,
    visibility: string,
    prefix: string,
    description: string | null = null,
  ): Promise<FakeRepository> {
    this.minted += 1;
    const bare = join(this.root, `${prefix}-${this.minted}.git`);
    await git(this.root, ["init", "--bare", "-q", bare]);
    const repository: FakeRepository = {
      nodeId: `${prefix}_kgDO${this.minted}`,
      owner,
      name,
      visibility,
      description,
      defaultBranch: null,
      bare,
      protections: new Map(),
    };
    this.repositories.set(this.key(owner, name), repository);
    return repository;
  }

  /** A repository someone else made — exists, and no receipt of ours names it. */
  seedForeign(owner: string, name: string, visibility = "public", description: string | null = null): Promise<FakeRepository> {
    return this.mint(owner, name, visibility, "R_foreign", description);
  }

  /** Delete and recreate under the same name: the name is reused, the node id is not. */
  async replace(owner: string, name: string): Promise<FakeRepository> {
    this.repositories.delete(this.key(owner, name));
    return this.mint(owner, name, "public", "R_replacement");
  }

  /** Delete without recreating: the name is free again. */
  remove(owner: string, name: string): void {
    this.repositories.delete(this.key(owner, name));
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

  /** Called after a write has mutated: loses its response, or arms a failure for the next read. */
  private afterMutation(method: WriteMethod): void {
    if (this.failAfter?.method !== method) return;
    const mode = this.failAfter.mode;
    this.failAfter = null;
    if (mode === "response") throw new Error(`connection reset after ${method} reached GitHub`);
    this.failNextRead = true;
  }

  private read(what: string): void {
    this.reads.push(what);
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error(`HTTP 502 injected on read ${what}`);
    }
  }

  private shape(repository: FakeRepository) {
    return {
      nodeId: repository.nodeId,
      fullName: `${repository.owner}/${repository.name}`,
      visibility: repository.visibility,
      description: repository.description,
      defaultBranch: repository.defaultBranch,
    };
  }

  async observeRepository(target: Target) {
    this.read(`repository ${target.owner}/${target.name}`);
    const repository = this.repository(target.owner, target.name);
    return repository ? this.shape(repository) : null;
  }

  async createRepository(target: Target, visibility: string, description?: string) {
    this.writes.push({ method: "createRepository", target: `${target.owner}/${target.name}` });
    this.failIfInjected("createRepository");
    if (this.repository(target.owner, target.name)) throw new Error("HTTP 422 name already exists on this account");
    const owner = this.createUnderOwner ?? this.canonicalOwner ?? target.owner;
    const created = await this.mint(owner, target.name, this.createWithVisibility ?? visibility, "R", description ?? null);
    this.afterMutation("createRepository");
    return this.shape(created);
  }

  async observeBranch(target: Target, branch: string) {
    this.read(`branch ${target.owner}/${target.name}#${branch}`);
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
    this.afterMutation("pushBranch");
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
    this.afterMutation("setDefaultBranch");
  }

  async observeBranchProtection(target: Target, branch: string) {
    this.read(`protection ${target.owner}/${target.name}#${branch}`);
    const stored = this.repository(target.owner, target.name)?.protections.get(branch);
    return stored === undefined ? null : (structuredClone(stored) as Protection);
  }

  async protectBranch(target: Target, branch: string, desired: unknown) {
    this.writes.push({ method: "protectBranch", target: `${target.owner}/${target.name}#${branch}` });
    this.failIfInjected("protectBranch");
    const repository = this.repository(target.owner, target.name);
    if (!repository) throw new Error("HTTP 404 repository not found");
    const kept = this.keepProtection ? this.keepProtection(structuredClone(desired)) : structuredClone(desired);
    repository.protections.set(branch, kept);
    this.afterMutation("protectBranch");
  }
}
