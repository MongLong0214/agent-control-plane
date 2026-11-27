import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { Db } from "../../src/db/database.ts";
import { identityChain, repositoryHeldIdentities, repositoryIdentities, repositoryNameSpans } from "../../src/registry/repository-identity-chain.ts";
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
const T3 = "2026-11-24T00:00:00.000Z";
const T4 = "2026-11-26T00:00:00.000Z";
const T5 = "2026-11-27T00:00:00.000Z";
const BEFORE_T1 = "2026-11-20T12:00:00.000Z";
const AFTER_T2 = "2026-11-23T00:00:00.000Z";
const AFTER_T4 = "2026-11-26T12:00:00.000Z";
const AFTER_T5 = "2026-11-28T00:00:00.000Z";
const Z = "github:acme/z";

const manifest = (projectId: string, remote: string): string =>
  JSON.stringify({ schema: "x", projectId, repositories: [{ role: "primary", remote, manifestRoot: "." }], ciWorkflows: [] });

/**
 * What happens after A (x to y at T1) and B (created as x at T2): `bLeaves` is B renamed x to z at T3; `aReturns` is
 * then A renamed y back to x at T4 (A to y to x, with B in between); `cTakes` is a third repository C created as x at
 * T5 once B left. Without an option the world stops at B holding x.
 */
const world = (after: { bLeaves?: boolean; aReturns?: boolean; cTakes?: boolean } = {}) => {
  const path = join(tempDir("acp-reused-name-"), "state.sqlite");
  new Db(path).close();
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  const run = (sql: string, ...values: unknown[]) => raw.prepare(sql).run(...values);
  for (const [digest, project, remote] of [["sha256:ma1", "pa", X], ["sha256:ma2", "pa", Y], ["sha256:mb1", "pb", X], ["sha256:mb2", "pb", Z]] as const) {
    run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, 'x', ?, ?)`, digest, manifest(project, remote), T0);
  }
  run(`INSERT INTO projects (project_id, name, active_manifest_digest, created_at) VALUES ('pa', 'pa', 'sha256:ma1', ?)`, T0);
  run(`INSERT INTO projects (project_id, name, active_manifest_digest, created_at) VALUES ('pb', 'pb', 'sha256:mb1', ?)`, T0);
  run(`INSERT INTO projects (project_id, name, created_at) VALUES ('pc', 'pc', ?)`, T0);
  run(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_a', ?, '/tmp/acp-reuse-a', 'pa', 'primary', ?)`, X, T0);
  const renamed = (id: string, repository: string, project: string, sequence: number, from: string, to: string, fromDigest: string, toDigest: string, at: string) => {
    run(`INSERT INTO repository_identity_renames (rename_id, repository_id, project_id, sequence, from_identity, to_identity, repository_node_id,
           from_manifest_digest, to_manifest_digest, renamed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, repository, project, sequence, from, to, `R_node_${repository}`, fromDigest, toDigest, at);
    run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, toDigest, project);
    run(`UPDATE repositories SET identity = ? WHERE repository_id = ?`, to, repository);
  };
  // A is renamed at T1; B takes the freed name at T2.
  renamed("ren_a", "repo_a", "pa", 1, X, Y, "sha256:ma1", "sha256:ma2", T1);
  run(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_b', ?, '/tmp/acp-reuse-b', 'pb', 'primary', ?)`, X, T2);
  if (after.bLeaves === true || after.aReturns === true || after.cTakes === true) renamed("ren_b", "repo_b", "pb", 1, X, Z, "sha256:mb1", "sha256:mb2", T3);
  // A renamed back to the name B left: the rename restores the manifest A had, byte for byte.
  if (after.aReturns === true) renamed("ren_a2", "repo_a", "pa", 2, Y, X, "sha256:ma2", "sha256:ma1", T4);
  if (after.cTakes === true) run(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_c', ?, '/tmp/acp-reuse-c', 'pc', 'primary', ?)`, X, T5);
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
    // By its text alone a repository owns only the names no one else held; its held names are all of them.
    expect(repositoryIdentities(w.db, "repo_a", Y)).toEqual([Y]);
    expect(repositoryIdentities(w.db, "repo_b", X)).toEqual([X]);
    expect(repositoryHeldIdentities(w.db, "repo_a", Y)).toEqual([Y, X]);
    expect(repositoryHeldIdentities(w.db, "repo_b", X)).toEqual([X]);
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

  it("A renamed x to y, B took x and renamed it to z, A renamed y back to x: each claim and receipt is the repository that held x when it was written", () => {
    const w = world({ aReturns: true });
    expect(repositoryNameSpans(w.db, "repo_a", X)).toEqual([
      { identity: X, from: null, until: T1 }, { identity: Y, from: null, until: null }, { identity: X, from: T4, until: null },
    ]);
    expect(repositoryNameSpans(w.db, "repo_b", Z)).toEqual([{ identity: X, from: T1, until: T3 }, { identity: Z, from: null, until: null }]);
    w.claim("clm_a_first", BEFORE_T1);
    w.claim("clm_b", AFTER_T2);
    w.claim("clm_a_again", AFTER_T4);
    w.receipt("rcp_a_first", BEFORE_T1);
    w.receipt("rcp_b", AFTER_T2);
    w.receipt("rcp_a_again", AFTER_T4);
    expect(w.busyOf("repo_a", X, "pa")).toEqual({ claims: ["clm_a_again", "clm_a_first"], receipts: ["rcp_a_again", "rcp_a_first"] });
    expect(w.busyOf("repo_b", Z, "pb")).toEqual({ claims: ["clm_b"], receipts: ["rcp_b"] });
    expect(identityChain(w.db, X, BEFORE_T1)).toEqual([X, Y]);
    expect(identityChain(w.db, X, AFTER_T2)).toEqual([Z, X]);
    expect(identityChain(w.db, X, AFTER_T4)).toEqual([X, Y]);
    expect(identityChain(w.db, X)).toEqual([X, Y]);
  });

  it("a name reused twice (A, then B, then C): each repository owns what was written while it held the name, and no other's", () => {
    const w = world({ cTakes: true });
    expect(repositoryNameSpans(w.db, "repo_b", Z)).toEqual([{ identity: X, from: T1, until: T3 }, { identity: Z, from: null, until: null }]);
    expect(repositoryNameSpans(w.db, "repo_c", X)).toEqual([{ identity: X, from: T3, until: null }]);
    w.claim("clm_a", BEFORE_T1);
    w.claim("clm_b", AFTER_T2);
    w.claim("clm_c", AFTER_T5);
    w.receipt("rcp_a", BEFORE_T1);
    w.receipt("rcp_b", AFTER_T2);
    w.receipt("rcp_c", AFTER_T5);
    expect(w.busyOf("repo_a", Y, "pa")).toEqual({ claims: ["clm_a"], receipts: ["rcp_a"] });
    expect(w.busyOf("repo_b", Z, "pb")).toEqual({ claims: ["clm_b"], receipts: ["rcp_b"] });
    expect(w.busyOf("repo_c", X, "pc")).toEqual({ claims: ["clm_c"], receipts: ["rcp_c"] });
    expect(identityChain(w.db, X, BEFORE_T1)).toEqual([Y, X]);
    expect(identityChain(w.db, X, AFTER_T2)).toEqual([Z, X]);
    expect(identityChain(w.db, X, AFTER_T5)).toEqual([X]);
    expect(identityChain(w.db, X)).toEqual([X]);
  });
});
