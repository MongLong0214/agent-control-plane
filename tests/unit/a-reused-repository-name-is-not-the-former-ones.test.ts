import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { Db } from "../../src/db/database.ts";
import { identityChain, repositoryIdentities, repositoryNameSpans } from "../../src/registry/repository-identity-chain.ts";
import { RepositoryRenames } from "../../src/registry/repository-rename.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * v61 — GitHub frees a repository's old name when it is renamed, and another repository may take it. Repository A
 * is renamed `acme/x` to `acme/y` at T1, then a different repository B is created as `acme/x` at T2. A row that
 * carries `github:acme/x` is A's when it was written before T1 and B's when it was written after T2: the name
 * alone says neither. Each case is a database of its own, with the rows written directly.
 */
const X = "github:acme/x";
const Y = "github:acme/y";
const T0 = "2026-11-20T00:00:00.000Z";
const T1 = "2026-11-21T00:00:00.000Z";
const T2 = "2026-11-22T00:00:00.000Z";
const BEFORE_T1 = "2026-11-20T12:00:00.000Z";
const AFTER_T2 = "2026-11-23T00:00:00.000Z";

const manifest = (remote: string): string =>
  JSON.stringify({ schema: "x", projectId: "pa", repositories: [{ role: "primary", remote, manifestRoot: "." }], ciWorkflows: [] });

const world = () => {
  const path = join(tempDir("acp-reused-name-"), "state.sqlite");
  new Db(path).close();
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  const run = (sql: string, ...values: unknown[]) => raw.prepare(sql).run(...values);
  for (const [digest, remote] of [["sha256:ma1", X], ["sha256:ma2", Y]] as const) {
    run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, 'x', ?, ?)`, digest, manifest(remote), T0);
  }
  run(`INSERT INTO projects (project_id, name, active_manifest_digest, created_at) VALUES ('pa', 'pa', 'sha256:ma1', ?)`, T0);
  run(`INSERT INTO projects (project_id, name, created_at) VALUES ('pb', 'pb', ?)`, T0);
  run(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_a', ?, '/tmp/acp-reuse-a', 'pa', 'primary', ?)`, X, T0);
  // A is renamed at T1: the rename row, the manifest pointer, the repository's name.
  run(`INSERT INTO repository_identity_renames (rename_id, repository_id, project_id, sequence, from_identity, to_identity, repository_node_id,
         from_manifest_digest, to_manifest_digest, renamed_at) VALUES ('ren_a', 'repo_a', 'pa', 1, ?, ?, 'R_node_a', 'sha256:ma1', 'sha256:ma2', ?)`, X, Y, T1);
  run(`UPDATE projects SET active_manifest_digest = 'sha256:ma2' WHERE project_id = 'pa'`);
  run(`UPDATE repositories SET identity = ? WHERE repository_id = 'repo_a'`, Y);
  // B takes the freed name at T2.
  run(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_b', ?, '/tmp/acp-reuse-b', 'pb', 'primary', ?)`, X, T2);
  const claim = (id: string, at: string, identity = X) => {
    // Foreign keys are off: the claim's run and session rows are not what is read.
    run(`INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id, owner_session_id, owner_binding_generation, acquired_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, 1, ?, '2999-01-01T00:00:00.000Z', 'HELD')`, id, identity, `wt-${id}`, `run_${id}`, `ses_${id}`, at);
  };
  const receipt = (id: string, at: string, identity = X) => run(
    `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
       preexisting, request_digest, response_json, created_at, verified, status)
     VALUES (?, ?, 'merge_execute', NULL, ?, 'merge', 'acme/x#1', 0, 'sha256:r', '{"pending":true}', ?, 0, 'PENDING')`, id, `merge_execute:${id}`, identity, at);
  const db = new Db(path);
  const renames = new RepositoryRenames({
    db, clock: new ManualClock(), audit: undefined as never, github: { observeRepository: async () => null },
  });
  const row = (repositoryId: string, identity: string) => ({ repository_id: repositoryId, identity, checkout_path: `/tmp/${repositoryId}`, observed_remote_url: null });
  // busy() answers null when the repository has no work in flight, else the refusal naming it.
  const busyOf = (repositoryId: string, identity: string, project: string) => {
    const answer = (renames as unknown as { busy(project: string, repository: ReturnType<typeof row>): { allowed: boolean; evidence: Record<string, unknown> } | null })
      .busy(project, row(repositoryId, identity));
    return answer === null ? { claims: [], receipts: [] } : { claims: answer.evidence["claims"], receipts: answer.evidence["receipts"] };
  };
  return { db, claim, receipt, busyOf, raw: run };
};

describe("v61 — a name another repository took after a rename is not the renamed repository's by its text", () => {
  it("knows each repository's names by the time it held them", () => {
    const w = world();
    expect(repositoryNameSpans(w.db, "repo_a", Y)).toEqual([{ identity: X, from: null, until: T1 }, { identity: Y, from: null, until: null }]);
    expect(repositoryNameSpans(w.db, "repo_b", X)).toEqual([{ identity: X, from: T1, until: null }]);
    expect(repositoryIdentities(w.db, "repo_a", Y)).toEqual([Y]);
    expect(repositoryIdentities(w.db, "repo_b", X)).toEqual([X]);
  });

  it("busy(): A's claims and receipts under the reused name are A's, B's are B's, and neither counts the other's", () => {
    const w = world();
    w.claim("clm_a", BEFORE_T1);
    w.receipt("rcp_a", BEFORE_T1);
    w.claim("clm_b", AFTER_T2);
    w.receipt("rcp_b", AFTER_T2);
    expect(w.busyOf("repo_a", Y, "pa")).toEqual({ claims: ["clm_a"], receipts: ["rcp_a"] });
    expect(w.busyOf("repo_b", X, "pb")).toEqual({ claims: ["clm_b"], receipts: ["rcp_b"] });
  });

  it("busy(): B's unfinished work alone leaves A free, and A's alone leaves B free", () => {
    const onlyB = world();
    onlyB.claim("clm_b", AFTER_T2);
    onlyB.receipt("rcp_b", AFTER_T2);
    expect(onlyB.busyOf("repo_a", Y, "pa")).toEqual({ claims: [], receipts: [] });
    const onlyA = world();
    onlyA.claim("clm_a", BEFORE_T1);
    onlyA.receipt("rcp_a", BEFORE_T1);
    expect(onlyA.busyOf("repo_b", X, "pb")).toEqual({ claims: [], receipts: [] });
  });

  it("busy(): a repository's own earlier name still counts when no one else took it", () => {
    const w = world();
    w.raw(`DELETE FROM repositories WHERE repository_id = 'repo_b'`);
    w.claim("clm_a", BEFORE_T1);
    w.claim("clm_late", AFTER_T2);
    expect(w.busyOf("repo_a", Y, "pa").claims).toEqual(["clm_a", "clm_late"]);
  });

  it("identityChain(): A's past receipt resolves to A, B's to B, and a name with no time to the repository holding it now", () => {
    const w = world();
    expect(identityChain(w.db, X, BEFORE_T1)).toEqual([Y, X]);
    expect(identityChain(w.db, X, AFTER_T2)).toEqual([X]);
    expect(identityChain(w.db, X)).toEqual([X]);
    expect(identityChain(w.db, Y)).toEqual([Y]);
  });
});
