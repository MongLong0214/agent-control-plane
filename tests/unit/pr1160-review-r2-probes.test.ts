import { RunState } from "../../src/domain/types.ts";
import { rmSync } from "node:fs";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { commandsForMode } from "../../src/contracts/manifest.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import type { BranchProfile } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter } from "../helpers/worker-turn-fixture.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * PR #1160 review r2 (BLOCK at a6e7b1e6): the reviewer's repair-review probes, ported as written. The
 * two that failed at a6e7b1e6 are S-TB-03 (a failed creation's intent authorised a foreign branch on
 * retry) and S-TB-07 (a late dirty refusal left the created ref); the rest passed there and still do,
 * including S-TB-06 end to end (real worker commit, freeze, verification, PR preparation against the
 * GitHub double) for dev and main-only. Changed only to drop unused imports and helpers for lint. The
 * header the reviewer carried over from the r1 port follows.
 *
 * PR #1159 review r1 (BLOCK at fc52cb92), the reviewer's nine probes ported as written: R1–R8 are the
 * eight requirement witnesses (S-TB-01..08) that failed at fc52cb92, R9 the rollback witness that
 * passed. Changed from the reviewer's file only where noted: its imports moved to the top, `any`
 * typed, and R4's two assertions that recorded fc52cb92's divergent bases replaced by the one base the
 * requirement asks for. The reviewer's description of S-TB follows.
 *
 * #512 S-TB (CEO 0a16329c, f5879479) — a STANDARD_WORK task gets its own work branch, made by the
 * control plane:
 *
 * - one canonical write target per task (repository, branch, declared parent, paths, the run's pinned
 *   base commit) is recorded when its first worker is provisioned, into the task's spec that
 *   contract_get answers, and the claim and the runner name that same value;
 * - a task planned before the field existed (the live task_e959ee8b: a docs task, no writeTarget, a
 *   main-only repository) gets it the same way, derived from its contract's one declared file;
 * - the work branch's class is one policy point: `task/<id>-<slug>` from dev in a dev-bearing
 *   profile, `hotfix/<id>-<slug>` from main in a main-only one, anything else refused by name; the
 *   pair passes the branch contract the PR is checked against;
 * - before the first execution the branch is created at the pinned base, never at the base branch's
 *   moving name, as a guard-approved GIT_BRANCH write on a clean, owned checkout, and checked out; an
 *   existing branch of the same run and task is re-entered, a foreign or diverged one is refused and
 *   left as it is; a dirty checkout is refused with its change intact; the base branch is never
 *   written, nothing is pushed or forced.
 *
 * Over the real CTO MCP socket, the real claim registry, guard and worker runner, in scratch
 * repositories only. Stood in: the WORKER provider (the Claude double, which launches no process, so
 * a started execution ends FAILED) and its capacity admission. Literals stand for the new exports so
 * a tree without them fails on behaviour, not on a missing name.
 */

const PREPARED = "TASK_BRANCH_PREPARED";
const IDENTITY = "github:acme/fixture";

const DEV_BEARING: BranchProfile = fixtureManifest("profile").branchProfile;


interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  declaredParent: string;
  baseSha: string;
}

const contractFor = (scope: string[]) => ({
  goal: "update the README",
  why: "one documentation change",
  scope,
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
});

interface TaskInput {
  key: string;
  title: string;
  category: "docs" | "implementation";
  spec?: Record<string, unknown>;
}

/**
 * A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, its tasks as its PLAN left them, and the real
 * worker path with only the provider and its capacity admission stood in.
 */
