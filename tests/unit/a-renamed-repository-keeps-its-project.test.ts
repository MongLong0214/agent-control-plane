import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { parseGitHubIdentity } from "../../src/bootstrap/github-write-port.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { acpError, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { startOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { RunEvidenceExporter } from "../../src/export/run-evidence.ts";
import { type GitHubClient, proveActionsCheckProvenance } from "../../src/github/github-kernel.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { projectCi } from "../../src/registry/project-ci.ts";
import {
  REPOSITORY_NODE_ID_RECORDED, RepositoryNodeIdUnrecorded, RepositoryRenameRefusal, RepositoryRenames, renameManifestDiff, renamedManifest, type RepositoryRenamePlan,
} from "../../src/registry/repository-rename.ts";
import { identityChain } from "../../src/registry/repository-identity-chain.ts";
import { residentRepositories } from "../../src/registry/resident-repositories.ts";
import { WorkScopeTracking } from "../../src/run/work-scope-tracking.ts";
import { createRun, firstManifest, rawFirstActivation, unitTestsWorkflow } from "../helpers/first-activation.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import {
  TEST_MCP_TOKEN, TEST_OPERATOR_TOKEN, TEST_OWNER, bindCeo, fixtureManifest, makeHarness, registerFixtureProject, type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * v61 — after its owner renames a GitHub repository, ACP adopts the new name for the SAME repository
 * (`agentctl project rename-repository`): GitHub must answer the new name with the node id the project's
 * allocation recorded. The project, its CTO binding, its issue tracking and its CI history stay its own.
 *
 * The case: project myeotnyeon, repository MongLong0214/myeotnyeon at node R_kgDOVXh6fA, renamed to
 * youtube-factory. GitHub's REST surface is the recorded fixture, replayed through the production port
 * (`createBootstrapGitHubWritePort`); nothing leaves the process, and git runs on local repositories.
 */

interface Recorded { method: string; path: string; status: number; body: Record<string, unknown> }
const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/github-repository-rename.json", import.meta.url), "utf8")) as {
  renamed: { from: string; to: string; nodeId: string; id: number };
  responses: Recorded[];
};
const PROJECT = "myeotnyeon";
const OLD = `github:${FIXTURE.renamed.from}`;
const NEW = `github:${FIXTURE.renamed.to}`;
const NODE = FIXTURE.renamed.nodeId;
const OLD_HTTPS = "https://github.com/MongLong0214/myeotnyeon.git";
const OLD_SSH = "git@github.com:MongLong0214/myeotnyeon.git";
const DEFAULT_SHA = "c".repeat(40);
const SHA = DEFAULT_SHA;
const WORKFLOW = {
  path: ".github/workflows/ci.yml", checkName: "project-ci", repositoryRole: "primary", approvedDigest: "sha256:approved-ci", unapprovedFirstActivation: false,
};
const contract = {
  goal: "ship the verdict feed", why: "the next product goal", scope: ["src/app.js"], nonGoals: [], acceptance: ["the feed is live"],
  priority: "NORMAL" as const, humanGate: [], references: [],
};

/** GitHub's REST answers replayed from the fixture; a redirect is refused, as ACP's transports refuse one. */
class RecordedGitHub implements GitHubClient {
  readonly calls: string[] = [];
  /** Runs on each request before it is answered: the world moving while ACP waits on GitHub. */
  onRequest: ((path: string) => void) | null = null;
  constructor(private readonly responses: readonly Recorded[]) {}
  async request<T>(method: string, path: string): Promise<T> {
    this.calls.push(`${method} ${path}`);
    this.onRequest?.(path);
    const hit = this.responses.find((response) => response.method === method && response.path === path);
    if (hit === undefined) throw acpError(ReasonCode.NOT_FOUND, `gh api ${method} ${path} failed: HTTP 404`, { status: 404, method, path });
    if (hit.status !== 200) {
      throw acpError(ReasonCode.INTERNAL_ERROR, `GitHub answered HTTP ${hit.status}, a redirect, which is not followed`, {
        status: hit.status, redirect: hit.status >= 300 && hit.status < 400, method, path,
      });
    }
    return structuredClone(hit.body) as T;
  }
}

/** The fixture with the new path's answer changed. */
const answering = (body: Record<string, unknown>): Recorded[] =>
  FIXTURE.responses.map((response) => (response.status === 200 ? { ...response, body: { ...response.body, ...body } } : response));

interface World {
  h: Harness;
  github: RecordedGitHub;
  repositoryId: string;
  checkoutPath: string;
  clonePath: string;
  ctoRoleKey: string;
  oldRunId: string;
}

/**
 * Project myeotnyeon as activation leaves it: its repository registered at the old name, origin naming it,
 * the resident's clone (ssh origin), the PRIMARY_CTO bound, a finished run whose merge and post-merge
 * receipts and trusted-CI result were written under the old name, and the resident allocation recording
 * the repository's node id. GitHub already answers the new name.
 */
