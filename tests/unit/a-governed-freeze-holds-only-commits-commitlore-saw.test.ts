import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commitloreGoverned } from "../../src/bootstrap/commitlore-observation.ts";
import { sha256 } from "../../src/core/digest.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type * as Git from "../../src/git/git.ts";
import type * as Integration from "../../src/run/candidate-integration.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { StartsFrom } from "../../src/run/task-write-target.ts";
import { WorkerTurnEvent, workerSuccessDigest, type WorkerSuccessDigestInputs } from "../../src/run/worker-turn.ts";
import { passingCommitLore } from "../helpers/commitlore-attempt.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #1268 slice 1 — a freeze of a run whose contract requires CommitLore holds a candidate only when every commit
 * between the base it froze and the exact head it froze is one the run's CommitLore path accounts for:
 *
 * - one of this run's SUCCEEDED worker commits, read through the execution id and result digest its receipt
 *   binds, whose CommitLore evidence has a known outcome and names exactly the `Record-Id` trailers the commit
 *   itself carries (none for `empty`); or
 * - an integration merge this freeze's CommitLore check passed, bound to that commit's own parents (in order),
 *   tree and message.
 *
 * Anything else refuses the freeze, naming the first such commit, and writes nothing. Worker receipts are seeded
 * the way `driven-standard-work-continuation` and S6-B's stacked-task witness seed them (`startExecution`,
 * `finishExecution`, the SUCCEEDED row), with the `commitlore` field a CommitLore-settled turn records; the
 * merges are the real integration's, checked by a passing CommitLore double.
 */

const hooks = vi.hoisted(() => ({
  /** Runs after each of the freeze's CommitLore range checks answers, with how many have answered. */
  afterRangeCheck: null as ((calls: number) => void) | null,
  rangeChecks: 0,
  /** Rewrites what the integration reports it checked. */
  tamperChecks: null as ((checks: Integration.MergeCheckBinding[]) => Integration.MergeCheckBinding[]) | null,
  /** Runs once when the freeze starts planning its candidate refs. */
  atRefPlan: null as (() => void) | null,
  /** Runs once when the freeze starts applying its candidate refs. */
  atRefApply: null as (() => void) | null,
  /** How many ref applications have started, and the one (if any) that is refused instead of applied. */
  refApplies: 0,
  failRefApplyAt: null as number | null,
  /** Runs before each `tryRevParse(…, "HEAD")` the freeze makes, with the checkout it reads. */
  duringHeadRead: null as ((checkoutPath: string) => void) | null,
}));
vi.mock("../../src/git/git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Git>();
  return {
    ...actual,
    tryRevParse: async (...args: Parameters<typeof actual.tryRevParse>) => {
      if (args[1] === "HEAD") hooks.duringHeadRead?.(args[0]);
      return actual.tryRevParse(...args);
    },
  };
});
vi.mock("../../src/run/candidate-integration.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Integration>();
  return {
    ...actual,
    integrateTaskResults: async (input: Parameters<typeof actual.integrateTaskResults>[0]) => {
      const answer = await actual.integrateTaskResults(input);
      if (hooks.tamperChecks === null || !answer.allowed || answer.value === null) return answer;
      return { ...answer, value: { ...answer.value, commitloreMergeChecks: hooks.tamperChecks(answer.value.commitloreMergeChecks) } };
    },
    candidateRefPlan: async (...args: Parameters<typeof actual.candidateRefPlan>) => {
      const hook = hooks.atRefPlan;
      hooks.atRefPlan = null;
      hook?.();
      return actual.candidateRefPlan(...args);
    },
    applyCandidateRefPlan: async (...args: Parameters<typeof actual.applyCandidateRefPlan>) => {
      hooks.refApplies += 1;
      const hook = hooks.atRefApply;
      hooks.atRefApply = null;
      hook?.();
      if (hooks.failRefApplyAt === hooks.refApplies) return deny(ReasonCode.PROBE_FAILED, "this ref application is refused by the test", {});
      return actual.applyCandidateRefPlan(...args);
    },
    foreignCandidateCommit: async (input: Parameters<typeof actual.foreignCandidateCommit>[0]) => {
      const answer = await actual.foreignCandidateCommit(input);
      hooks.rangeChecks += 1;
      hooks.afterRangeCheck?.(hooks.rangeChecks);
      return answer;
    },
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  hooks.afterRangeCheck = null;
  hooks.rangeChecks = 0;
  hooks.tamperChecks = null;
  hooks.atRefPlan = null;
  hooks.atRefApply = null;
  hooks.refApplies = 0;
  hooks.failRefApplyAt = null;
  hooks.duringHeadRead = null;
});

