import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executablePlanOf } from "../../src/bootstrap/bootstrap-plan.ts";
import { createGitHubApiWritePort } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import type { Target } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";

afterAll(cleanupTempDirs);

/**
 * #1269 — a new project repository allows ordinary merge commits only. GitHub's create defaults allow
 * squash and rebase too, so the create states all three, and genesis reads the repository back and
 * refuses, by field, any value GitHub does not show as asked — the repository is kept, never deleted,
 * created again or PATCHed to match.
 */
const target = { owner: "acme", name: "fixture" };
const STATED = { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false };

describe("#1269 the create request states merge commits only", () => {
  it("sends allow_merge_commit true, allow_squash_merge false, allow_rebase_merge false, and reads them back from GitHub's repository", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const answers: Record<string, unknown> = {
      "GET users/acme": { login: "acme", type: "Organization" },
      "POST orgs/acme/repos": { node_id: "R_kgDOnew", full_name: "acme/fixture", visibility: "public" },
      "GET repos/acme/fixture": { node_id: "R_kgDOnew", full_name: "acme/fixture", visibility: "public", allow_merge_commit: true, allow_squash_merge: true },
    };
    const client: GitHubClient = {
      async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
        calls.push(body === undefined ? { method, path } : { method, path, body });
        const key = `${method} ${path}`;
        if (!(key in answers)) throw acpError(ReasonCode.NOT_FOUND, "Not Found", { status: 404 });
        return answers[key] as T;
      },
    };
    const port = createGitHubApiWritePort({ client });
    await port.createRepository(target, "public", "repo-factory:marker", true);
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject(STATED);
    // A field GitHub's read does not carry is unknown, never the value asked for.
    expect((await port.observeRepository(target))?.mergeMethods).toEqual({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: null });
  });
});

/** The genesis double, reporting these merge methods for the repository it created; a field left out is not sent. */
function reporting(port: GenesisGitHub, reported: Partial<typeof STATED>): GenesisGitHub {
  const observe = port.observeRepository.bind(port);
  (port as { observeRepository: (at: Target) => Promise<unknown> }).observeRepository = async (at) => {
    const observed = await observe(at);
    return observed && {
      ...observed,
      mergeMethods: {
        allow_merge_commit: reported.allow_merge_commit ?? null,
        allow_squash_merge: reported.allow_squash_merge ?? null,
        allow_rebase_merge: reported.allow_rebase_merge ?? null,
      },
    };
  };
  return port;
}

function genesis(reported: Partial<typeof STATED>) {
  const f = genesisPlanFixture();
  const root = tempDir("genesis-merge-methods-");
  const port = reporting(new GenesisGitHub(root), reported);
  const input = {
    plan: executablePlanOf(f.outputs, f.binding.planDigest),
    workDir: join(root, "work"),
    approvedFiles: f.outputs.files,
    github: {
      port,
      authority: {
        owner: "acme",
        visibility: "public" as const,
        approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })),
      },
    },
  };
  return { port, input };
}

describe("#1269 genesis confirms a created repository allows merge commits only", () => {
  it.each([
    ["squash=true", { ...STATED, allow_squash_merge: true }, "allow_squash_merge"],
    ["rebase=true", { ...STATED, allow_rebase_merge: true }, "allow_rebase_merge"],
    ["allow_squash_merge missing", { allow_merge_commit: true, allow_rebase_merge: false }, "allow_squash_merge"],
    ["allow_merge_commit missing", { allow_squash_merge: false, allow_rebase_merge: false }, "allow_merge_commit"],
  ] as const)("a reread with %s is refused naming the field; the repository is kept and nothing else is written", async (_case, reported, field) => {
    const { port, input } = genesis(reported);
    for (const drive of [1, 2]) {
      const decision = await produceRepoFactoryResult(input);
      expect(decision.allowed, `drive ${drive}`).toBe(false);
      if (decision.allowed) return;
      expect(decision.message).toContain(field);
      expect(JSON.stringify(decision.evidence)).toContain(`"fields":["${field}"]`);
      expect(JSON.stringify(decision.evidence)).toContain('"failedOperationId":"create-repository"');
      // Kept, not created again under the same name, and nothing PATCHed or protected after it.
      expect(port.creates, `drive ${drive}`).toBe(1);
      expect(port.repository("acme", "fixture")).toBeDefined();
      expect(port.writes.map((write) => write.method)).toEqual(["createRepository"]);
      expect(port.events).toEqual(["create-repository"]);
    }
  });

  it("the refusal is kept with the pending create: once GitHub later shows the stated values, a retry still refuses and writes nothing more", async () => {
    const reported: Partial<typeof STATED> = { ...STATED, allow_squash_merge: true };
    const { port, input } = genesis(reported);
    const first = await produceRepoFactoryResult(input);
    expect(first.allowed).toBe(false);
    reported.allow_squash_merge = false;
    expect((await port.observeRepository(target))?.mergeMethods).toEqual(STATED);
    const second = await produceRepoFactoryResult(input);
    expect(second.allowed, "drive 2").toBe(false);
    if (second.allowed || first.allowed) return;
    for (const decision of [first, second]) {
      expect(JSON.stringify(decision.evidence)).toContain('"refusal":"MERGE_METHODS_MISMATCH"');
      expect(JSON.stringify(decision.evidence)).toContain('"fields":["allow_squash_merge"]');
    }
    expect(port.creates).toBe(1);
    expect(port.writes.map((write) => write.method)).toEqual(["createRepository"]);
    expect(port.events).toEqual(["create-repository"]);
  });

  it("control: a reread with all three as stated proceeds through genesis", async () => {
    const { port, input } = genesis(STATED);
    const decision = await produceRepoFactoryResult(input);
    expect(decision.allowed, decision.allowed ? "" : decision.message + JSON.stringify(decision.evidence)).toBe(true);
    expect(port.creates).toBe(1);
    expect(port.merges).toBe(1);
  });
});
