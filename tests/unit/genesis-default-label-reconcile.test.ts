import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { currentBootstrapPlan, executablePlanOf, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import type { GenesisBundle } from "../../src/bootstrap/genesis-bundle.ts";
import { createGitHubApiWritePort, genesisLabelConflictOf } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { acpError } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import type { Target } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisBundle } from "../helpers/genesis-github.ts";
import { fixtureManifest } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * run_3884d4fc — GitHub's autoInit adds its default labels, and a genesis label that reuses one of
 * their names (here `enhancement`) with another description stopped every such bootstrap at
 * acp-genesis-labels, reported as REMOTE_REFUSED. On a repository this operation created the label is
 * GitHub's own initialization and is PATCHed to the plan's; anywhere else ACP refuses it by name.
 */
const GITHUB_DEFAULT_LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "documentation", color: "0075ca", description: "Improvements or additions to documentation" },
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "invalid", color: "e4e669", description: "This doesn't seem right" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
];
const ENHANCEMENT = { name: "enhancement", color: "a2eeef", description: "Product development" };
const target = { owner: "acme", name: "fixture" };

type Call = { method: string; path: string; body?: unknown };

/** GitHub's labels, milestones and issues REST surface, in memory; every request is recorded. */
function restModel() {
  const labels: Array<{ name: string; color: string; description: string | null }> = [];
  const milestones: Array<{ number: number; title: string; description: string }> = [];
  const issues: Array<{ title: string; body: string; labels: Array<{ name: string }>; milestone: { number: number } | null }> = [];
  const calls: Call[] = [];
  const rejected: Call[] = [];
  const refuse = { next: null as null | "POST" | "PATCH" };
  const client: GitHubClient = {
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (refuse.next === method) {
        refuse.next = null;
        throw acpError(ReasonCode.INTERNAL_ERROR, `GitHub API ${method} ${path} failed with HTTP 422`, { status: 422, path });
      }
      const value = body as Record<string, unknown>;
      if (path.includes("/labels")) {
        if (method === "GET") return labels.map((l) => ({ ...l })) as T;
        if (method === "POST") {
          // GitHub label names are case-insensitive: a second one differing only in case is already_exists.
          if (labels.some((l) => l.name.toLowerCase() === String(value["name"]).toLowerCase())) {
            rejected.push({ method, path, body });
            throw acpError(ReasonCode.INTERNAL_ERROR, `GitHub API POST ${path} failed with HTTP 422`, { status: 422, path });
          }
          labels.push({ ...(value as (typeof labels)[number]) });
          return value as T;
        }
        const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        const label = labels.find((l) => l.name === name);
        if (!label) throw acpError(ReasonCode.INTERNAL_ERROR, "HTTP 404", { status: 404, path });
        const { new_name: newName, ...rest } = value;
        Object.assign(label, rest, typeof newName === "string" ? { name: newName } : {});
        return { ...label } as T;
      }
      if (path.includes("/milestones")) {
        if (method === "GET") return milestones as T;
        const row = { number: milestones.length + 1, title: String(value["title"]), description: String(value["description"]) };
        milestones.push(row);
        return row as T;
      }
      if (method === "GET") return issues as T;
      const milestone = typeof value["milestone"] === "number" ? { number: value["milestone"] } : null;
      const row = { title: String(value["title"]), body: String(value["body"]), labels: (value["labels"] as string[]).map((name) => ({ name })), milestone };
      issues.push(row);
      return row as T;
    },
  };
  return { labels, milestones, issues, calls, rejected, refuse, client };
}

/** The genesis double, with GitHub's default labels at create and the production port over the REST model. */
class DefaultLabelGitHub extends GenesisGitHub {
  readonly store = restModel();
  private readonly labelPort = createGitHubApiWritePort({ client: this.store.client });

  override async createRepository(t: Target, visibility: string, description?: string, autoInit?: boolean) {
    const created = await super.createRepository(t, visibility, description, autoInit);
    this.store.labels.push(...GITHUB_DEFAULT_LABELS.map((l) => ({ ...l })));
    return created;
  }

  override async ensureGenesisResources(t: Target, b: Pick<GenesisBundle, "labels" | "milestones" | "issues">, options?: { reconcileExistingLabels?: boolean }) {
    this.events.push("resources");
    await this.labelPort.ensureGenesisResources!(t, b, options);
  }

  override async observeGenesisResources(t: Target, b: Pick<GenesisBundle, "labels" | "milestones" | "issues">) {
    return (await this.labelPort.observeGenesisResources!(t, b)) === null ? null : b;
  }

  patches(): Call[] {
    return this.store.calls.filter((c) => c.method === "PATCH");
  }
}

