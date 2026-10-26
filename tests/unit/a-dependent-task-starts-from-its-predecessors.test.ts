import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commandsForMode } from "../../src/contracts/manifest.ts";
import type * as Ids from "../../src/core/ids.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { baseRefFor } from "../../src/run/candidate-integration.ts";
import { TASK_WRITE_TARGET_RECORDED, TaskWriteTargets, recordedWriteTarget } from "../../src/run/task-write-target.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, gitSync, makeRepo } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

/**
 * #1242 — a STANDARD_WORK task with dependsOn predecessors starts from them: its write target's branch
 * is made at its predecessors' SUCCEEDED commits integrated on the run's pinned base (#1236's own
 * integration), so its worker sees the files it must fix, and freeze holds every task exactly once.
 *
 * Over the real CTO MCP socket, the real claim registry, guard, worker runner, pipeline and
 * verification engine, in scratch repositories only. Stood in: the WORKER provider and its capacity
 * admission, and which task ids the task graph mints (so the integration order is known).
 */

const seeded = vi.hoisted(() => ({ taskIds: [] as string[] }));
vi.mock("../../src/core/ids.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Ids>();
  return {
    ...actual,
    newTaskId: () => (seeded.taskIds.shift() ?? actual.newTaskId()) as ReturnType<typeof actual.newTaskId>,
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  seeded.taskIds.length = 0;
});

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  declaredParent: string;
  baseSha: string;
  startsFrom?: { commit: string; predecessors: Array<{ taskId: string; commit: string }> };
}

interface TaskInput {
  key: string;
  title: string;
  category: "docs" | "implementation";
  dependsOn?: string[];
  spec: Record<string, unknown>;
}

const task = (key: string, paths: string[], dependsOn: string[] = []): TaskInput => ({
  key,
  title: `task ${key}`,
  category: "implementation",
  ...(dependsOn.length > 0 ? { dependsOn } : {}),
  spec: { writeTarget: { paths } },
});

/** A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, its tasks submitted, the real worker path. */
const SECOND = "github:acme/second";

/** `second`: the run also writes a second registered repository, `SECOND`. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string, tasks: TaskInput[], taskIds: string[], options: { second?: boolean } = {}) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  // The project declares the secondary role the second repository joins the run under (#530).
  await registerFixtureProject(f.harness, projectId, options.second
    ? { repositories: [{ role: "primary", remote: "github:acme/fixture", manifestRoot: "." }, { role: "secondary", remote: SECOND, manifestRoot: "." }] }
    : {});
  const second = options.second
    ? await cp.repositories.register({ checkoutPath: makeRepo({ "README.md": "# second\n" }), projectId, repositoryRole: "secondary", identity: SECOND })
    : null;
  if (second && !second.allowed) throw new Error(second.message);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  const sessionId = bound.value.sessionId;
  const repository = cp.db.get<{ repository_id: string; checkout_path: string }>(
    `SELECT repository_id, checkout_path FROM repositories WHERE project_id = ? AND repository_role = 'primary'`,
    [projectId],
  )!;
  const created = cp.runs.create({
    projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract: {
      goal: "build an adapter and fix it",
      why: "a follow-up task fixes what an earlier one wrote",
      scope: ["README.md", "src/app.js", "docs/notes.md"],
      nonGoals: [],
      acceptance: ["verify.js exits 0"],
      priority: "NORMAL" as const,
      humanGate: [],
      references: [],
    },
    repositories: [
      { repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" },
      ...(second?.allowed ? [{ repositoryId: second.value.repositoryId, repositoryRole: "secondary", baseBranch: "dev" }] : []),
    ],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  seeded.taskIds.push(...taskIds);
  const submitted = cp.tasks.submit(runId, tasks);
  if (!submitted.allowed) throw new Error(submitted.message);
  expect(seeded.taskIds, "every seeded task id was minted by this submission").toEqual([]);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  const ids = Object.fromEntries(tasks.map((input, index) => [input.key, submitted.value[index]!.taskId]));
  const runBase = gitSync(f.harness.repoPath, ["rev-parse", "refs/heads/dev"]);
  return { runId, sessionId, ids, repo: f.harness.repoPath, checkoutPath: repository.checkout_path, runBase };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const workerDoing = (f: BootstrapRuntimeFixture): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

type Provisioned = { ok: boolean; reasonCode?: string; value?: { writeTarget: WriteTarget | null; writeTargetRefused?: { reasonCode: string; message: string; evidence: Record<string, unknown> } } };

const provision = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string): Promise<Provisioned> =>
  (await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" })) as unknown as Provisioned;

/** Claims a provisioned task's target, runs one turn with `script` to SUCCEEDED, and releases the run's claims. */
const runProvisioned = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, target: WriteTarget, script: FakeTurnScript) => {
  worker.script = script;
  const claimed = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });
  expect(claimed).toMatchObject({ ok: true });
  const claimId = (claimed["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims.find((claim) => claim.worktreeId !== null)!.claimId;
  const ran = await f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });
  expect(ran, JSON.stringify(ran).slice(0, 600)).toMatchObject({ ok: true });
  const executionId = (ran["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  expect(f.harness.cp.tasks.execution(executionId)?.status).toBe("SUCCEEDED");
  expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
  return gitSync(s.repo, ["rev-parse", `refs/heads/${target.branch}`]);
};

const runToSuccess = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, script: FakeTurnScript) => {
  const provisioned = await provision(f, s, taskId);
  expect(provisioned, JSON.stringify(provisioned).slice(0, 600)).toMatchObject({ ok: true, value: { writeTarget: expect.any(Object) } });
  const target = provisioned.value!.writeTarget!;
  return { target, commit: await runProvisioned(f, s, worker, taskId, target, script) };
};