const standardRun = async (
  f: BootstrapRuntimeFixture,
  projectId: string,
  options: { tasks: TaskInput[]; profile?: BranchProfile; base?: string; scope?: string[] },
) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId, options.profile ? { branchProfile: options.profile } : {});
  const bootstrap = await f.dispatchBootstrap();
  const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  const sessionId = bound.value.sessionId;
  const repository = cp.db.get<{ repository_id: string; checkout_path: string }>(
    `SELECT repository_id, checkout_path FROM repositories WHERE project_id = ?`,
    [projectId],
  )!;
  const created = cp.runs.create({
    projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract: contractFor(options.scope ?? ["README.md"]),
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: options.base ?? "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(sessionId, turns + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const submitted = cp.tasks.submit(runId, options.tasks.map((task) => ({ ...task, spec: task.spec ?? {} })));
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return {
    runId,
    sessionId,
    bootstrapRunId: bootstrap.runId,
    taskIds: submitted.value.map((task) => task.taskId),
    repo: f.harness.repoPath,
    checkoutPath: repository.checkout_path,
  };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const provision = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) =>
  f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });

const targetOf = (answer: Record<string, unknown>): WriteTarget =>
  (answer["value"] as { writeTarget: WriteTarget }).writeTarget;

const claimTarget = async (f: BootstrapRuntimeFixture, s: StandardRun, target: Pick<WriteTarget, "repositoryIdentity" | "branch" | "paths">) => {
  const answer = await f.cto(s.sessionId, "resource_claim", {
    runId: s.runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });
  expect(answer).toMatchObject({ ok: true });
  return (answer["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims
    .find((claim) => claim.worktreeId !== null)!.claimId;
};

const runTask = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string, claimId: string, as: string = s.sessionId) =>
  f.cto(as, "task_worker_run", { runId: s.runId, taskId, claimId });

const settle = async (f: BootstrapRuntimeFixture, answer: Record<string, unknown>): Promise<string> => {
  const executionId = (answer["value"] as { executionId: string }).executionId;
  await f.harness.cp.workerTurns.settled(executionId);
  return executionId;
};

const refOf = (repo: string, ref: string): string | null => {
  try {
    return gitSync(repo, ["rev-parse", "--verify", "-q", ref]);
  } catch {
    return null;
  }
};
const branchOf = (repo: string): string => gitSync(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);

const events = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
  f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId).map((row) => row.evidence);


/** Provisions the task's worker and claims the write target the control plane recorded for it. */
const staffAndClaim = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) => {
  const provisioned = await provision(f, s, taskId);
  expect(provisioned).toMatchObject({ ok: true });
  const target = targetOf(provisioned);
  const claimId = await claimTarget(f, s, target);
  return { target, claimId };
};