const CONTRACT: TaskContract = {
  goal: "update the project",
  why: "changes in one run",
  scope: ["README.md", "src/app.js", "notes.md"],
  nonGoals: [],
  acceptance: ["the files change"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

interface Lore {
  outcome: string;
  recordIds: string[];
  nonce: string | null;
}
const EMPTY: Lore = { outcome: "empty", recordIds: [], nonce: null };
const recorded = (...recordIds: string[]): Lore => ({ outcome: "recorded", recordIds, nonce: "capture-nonce" });

type World = Awaited<ReturnType<typeof worldOf>>;

const SECOND = "github:acme/second";

/**
 * A dispatched run of a project whose CommitLore mode is `mode`. `second` adds a secondary repository to the
 * project and the run: a clone of the primary with no remote, so the two share their base commit.
 */
const worldOf = async (mode: "required" | "preferred", projectId = `cl-freeze-${mode}`, options: { second?: boolean } = {}) => {
  const harness = makeHarness();
  const { repositoryId, identity } = await registerFixtureProject(harness, projectId, {
    commitlore: { mode },
    ...(options.second
      ? { repositories: [{ role: "primary", remote: "github:acme/fixture", manifestRoot: "." }, { role: "secondary", remote: SECOND, manifestRoot: "." }] }
      : {}),
  });
  let second: { repositoryId: string; repo: string } | null = null;
  if (options.second) {
    const clone = tempDir("acp-1268-second-");
    gitSync(harness.repoPath, ["clone", "-q", "--no-local", harness.repoPath, clone]);
    gitSync(clone, ["remote", "remove", "origin"]);
    gitSync(clone, ["config", "--local", "maintenance.auto", "false"]);
    const registered = await harness.cp.repositories.register({ checkoutPath: clone, projectId, repositoryRole: "secondary", identity: SECOND });
    if (!registered.allowed) throw new Error(registered.message);
    second = { repositoryId: registered.value.repositoryId, repo: clone };
  }
  bindCeo(harness);
  const run = await dispatchedRun(harness, projectId, repositoryId, second?.repositoryId);
  // The integration's merge messages get CommitLore's check; this double passes every one.
  harness.cp.pipeline.attach({ commitlore: passingCommitLore() });
  expect(commitloreGoverned(harness.cp.db, run.runId)).toBe(mode === "required");
  return { harness, run, projectId, repositoryId, identity, repo: harness.repoPath, base: gitSync(harness.repoPath, ["rev-parse", "dev"]), second };
};

const dispatchedRun = async (harness: ReturnType<typeof makeHarness>, projectId: string, repositoryId: string, secondRepositoryId?: string) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [
      { repositoryId, repositoryRole: "primary", baseBranch: "dev" },
      ...(secondRepositoryId === undefined ? [] : [{ repositoryId: secondRepositoryId, repositoryRole: "secondary", baseBranch: "dev" }]),
    ],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  return dispatched.value;
};

/** A task of the run, after the tasks named (by title) in `dependsOn`. */
const submitTask = (world: World, key: string, dependsOn: string[] = []): string => {
  const submitted = world.harness.cp.tasks.submit(world.run.runId, [
    { key, title: `update ${key}`, category: "implementation", ...(dependsOn.length > 0 ? { dependsOn } : {}) },
  ]);
  if (!submitted.allowed) throw new Error(submitted.message);
  return submitted.value[0]!.taskId;
};

/**
 * One task's SUCCEEDED turn: its branch at the pinned base (or at `startsFrom`) and the write target recorded
 * for it, the commit with `message`, and the receipt that names it, carrying `commitlore` unless it is null.
 */
const workerCommit = (
  world: World,
  key: string,
  files: Record<string, string>,
  message: string,
  commitlore: Lore | null,
  options: { onCurrentHead?: boolean; run?: World["run"]; taskId?: string; startsFrom?: StartsFrom } = {},
): { taskId: string; commit: string; executionId: string } => {
  const { harness } = world;
  const run = options.run ?? world.run;
  let taskId = options.taskId;
  if (taskId === undefined) {
    const submitted = harness.cp.tasks.submit(run.runId, [{ key, title: `update ${key}`, category: "implementation" }]);
    if (!submitted.allowed) throw new Error(submitted.message);
    taskId = submitted.value[0]!.taskId;
  }
  const branch = `task/${key}`;
  if (!options.onCurrentHead) {
    gitSync(world.repo, ["checkout", "-q", "-B", branch, options.startsFrom?.commit ?? world.base]);
    const writeTarget = {
      repositoryIdentity: world.identity,
      branch,
      paths: Object.keys(files),
      declaredParent: "dev",
      baseSha: world.base,
      ...(options.startsFrom === undefined ? {} : { startsFrom: options.startsFrom }),
    };
    harness.cp.audit.record({ kind: "TASK_WRITE_TARGET_RECORDED", runId: run.runId, evidence: { taskId, writeTarget } });
  }
  const head = gitSync(world.repo, ["rev-parse", "HEAD"]);
  const workerSessionId = bindWorker(harness, taskId);
  const opened = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: world.repositoryId,
  });
  if (!opened.allowed) throw new Error(opened.message);
  writeFiles(world.repo, files);
  const commit = commitAll(world.repo, message);
  const inputs: WorkerSuccessDigestInputs = {
    executionId: opened.value.executionId,
    workerSessionId,
    sessionIncarnation: harness.cp.sessions.get(workerSessionId)!.incarnation,
    providerSessionId: "scripted-session",
    exitCode: 0,
    stdoutSha256: sha256(""),
    commitHead: commit,
    diffDigest: "sha256:stand-in-diff",
  };
  const resultDigest = workerSuccessDigest(inputs);
  const closed = harness.cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest }, run.runId);
  if (!closed.allowed) throw new Error(closed.message);
  harness.cp.audit.record({
    kind: WorkerTurnEvent.SUCCEEDED,
    runId: run.runId,
    sessionId: workerSessionId,
    evidence: { ...inputs, resultDigest, taskId, head, paths: Object.keys(files), ...(commitlore === null ? {} : { commitlore }) },
  });
  return { taskId, commit, executionId: opened.value.executionId };
};