/** What the registered checkout holds at `path` right now. */
const onDisk = (s: StandardRun, path: string): string => readFileSync(join(s.checkoutPath, path), "utf8");
const fileAt = (repo: string, commit: string, path: string): string => gitSync(repo, ["show", `${commit}:${path}`]);
const recordsFor = (f: BootstrapRuntimeFixture, runId: string, taskId: string) =>
  f.harness.cp.audit.byKind(TASK_WRITE_TARGET_RECORDED).filter((row) => row.runId === runId && row.evidence["taskId"] === taskId);

const ADAPTER = { "README.md": "# adapter\n", "src/app.js": "module.exports = () => 3;\n" };
const FIXED = { "src/app.js": "module.exports = () => 2;\n" };

describe("a dependent task starts from its predecessors' SUCCEEDED commits (#1242)", () => {
  it("W1: a dependsOn task's worker checkout holds its predecessor's files when its turn starts, and the chosen base is on record", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "dep-w1", [task("a", ["README.md", "src/app.js"]), task("b", ["src/app.js"], ["a"])], ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb"]);
      const worker = workerDoing(f);
      try {
        const a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: ADAPTER });
        const provisioned = await provision(f, s, s.ids["b"]!);
        expect(provisioned, JSON.stringify(provisioned).slice(0, 600)).toMatchObject({ ok: true });
        const target = provisioned.value!.writeTarget!;
        const seen: Record<string, string> = {};
        const b = await runProvisioned(f, s, worker, s.ids["b"]!, target, {
          beforeSpawn: async () => {
            seen["README.md"] = onDisk(s, "README.md");
            seen["src/app.js"] = onDisk(s, "src/app.js");
          },
          writes: FIXED,
        });
        // What B's worker found in the checkout when its turn started: A's files, as A left them.
        expect(seen).toEqual(ADAPTER);
        expect(gitSync(s.repo, ["rev-parse", `${b}^`])).toBe(a.commit);
        // The run's base stays the run's base; the branch started from the predecessor's commit, on record.
        expect(target.baseSha).toBe(a.target.baseSha);
        expect(target.startsFrom).toEqual({ commit: a.commit, predecessors: [{ taskId: s.ids["a"], commit: a.commit }] });
        expect(recordsFor(f, s.runId, s.ids["b"]!).map((row) => (row.evidence["writeTarget"] as WriteTarget).startsFrom)).toEqual([target.startsFrom]);
        const prepared = f.harness.cp.audit.byKind("TASK_BRANCH_PREPARED").filter((row) => row.runId === s.runId && row.evidence["taskId"] === s.ids["b"]);
        expect(prepared.map((row) => [row.evidence["head"], row.evidence["baseSha"], row.evidence["startsFrom"]])).toEqual([[a.commit, s.runBase, target.startsFrom]]);
      } finally {
        worker.killAll();
      }
    });
  });

  it("W2: the freeze candidate of A, then B-depends-on-A changing A's file, holds both changes exactly once and verifies", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "dep-w2", [task("a", ["README.md", "src/app.js"]), task("b", ["src/app.js"], ["a"])], ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb"]);
      const worker = workerDoing(f);
      let a: { commit: string };
      let b: { commit: string };
      try {
        a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: ADAPTER });
        b = await runToSuccess(f, s, worker, s.ids["b"]!, { writes: FIXED });
      } finally {
        worker.killAll();
      }
      const frozen = await cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence).slice(0, 400)}`);
      const repo = frozen.value.repositories[0]!;
      // B was built on A, so B's commit holds both: no merge, nothing applied twice.
      expect(repo.candidateHead).toBe(b.commit);
      expect(gitSync(s.repo, ["rev-list", "--reverse", `${s.runBase}..${repo.candidateHead}`]).split("\n")).toEqual([a.commit, b.commit]);
      expect(fileAt(s.repo, repo.candidateHead, "README.md")).toBe("# adapter");
      expect(fileAt(s.repo, repo.candidateHead, "src/app.js")).toBe("module.exports = () => 2;");
      expect(gitSync(s.repo, ["diff", "--name-only", s.runBase, repo.candidateHead]).split("\n")).toEqual(["README.md", "src/app.js"]);
      expect({ sourceBranch: repo.sourceBranch, sourceHead: repo.sourceHead }).toEqual({ sourceBranch: "dev", sourceHead: s.runBase });
      const run = cp.runs.require(s.runId);
      const manifest = cp.projects.manifest(run.pinnedManifestDigest!)!;
      const verified = await cp.verification.verify({ runId: s.runId, snapshot: frozen.value, commands: commandsForMode(manifest, run.executionMode), contractDigest: run.contractDigest });
      if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
      expect(verified.value.results.map((result) => [result.status, result.exactHead])).toEqual([["PASS", repo.candidateHead]]);
    });
  });

  it("W2, integrated: with an independent task last on the checkout, the freeze integrates A, B on A as it is, and the independent task, with no false overlap", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "dep-w2-integrated",
        [task("a", ["README.md", "src/app.js"]), task("b", ["src/app.js"], ["a"]), task("c", ["docs/notes.md"])],
        ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb", "task_cccccccccccccccccccccccc"],
      );
      const worker = workerDoing(f);
      let a: { commit: string };
      let b: { commit: string };
      let c: { commit: string };
      try {
        a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: ADAPTER });
        b = await runToSuccess(f, s, worker, s.ids["b"]!, { writes: FIXED });
        c = await runToSuccess(f, s, worker, s.ids["c"]!, { writes: { "docs/notes.md": "notes\n" } });
      } finally {
        worker.killAll();
      }
      expect(gitSync(s.repo, ["rev-parse", "HEAD"])).toBe(c.commit);
      const frozen = await cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence).slice(0, 400)}`);
      const repo = frozen.value.repositories[0]!;
      expect(repo.integration?.tasks).toEqual([
        { taskId: s.ids["a"], commit: a.commit },
        { taskId: s.ids["b"], commit: b.commit },
        { taskId: s.ids["c"], commit: c.commit },
      ]);
      expect(gitSync(s.repo, ["rev-list", "--parents", "-n", "1", repo.candidateHead]).split(" ").slice(1)).toEqual([b.commit, c.commit]);
      expect(fileAt(s.repo, repo.candidateHead, "README.md")).toBe("# adapter");
      expect(fileAt(s.repo, repo.candidateHead, "src/app.js")).toBe("module.exports = () => 2;");
      expect(fileAt(s.repo, repo.candidateHead, "docs/notes.md")).toBe("notes");
      const run = cp.runs.require(s.runId);
      const manifest = cp.projects.manifest(run.pinnedManifestDigest!)!;
      const verified = await cp.verification.verify({ runId: s.runId, snapshot: frozen.value, commands: commandsForMode(manifest, run.executionMode), contractDigest: run.contractDigest });
      if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
      expect(verified.value.results.map((result) => [result.status, result.exactHead])).toEqual([["PASS", repo.candidateHead]]);
    });
  });

  it("W3: a predecessor that has not SUCCEEDED refuses the dependent task's write target, at provisioning and at every other door, recording nothing", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "dep-w3", [task("a", ["README.md"]), task("b", ["src/app.js"], ["a"])], ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb"]);
      expect(cp.tasks.get(s.ids["a"]!)?.state).toBe("READY");
      expect(await provision(f, s, s.ids["b"]!)).toMatchObject({ ok: false, reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED });
      // The doors that record a target for an already-staffed task (the runner and the daemon) go
      // through the same derivation: it refuses too, and nothing is recorded at the run's base.
      const targets = new TaskWriteTargets({ db: cp.db, clock: cp.clock, audit: cp.audit, predecessorBase: (input) => cp.pipeline.predecessorBase(input) });
      const ensured = await targets.ensure(s.runId, s.ids["b"]!, () => allow(ReasonCode.OK, undefined));
      expect(ensured).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED,
        evidence: { taskId: s.ids["b"], unsatisfied: [{ taskId: s.ids["a"], state: "READY" }] },
      });
      expect(recordedWriteTarget(cp.db, s.runId, s.ids["b"]!)).toBeNull();
      expect(recordsFor(f, s.runId, s.ids["b"]!)).toEqual([]);
    });
  });

  it("W4: a predecessor whose commit is gone refuses provisioning by name, never falling back to the run's base", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "dep-w4", [task("a", ["README.md", "src/app.js"]), task("b", ["src/app.js"], ["a"])], ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb"]);
      const worker = workerDoing(f);
      let a: { target: WriteTarget; commit: string };
      try {
        a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: ADAPTER });
      } finally {
        worker.killAll();
      }
      // A's commit is lost from the repository: its branch deleted by hand and its objects pruned.
      gitSync(s.repo, ["checkout", "-q", "dev"]);
      gitSync(s.repo, ["branch", "-q", "-D", a.target.branch]);
      gitSync(s.repo, ["reflog", "expire", "--expire=now", "--all"]);
      gitSync(s.repo, ["gc", "--quiet", "--prune=now"]);
      expect(() => gitSync(s.repo, ["cat-file", "-e", `${a.commit}^{commit}`])).toThrow();

      const provisioned = await provision(f, s, s.ids["b"]!);
      expect(provisioned).toMatchObject({
        ok: true,
        value: {
          writeTarget: null,
          writeTargetRefused: {
            reasonCode: ReasonCode.TASK_PREDECESSOR_COMMIT_MISSING,
            evidence: { taskId: s.ids["b"], predecessor: s.ids["a"], commit: a.commit },
          },
        },
      });
      expect(recordedWriteTarget(cp.db, s.runId, s.ids["b"]!)).toBeNull();
      expect(recordsFor(f, s.runId, s.ids["b"]!)).toEqual([]);
    });
  });

  it("W5: a task without dependsOn keeps exactly the run's base, even after another task SUCCEEDED", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await standardRun(f, "dep-w5", [task("a", ["README.md", "src/app.js"]), task("c", ["docs/notes.md"])], ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_cccccccccccccccccccccccc"]);
      const worker = workerDoing(f);
      try {
        await runToSuccess(f, s, worker, s.ids["a"]!, { writes: ADAPTER });
        const provisioned = await provision(f, s, s.ids["c"]!);
        const target = provisioned.value!.writeTarget!;
        expect(Object.keys(target).sort()).toEqual(["baseSha", "branch", "declaredParent", "paths", "repositoryIdentity"]);
        expect(target.baseSha).toBe(s.runBase);
        const seen: Record<string, string> = {};
        const c = await runProvisioned(f, s, worker, s.ids["c"]!, target, {
          beforeSpawn: async () => {
            seen["README.md"] = onDisk(s, "README.md");
          },
          writes: { "docs/notes.md": "notes\n" },
        });
        expect(seen["README.md"]).toBe(fileAt(s.repo, s.runBase, "README.md") + "\n");
        expect(gitSync(s.repo, ["rev-parse", `${c}^`])).toBe(s.runBase);
        expect(gitSync(s.repo, ["for-each-ref", "refs/acp/bases/"])).toBe("");
      } finally {
        worker.killAll();
      }
    });
  });
});