/** The shared genesis fixture, with a genesis label that reuses GitHub's `enhancement`. */
function planWithLabel(label: GenesisBundle["labels"][number]) {
  const base = genesisBundle();
  const genesis: GenesisBundle = {
    ...base,
    labels: [...base.labels, label],
    issues: [{ ...base.issues[0]!, labels: ["ready", label.name] }],
  };
  const manifest = projectManifestSchema.parse(fixtureManifest("resident-test", {
    verificationCommands: [{ id: "test", argv: ["node", "test.js"], repositoryRole: "primary", cwd: ".", timeoutSeconds: 30, envAllowlist: [], network: "deny", networkAllowlist: [], required: true, evidenceMode: "LOCAL_COMMAND", maxOutputBytes: 1048576, maxMemoryMb: 1024, maxCpuSeconds: 30 }],
    verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
    ciWorkflows: [{ repositoryRole: "primary", path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: genesis.files[1]!.sha256, unapprovedFirstActivation: false }],
  }));
  const normalized = planForSubmission({ kind: "PROJECT_BOOTSTRAP", projectId: null }, { summary: "create", bootstrapOperationId: "genesis-op", requestDigest: digestOf("request"), projectManifest: manifest, projectManifestDigest: manifestDigest(manifest), genesis });
  if (!normalized.allowed) throw new Error(normalized.message);
  const current = currentBootstrapPlan("run_genesis", { content: normalized.value, digest: digestOf(normalized.value) });
  if (!current.allowed) throw new Error(current.message);
  return current.value;
}

function produceInput(root: string, port: DefaultLabelGitHub, label: GenesisBundle["labels"][number] = ENHANCEMENT) {
  const f = planWithLabel(label);
  return {
    plan: executablePlanOf(f.outputs, f.binding.planDigest),
    workDir: join(root, "work"),
    approvedFiles: f.outputs.files,
    github: { port, authority: { owner: "acme", visibility: "public" as const, approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })) } },
  };
}

type Ledger = { receipts: Array<{ operationId: string; resourceType: string; preexisting: boolean; observed: unknown }> };