const world = async (options: { responses?: Recorded[]; allocation?: "node" | "no-node" | "none"; evidenceWriters?: boolean } = {}): Promise<World> => {
  const github = new RecordedGitHub(options.responses ?? FIXTURE.responses);
  const h = makeHarness({
    ...(options.evidenceWriters === true ? { allowTestEvidenceWriters: true } : {}),
    repoFactory: { workRoot: tempDir("rf-rename-"), githubPort: createBootstrapGitHubWritePort(github, async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
  });
  gitSync(h.repoPath, ["remote", "add", "origin", OLD_HTTPS]);
  const project = await registerFixtureProject(h, PROJECT, {
    repositories: [{ role: "primary", remote: OLD, manifestRoot: "." }], ciWorkflows: [WORKFLOW],
  }, { identity: OLD });
  const clonePath = makeRepo();
  gitSync(clonePath, ["remote", "add", "origin", OLD_SSH]);

  const cto = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
  h.cp.sessions.transition(cto.sessionId, SessionLifecycle.READY, "the project's CTO");
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const bound = h.cp.bindings.bind({ roleKey: ctoRoleKey, role: Role.PRIMARY_CTO, sessionId: cto.sessionId, projectId: PROJECT });
  if (!bound.allowed) throw new Error(bound.message);

  const created = h.cp.runs.create({
    projectId: PROJECT, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const oldRunId = created.value.runId;
  const pinned = h.cp.runs.pinManifest(oldRunId, h.cp.projects.get(PROJECT)!.activeManifestDigest!);
  if (!pinned.allowed) throw new Error(pinned.message);
  recordHistory(h, oldRunId);
  const cancelled = h.cp.runs.cancel(oldRunId, "finished before the rename");
  if (!cancelled.allowed) throw new Error(cancelled.message);

  if (options.allocation !== "none") {
    h.cp.db.run(
      `INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,steps_json,status,updated_at)
       VALUES (?,?,'{}',?,'{}','{}','COMPLETE',?)`,
      [oldRunId, PROJECT, JSON.stringify({
        projectId: PROJECT, runId: oldRunId, repositoryIdentity: OLD, ...(options.allocation === "no-node" ? {} : { repositoryNodeId: NODE }), clonePath,
      }), h.clock.nowIso()],
    );
  }
  const checkoutPath = h.cp.repositories.byId(project.repositoryId)!.checkoutPath;
  return { h, github, repositoryId: project.repositoryId, checkoutPath, clonePath, ctoRoleKey, oldRunId };
};

/** A merge, its post-merge verification and a trusted-CI result, each written under the old name as the kernel writes them. */
const recordHistory = (h: Harness, runId: string, SHA = DEFAULT_SHA): void => {
  const at = h.clock.nowIso();
  const merge = `merge_execute:test:${runId}:${OLD}:${SHA}`;
  h.cp.db.run(
    `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
       preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified, status)
     VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, ?, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [`rcp_${sha256(merge).slice(7, 31)}`, merge, runId, OLD, `${FIXTURE.renamed.from}#7`, digestOf({ head: SHA }), digestOf({ merge }), at],
  );
  h.cp.db.run(`UPDATE github_receipts SET status = 'APPLIED', verified = 1, after_state_digest = ?, reread_at = ?, response_json = ? WHERE idempotency_key = ?`,
    [sha256(SHA), at, JSON.stringify({ mergeCommitSha: SHA }), merge]);
  const checks = [{ name: WORKFLOW.checkName, conclusion: "success" }];
  const verify = `post_merge_verify:${OLD}:${SHA}`;
  h.cp.db.run(
    `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
       preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified, status)
     VALUES (?, ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [`rcp_${sha256(verify).slice(7, 31)}`, verify, runId, OLD, `${FIXTURE.renamed.from}@${SHA}`, digestOf(checks),
      digestOf({ mergeCommitSha: SHA, requiredChecks: [WORKFLOW.checkName] }), JSON.stringify({ checks }), at, at],
  );
  const snapshot = digestOf({ runId, head: SHA });
  h.cp.db.run(
    `INSERT INTO verification_results (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
       exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, 'ci', ?, ?, ?, NULL, ?, 0, 'PASS', NULL)`,
    [`${snapshot}:${WORKFLOW.checkName}:${OLD}:ci`, runId, snapshot, WORKFLOW.checkName, OLD, SHA, at, at, digestOf({ head: SHA })],
  );
};

const rename = (w: World, apply: boolean, to = FIXTURE.renamed.to) => w.h.cp.repositoryRenames.rename({ projectId: PROJECT, to, apply });
const planOf = (decision: Awaited<ReturnType<typeof rename>>): RepositoryRenamePlan => {
  if (!decision.allowed) throw new Error(`${decision.reasonCode}: ${decision.message} ${JSON.stringify(decision.evidence)}`);
  return decision.value;
};
const refusalOf = (decision: Awaited<ReturnType<typeof rename>>): unknown => (decision.allowed ? null : decision.evidence["refusal"]);
const originOf = (path: string): string => gitSync(path, ["remote", "get-url", "origin"]).trim();
const renames = (h: Harness) => h.cp.db.all<Record<string, unknown>>(`SELECT * FROM repository_identity_renames ORDER BY rename_id`);

/** Everything a refused rename must leave as it was. */
const untouched = (w: World): unknown => ({
  identity: w.h.cp.repositories.byId(w.repositoryId)!.identity,
  pointer: w.h.cp.projects.get(PROJECT)!.activeManifestDigest,
  manifests: w.h.cp.db.get(`SELECT COUNT(*) AS n FROM manifests`),
  renames: renames(w.h),
  audit: w.h.cp.audit.byKind("REPOSITORY_RENAMED").length,
  checkout: originOf(w.checkoutPath),
  clone: originOf(w.clonePath),
});
const UNTOUCHED = { identity: OLD, renames: [], audit: 0, checkout: OLD_HTTPS, clone: OLD_SSH, pointer: expect.any(String), manifests: expect.anything() };

const ciOf = (h: Harness) => {
  const ci = projectCi(h.cp.db, h.cp.projects, PROJECT);
  if (!ci.declared) throw new Error("the project declares its CI workflow");
  return ci.workflows[0]!;
};
const exportInputs = (h: Harness, runId: string): unknown => {
  const exported = new RunEvidenceExporter(h.cp.db, h.cp.artifacts, h.clock, h.cp.audit).exportRun(runId);
  if (!exported.allowed) throw new Error(exported.message);
  return exported.value.baseline.qualitySource["postMergeCheckInputs"];
};

describe("v61 — a repository renamed on GitHub is adopted for the same repository", () => {
  it("the recorded fixture: GitHub answers the old path with a redirect ACP does not follow, and the new path with the same node id", async () => {
    const port = createBootstrapGitHubWritePort(new RecordedGitHub(FIXTURE.responses));
    await expect(port.observeRepository({ owner: "MongLong0214", name: "myeotnyeon" })).rejects.toMatchObject({ evidence: { status: 301, redirect: true } });
    expect(await port.observeRepository({ owner: "MongLong0214", name: "youtube-factory" })).toMatchObject({ nodeId: NODE, fullName: FIXTURE.renamed.to });
  });

  it("accepts the same node id: one transaction renames it, the clones follow, and the project, its CTO, its tracking and its history stay", async () => {
    const w = await world();
    const { h } = w;
    const binding = h.cp.bindings.active(w.ctoRoleKey);
    const project = h.cp.projects.get(PROJECT);
    const base = h.cp.projects.activeManifest(PROJECT)!;
    const ciBefore = ciOf(h);
    expect(ciBefore.lastObserved?.source).toMatchObject({ kind: "POST_MERGE_VERIFY_RECEIPT", runId: w.oldRunId });
    const exportBefore = exportInputs(h, w.oldRunId);
    expect(residentRepositories(h.cp.db).map((r) => r.identity)).toEqual([OLD]);

    // Without --apply: the plan, and nothing written.
    const planned = planOf(await rename(w, false));
    expect(planned).toMatchObject({
      mode: "dry-run", state: "PLANNED", projectId: PROJECT, repositoryId: w.repositoryId, role: "primary", from: OLD, to: NEW,
      repositoryNodeId: NODE, fromManifestDigest: base.digest, renameId: null,
      clones: [
        { path: w.checkoutPath, state: "STALE", url: OLD_HTTPS, next: "https://github.com/MongLong0214/youtube-factory.git" },
        { path: w.clonePath, state: "STALE", url: OLD_SSH, next: "git@github.com:MongLong0214/youtube-factory.git" },
      ],
    });
    expect(untouched(w)).toMatchObject(UNTOUCHED);
    expect(w.github.calls).toEqual([`GET repos/${FIXTURE.renamed.to}`]);

    const applied = planOf(await rename(w, true));
    expect(applied).toMatchObject({ mode: "apply", state: "RENAMED", from: OLD, to: NEW, toManifestDigest: planned.toManifestDigest });
    expect(applied.clones.map((clone) => clone.result)).toEqual(["SET", "SET"]);
    expect(originOf(w.checkoutPath)).toBe("https://github.com/MongLong0214/youtube-factory.git");
    expect(originOf(w.clonePath)).toBe("git@github.com:MongLong0214/youtube-factory.git");

    // The repository row, the project's manifest pointer, and one rename record.
    const repository = h.cp.repositories.byId(w.repositoryId)!;
    expect(repository).toMatchObject({ identity: NEW, observedRemoteUrl: "https://github.com/MongLong0214/youtube-factory.git", activeManifestDigest: applied.toManifestDigest });
    const active = h.cp.projects.activeManifest(PROJECT)!;
    expect(active.digest).toBe(applied.toManifestDigest);
    expect(active.manifest.repositories).toEqual([{ role: "primary", remote: NEW, manifestRoot: "." }]);
    expect({ ...active.manifest, repositories: base.manifest.repositories }).toEqual(base.manifest);
    expect(renames(h)).toEqual([expect.objectContaining({
      repository_id: w.repositoryId, project_id: PROJECT, from_identity: OLD, to_identity: NEW, repository_node_id: NODE,
      from_manifest_digest: base.digest, to_manifest_digest: applied.toManifestDigest,
    })]);
    expect(h.cp.audit.byKind("REPOSITORY_RENAMED")).toHaveLength(1);

    // The same project and CTO binding; the resident still owns its repository under the new name.
    expect(h.cp.projects.get(PROJECT)).toEqual({ ...project, activeManifestDigest: applied.toManifestDigest });
    expect(h.cp.bindings.active(w.ctoRoleKey)).toEqual(binding);
    expect(residentRepositories(h.cp.db)).toEqual([expect.objectContaining({ repositoryId: w.repositoryId, identity: NEW, clonePath: canonical(w.clonePath) })]);

    // Old verdicts and receipts are still the repository's: the CI read and the run export find them as before.
    const ciAfter = ciOf(h);
    expect(ciAfter.lastObserved).toEqual(ciBefore.lastObserved);
    expect(ciAfter.repositoryIdentity).toBe(NEW);
    expect(exportInputs(h, w.oldRunId)).toEqual(exportBefore);
    expect((exportBefore as { declared: Array<{ checks: unknown }> }).declared[0]!.checks).toEqual([WORKFLOW.checkName]);

    // Issue tracking: a new run of the project is governed on the repository under its new name.
    const next = h.cp.runs.create({
      projectId: PROJECT, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract,
      repositories: [{ repositoryId: w.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!next.allowed) throw new Error(next.message);
    const tracking = new WorkScopeTracking({
      db: h.cp.db, audit: h.cp.audit, artifacts: h.cp.artifacts, runs: h.cp.runs, tasks: h.cp.tasks,
      github: createBootstrapGitHubWritePort(w.github),
    });
    expect(tracking.trackedIssues(next.value.runId)).toEqual({ repositoryIdentity: NEW, issues: [] });
  });

  it("run again after it finished, it changes nothing, asks GitHub nothing, and reports the repository already renamed", async () => {
    const w = await world();
    planOf(await rename(w, true));
    const calls = w.github.calls.length;
    const state = untouched(w);
    const again = planOf(await rename(w, true));
    expect(again).toMatchObject({ state: "ALREADY_RENAMED", from: OLD, to: NEW, repositoryNodeId: NODE });
    expect(again.clones.map((clone) => clone.state)).toEqual(["CURRENT", "CURRENT"]);
    expect(untouched(w)).toEqual(state);
    expect(w.github.calls).toHaveLength(calls);
    // The current name with no rename recorded is not one.
    const fresh = await world();
    expect(refusalOf(await fresh.h.cp.repositoryRenames.rename({ projectId: PROJECT, to: FIXTURE.renamed.from, apply: true })))
      .toBe(RepositoryRenameRefusal.NO_CHANGE);
  });

  it("refuses a new name that is another repository before any write", async () => {
    for (const [body, refusal] of [
      [{ node_id: "R_kgDOAnotherOne" }, RepositoryRenameRefusal.DIFFERENT_REPOSITORY],
      // GitHub answered the name with another repository's full name: the name redirects, it is not this repository's own.
      [{ full_name: "MongLong0214/something-else" }, RepositoryRenameRefusal.NOT_GITHUB_NAME],
    ] as const) {
      const w = await world({ responses: answering(body) });
      const refused = await rename(w, true);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.REPOSITORY_IDENTITY_MISMATCH });
      expect(refusalOf(refused)).toBe(refusal);
      expect(untouched(w)).toMatchObject(UNTOUCHED);
    }
    const missing = await world();
    expect(refusalOf(await rename(missing, true, "MongLong0214/no-such-repository"))).toBe(RepositoryRenameRefusal.NAME_NOT_ON_GITHUB);
    expect(untouched(missing)).toMatchObject(UNTOUCHED);
  });

  it("refuses when no node id is recorded, without asking GitHub", async () => {
    for (const allocation of ["no-node", "none"] as const) {
      const w = await world({ allocation });
      const refused = await rename(w, true);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_MISSING });
      expect(refusalOf(refused)).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
      expect(w.github.calls).toEqual([]);
      expect(untouched(w)).toMatchObject(UNTOUCHED);
    }
  });

  it("refuses a manifest change beyond the one remote, and a changed role", () => {
    const base: ProjectManifest = fixtureManifest(PROJECT, { repositories: [{ role: "primary", remote: OLD, manifestRoot: "." }] });
    expect(renameManifestDiff(base, renamedManifest(base, "primary", NEW), "primary", OLD, NEW).allowed).toBe(true);
    const refusal = (candidate: ProjectManifest): unknown => {
      const decision = renameManifestDiff(base, candidate, "primary", OLD, NEW);
      return decision.allowed ? null : decision.evidence["refusal"];
    };
    const renamed = renamedManifest(base, "primary", NEW);
    expect(refusal({ ...renamed, verificationProfiles: { ...renamed.verificationProfiles, simple: [] } })).toBe(RepositoryRenameRefusal.MANIFEST_DIFFERS);
    expect(refusal({ ...renamed, repositories: [{ role: "primary", remote: NEW, manifestRoot: "app" }] })).toBe(RepositoryRenameRefusal.MANIFEST_DIFFERS);
    expect(refusal({ ...renamed, repositories: [{ role: "primary", remote: "github:MongLong0214/elsewhere", manifestRoot: "." }] }))
      .toBe(RepositoryRenameRefusal.MANIFEST_DIFFERS);
    expect(refusal(base)).toBe(RepositoryRenameRefusal.MANIFEST_DIFFERS);
    expect(refusal({ ...renamed, repositories: [{ role: "main", remote: NEW, manifestRoot: "." }] })).toBe(RepositoryRenameRefusal.ROLE_CHANGED);
    expect(refusal({ ...renamed, repositories: [...renamed.repositories, { role: "docs", remote: "github:MongLong0214/docs", manifestRoot: "." }] }))
      .toBe(RepositoryRenameRefusal.ROLE_CHANGED);
  });

  it("refuses while a run, a HELD claim or a PENDING receipt of the repository has not finished", async () => {
    const busy = async (seed: (w: World) => void): Promise<void> => {
      const w = await world();
      seed(w);
      const refused = await rename(w, true);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(refusalOf(refused)).toBe(RepositoryRenameRefusal.PROJECT_BUSY);
      expect(untouched(w)).toMatchObject(UNTOUCHED);
    };
    await busy((w) => {
      const run = w.h.cp.runs.create({ projectId: PROJECT, executionMode: ExecutionMode.STANDARD, contract, repositories: [{ repositoryId: w.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
      if (!run.allowed) throw new Error(run.message);
    });
    await busy((w) => {
      const session = w.h.cp.bindings.active(w.ctoRoleKey)!.sessionId;
      w.h.cp.db.run(`INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id, owner_session_id, owner_binding_generation, acquired_at, expires_at, status)
        VALUES ('clm_held', ?, 'wt-1', ?, ?, 1, ?, '2999-01-01T00:00:00.000Z', 'HELD')`, [OLD, w.oldRunId, session, w.h.clock.nowIso()]);
    });
    await busy((w) => {
      w.h.cp.db.run(`INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
          preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified, status)
        VALUES ('rcp_pending', 'merge_execute:pending', 'merge_execute', ?, ?, 'merge', 'x#8', 0, NULL, NULL, 'sha256:r', '{"pending":true}', ?, NULL, 0, 'PENDING')`,
      [w.oldRunId, OLD, w.h.clock.nowIso()]);
    });
  });

  it("resumes: after GitHub renamed and ACP did not, after a crash inside the update, and after a crash before the clones", async () => {
    const w = await world();
    // GitHub renamed, ACP not yet: every call ACP builds from the old name is refused.
    await expect(createBootstrapGitHubWritePort(w.github).observeRepository({ owner: "MongLong0214", name: "myeotnyeon" }))
      .rejects.toMatchObject({ evidence: { status: 301 } });

    // A crash inside the update, at its last write: the transaction leaves nothing behind.
    const other = new Database(w.h.cp.db.raw.name);
    other.exec(`CREATE TRIGGER simulated_crash BEFORE UPDATE OF identity ON repositories BEGIN SELECT RAISE(ABORT, 'SIMULATED_CRASH'); END;`);
    other.close();
    const before = untouched(w);
    await expect(rename(w, true)).rejects.toThrow(/SIMULATED_CRASH/);
    expect(untouched(w)).toEqual(before);
    expect(untouched(w)).toMatchObject(UNTOUCHED);
    const dropper = new Database(w.h.cp.db.raw.name);
    dropper.exec(`DROP TRIGGER simulated_crash`);
    dropper.close();

    // A crash after the transaction and before the clones: the rename stands and the clones are left stale.
    const lost = new RepositoryRenames({
      db: w.h.cp.db, clock: w.h.clock, audit: w.h.cp.audit, github: createBootstrapGitHubWritePort(w.github),
      git: async (cwd, args) => (args[1] === "set-url" ? { exitCode: 128, stdout: "", stderr: "simulated exit before set-url" } : {
        exitCode: 0, stdout: `${originOf(cwd)}\n`, stderr: "",
      }),
    });
    const interrupted = await lost.rename({ projectId: PROJECT, to: FIXTURE.renamed.to, apply: true });
    expect(planOf(interrupted)).toMatchObject({ state: "RENAMED" });
    expect(planOf(interrupted).clones.map((clone) => clone.result)).toEqual(["FAILED", "FAILED"]);
    expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(NEW);
    expect([originOf(w.checkoutPath), originOf(w.clonePath)]).toEqual([OLD_HTTPS, OLD_SSH]);

    // The same command again finishes the clones and renames nothing twice.
    const resumed = planOf(await rename(w, true));
    expect(resumed).toMatchObject({ state: "ALREADY_RENAMED" });
    expect(resumed.clones.map((clone) => [clone.state, clone.result])).toEqual([["STALE", "SET"], ["STALE", "SET"]]);
    expect([originOf(w.checkoutPath), originOf(w.clonePath)]).toEqual([
      "https://github.com/MongLong0214/youtube-factory.git", "git@github.com:MongLong0214/youtube-factory.git",
    ]);
    expect(renames(w.h)).toHaveLength(1);
  });

  it("weakens no CI guard: evidence for the renamed repository must name the new full name exactly", async () => {
    const w = await world();
    planOf(await rename(w, true));
    const check = {
      id: 11, name: WORKFLOW.checkName, head_sha: SHA, conclusion: "success", status: "completed", app: { slug: "github-actions" },
      check_suite: { id: 21 }, details_url: "https://github.com/MongLong0214/youtube-factory/actions/runs/31/job/41",
    };
    // The kernel's root is read from the registry, which now holds the new name.
    const root = () => {
      const parsed = parseGitHubIdentity(w.h.cp.repositories.byId(w.repositoryId)!.identity)!;
      return allow(ReasonCode.OK, { root: `repos/${parsed.owner}/${parsed.name}`, owner: parsed.owner, repo: parsed.name });
    };
    const actions = (fullName: string): GitHubClient => ({
      request: async <T>(_method: string, path: string): Promise<T> => (path.endsWith("/check-suites/21")
        ? { id: 21, repository: { id: FIXTURE.renamed.id, full_name: fullName }, head_sha: SHA, app: { slug: "github-actions" } }
        : { id: 31, repository: { id: FIXTURE.renamed.id, full_name: fullName }, check_suite_id: 21, head_sha: SHA, path: WORKFLOW.path, status: "completed", conclusion: "success" }) as T,
    });
    const prove = (fullName: string) => proveActionsCheckProvenance(actions(fullName), {
      head: SHA, check, workflow: { path: WORKFLOW.path, approvedDigest: WORKFLOW.approvedDigest }, root,
      workflowDigest: async () => allow(ReasonCode.OK, WORKFLOW.approvedDigest),
    });
    expect(await prove(FIXTURE.renamed.from)).toMatchObject({ allowed: false, reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID });
    expect(await prove(FIXTURE.renamed.to)).toMatchObject({ allowed: true });
  });

  it("is the operator's command over the authenticated socket: a plan without --apply, the rename with it, and nothing without the credential", async () => {
    const w = await world();
    w.h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    bindCeo(w.h);
    const stateDir = tempDir("acp-rename-daemon-");
    const daemon = new Daemon(w.h.cp, { stateDir });
    const started = await daemon.start();
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    const listener = await startOperatorSocket(daemon, stateDir, { token: TEST_OPERATOR_TOKEN, peerId: `cli:${TEST_OWNER.actor}`, actor: TEST_OWNER.actor }, { mcpToken: TEST_MCP_TOKEN });
    const printed: unknown[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(JSON.parse(String(chunk))); return true; });
    try {
      const client = createOperatorClient({ socketPath: listener.socketPath, token: TEST_OPERATOR_TOKEN });
      const args = ["rename-repository", PROJECT, FIXTURE.renamed.to];
      expect(await dispatch(createOperatorClient({ socketPath: listener.socketPath }), "project", [...args, "--apply"], false)).toBe(1);
      expect(printed.pop()).toMatchObject({ allowed: false, reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
      expect(await dispatch(client, "project", args, false)).toBe(0);
      expect(printed.pop()).toMatchObject({ mode: "dry-run", state: "PLANNED", from: OLD, to: NEW });
      expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(OLD);
      expect(await dispatch(client, "project", [...args, "--apply"], false)).toBe(0);
      expect(printed.pop()).toMatchObject({ mode: "apply", state: "RENAMED" });
      expect(await dispatch(client, "project", [...args, "--apply"], false)).toBe(0);
      expect(printed.pop()).toMatchObject({ state: "ALREADY_RENAMED" });
      expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(NEW);
    } finally {
      vi.restoreAllMocks();
      await listener.close();
      await daemon.stop();
    }
  });

  /** The fixture, and GitHub answering a third name of the same repository, for a second rename. */
  const THIRD = "MongLong0214/youtube-factory-shorts";
  const withThird = (): Recorded[] => [...FIXTURE.responses, {
    method: "GET", path: `repos/${THIRD}`, status: 200,
    body: { ...FIXTURE.responses.find((r) => r.status === 200)!.body, name: "youtube-factory-shorts", full_name: THIRD },
  }];
  const holdClaim = (w: World, identity: string, id = "clm_held"): void => {
    const session = w.h.cp.bindings.active(w.ctoRoleKey)!.sessionId;
    w.h.cp.db.run(`INSERT INTO resource_claims (claim_id, repository_identity, branch, declared_path, run_id, owner_session_id, owner_binding_generation,
        acquired_at, expires_at, status) VALUES (?, ?, 'feature/shared', 'src/app.js', ?, ?, 1, ?, '2999-01-01T00:00:00.000Z', 'HELD')`,
    [id, identity, w.oldRunId, session, w.h.clock.nowIso()]);
  };

  it("review P2-2: work in flight under another letter case, or under an earlier name, keeps the repository busy", async () => {
    // GitHub's names are case-insensitive, so a claim may carry another spelling of the name the repository holds.
    const cased = await world();
    holdClaim(cased, "github:monglong0214/MYEOTNYEON");
    expect(refusalOf(await rename(cased, true))).toBe(RepositoryRenameRefusal.PROJECT_BUSY);
    expect(untouched(cased)).toMatchObject(UNTOUCHED);
    // After A→B, a claim or receipt still keyed by A is B's work: B→C waits for it.
    for (const seed of ["claim", "receipt"] as const) {
      const w = await world({ responses: withThird() });
      planOf(await rename(w, true));
      if (seed === "claim") holdClaim(w, OLD);
      else {
        w.h.cp.db.run(`INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
            preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified, status)
          VALUES ('rcp_old_name', 'merge_execute:old-name', 'merge_execute', ?, ?, 'merge', 'x#9', 0, NULL, NULL, 'sha256:r', '{"pending":true}', ?, NULL, 0, 'PENDING')`,
        [w.oldRunId, OLD, w.h.clock.nowIso()]);
      }
      const refused = await rename(w, true, THIRD);
      expect(refusalOf(refused), seed).toBe(RepositoryRenameRefusal.PROJECT_BUSY);
      expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(NEW);
      expect(renames(w.h)).toHaveLength(1);
    }
  });

  it("review P2-1: a second rename is a new row, and the first one never moves the manifest again", async () => {
    const w = await world({ responses: withThird() });
    const first = planOf(await rename(w, true));
    const second = planOf(await rename(w, true, THIRD));
    expect(second).toMatchObject({ state: "RENAMED", from: NEW, to: `github:${THIRD}`, fromManifestDigest: first.toManifestDigest });
    expect(renames(w.h).map((row) => [row["sequence"], row["from_identity"], row["to_identity"]]).sort())
      .toEqual([[1, OLD, NEW], [2, NEW, `github:${THIRD}`]]);
    expect(w.h.cp.projects.activeManifest(PROJECT)!.manifest.repositories[0]!.remote).toBe(`github:${THIRD}`);
    // Old evidence is found under every earlier name.
    expect(identityChain(w.h.cp.db, OLD)).toEqual([`github:${THIRD}`, OLD, NEW]);
    expect(ciOf(w.h).lastObserved?.source).toMatchObject({ kind: "POST_MERGE_VERIFY_RECEIPT", runId: w.oldRunId });
  });

  it("review P3-3: replaying a pre-rename run's merge receipt finds its repository under the new name", async () => {
    const w = await world({ evidenceWriters: true });
    const runId = "run_completed_before_rename";
    w.h.cp.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, pinned_manifest_digest, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'COMPLETED', 'merged before the rename', 'sha256:contract', ?, ?)`,
      [runId, PROJECT, w.h.cp.projects.get(PROJECT)!.activeManifestDigest, w.h.clock.nowIso()],
    );
    w.h.cp.db.run(`INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, ?, 'primary', 'dev')`, [runId, w.repositoryId]);
    recordHistory(w.h, runId, "d".repeat(40));
    planOf(await rename(w, true));
    const observe = vi.spyOn(w.h.cp.repositories, "observe");
    const replayed = await new ApprovedRunFinalizer(w.h.cp, "rename-replay").finalizeApprovedRun(runId);
    expect(replayed).toMatchObject({ allowed: true, reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY });
    expect(observe).toHaveBeenCalledWith(w.repositoryId);
  });

  it("a name the renamed repository left is taken by another repository: the finalizer still resolves the old run's receipt to the renamed one", async () => {
    const w = await world({ evidenceWriters: true });
    const runId = "run_completed_before_rename";
    w.h.cp.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, pinned_manifest_digest, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'COMPLETED', 'merged before the rename', 'sha256:contract', ?, ?)`,
      [runId, PROJECT, w.h.cp.projects.get(PROJECT)!.activeManifestDigest, w.h.clock.nowIso()],
    );
    w.h.cp.db.run(`INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, ?, 'primary', 'dev')`, [runId, w.repositoryId]);
    recordHistory(w.h, runId, "d".repeat(40));
    w.h.clock.advance(1000);
    planOf(await rename(w, true));
    // A different repository takes the freed name after the rename.
    w.h.clock.advance(1000);
    w.h.cp.db.run(
      `INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_reuser', ?, ?, NULL, NULL, ?)`,
      [OLD, tempDir("reuser-"), w.h.clock.nowIso()],
    );
    expect(w.h.cp.repositories.byIdentity(OLD)?.repositoryId).toBe("repo_reuser");
    const observe = vi.spyOn(w.h.cp.repositories, "observe").mockResolvedValue(undefined as never);
    const replayed = await new ApprovedRunFinalizer(w.h.cp, "rename-reuse-replay").finalizeApprovedRun(runId);
    expect(replayed).toMatchObject({ allowed: true, reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY });
    expect(observe).toHaveBeenCalledWith(w.repositoryId);
    expect(observe).not.toHaveBeenCalledWith("repo_reuser");
  });

  /** Another repository takes the name the renamed one left, and finishes a run whose merge and CI results carry it. */
  const reuserFinishesARun = (w: World, runId: string, sha: string): void => {
    w.h.clock.advance(1000);
    w.h.cp.db.run(
      `INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at) VALUES ('repo_reuser', ?, ?, NULL, NULL, ?)`,
      [OLD, tempDir("reuser-"), w.h.clock.nowIso()],
    );
    w.h.clock.advance(1000);
    w.h.cp.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, pinned_manifest_digest, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'COMPLETED', 'merged by the repository that took the name', 'sha256:contract', ?, ?)`,
      [runId, PROJECT, w.h.cp.projects.get(PROJECT)!.activeManifestDigest, w.h.clock.nowIso()],
    );
    w.h.cp.db.run(`INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, 'repo_reuser', 'primary', 'dev')`, [runId]);
    recordHistory(w.h, runId, sha);
  };

  it("a name the renamed repository left is taken by another repository: the CI read keeps the renamed one's results under it and shows none of the other's", async () => {
    const w = await world();
    const before = ciOf(w.h);
    expect(before.lastObserved).toMatchObject({ commitSha: DEFAULT_SHA, source: { runId: w.oldRunId } });
    planOf(await rename(w, true));
    // The other repository's later run writes newer results for the same check under the same text.
    reuserFinishesARun(w, "run_reuser", "e".repeat(40));
    const after = ciOf(w.h);
    expect(after.repositoryIdentity).toBe(NEW);
    expect(after.lastObserved).toEqual(before.lastObserved);
    expect(after.latestNonResult).toBeNull();
    expect(JSON.stringify(after)).not.toContain("run_reuser");
  });

  it("a name taken by another repository: the finalizer resolves that repository's own receipt to it, and the renamed one's to the renamed one", async () => {
    const w = await world({ evidenceWriters: true });
    const before = "run_completed_before_rename";
    w.h.cp.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, pinned_manifest_digest, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'COMPLETED', 'merged before the rename', 'sha256:contract', ?, ?)`,
      [before, PROJECT, w.h.cp.projects.get(PROJECT)!.activeManifestDigest, w.h.clock.nowIso()],
    );
    w.h.cp.db.run(`INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, ?, 'primary', 'dev')`, [before, w.repositoryId]);
    recordHistory(w.h, before, "d".repeat(40));
    w.h.clock.advance(1000);
    planOf(await rename(w, true));
    reuserFinishesARun(w, "run_reuser", "e".repeat(40));
    const observe = vi.spyOn(w.h.cp.repositories, "observe").mockResolvedValue(undefined as never);
    const finalizer = new ApprovedRunFinalizer(w.h.cp, "rename-reuse-both");
    expect(await finalizer.finalizeApprovedRun("run_reuser")).toMatchObject({ allowed: true, reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY });
    expect(observe.mock.calls).toEqual([["repo_reuser"]]);
    observe.mockClear();
    expect(await finalizer.finalizeApprovedRun(before)).toMatchObject({ allowed: true, reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY });
    expect(observe.mock.calls).toEqual([[w.repositoryId]]);
  });

  it("review P3-4: a claim recorded under the old name still conflicts with the same target under the new one", async () => {
    const w = await world();
    planOf(await rename(w, true));
    holdClaim(w, OLD);
    const claims = w.h.cp.claims as unknown as {
      findConflict(request: { runId: string; repositoryIdentity: string }, target: { branch: string | null; worktreeId: string | null; declaredPath: string | null }):
        { reasonCode: string } | null;
    };
    expect(claims.findConflict({ runId: "run_other", repositoryIdentity: NEW }, { branch: "feature/shared", worktreeId: null, declaredPath: null }))
      .toMatchObject({ reasonCode: ReasonCode.CLAIM_BRANCH_CONFLICT });
    expect(w.h.cp.claims.advisoryOverlaps(NEW, "run_other", ["src/feed.js"])).toEqual([
      expect.objectContaining({ path: "src/feed.js", otherRun: w.oldRunId, otherPath: "src/app.js" }),
    ]);
  });

  it("race (a): a run, claim or receipt that appears after the plan's quiet check and before the transaction makes the apply refuse", async () => {
    for (const appears of ["run", "claim", "receipt"] as const) {
      const w = await world();
      let moved = false;
      // The clones are read after the plan's quiet check and before the transaction: the world moves there.
      const service = new RepositoryRenames({
        db: w.h.cp.db, clock: w.h.clock, audit: w.h.cp.audit, github: createBootstrapGitHubWritePort(w.github),
        git: async (cwd) => {
          if (!moved) {
            moved = true;
            if (appears === "run") {
              const run = w.h.cp.runs.create({ projectId: PROJECT, executionMode: ExecutionMode.STANDARD, contract, repositories: [{ repositoryId: w.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
              if (!run.allowed) throw new Error(run.message);
            } else if (appears === "claim") holdClaim(w, OLD);
            else {
              w.h.cp.db.run(`INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
                  preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified, status)
                VALUES ('rcp_race', 'merge_execute:race', 'merge_execute', ?, ?, 'merge', 'x#10', 0, NULL, NULL, 'sha256:r', '{"pending":true}', ?, NULL, 0, 'PENDING')`,
              [w.oldRunId, OLD, w.h.clock.nowIso()]);
            }
          }
          return { exitCode: 0, stdout: `${originOf(cwd)}\n`, stderr: "" };
        },
      });
      const refused = await service.rename({ projectId: PROJECT, to: FIXTURE.renamed.to, apply: true });
      expect(moved, appears).toBe(true);
      expect(refusalOf(refused), appears).toBe(RepositoryRenameRefusal.PROJECT_BUSY);
      expect(untouched(w), appears).toMatchObject(UNTOUCHED);
    }
  });

  it("race (b): a stop right after the GitHub rename, before any ACP write, leaves ACP as it was, and the rerun converges", async () => {
    const w = await world();
    // GitHub has the new name; the first attempt dies while asking it, before anything of ACP is written.
    w.github.onRequest = () => { throw new Error("the connection was dropped mid-request"); };
    expect(refusalOf(await rename(w, true))).toBe(RepositoryRenameRefusal.GITHUB_UNREADABLE);
    expect(untouched(w)).toMatchObject(UNTOUCHED);
    w.github.onRequest = null;
    const converged = planOf(await rename(w, true));
    expect(converged).toMatchObject({ state: "RENAMED", from: OLD, to: NEW });
    expect([originOf(w.checkoutPath), originOf(w.clonePath)]).toEqual([
      "https://github.com/MongLong0214/youtube-factory.git", "git@github.com:MongLong0214/youtube-factory.git",
    ]);
  });
});

/**
 * A repository the operator registered (`agentctl project register`) has no resident allocation, so its node
 * id is the one GitHub answers at registration, read at the exact registered name: the rename then checks a
 * new name against it as it checks an allocation's. GitHub's answer at the old name, before the owner renamed
 * it there, is the fixture's answer with the old name.
 */
describe("an operator-registered repository: its node id is GitHub's answer at registration", () => {
  const PEER: AuthenticatedOperatorPeer = { channel: "cli", peerId: "cli:fixture-operator", actor: "fixture-operator", incarnation: "incarnation-1" };
  const renamedAnswer = FIXTURE.responses.find((response) => response.status === 200)!;
  /** GitHub before the owner renamed the repository there: the old name answers 200 as itself. */
  const beforeRename = (body: Record<string, unknown> = {}): Recorded => ({
    method: "GET", path: `repos/${FIXTURE.renamed.from}`, status: 200,
    body: { ...renamedAnswer.body, name: "myeotnyeon", full_name: FIXTURE.renamed.from, ...body },
  });
  const recordedNodeIds = (h: Harness) => h.cp.audit.byKind(REPOSITORY_NODE_ID_RECORDED).map((entry) => entry.evidence);
  /** Everything written to stdout, stderr or the console until `restore`. */
  const captureOutput = () => {
    const output: string[] = [];
    const capture = (...chunks: unknown[]) => { output.push(chunks.map((chunk) => (typeof chunk === "string" ? chunk : JSON.stringify(chunk) ?? String(chunk))).join(" ")); return true; };
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(capture), vi.spyOn(process.stderr, "write").mockImplementation(capture),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(capture)),
    ];
    return { text: () => output.join("\n"), restore: () => { for (const spy of spies) spy.mockRestore(); } };
  };
  /** A GitHub failure whose text carries a fake bearer header and a private body fragment, with and without an HTTP status. */
  const leakingFailures = (path: string): ReadonlyArray<readonly [Error, number | undefined]> => {
    const message = `gh api GET ${path} failed: HTTP 502 Authorization: Bearer xyz {"message":"private-body-fragment"}`;
    return [
      [acpError(ReasonCode.INTERNAL_ERROR, message, { status: 502, header: "Authorization: Bearer xyz", body: '{"message":"private-body-fragment"}' }), 502],
      [new Error(message), undefined],
    ];
  };
  /** The reply, every audit row and the output carry nothing of the failure's header or body. */
  const expectNoLeak = (h: Harness, reply: unknown, output: string): void => {
    const audit = JSON.stringify(h.cp.db.all(`SELECT kind, reason_code, actor, evidence_json FROM audit_events`));
    for (const [where, text] of [["reply", JSON.stringify(reply)], ["audit", audit], ["output", output]] as const) {
      for (const secret of ["Bearer xyz", "Authorization: Bearer", "private-body-fragment"]) expect(text, `${where} carries ${secret}`).not.toContain(secret);
    }
  };

  /**
   * The project registered over the operator method with GitHub answering `atRegistration`, then given its
   * first manifest (naming the old name) the way a first activation leaves it, its activation run finished,
   * and GitHub then answering as the fixture does after the owner's rename (or `afterRename`). `failWith` is
   * thrown by the transport at registration; everything written to stdout, stderr or the console meanwhile
   * is `output`.
   */
  const operatorWorld = async (atRegistration: Recorded[], afterRename: Recorded[] = FIXTURE.responses, failWith?: Error) => {
    const responses = [...atRegistration];
    const github = new RecordedGitHub(responses);
    const h = makeHarness({
      repoFactory: { workRoot: tempDir("rf-rename-op-"), githubPort: createBootstrapGitHubWritePort(github, async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    });
    gitSync(h.repoPath, ["remote", "add", "origin", OLD_HTTPS]);
    h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    bindCeo(h);
    const stateDir = tempDir("acp-rename-op-daemon-");
    const daemon = new Daemon(h.cp, { stateDir });
    const started = await daemon.start();
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    let registered: Awaited<ReturnType<Daemon["handleOperatorRequest"]>>;
    const output = captureOutput();
    if (failWith !== undefined) github.onRequest = () => { throw failWith; };
    try {
      registered = await daemon.handleOperatorRequest({
        requestId: "req-register", method: OPERATOR_METHOD.PROJECT_REGISTER, params: { name: PROJECT, checkoutPath: h.repoPath, projectId: PROJECT },
      }, PEER);
    } finally {
      await daemon.stop();
      github.onRequest = null;
      output.restore();
    }
    if (!registered.allowed) throw new Error(`${registered.reasonCode}: ${registered.message}`);
    const registration = registered.value as {
      repository: { repositoryId: string; identity: string }; repositoryNodeId: string | null; repositoryNodeIdUnrecorded?: { code: string; status?: number };
    };
    const registrationCalls = [...github.calls];
    // Registered and never activated, the project has no manifest naming the repository: the rename refuses before it asks GitHub.
    const unactivated = await h.cp.repositoryRenames.rename({ projectId: PROJECT, to: FIXTURE.renamed.to, apply: false });

    const activation = await createRun(h, PROJECT, RunKind.CONTRACT_CHANGE);
    const registrationEventId = h.cp.db.get<{ event_id: number }>(`SELECT event_id FROM audit_events WHERE kind = 'PROJECT_REGISTERED' AND project_id = ?`, [PROJECT])!.event_id;
    rawFirstActivation(h, {
      projectId: PROJECT, runId: activation.runId, registrationEventId,
      manifest: firstManifest(PROJECT, [unitTestsWorkflow], { repositories: [{ role: "primary", remote: OLD, manifestRoot: "." }] }),
    });
    const cancelled = h.cp.runs.cancel(activation.runId, "the first activation finished");
    if (!cancelled.allowed) throw new Error(cancelled.message);

    responses.splice(0, responses.length, ...afterRename);
    github.calls.length = 0;
    return { h, github, registered, registration, registrationCalls, unactivated, output: output.text(), repositoryId: registration.repository.repositoryId };
  };
  const renameOf = (h: Harness, apply: boolean) => h.cp.repositoryRenames.rename({ projectId: PROJECT, to: FIXTURE.renamed.to, apply });

  it("project.register records the node id GitHub answers at the registered name, and a rename to a name GitHub answers with that id is allowed", async () => {
    const third = "MongLong0214/youtube-factory-shorts";
    const w = await operatorWorld([beforeRename()], [...FIXTURE.responses, {
      method: "GET", path: `repos/${third}`, status: 200, body: { ...renamedAnswer.body, name: "youtube-factory-shorts", full_name: third },
    }]);
    expect(w.registration).toMatchObject({ repository: { identity: OLD }, repositoryNodeId: NODE });
    expect(w.registration.repositoryNodeIdUnrecorded).toBeUndefined();
    expect(w.registrationCalls).toEqual([`GET repos/${FIXTURE.renamed.from}`]);
    expect(recordedNodeIds(w.h)).toEqual([{ repositoryId: w.repositoryId, identity: OLD, repositoryNodeId: NODE }]);
    expect(w.h.cp.db.get(`SELECT COUNT(*) AS n FROM resident_project_provisioning`)).toEqual({ n: 0 });
    expect(refusalOf(w.unactivated)).toBe(RepositoryRenameRefusal.MANIFEST_REMOTE_MISMATCH);

    const planned = planOf(await renameOf(w.h, false));
    expect(planned).toMatchObject({ mode: "dry-run", state: "PLANNED", repositoryId: w.repositoryId, from: OLD, to: NEW, repositoryNodeId: NODE });
    expect(w.github.calls).toEqual([`GET repos/${FIXTURE.renamed.to}`]);
    expect(planOf(await renameOf(w.h, true))).toMatchObject({ state: "RENAMED", from: OLD, to: NEW, repositoryNodeId: NODE });
    expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(NEW);
    expect(renames(w.h)).toEqual([expect.objectContaining({ repository_id: w.repositoryId, from_identity: OLD, to_identity: NEW, repository_node_id: NODE })]);
    // Renamed once, the repository is still the row registered under the old name: a second rename reads the same record.
    expect(planOf(await w.h.cp.repositoryRenames.rename({ projectId: PROJECT, to: third, apply: false })))
      .toMatchObject({ state: "PLANNED", from: NEW, to: `github:${third}`, repositoryNodeId: NODE });
  });

  it("a lookup that fails at registration leaves the registration as it was, records nothing, and the rename is refused", async () => {
    for (const [atRegistration, expected] of [
      [[], { code: RepositoryNodeIdUnrecorded.NOT_ON_GITHUB, status: 404 }],
      [[{ ...beforeRename(), status: 500 }], { code: RepositoryNodeIdUnrecorded.LOOKUP_FAILED, status: 500 }],
      [[{ ...beforeRename(), status: 301, body: { message: "Moved Permanently" } }], { code: RepositoryNodeIdUnrecorded.LOOKUP_FAILED, status: 301 }],
      [[beforeRename({ full_name: "MongLong0214/something-else" })], { code: RepositoryNodeIdUnrecorded.OTHER_FULL_NAME }],
      [[beforeRename({ node_id: "" })], { code: RepositoryNodeIdUnrecorded.LOOKUP_FAILED }],
    ] as const) {
      const unrecorded = JSON.stringify(expected);
      const w = await operatorWorld([...atRegistration]);
      expect(w.registration, unrecorded).toMatchObject({ repository: { identity: OLD }, repositoryNodeId: null });
      expect(w.registration.repositoryNodeIdUnrecorded, unrecorded).toEqual(expected);
      expect(w.h.cp.projects.get(PROJECT), unrecorded).not.toBeNull();
      expect(w.h.cp.repositories.byId(w.repositoryId), unrecorded).toMatchObject({ identity: OLD, projectId: PROJECT, registration: "REGISTERED" });
      expect(recordedNodeIds(w.h), unrecorded).toEqual([]);

      const refused = await renameOf(w.h, true);
      expect(refused, unrecorded).toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_MISSING });
      expect(refusalOf(refused), unrecorded).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
      expect(w.github.calls, unrecorded).toEqual([]);
      expect(w.h.cp.repositories.byId(w.repositoryId)!.identity, unrecorded).toBe(OLD);
      expect(renames(w.h), unrecorded).toEqual([]);
    }
  });

  it("a failed lookup reports a fixed code and at most GitHub's status: no error text, header or body reaches the reply, the audit log or the output", async () => {
    for (const [failure, status] of leakingFailures(`repos/${FIXTURE.renamed.from}`)) {
      const w = await operatorWorld([beforeRename()], FIXTURE.responses, failure);
      expect(w.registrationCalls).toEqual([`GET repos/${FIXTURE.renamed.from}`]);
      expect(w.registration).toMatchObject({ repository: { identity: OLD }, repositoryNodeId: null });
      expect(w.registration.repositoryNodeIdUnrecorded).toEqual({ code: RepositoryNodeIdUnrecorded.LOOKUP_FAILED, ...(status === undefined ? {} : { status }) });
      expectNoLeak(w.h, w.registered, w.output);
      expect(recordedNodeIds(w.h)).toEqual([]);
      expect(refusalOf(await renameOf(w.h, true))).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
    }
  });

  it("a GitHub failure at rename time is refused with the fixed code and at most GitHub's status: no error text, header or body reaches the reply, the audit log or the output", async () => {
    for (const [failure, status] of leakingFailures(`repos/${FIXTURE.renamed.to}`)) {
      const w = await world();
      w.h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      bindCeo(w.h);
      const daemon = new Daemon(w.h.cp, { stateDir: tempDir("acp-rename-leak-daemon-") });
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
      const output = captureOutput();
      w.github.onRequest = () => { throw failure; };
      let reply: Awaited<ReturnType<Daemon["handleOperatorRequest"]>>;
      try {
        reply = await daemon.handleOperatorRequest({
          requestId: "req-rename", method: OPERATOR_METHOD.PROJECT_RENAME_REPOSITORY, params: { projectId: PROJECT, to: FIXTURE.renamed.to, apply: true },
        }, PEER);
      } finally {
        await daemon.stop();
        w.github.onRequest = null;
        output.restore();
      }
      expect(w.github.calls).toEqual([`GET repos/${FIXTURE.renamed.to}`]);
      expect(reply).toMatchObject({ allowed: false, reasonCode: ReasonCode.INTERNAL_ERROR });
      expect(reply.allowed ? null : reply.evidence).toEqual({
        refusal: RepositoryRenameRefusal.GITHUB_UNREADABLE, to: NEW, ...(status === undefined ? {} : { status }),
      });
      expectNoLeak(w.h, reply, output.text());
      expect(untouched(w)).toMatchObject(UNTOUCHED);
    }
  });

  it("a new name GitHub answers with another node id than the one recorded at registration is refused, and nothing is written", async () => {
    const w = await operatorWorld([beforeRename({ node_id: "R_kgDOAnotherOne" })]);
    expect(w.registration.repositoryNodeId).toBe("R_kgDOAnotherOne");
    const pointer = w.h.cp.projects.get(PROJECT)!.activeManifestDigest;
    const refused = await renameOf(w.h, true);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.REPOSITORY_IDENTITY_MISMATCH });
    expect(refusalOf(refused)).toBe(RepositoryRenameRefusal.DIFFERENT_REPOSITORY);
    expect(refused.allowed ? null : refused.evidence).toMatchObject({ recordedNodeId: "R_kgDOAnotherOne", observedNodeId: NODE });
    expect(w.h.cp.repositories.byId(w.repositoryId)!.identity).toBe(OLD);
    expect(w.h.cp.projects.get(PROJECT)!.activeManifestDigest).toBe(pointer);
    expect(renames(w.h)).toEqual([]);
  });

  it("the bootstrap path is unchanged: an allocation of the repository decides alone, and no registration record fills in for it or settles a conflict", async () => {
    // GitHub still answering the old name, so a registration record can be taken for the bootstrap world's repository.
    const withOldName = (node: string): Recorded[] => [...FIXTURE.responses.filter((response) => response.status === 200), beforeRename({ node_id: node })];

    // An allocation without a node id stays refused, though a registration record names one.
    const noNode = await world({ allocation: "no-node", responses: withOldName(NODE) });
    expect(await noNode.h.cp.repositoryRenames.recordRegisteredNodeId(noNode.repositoryId)).toEqual({ repositoryNodeId: NODE });
    expect(refusalOf(await rename(noNode, true))).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
    expect(untouched(noNode)).toMatchObject(UNTOUCHED);

    // An allocation's node id is the one checked, whatever a registration record says.
    const allocated = await world({ responses: withOldName("R_kgDOAnotherOne") });
    expect(await allocated.h.cp.repositoryRenames.recordRegisteredNodeId(allocated.repositoryId)).toEqual({ repositoryNodeId: "R_kgDOAnotherOne" });
    expect(planOf(await rename(allocated, false))).toMatchObject({ state: "PLANNED", repositoryNodeId: NODE });

    // Without an allocation, registration records that disagree are no node id.
    const conflicting = await world({ allocation: "none", responses: withOldName(NODE) });
    expect(await conflicting.h.cp.repositoryRenames.recordRegisteredNodeId(conflicting.repositoryId)).toEqual({ repositoryNodeId: NODE });
    expect(await conflicting.h.cp.repositoryRenames.recordRegisteredNodeId(conflicting.repositoryId)).toMatchObject({ repositoryNodeId: null });
    conflicting.h.cp.audit.record({ kind: REPOSITORY_NODE_ID_RECORDED, evidence: { repositoryId: conflicting.repositoryId, identity: OLD, repositoryNodeId: "R_kgDOAnotherOne" } });
    expect(refusalOf(await rename(conflicting, true))).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
    expect(untouched(conflicting)).toMatchObject(UNTOUCHED);

    // A record counts only for the repository row it names, under the exact name that row was registered with.
    for (const evidence of [
      { repositoryId: "repo_another_repository", identity: OLD },
      { identity: "github:MongLong0214/someone-else" },
      { identity: "github:monglong0214/myeotnyeon" },
    ]) {
      const foreign = await world({ allocation: "none" });
      foreign.h.cp.audit.record({ kind: REPOSITORY_NODE_ID_RECORDED, evidence: { repositoryId: foreign.repositoryId, repositoryNodeId: NODE, ...evidence } });
      expect(refusalOf(await rename(foreign, true)), JSON.stringify(evidence)).toBe(RepositoryRenameRefusal.NODE_ID_UNRECORDED);
      expect(untouched(foreign)).toMatchObject(UNTOUCHED);
    }
  });
});
