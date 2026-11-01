import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { COMMITLORE_LIMITS, commitloreRunner, checkGeneratedCommitMessage, createCommitLoreCliPort } from "../../src/bootstrap/commitlore-observation.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import type * as Integration from "../../src/run/candidate-integration.ts";
import { CANDIDATE_REF_NAMESPACE } from "../../src/run/candidate-integration.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { writeCommitLoreInstall } from "../helpers/commitlore-install.ts";
import { latestRelease } from "../helpers/commitlore-release.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

/**
 * #1268 review r2 P1 — a merge commit the freeze's integration makes (`commit-tree` with two parents over a
 * private index) is one no session produced and CommitLore has no command to make or bind, so before it exists
 * its exact message gets CommitLore's commit-msg check (`checkGeneratedCommitMessage`): a refusal means it is
 * not made and the freeze is refused. A pass is a message check, not a capture: nothing is recorded on the
 * merge, and the frozen candidate's audit says only how many merge messages were checked.
 *
 * The run here is a fixture project's, whose contract does not require CommitLore, so the consideration a
 * required run's freeze passes (`CandidatePipeline`'s `checkMergeMessages`) is given to the integration by the
 * one stand-in below; everything else is the real CTO socket, worker runner, pipeline and verification.
 */

const injected = vi.hoisted(() => ({ consider: null as Integration.CheckMergeMessage | null }));
vi.mock("../../src/run/candidate-integration.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Integration>();
  return {
    ...actual,
    integrateTaskResults: (input: Parameters<typeof actual.integrateTaskResults>[0]) =>
      actual.integrateTaskResults(injected.consider === null ? input : { ...input, checkMessage: injected.consider }),
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  injected.consider = null;
});

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
}

const README = { key: "readme", title: "update readme", category: "docs" as const, spec: { writeTarget: { paths: ["README.md"] } } };
const APP = { key: "app", title: "update app", category: "implementation" as const, spec: { writeTarget: { paths: ["src/app.js"] } } };