/** A commit made straight onto the checkout, with no turn and no receipt: one CommitLore never saw. */
const unmanagedCommit = (world: World, message: string): string => {
  writeFiles(world.repo, { "notes.md": `${message}\n` });
  return commitAll(world.repo, message);
};

/** Every ref and what it names, and HEAD (symbolic and resolved): what a refusal must leave as it was. */
const refsAndHead = (repo: string): string =>
  [
    gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    gitSync(repo, ["symbolic-ref", "-q", "HEAD"]),
    gitSync(repo, ["rev-parse", "HEAD"]),
  ].join("\n");

const currentCandidateOf = (world: World): string | null =>
  world.harness.cp.db.get<{ digest: string | null }>(`SELECT current_candidate_digest AS digest FROM runs WHERE run_id = ?`, [world.run.runId])?.digest ?? null;

const frozenRows = (world: World) => world.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === world.run.runId);

/** What a freeze can leave behind in ACP's own storage: audit rows and verification worktrees. */
const persistentRows = (world: World) => ({
  audit: world.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events`)!.n,
  worktrees: world.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM verification_worktrees`)!.n,
});

/**
 * The freeze is refused as `reasonCode` naming `commit` and `refusal`, and nothing is written or moved: no ref,
 * no HEAD, and (unless the refusal is one only an inconsistency after integration can reach) no audit row and no
 * verification worktree either.
 */
