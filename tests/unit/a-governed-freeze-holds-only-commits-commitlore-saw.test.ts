import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { commitloreGoverned } from "../../src/bootstrap/commitlore-observation.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type * as Integration from "../../src/run/candidate-integration.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { StartsFrom } from "../../src/run/task-write-target.ts";
import { WorkerTurnEvent, workerSuccessDigest, type WorkerSuccessDigestInputs } from "../../src/run/worker-turn.ts";
import { passingCommitLore } from "../helpers/commitlore-attempt.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
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
  /** Runs after the freeze's CommitLore range check answers, before anything is recorded. */
  afterRangeCheck: null as (() => void) | null,
  /** Rewrites what the integration reports it checked. */
  tamperChecks: null as ((checks: Integration.MergeCheckBinding[]) => Integration.MergeCheckBinding[]) | null,
}));
vi.mock("../../src/run/candidate-integration.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Integration>();
  return {
    ...actual,
    integrateTaskResults: async (input: Parameters<typeof actual.integrateTaskResults>[0]) => {
      const answer = await actual.integrateTaskResults(input);
      if (hooks.tamperChecks === null || !answer.allowed || answer.value === null) return answer;
      return { ...answer, value: { ...answer.value, commitloreMergeChecks: hooks.tamperChecks(answer.value.commitloreMergeChecks) } };
    },
    foreignCandidateCommit: async (input: Parameters<typeof actual.foreignCandidateCommit>[0]) => {
      const answer = await actual.foreignCandidateCommit(input);
      hooks.afterRangeCheck?.();
      return answer;
    },
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  hooks.afterRangeCheck = null;
  hooks.tamperChecks = null;
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

const worldOf = async (mode: "required" | "preferred", projectId = `cl-freeze-${mode}`) => {
  const harness = makeHarness();
  const { repositoryId, identity } = await registerFixtureProject(harness, projectId, { commitlore: { mode } });
  bindCeo(harness);
  const run = await dispatchedRun(harness, projectId, repositoryId);
  // The integration's merge messages get CommitLore's check; this double passes every one.
  harness.cp.pipeline.attach({ commitlore: passingCommitLore() });
  expect(commitloreGoverned(harness.cp.db, run.runId)).toBe(mode === "required");
  return { harness, run, projectId, repositoryId, identity, repo: harness.repoPath, base: gitSync(harness.repoPath, ["rev-parse", "dev"]) };
};

const dispatchedRun = async (harness: ReturnType<typeof makeHarness>, projectId: string, repositoryId: string) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
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

/** The freeze is refused as `reasonCode` naming `commit` and `refusal`, and nothing is written or moved. */
const expectRefusedUnchanged = async (world: World, expected: { reasonCode: string; commit?: string; refusal: string }) => {
  const before = refsAndHead(world.repo);
  const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
  expect(frozen, JSON.stringify(frozen)).toMatchObject({
    allowed: false,
    reasonCode: expected.reasonCode,
    evidence: { runId: world.run.runId, refusal: expected.refusal, ...(expected.commit === undefined ? {} : { commit: expected.commit }) },
  });
  expect(refsAndHead(world.repo)).toBe(before);
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
    await expectRefusedUnchanged(world, { reasonCode: ReasonCode.CANDIDATE_FOREIGN_COMMIT, refusal: "MERGE_NOT_BOUND" });
  });

  it("refused — the checkout's HEAD moved after the check: the checked head is not the one that would be frozen", async () => {
    const world = await worldOf("required");
    const one = workerCommit(world, "readme", { "README.md": "# one\n" }, "update readme", EMPTY);
    let moved: string | null = null;
    hooks.afterRangeCheck = () => {
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