describe("a dependent task of several predecessors (#1242)", () => {
  it("starts from their integration, kept by a private ref through gc --prune=now, and freeze holds all three", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "dep-merge",
        [task("a", ["README.md"]), task("c", ["docs/notes.md"]), task("d", ["src/app.js"], ["a", "c"])],
        ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_cccccccccccccccccccccccc", "task_dddddddddddddddddddddddd"],
      );
      const worker = workerDoing(f);
      try {
        const a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: { "README.md": "# from a\n" } });
        const c = await runToSuccess(f, s, worker, s.ids["c"]!, { writes: { "docs/notes.md": "from c\n" } });
        const provisioned = await provision(f, s, s.ids["d"]!);
        const target = provisioned.value!.writeTarget!;
        const start = target.startsFrom!.commit;
        expect(target.startsFrom!.predecessors).toEqual([{ taskId: s.ids["a"], commit: a.commit }, { taskId: s.ids["c"], commit: c.commit }]);
        expect(gitSync(s.repo, ["rev-list", "--parents", "-n", "1", start]).split(" ").slice(1)).toEqual([a.commit, c.commit]);
        expect(gitSync(s.repo, ["rev-parse", baseRefFor(s.runId, s.ids["d"]!)])).toBe(start);
        expect(cp.db.all<{ state: string }>(`SELECT state FROM verification_worktrees WHERE run_id = ? AND command_id = 'predecessor-base'`, [s.runId]).map((row) => row.state)).toEqual(["DESTROYED"]);
        gitSync(s.repo, ["gc", "--quiet", "--prune=now"]);
        expect(() => gitSync(s.repo, ["cat-file", "-e", `${start}^{commit}`]), "the base survives gc --prune=now").not.toThrow();

        const seen: Record<string, string> = {};
        const d = await runProvisioned(f, s, worker, s.ids["d"]!, target, {
          beforeSpawn: async () => {
            seen["README.md"] = onDisk(s, "README.md");
            seen["docs/notes.md"] = onDisk(s, "docs/notes.md");
          },
          writes: FIXED,
        });
        expect(seen).toEqual({ "README.md": "# from a\n", "docs/notes.md": "from c\n" });
        const frozen = await cp.pipeline.freeze(s.runId);
        if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
        const repo = frozen.value.repositories[0]!;
        expect(repo.candidateHead).toBe(d);
        expect(repo.touchedPaths).toEqual(["README.md", "docs/notes.md", "src/app.js"]);
      } finally {
        worker.killAll();
      }
    });
  });

  it("two predecessors that change one path refuse the dependent task by name, recording nothing", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(
        f,
        "dep-overlap",
        [task("a", ["README.md"]), task("c", ["README.md"]), task("d", ["src/app.js"], ["a", "c"])],
        ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_cccccccccccccccccccccccc", "task_dddddddddddddddddddddddd"],
      );
      const worker = workerDoing(f);
      try {
        await runToSuccess(f, s, worker, s.ids["a"]!, { writes: { "README.md": "# from a\n" } });
        await runToSuccess(f, s, worker, s.ids["c"]!, { writes: { "README.md": "# from c\n" } });
      } finally {
        worker.killAll();
      }
      const provisioned = await provision(f, s, s.ids["d"]!);
      expect(provisioned).toMatchObject({
        ok: true,
        value: {
          writeTarget: null,
          writeTargetRefused: {
            reasonCode: ReasonCode.TASK_PREDECESSORS_OVERLAP,
            evidence: { taskId: s.ids["d"], conflicts: [{ tasks: [s.ids["a"], s.ids["c"]], paths: ["README.md"] }] },
          },
        },
      });
      expect(recordedWriteTarget(cp.db, s.runId, s.ids["d"]!)).toBeNull();
      expect(gitSync(s.repo, ["for-each-ref", "refs/acp/bases/"])).toBe("");
    });
  });
});