const expectRefusedUnchanged = async (
  world: World,
  expected: { reasonCode: string; commit?: string; refusal: string },
  options: { afterIntegration?: boolean } = {},
) => {
  const repos = [world.repo, ...(world.second === null ? [] : [world.second.repo])];
  const before = repos.map(refsAndHead);
  const rows = persistentRows(world);
  const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
  expect(frozen, JSON.stringify(frozen)).toMatchObject({
    allowed: false,
    reasonCode: expected.reasonCode,
    evidence: { runId: world.run.runId, refusal: expected.refusal, ...(expected.commit === undefined ? {} : { commit: expected.commit }) },
  });
  expect(repos.map(refsAndHead)).toEqual(before);
  if (!options.afterIntegration) expect(persistentRows(world)).toEqual(rows);
  expect(currentCandidateOf(world)).toBeNull();
  expect(frozenRows(world)).toEqual([]);
  return frozen;
};

const freezeAllowed = async (world: World) => {
  const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
  if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence)}`);
  return frozen.value;
};

describe("#1268: a governed freeze holds only commits CommitLore accounts for", () => {
  it("GREEN — a worker commit whose Record-Id trailers are exactly the ones its receipt names is frozen", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme\n\nWarn: readers see one\nRecord-Id: r-0123456789ab", recorded("r-0123456789ab"));
    const value = await freezeAllowed(world);
    expect(value.repositories[0]!.candidateHead).toBe(one.commit);
  });

  it("GREEN — a verified empty worker commit (no Record-Id, outcome empty) is frozen", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const value = await freezeAllowed(world);
    expect(value.repositories[0]!.candidateHead).toBe(one.commit);
  });

  it("GREEN — a multi-task freeze: two worker commits joined by the integration merge this freeze checked and bound", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme\n\nRecord-Id: r-aaaaaaaaaaaa", recorded("r-aaaaaaaaaaaa"));
    const two = workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    const value = await freezeAllowed(world);
    const head = value.repositories[0]!.candidateHead;
    const parents = gitSync(world.repo, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
    expect(parents).toHaveLength(2);
    expect(value.repositories[0]!.integration?.tasks.map((task) => task.commit).sort()).toEqual([one.commit, two.commit].sort());
    const evidence = frozenRows(world).at(-1)?.evidence as { repositories: Array<Record<string, unknown>> };
    expect(evidence.repositories[0]).toMatchObject({ commitloreMergeChecks: [{ commit: head, parents }] });
  });

  it("UNCHANGED — a run whose contract does not require CommitLore freezes an unmanaged commit on top, as before", async () => {
    const world = await worldOf("preferred");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", null);
    const onTop = unmanagedCommit(world, "on top of the task");
    const value = await freezeAllowed(world);
    expect(value.repositories[0]!.candidateHead).toBe(onTop);
    expect("integration" in value.repositories[0]!).toBe(false);
  });

  it("(a) refused — an unmanaged commit stacked on a worker commit; refs and HEAD unchanged", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const onTop = unmanagedCommit(world, "on top of the task");
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: onTop, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("(b) refused — a forged Record-Id trailer on a commit no turn made; refs and HEAD unchanged", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const forged = unmanagedCommit(world, "looks recorded\n\nWarn: trust me\nRecord-Id: r-feedfacecafe");
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: forged, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("refused — a worker commit carrying a Record-Id its receipt does not name (receipt says empty)", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme\n\nRecord-Id: r-feedfacecafe", EMPTY);
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: one.commit, refusal: "RECORD_IDS_MISMATCH" });
  });

  it("refused — a receipt whose CommitLore evidence is another commit's (its Record-Id, not this commit's)", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme\n\nRecord-Id: r-111111111111", recorded("r-222222222222"));
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: one.commit, refusal: "RECORD_IDS_MISMATCH" });
  });

  it("refused — a commit copying a worker commit's Record-Id, with no receipt of its own", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme\n\nRecord-Id: r-333333333333", recorded("r-333333333333"));
    const copied = unmanagedCommit(world, "copy\n\nRecord-Id: r-333333333333");
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: copied, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("refused — evidence from another run: a SUCCEEDED receipt of a different run names the stacked commit", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    // A second run of the same project, whose own SUCCEEDED receipt names a commit stacked on this run's.
    const other = await dispatchedRun(world.harness, world.projectId, world.repositoryId);
    expect(other.runId).not.toBe(world.run.runId);
    const stacked = workerCommit(world, "notes", { "notes.md": "other run\n" }, "other run's turn", EMPTY, { onCurrentHead: true, run: other });
    expect(gitSync(world.repo, ["rev-parse", "HEAD"])).toBe(stacked.commit);
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: stacked.commit, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("refused — a worker receipt with no CommitLore evidence, or with an outcome CommitLore does not give", async () => {
    const missing = await worldOf("required");
    const bare = workerCommit(missing, "readme", { "README.md": "# one\n" }, "update readme", null);
    await expectRefusedUnchanged(missing, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: bare.commit, refusal: "COMMITLORE_EVIDENCE_MISSING" });

    const unknown = await worldOf("required", "cl-freeze-unknown");
    const odd = workerCommit(unknown, "readme", { "README.md": "# one\n" }, "update readme", { outcome: "skipped", recordIds: [], nonce: null });
    await expectRefusedUnchanged(unknown, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: odd.commit, refusal: "COMMITLORE_OUTCOME_UNKNOWN" });
  });

  it("refused — a merge of two task commits made by hand in the checkout, which no check of this freeze was bound to", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    gitSync(world.repo, ["merge", "-q", "--no-ff", "--no-edit", "task/readme"]);
    const merge = gitSync(world.repo, ["rev-parse", "HEAD"]);
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: merge, refusal: "MERGE_NOT_CHECKED" });
  });

  /** Two sibling tasks, and a third depending on both whose base is their predecessor-base merge (#1242). */
  const dependentOnTwo = async (world: World) => {
    const readme = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const app = workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    const docs = submitTask(world, "docs", ["update readme", "update app"]);
    const based = await world.harness.cp.pipeline.predecessorBase({
      runId: world.run.runId,
      taskId: docs,
      predecessors: [readme.taskId, app.taskId],
      repositoryIdentity: world.identity,
      checkoutPath: world.repo,
      baseSha: world.base,
    });
    if (!based.allowed || based.value === null) throw new Error(`predecessor base: ${JSON.stringify(based)}`);
    expect(gitSync(world.repo, ["rev-list", "--parents", "-n", "1", based.value.commit]).split(" ").slice(1).sort()).toEqual([readme.commit, app.commit].sort());
    return { readme, app, docs, startsFrom: based.value };
  };

  it("GREEN — a dependent task on two same-repo predecessors, frozen from checkout HEAD holding their recorded predecessor-base merge", async () => {
    const world = await worldOf("required");
    const { docs, startsFrom } = await dependentOnTwo(world);
    const made = workerCommit(world, "docs", { "notes.md": "docs\n" }, "update docs", EMPTY, { taskId: docs, startsFrom });
    expect(gitSync(world.repo, ["rev-parse", "HEAD^"])).toBe(startsFrom.commit);
    const value = await freezeAllowed(world);
    expect(value.repositories[0]!.candidateHead).toBe(made.commit);
    expect("integration" in value.repositories[0]!).toBe(false);
  });

  it("refused — a hand-made merge at the predecessor base's position, which is not the base ACP recorded and checked", async () => {
    const world = await worldOf("required");
    const { readme, docs, startsFrom } = await dependentOnTwo(world);
    gitSync(world.repo, ["checkout", "-q", "-B", "by-hand", readme.commit]);
    gitSync(world.repo, ["merge", "-q", "--no-ff", "--no-edit", "task/app"]);
    const byHand = gitSync(world.repo, ["rev-parse", "HEAD"]);
    expect(byHand).not.toBe(startsFrom.commit);
    workerCommit(world, "docs", { "notes.md": "docs\n" }, "update docs", EMPTY, { taskId: docs, startsFrom: { ...startsFrom, commit: byHand } });
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: byHand, refusal: "MERGE_NOT_CHECKED" });
  });

  it("refused — an integration merge listed as checked whose binding is not that commit's tree: being listed is not enough", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    hooks.tamperChecks = (checks) => checks.map((check) => ({ ...check, tree: world.base }));
    // Only an inconsistency inside ACP reaches this after integration, so its worktree is already on record.
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, refusal: "MERGE_NOT_BOUND" }, { afterIntegration: true });
  });

  it("P2-1 refused before any persistent effect — two sibling commits needing integration, one receipt with no CommitLore evidence", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const bare = workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", null);
    // HEAD is task two's branch, which does not hold task one's commit: this freeze would integrate them.
    expect(() => gitSync(world.repo, ["merge-base", "--is-ancestor", "task/readme", "HEAD"])).toThrow();
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: bare.commit, refusal: "COMMITLORE_EVIDENCE_MISSING" });
  });

  it("P2-2 refused — an unmanaged commit appended to the checkout when the freeze starts planning its candidate ref", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const app = workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    let moved: string | null = null;
    hooks.atRefPlan = () => {
      moved = unmanagedCommit(world, "appended while the ref is planned");
    };
    const refsBefore = gitSync(world.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/acp/"]);
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED,
      evidence: { refusal: "HEAD_MOVED", expectedCheckoutHead: app.commit, observedCheckoutHead: moved },
    });
    expect(gitSync(world.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/acp/"])).toBe(refsBefore);
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
  });

  it("R2 refused — an unmanaged commit appended when the freeze starts applying its candidate ref: the ref it applied is undone", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const app = workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    let moved: string | null = null;
    hooks.atRefApply = () => {
      moved = unmanagedCommit(world, "appended while the ref is applied");
    };
    const refsBefore = gitSync(world.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED,
      evidence: { refusal: "HEAD_MOVED", expectedCheckoutHead: app.commit, observedCheckoutHead: moved, leftoverRefs: [] },
    });
    // The ref was applied (once) and then undone (a second application): every ref is as it was, but the branch the
    // appended commit itself moved.
    expect(hooks.refApplies).toBe(2);
    const others = (listed: string): string => listed.split("\n").filter((line) => !line.startsWith("refs/heads/task/app ")).join("\n");
    const refsAfter = gitSync(world.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    expect(others(refsAfter)).toBe(others(refsBefore));
    expect(refsAfter).toContain(`refs/heads/task/app ${moved}`);
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
  });

  it("R2 refused — the same, when undoing the applied ref fails: still refused, naming the ref left behind", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    hooks.atRefApply = () => {
      unmanagedCommit(world, "appended while the ref is applied");
    };
    hooks.failRefApplyAt = 2;
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED, evidence: { refusal: "HEAD_MOVED" } });
    const leftover = frozen.allowed ? [] : (frozen.evidence["leftoverRefs"] as string[]);
    expect(leftover).toHaveLength(1);
    expect(leftover[0]).toMatch(new RegExp(`^refs/acp/candidates/${world.run.runId}/`));
    expect(gitSync(world.repo, ["for-each-ref", "--format=%(refname)", "refs/acp/candidates/"])).toBe(leftover[0]);
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
  });

  it("R2 P1 refused — a worker commit of one repository fetched into another, which has no receipt for it", async () => {
    const world = await worldOf("required", "cl-freeze-two", { second: true });
    const readme = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    const second = world.second!;
    expect(gitSync(second.repo, ["rev-parse", "dev"])).toBe(world.base);
    gitSync(second.repo, ["fetch", "-q", world.repo, "task/readme:refs/heads/fetched"]);
    gitSync(second.repo, ["checkout", "-q", "fetched"]);
    expect(gitSync(second.repo, ["rev-parse", "HEAD"])).toBe(readme.commit);
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: readme.commit, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("R2 P2 refused before any repository's integration writes — one repository integrates two tasks, another holds an unmanaged commit", async () => {
    const world = await worldOf("required", "cl-freeze-two", { second: true });
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    const second = world.second!;
    gitSync(second.repo, ["checkout", "-q", "-b", "elsewhere"]);
    writeFiles(second.repo, { "notes.md": "unmanaged\n" });
    const foreign = commitAll(second.repo, "unmanaged in the second repository");
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, commit: foreign, refusal: "NOT_A_RUN_WORKER_COMMIT" });
  });

  it("R3 refused before any repository's integration writes — another repository's HEAD commit object cannot be read", async () => {
    const world = await worldOf("required", "cl-freeze-two", { second: true });
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    const second = world.second!;
    gitSync(second.repo, ["checkout", "-q", "-b", "broken"]);
    writeFiles(second.repo, { "notes.md": "lost\n" });
    const lost = commitAll(second.repo, "a commit whose object is then lost");
    rmSync(join(second.repo, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    expect(() => gitSync(second.repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])).toThrow();
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_RANGE_UNVERIFIABLE, refusal: "OBJECT_UNREADABLE" });
  });

  it("R4 refused — one repository's HEAD moves while the final check reads another's: no artifact, promotion or CANDIDATE_FROZEN", async () => {
    const world = await worldOf("required", "cl-freeze-two", { second: true });
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    const read: string[] = [];
    let moved: string | null = null;
    // Once the candidate ref is being applied, the next HEAD reads are the final check's: the first repository it
    // reads moves while it reads the second.
    hooks.atRefApply = () => {
      hooks.duringHeadRead = (checkoutPath) => {
        read.push(checkoutPath);
        if (read.length !== 2) return;
        hooks.duringHeadRead = null;
        writeFiles(read[0]!, { "notes.md": "moved while another repository is read\n" });
        moved = commitAll(read[0]!, "moved while another repository is read");
      };
    };
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(read).toHaveLength(2);
    expect(read[0]).not.toBe(read[1]);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED,
      evidence: { refusal: "HEAD_MOVED", observedCheckoutHead: moved, leftoverRefs: [] },
    });
    expect(world.harness.cp.artifacts.latest(world.run.runId, "CANDIDATE_SNAPSHOT")).toBeNull();
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
    expect(gitSync(world.repo, ["for-each-ref", "--format=%(refname)", "refs/acp/candidates/"])).toBe("");
  });

  it("R4 what an integration-then-refusal leaves is never taken up: a new freeze and its verification make their own", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    workerCommit(world, "app", { "src/app.js": "module.exports = () => 2;\n" }, "update app", EMPTY);
    hooks.atRefApply = () => {
      unmanagedCommit(world, "appended while the ref is applied");
    };
    const db = world.harness.cp.db;
    const refused = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED });
    // What it left: its integration worktree ended (DESTROYED, its directory gone), its claims released, and no
    // candidate, CANDIDATE_FROZEN, merge-check record or candidate ref.
    const worktreesOf = () => db.all<{ worktree_id: string; state: string; worktree_path: string; command_id: string }>(
      `SELECT worktree_id, state, worktree_path, command_id FROM verification_worktrees WHERE run_id = ? ORDER BY worktree_id`, [world.run.runId]);
    const left = worktreesOf();
    expect(left.map((row) => [row.command_id, row.state])).toEqual([["candidate-integration", "DESTROYED"]]);
    expect(left.every((row) => !existsSync(row.worktree_path))).toBe(true);
    expect(gitSync(world.repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(db.all<{ status: string }>(`SELECT status FROM resource_claims WHERE run_id = ?`, [world.run.runId]).every((row) => row.status === "RELEASED")).toBe(true);
    expect(world.harness.cp.artifacts.latest(world.run.runId, "CANDIDATE_SNAPSHOT")).toBeNull();
    expect(frozenRows(world)).toEqual([]);
    expect(world.harness.cp.audit.byKind("PREDECESSOR_BASE_MERGES_CHECKED")).toEqual([]);
    expect(gitSync(world.repo, ["for-each-ref", "--format=%(refname)", "refs/acp/"])).toBe("");

    // A new, valid freeze: its own integration worktree, its own merge check, its own candidate.
    const snapshot = await freezeAllowed(world);
    const head = snapshot.repositories[0]!.candidateHead;
    const afterFreeze = worktreesOf();
    expect(afterFreeze.filter((row) => left.some((old) => old.worktree_id === row.worktree_id))).toEqual(left);
    expect(afterFreeze.filter((row) => !left.some((old) => old.worktree_id === row.worktree_id)).map((row) => [row.command_id, row.state]))
      .toEqual([["candidate-integration", "DESTROYED"]]);
    const evidence = frozenRows(world).at(-1)?.evidence as { candidateSnapshotDigest: string; repositories: Array<Record<string, unknown>> };
    expect(evidence.repositories[0]).toMatchObject({ commitloreMergeChecks: [{ commit: head }] });
    expect(currentCandidateOf(world)).toBe(evidence.candidateSnapshotDigest);

    // Its verification runs on that candidate, in worktrees of its own.
    const manifest = world.harness.cp.projects.activeManifest(world.projectId)!.manifest;
    const verified = await world.harness.cp.verification.verify({
      runId: world.run.runId,
      snapshot,
      commands: manifest.verificationCommands,
      contractDigest: snapshot.contractDigest,
    });
    expect(verified, JSON.stringify(verified).slice(0, 600)).toMatchObject({ allowed: true, value: { candidateSnapshotDigest: evidence.candidateSnapshotDigest } });
    const results = db.all<{ exact_head: string }>(`SELECT exact_head FROM verification_results WHERE run_id = ?`, [world.run.runId]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => row.exact_head === head)).toBe(true);
    expect(worktreesOf().filter((row) => afterFreeze.some((old) => old.worktree_id === row.worktree_id))).toEqual(afterFreeze);
  });

  it("refused — the checkout's HEAD moved after the check: the checked head is not the one that would be frozen", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    let moved: string | null = null;
    // The third range check is the frozen candidate's own: the task's range and the checkout HEAD's are asked first,
    // before anything is built.
    hooks.afterRangeCheck = (calls) => {
      if (calls !== 3) return;
      hooks.afterRangeCheck = null;
      moved = unmanagedCommit(world, "slipped in after the check");
    };
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CANDIDATE_HEAD_MOVED,
      evidence: { runId: world.run.runId, refusal: "HEAD_MOVED", candidateHead: one.commit, expectedCheckoutHead: one.commit, observedCheckoutHead: moved },
    });
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
  });

  it("refused — the base the freeze pinned is not an ancestor of the candidate head", async () => {
    const world = await worldOf("required");
    workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    // A branch the run never recorded, cut from a commit off the base: the freeze has only the base branch to
    // diff against, and its tip, moved on since, is not in the candidate's history.
    gitSync(world.repo, ["checkout", "-q", "dev"]);
    writeFiles(world.repo, { "notes.md": "dev moved on\n" });
    commitAll(world.repo, "dev moved on");
    gitSync(world.repo, ["checkout", "-q", "-b", "elsewhere", "task/readme"]);
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_RANGE_UNVERIFIABLE, refusal: "BASE_NOT_ANCESTOR" });
  });
});