it("S-TB-03 creation intent from a failed create cannot authorize a foreign branch on retry", async () => {
 await withBootstrapRuntime(async f => {
  const cp=f.harness.cp;
  const s=await standardRun(f,"r2-create-collision",{tasks:[{key:"one",title:"update readme",category:"docs",spec:{writeTarget:{paths:["README.md"]}}}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  const record=cp.audit.record.bind(cp.audit);
  let injected=false;
  const spy=vi.spyOn(cp.audit,"record").mockImplementation(entry=>{
   const result=record(entry);
   if(entry.kind==="TASK_BRANCH_CREATING" && !injected){injected=true;gitSync(s.repo,["branch",target.branch,target.baseSha]);}
   return result;
  });
  const first=await runTask(f,s,s.taskIds[0]!,claimId);
  expect(first).toMatchObject({ok:false,reasonCode:ReasonCode.CONFLICT});
  expect(branchOf(s.repo)).toBe("dev");
  expect(events(f,PREPARED,s.runId)).toEqual([]);
  spy.mockRestore();
  const retry=await runTask(f,s,s.taskIds[0]!,claimId);
  if(retry["ok"]) await settle(f,retry);
  console.error("CREATE_COLLISION",JSON.stringify({first,retry,creating:events(f,"TASK_BRANCH_CREATING",s.runId),branch:branchOf(s.repo)}));
  expect(retry).toMatchObject({ok:false});
  expect(branchOf(s.repo)).toBe("dev");
 });
});

it("S-TB-07 a late dirty refusal preserves all branch refs",async()=>{
 await withBootstrapRuntime(async f=>{
  const cp=f.harness.cp;
  const s=await standardRun(f,"r2-late-dirty",{tasks:[{key:"one",title:"update readme",category:"docs",spec:{writeTarget:{paths:["README.md"]}}}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  writeFiles(s.repo,{"README.md":"# advanced base\n"});
  commitAll(s.repo,"advance base");
  const record=cp.audit.record.bind(cp.audit);
  let injected=false;
  vi.spyOn(cp.audit,"record").mockImplementation(entry=>{
   const result=record(entry);
   if(entry.kind==="TASK_BRANCH_CREATING" && !injected){injected=true;writeFileSync(join(s.repo,"README.md"),"# late user edit\n");}
   return result;
  });
  const refused=await runTask(f,s,s.taskIds[0]!,claimId);
  console.error("LATE_DIRTY",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${target.branch}`)}));
  expect(refused).toMatchObject({ok:false,reasonCode:ReasonCode.CONFLICT});
  expect(readFileSync(join(s.repo,"README.md"),"utf8")).toBe("# late user edit\n");
  expect(branchOf(s.repo)).toBe("dev");
  expect(refOf(s.repo,`refs/heads/${target.branch}`)).toBeNull();
 });
});

it.each(["run","task","repository","branch","base"])("S-TB-03 rejects creation attribution with wrong %s",async field=>{
 await withBootstrapRuntime(async f=>{
  const s=await standardRun(f,`r2-attr-${field}`,{tasks:[{key:"one",title:"update readme",category:"docs",spec:{writeTarget:{paths:["README.md"]}}},{key:"two",title:"other",category:"docs",spec:{writeTarget:{paths:["README.md"]}}}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  gitSync(s.repo,["branch",target.branch,target.baseSha]);
  f.harness.cp.audit.record({kind:"TASK_BRANCH_CREATING",runId:field==="run"?s.bootstrapRunId:s.runId,evidence:{taskId:field==="task"?s.taskIds[1]!:s.taskIds[0]!,repositoryIdentity:field==="repository"?"github:other/repo":IDENTITY,branch:field==="branch"?"task/other":target.branch,baseSha:field==="base"?"0".repeat(40):target.baseSha}});
  expect(await runTask(f,s,s.taskIds[0]!,claimId)).toMatchObject({ok:false,reasonCode:ReasonCode.CONFLICT});
  expect(branchOf(s.repo)).toBe("dev");
 });
});

it("linked checkout prepares and re-enters its owned task branch",async()=>{
 await withBootstrapRuntime(async f=>{
  const original=f.harness.repoPath;
  const linked=tempDir("pr1160-linked-");
  gitSync(original,["checkout","--detach","-q"]);
  gitSync(original,["worktree","add","-q",linked,"dev"]);
  f.harness.repoPath=linked;
  const s=await standardRun(f,"r2-linked",{tasks:[{key:"one",title:"update readme",category:"docs"}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  const ran=await runTask(f,s,s.taskIds[0]!,claimId);
  expect(ran).toMatchObject({ok:true});
  await settle(f,ran);
  expect(branchOf(linked)).toBe(target.branch);
  gitSync(linked,["checkout","-q","dev"]);
  const retry=await runTask(f,s,s.taskIds[0]!,claimId);
  expect(retry).toMatchObject({ok:true});
  await settle(f,retry);
 });
});

it("SHA-256 checkout prepares its task branch at the 64-character pinned SHA",async()=>{
 await withBootstrapRuntime(async f=>{
  const repo=f.harness.repoPath;
  rmSync(join(repo,".git"),{recursive:true,force:true});
  gitSync(repo,["init","-q","--object-format=sha256","--initial-branch=dev"]);
  commitAll(repo,"sha256 initial");
  const s=await standardRun(f,"r2-sha256",{tasks:[{key:"one",title:"update readme",category:"docs"}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  expect(target.baseSha).toHaveLength(64);
  const ran=await runTask(f,s,s.taskIds[0]!,claimId);
  console.error("SHA256_PREPARE",JSON.stringify(ran));
  expect(ran).toMatchObject({ok:true});
  await settle(f,ran);
  expect(refOf(repo,`refs/heads/${target.branch}`)).toBe(target.baseSha);
 });
});

it.each(["dev","main"])("S-TB-06 %s real worker, freeze, verification, PR preparation retain the pin",async base=>{
 const gh=new FakeGitHub();
 await withBootstrapRuntime(async f=>{
  const cp=f.harness.cp;
  if(base==="main") gitSync(f.harness.repoPath,["checkout","-q","-b","main"]);
  const profile=base==="main"?{...DEV_BEARING,defaultBranch:"main",longLived:["main"]}:DEV_BEARING;
  const s=await standardRun(f,`r2-e2e-${base}`,{profile,base,tasks:[{key:"one",title:"update app",category:"implementation",spec:{writeTarget:{paths:["src/app.js"]}}}]});
  const {target,claimId}=await staffAndClaim(f,s,s.taskIds[0]!);
  writeFiles(s.repo,{"README.md":"# base has advanced\n"});
  const advanced=commitAll(s.repo,"advance base");
  const fake=new FakeWorkerAdapter(new GuardedInvocationWriteBroker(cp.guard));
  fake.script={writes:{"src/app.js":"module.exports = () => 2;\n"}};
  vi.spyOn(f.claude,"invoke").mockImplementation(r=>fake.invoke(r));
  try{
   const ran=await runTask(f,s,s.taskIds[0]!,claimId);
   expect(ran).toMatchObject({ok:true});
   expect(cp.tasks.execution(await settle(f,ran))?.status).toBe("SUCCEEDED");
  }finally{fake.killAll();}
  const frozen=await cp.pipeline.freeze(s.runId);
  if(!frozen.allowed)throw new Error(JSON.stringify(frozen));
  const repo=frozen.value.repositories[0]!;
  expect(repo.sourceBranch).toBe(base);
  expect(repo.sourceHead).toBe(target.baseSha);
  const run=cp.runs.require(s.runId);
  const manifest=cp.projects.manifest(run.pinnedManifestDigest!)!;
  const verified=await cp.verification.verify({runId:s.runId,snapshot:frozen.value,commands:commandsForMode(manifest,run.executionMode),contractDigest:run.contractDigest});
  console.error("LINEAGE_VERIFY",base,JSON.stringify(verified));
  expect.soft(verified.allowed).toBe(true);
  // Exercise actual prPrepare and its guard/receipt/readback, with finalization state set by the
  // test. This boundary check does not certify the CEO/review approval workflow.
  expect(cp.runs.transition(s.runId,RunState.READY_FOR_CEO_REVIEW,"boundary fixture").allowed).toBe(true);
  expect(cp.runs.transition(s.runId,RunState.CEO_APPROVED,"boundary fixture").allowed).toBe(true);
  gh.setBranch(base,advanced);gh.setBranch(target.branch,repo.candidateHead);
  const prepared=await cp.github.prPrepare({runId:s.runId,repositoryIdentity:IDENTITY,head:target.branch,base,title:"pinned lineage",body:"review boundary probe",declaredParent:repo.sourceBranch!,exactHeadSha:repo.candidateHead,ownerSessionId:run.ownerSessionId!,ownerBindingGeneration:run.ownerBindingGeneration!,daemonFinalizerAuthority:cp.daemonFinalizationAuthorities().write});
  console.error("LINEAGE_PR",base,JSON.stringify(prepared));
  expect(prepared.allowed).toBe(true);
  const receipt=cp.db.get<{response_json:string}>("SELECT response_json FROM github_receipts WHERE run_id = ? AND operation = 'pr_prepare'",[s.runId]);
  console.error("LINEAGE_RECEIPT",base,receipt);
  expect(receipt).toBeTruthy();
  const intent=JSON.parse(receipt!.response_json).intent;
  expect(intent.sourceHead).toBe(target.baseSha);expect(intent.sourceBranch).toBe(base);
 },{githubClient:gh});
});