const standardRun = async (f: BootstrapRuntimeFixture, projectId: string) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  const sessionId = bound.value.sessionId;
  const repository = cp.db.get<{ repository_id: string; checkout_path: string }>(`SELECT repository_id, checkout_path FROM repositories WHERE project_id = ?`, [projectId])!;
  const created = cp.runs.create({
    projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract: {
      goal: "update the project",
      why: "changes in one run",
      scope: ["README.md", "src/app.js"],
      nonGoals: [],
      acceptance: ["the files change"],
      priority: "NORMAL" as const,
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, [README, APP]);
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return { runId, sessionId, ids: { readme: submitted.value[0]!.taskId, app: submitted.value[1]!.taskId }, repo: f.harness.repoPath, checkoutPath: repository.checkout_path };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const workerDoing = (f: BootstrapRuntimeFixture): FakeWorkerAdapter => {
  const fake = new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

const runToSuccess = async (f: BootstrapRuntimeFixture, s: StandardRun, worker: FakeWorkerAdapter, taskId: string, script: FakeTurnScript) => {
  worker.script = script;
  const provisioned = await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });
  expect(provisioned).toMatchObject({ ok: true });
  const target = (provisioned["value"] as { writeTarget: WriteTarget }).writeTarget;
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
};

/** Two tasks on sibling branches, so their candidate is one merge commit the integration makes. */
const twoTasks = async (f: BootstrapRuntimeFixture, projectId: string): Promise<StandardRun> => {
  const s = await standardRun(f, projectId);
  const worker = workerDoing(f);
  try {
    await runToSuccess(f, s, worker, s.ids.app, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
    await runToSuccess(f, s, worker, s.ids.readme, { writes: { "README.md": "# task one\n" } });
  } finally {
    worker.killAll();
  }
  return s;
};

const candidateRefsOf = (repo: string, runId: string): string =>
  gitSync(repo, ["for-each-ref", "--format=%(refname) %(objectname)", `${CANDIDATE_REF_NAMESPACE}/${runId}/`]);

const realCommitLore = (): string | null => {
  const explicit = process.env["ACP_TEST_REAL_COMMITLORE"];
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const directory of (process.env["PATH"] ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
    try {
      accessSync(join(directory, "commitlore"), constants.X_OK);
      return join(directory, "commitlore");
    } catch {
      // not here
    }
  }
  return null;
};
const REAL = realCommitLore();

describe("#1268 review r2 P1: an integration merge commit's message is checked by CommitLore before it is made", () => {
  it("a merge whose message CommitLore's check refuses is not made: the freeze is refused and no candidate is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await twoTasks(f, "cl-merge-refused");
      const asked: string[] = [];
      injected.consider = async ({ message }) => {
        asked.push(message);
        return deny(ReasonCode.VERIFICATION_GAP, "CommitLore's commit-msg check refused this message, so the commit is not made", {
          refusal: "COMMITLORE_MESSAGE_REFUSED",
        });
      };
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      expect(frozen, JSON.stringify(frozen)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_MESSAGE_REFUSED" } });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^Integrate: /);
      expect(candidateRefsOf(s.repo, s.runId)).toBe("");
      expect(f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId)).toEqual([]);
    });
  });

  it.skipIf(REAL === null)("the real CLI passes the integration's clean message, the merge is made with no record, and the freeze's audit counts the check", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await twoTasks(f, "cl-merge-clean");
      const version = execFileSync(REAL as string, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
      const port = createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string, latestRelease(version)));
      injected.consider = (input) => checkGeneratedCommitMessage(port, input);
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence)}`);
      const head = frozen.value.repositories[0]!.candidateHead;
      expect(gitSync(s.repo, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1)).toHaveLength(2);
      expect(gitSync(s.repo, ["log", "-1", "--format=%B", head])).not.toContain("Record-Id:");
      const evidence = f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId).at(-1)?.evidence;
      const parents = gitSync(s.repo, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
      expect((evidence?.["repositories"] as Array<Record<string, unknown>>)[0]).toMatchObject({
        integratedTasks: 2,
        commitloreMergeChecks: [{ commit: head, parents, tree: gitSync(s.repo, ["rev-parse", `${head}^{tree}`]) }],
      });
    });
  }, 180_000);

  /**
   * The reviewer's instrumentation: a CommitLore whose `validate` reports what its git sees — the index it was
   * given, the staged diff against the worktree's HEAD, the git dir — and, in `tamper` mode, adds a path to that
   * index while it checks. Its other answers are a supported CLI's.
   */
  const instrumented = (mode: "observe" | "tamper") => {
    const dir = tempDir("acp-1268-merge-instrument-");
    const log = join(dir, "validate.jsonl");
    const { wrapper } = writeCommitLoreInstall(
      dir,
      `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const answer = (text) => process.stdout.write(text, () => process.exit(0));