describe("genesis labels that reuse a GitHub default label name", () => {
  it("Witness A: on a repository this operation created, the default enhancement label is PATCHed, read back and receipted", async () => {
    const root = tempDir("genesis-default-label-");
    const port = new DefaultLabelGitHub(root);
    const result = await produceRepoFactoryResult(produceInput(root, port));
    expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
    expect(port.patches()).toEqual([
      { method: "PATCH", path: "repos/acme/fixture/labels/enhancement", body: { new_name: "enhancement", color: ENHANCEMENT.color, description: ENHANCEMENT.description } },
    ]);
    // Only the plan's own new label is created; GitHub's eight other defaults are untouched.
    expect(port.store.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels")).map((c) => (c.body as { name: string }).name)).toEqual(["ready"]);
    expect(port.store.labels.find((l) => l.name === "enhancement")).toEqual(ENHANCEMENT);
    expect(port.store.labels.filter((l) => l.name !== "enhancement" && l.name !== "ready")).toEqual(GITHUB_DEFAULT_LABELS.filter((l) => l.name !== "enhancement"));
    expect(port.store.issues.map((i) => i.labels.map((l) => l.name))).toEqual([["ready", "enhancement"]]);
    const ledger = JSON.parse(readFileSync(join(root, "work/github-ledger/primary.json"), "utf8")) as Ledger;
    const labelsReceipt = ledger.receipts.find((r) => r.operationId === "acp-genesis-labels");
    expect(labelsReceipt?.observed).toMatchObject({ labels: [{ name: "ready" }, ENHANCEMENT] });
  });

  it("Witness B and C: on a repository this operation's receipt does not say it created, the conflict is refused by name with no PATCH, and not as REMOTE_REFUSED", async () => {
    const root = tempDir("genesis-default-label-preexisting-");
    const port = new DefaultLabelGitHub(root);
    const input = produceInput(root, port);
    // Stop the first attempt before any genesis resource step, with the repository receipted.
    port.mergeCiState = "pending";
    const first = await produceRepoFactoryResult(input);
    expect(first.allowed).toBe(false);
    expect(port.store.calls).toHaveLength(0);
    // The repository receipt now says the repository was there before this operation.
    const ledgerPath = join(root, "work/github-ledger/primary.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
    const repository = ledger.receipts.find((r) => r.resourceType === "repository")!;
    expect(repository.preexisting).toBe(false);
    repository.preexisting = true;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    port.mergeCiState = "success";
    const refused = await produceRepoFactoryResult(input);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.evidence["refusal"], JSON.stringify(refused.evidence)).toBe("GENESIS_LABEL_CONFLICT");
    expect(refused.evidence["refusal"]).not.toBe("REMOTE_REFUSED");
    expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
    expect(refused.evidence).toMatchObject({
      failedOperationId: "acp-genesis-labels",
      label: "enhancement",
      observed: { name: "enhancement", color: "a2eeef", description: "New feature or request" },
      desired: { name: "enhancement", color: "a2eeef", description: "Product development" },
      resumable: false,
    });
    expect(port.patches()).toEqual([]);
    expect(port.store.labels.find((l) => l.name === "enhancement")).toEqual(GITHUB_DEFAULT_LABELS[3]);
  });

  it("a label request GitHub itself refuses is still REMOTE_REFUSED", async () => {
    const root = tempDir("genesis-default-label-remote-");
    const port = new DefaultLabelGitHub(root);
    port.store.refuse.next = "PATCH";
    const refused = await produceRepoFactoryResult(produceInput(root, port));
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.evidence).toMatchObject({ refusal: "REMOTE_REFUSED", failedOperationId: "acp-genesis-labels", resumable: true, remote: { status: 422 } });
  });

  it("Witness D: genesis Enhancement against GitHub's default enhancement is renamed by one PATCH, with no POST and no 422", async () => {
    const root = tempDir("genesis-default-label-case-");
    const port = new DefaultLabelGitHub(root);
    const cased = { name: "Enhancement", color: "a2eeef", description: "New feature or request" };
    const result = await produceRepoFactoryResult(produceInput(root, port, cased));
    expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
    expect(port.patches()).toEqual([
      { method: "PATCH", path: "repos/acme/fixture/labels/enhancement", body: { new_name: "Enhancement", color: "a2eeef", description: "New feature or request" } },
    ]);
    expect(port.store.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels")).map((c) => (c.body as { name: string }).name)).toEqual(["ready"]);
    expect(port.store.rejected).toEqual([]);
    expect(port.store.labels.filter((l) => l.name.toLowerCase() === "enhancement")).toEqual([cased]);
    expect(port.store.issues.map((i) => i.labels.map((l) => l.name))).toEqual([["ready", "Enhancement"]]);
    const ledger = JSON.parse(readFileSync(join(root, "work/github-ledger/primary.json"), "utf8")) as Ledger;
    expect(ledger.receipts.find((r) => r.operationId === "acp-genesis-labels")?.observed).toMatchObject({ labels: [{ name: "ready" }, cased] });
  });
});

describe("the production port's genesis label write", () => {
  const bundle = { labels: [ENHANCEMENT, { name: "good first issue", color: "7057ff", description: "Start here" }], milestones: [], issues: [] };

  it("PATCHes a same-named label, its name path-encoded, only when told the repository is this operation's", async () => {
    const rest = restModel();
    rest.labels.push(...GITHUB_DEFAULT_LABELS.map((l) => ({ ...l })));
    const port = createGitHubApiWritePort({ client: rest.client });
    expect(await port.observeGenesisResources!(target, bundle)).toBeNull();
    await port.ensureGenesisResources!(target, bundle, { reconcileExistingLabels: true });
    expect(rest.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "PATCH", path: "repos/acme/fixture/labels/enhancement", body: { new_name: "enhancement", color: "a2eeef", description: "Product development" } },
      { method: "PATCH", path: "repos/acme/fixture/labels/good%20first%20issue", body: { new_name: "good first issue", color: "7057ff", description: "Start here" } },
    ]);
    expect(await port.observeGenesisResources!(target, bundle)).toEqual(bundle);
  });

  it("without that judgement, throws a structured conflict and writes nothing", async () => {
    const rest = restModel();
    rest.labels.push(...GITHUB_DEFAULT_LABELS.map((l) => ({ ...l })));
    const port = createGitHubApiWritePort({ client: rest.client });
    const thrown = await port.ensureGenesisResources!(target, bundle).then(() => null, (error: unknown) => error);
    expect(genesisLabelConflictOf(thrown)).toEqual({
      name: "enhancement",
      observed: { name: "enhancement", color: "a2eeef", description: "New feature or request" },
      desired: { name: "enhancement", color: "a2eeef", description: "Product development" },
    });
    expect(rest.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(genesisLabelConflictOf(new Error("genesis label conflict"))).toBeNull();
  });

  it("without that judgement, a label differing only in case is a conflict naming both spellings, and nothing is written", async () => {
    const rest = restModel();
    rest.labels.push(...GITHUB_DEFAULT_LABELS.map((l) => ({ ...l })));
    const port = createGitHubApiWritePort({ client: rest.client });
    const cased = { labels: [{ name: "Enhancement", color: "a2eeef", description: "New feature or request" }], milestones: [], issues: [] };
    const thrown = await port.ensureGenesisResources!(target, cased).then(() => null, (error: unknown) => error);
    expect(genesisLabelConflictOf(thrown)).toMatchObject({ name: "Enhancement", observed: { name: "enhancement" }, desired: { name: "Enhancement" } });
    expect(rest.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("Witness E: an uppercase hex color equals GitHub's lowercase one in observe and ensure, so nothing is written or refused", async () => {
    const rest = restModel();
    rest.labels.push(...GITHUB_DEFAULT_LABELS.map((l) => ({ ...l })));
    const port = createGitHubApiWritePort({ client: rest.client });
    const upper = { labels: [{ name: "enhancement", color: "A2EEEF", description: "New feature or request" }], milestones: [], issues: [] };
    expect(await port.observeGenesisResources!(target, upper)).toEqual(upper);
    await port.ensureGenesisResources!(target, upper);
    expect(rest.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(await port.observeGenesisResources!(target, upper)).toEqual(upper);
  });
});