describe("review of #1242 (PR #1245)", () => {
  it("P2-a: a predecessor's commit lost from another repository refuses the dependent task by name, not only one lost from its own", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const primary = "github:acme/fixture";
      const s = await standardRun(
        f,
        "dep-p2a",
        [
          { key: "a", title: "task a", category: "implementation", spec: { writeTarget: { repositoryIdentity: primary, paths: ["README.md"] } } },
          { key: "b", title: "task b", category: "implementation", dependsOn: ["a"], spec: { writeTarget: { repositoryIdentity: SECOND, paths: ["README.md"] } } },
        ],
        ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb"],
        { second: true },
      );
      const worker = workerDoing(f);
      let a: { target: WriteTarget; commit: string };
      try {
        a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: { "README.md": "# from a\n" } });
      } finally {
        worker.killAll();
      }
      expect(a.target.repositoryIdentity).toBe(primary);
      // A's commit is lost from its repository (R1); B writes the other one (R2).
      gitSync(s.repo, ["checkout", "-q", "dev"]);
      gitSync(s.repo, ["branch", "-q", "-D", a.target.branch]);
      gitSync(s.repo, ["reflog", "expire", "--expire=now", "--all"]);
      gitSync(s.repo, ["gc", "--quiet", "--prune=now"]);
      expect(() => gitSync(s.repo, ["cat-file", "-e", `${a.commit}^{commit}`])).toThrow();

      const provisioned = await provision(f, s, s.ids["b"]!);
      expect(provisioned).toMatchObject({
        ok: true,
        value: {
          writeTarget: null,
          writeTargetRefused: {
            reasonCode: ReasonCode.TASK_PREDECESSOR_COMMIT_MISSING,
            evidence: { taskId: s.ids["b"], predecessor: s.ids["a"], commit: a.commit, repositoryIdentity: primary },
          },
        },
      });
      expect(recordedWriteTarget(cp.db, s.runId, s.ids["b"]!)).toBeNull();
      expect(recordsFor(f, s.runId, s.ids["b"]!)).toEqual([]);
    });
  });

  it("P2-b: a file that becomes a directory, and a directory that becomes a file, along a chain do not block a later dependent or the freeze", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      // Neither `module` nor `dir` exists at the base. A makes both as one kind, B deletes them, C makes each as the other kind.
      const s = await standardRun(
        f,
        "dep-p2b",
        [task("a", ["dir/x", "module"]), task("b", ["dir/x", "module"], ["a"]), task("c", ["dir", "module/index.js"], ["b"]), task("d", ["src/app.js"], ["c"])],
        ["task_aaaaaaaaaaaaaaaaaaaaaaaa", "task_bbbbbbbbbbbbbbbbbbbbbbbb", "task_cccccccccccccccccccccccc", "task_dddddddddddddddddddddddd"],
      );
      expect(() => gitSync(s.repo, ["cat-file", "-e", `${s.runBase}:module`])).toThrow();
      expect(() => gitSync(s.repo, ["cat-file", "-e", `${s.runBase}:dir`])).toThrow();
      const worker = workerDoing(f);
      let a: { commit: string };
      let b: { commit: string };
      let c: { commit: string };
      try {
        a = await runToSuccess(f, s, worker, s.ids["a"]!, { writes: { module: "a file\n", "dir/x": "x\n" } });
        b = await runToSuccess(f, s, worker, s.ids["b"]!, {
          writes: {},
          whileLatched: () => {
            rmSync(join(s.checkoutPath, "module"));
            rmSync(join(s.checkoutPath, "dir"), { recursive: true });
          },
        });
        c = await runToSuccess(f, s, worker, s.ids["c"]!, { writes: { "module/index.js": "module.exports = 1;\n", dir: "a file\n" } });
      } finally {
        worker.killAll();
      }
      expect(gitSync(s.repo, ["cat-file", "-t", `${c.commit}:module`])).toBe("tree");
      expect(gitSync(s.repo, ["cat-file", "-t", `${c.commit}:dir`])).toBe("blob");

      const provisioned = await provision(f, s, s.ids["d"]!);
      expect(provisioned.value?.writeTargetRefused).toBeUndefined();
      expect(provisioned.value!.writeTarget?.startsFrom).toEqual({
        commit: c.commit,
        predecessors: [
          { taskId: s.ids["a"], commit: a.commit },
          { taskId: s.ids["b"], commit: b.commit },
          { taskId: s.ids["c"], commit: c.commit },
        ],
      });
      // The freeze's content check reads the same entries: B's deletions stand in C's candidate.
      const frozen = await cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence).slice(0, 400)}`);
      expect(frozen.value.repositories[0]!.candidateHead).toBe(c.commit);
    });
  });
});