if (argv.join(' ') === '--version') return answer('1.7.3\\n');
if (argv.join(' ') === 'doctor --help') return answer('Usage: commitlore doctor [options]\\n\\nOptions:\\n  --json  emit the report as JSON\\n');
if (argv.join(' ') === 'init --help') return answer('Usage: commitlore init [options]\\n\\nOptions:\\n  --mcp-scope <scope>  where\\n  --no-unattended      off\\n  --no-agent-hooks     nothing in the tree\\n');
if (argv[0] !== 'validate') return process.stderr.write('unknown ' + argv.join(' ') + '\\n', () => process.exit(2));
const git = (args, input) => spawnSync('git', args, { env: process.env, input: input ?? '', encoding: 'utf8', timeout: 20000 });
const staged = git(['diff', '--cached', '--name-only']).stdout.split('\\n').filter(Boolean);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ indexFile: process.env.GIT_INDEX_FILE ?? null, gitDir: process.env.GIT_DIR ?? null, staged, message: fs.readFileSync(argv[argv.indexOf('--message-file') + 1], 'utf8') }) + '\\n');
if (${JSON.stringify(mode)} === 'tamper') {
  const blob = git(['hash-object', '-w', '--stdin'], 'stray\\n').stdout.trim();
  git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',stray.txt']);
}
answer(JSON.stringify({ examined: 1, checks: [], violations: [], secrets: [] }) + '\\n');
`,
      { version: "1.7.3" },
    );
    const port = createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, wrapper, latestRelease("1.7.3")));
    const seen = (): Array<{ indexFile: string | null; gitDir: string | null; staged: string[]; message: string }> =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { port, seen };
  };

  it("review r3 P1: the check runs with the merge's own index, whose staged diff is the merge's change; the evidence binds its parents and tree", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await twoTasks(f, "cl-merge-instrumented");
      const { port, seen } = instrumented("observe");
      injected.consider = (input) => checkGeneratedCommitMessage(port, input);
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence)}`);
      const head = frozen.value.repositories[0]!.candidateHead;
      const [check] = seen();
      expect(seen()).toHaveLength(1);
      // Not the registered checkout's empty staged diff: the integration's private index, staging both tasks.
      expect(check!.indexFile).toMatch(/integration\.index$/);
      expect(check!.gitDir).not.toBe(join(s.checkoutPath, ".git"));
      expect(check!.staged.sort()).toEqual(["README.md", "src/app.js"]);
      expect(check!.message.trim()).toMatch(/^Integrate: /);
      const parents = gitSync(s.repo, ["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
      const evidence = f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId).at(-1)?.evidence;
      expect((evidence?.["repositories"] as Array<Record<string, unknown>>)[0]).toMatchObject({
        commitloreMergeChecks: [{ commit: head, parents, tree: gitSync(s.repo, ["rev-parse", `${head}^{tree}`]) }],
      });
    });
  }, 180_000);

  it("review r3 P1 input-swap controls: a check after which the index, a parent's value or order, the tree or the message differs is refused before the merge is made", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await twoTasks(f, "cl-merge-swaps");
      const controls: Array<[string, (input: Parameters<Integration.CheckMergeMessage>[0]) => void, string]> = [
        ["reorders the parents", (input) => input.parents.reverse(), "parents"],
        ["replaces a parent", (input) => { input.parents[1] = input.parents[0]; }, "parents"],
        ["changes the tree", (input) => { input.tree = "0".repeat(40); }, "tree"],
        ["changes the message", (input) => { input.message = `${input.message} (changed)`; }, "message"],
        ["swaps the index for another", (input) => { input.index = `${input.index}.other`; }, "index"],
      ];
      for (const [name, swap, field] of controls) {
        injected.consider = async (input) => {
          swap(input);
          return allow(ReasonCode.OK, undefined);
        };
        const frozen = await f.harness.cp.pipeline.freeze(s.runId);
        expect(frozen, `${name}: ${JSON.stringify(frozen)}`).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_MERGE_UNBOUND", observed: { differing: [field] } } });
        expect(candidateRefsOf(s.repo, s.runId), name).toBe("");
      }
      // Control: the same check, swapping nothing, passes, and the merge is the one it was bound to.
      injected.consider = async () => allow(ReasonCode.OK, undefined);
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
      expect(f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId)).toHaveLength(1);
    });
  }, 300_000);

  it("review r3 P1: a merge whose tree is not the one its check was bound to is refused at freeze, and no candidate is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const s = await twoTasks(f, "cl-merge-tampered");
      const { port, seen } = instrumented("tamper");
      injected.consider = (input) => checkGeneratedCommitMessage(port, input);
      const frozen = await f.harness.cp.pipeline.freeze(s.runId);
      expect(frozen, JSON.stringify(frozen)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_MERGE_UNBOUND", observed: { differing: ["index", "tree"] } } });
      expect(seen()).toHaveLength(1);
      expect(candidateRefsOf(s.repo, s.runId)).toBe("");
      expect(f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === s.runId)).toEqual([]);
    });
  }, 180_000);
});
