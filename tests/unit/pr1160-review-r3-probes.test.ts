import Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import { delimiter } from "node:path";
import { tempDir } from "../helpers/fixtures.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import type { BranchProfile } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * PR #1160 review r3 (BLOCK at de3721f0, S-TB-07): the reviewer's undo probes, ported as written. Five
 * failed at de3721f0 (a user's concurrent HEAD selection rewritten, an actual completion database error
 * bypassing the undo, a partial read-tree failure taken as "nothing moved", and the backward and forward
 * symbolic-ref failures dropped from the refusal); the rest passed and still do. Changed only to drop
 * unused imports and helpers for lint; the unmodified file is replayed separately with the reviewer's
 * config. The header the reviewer carried over follows.
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

const IDENTITY = "github:acme/fixture";



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




const realGitPath = (): string => {
 for (const dir of (process.env["PATH"] ?? "").split(delimiter)) if (dir && existsSync(join(dir,"git"))) return join(dir,"git");
 throw new Error("no git");
};
const intercept = (match: string, script: (git: string) => string) => {
 const bin=tempDir("r3-git-"); const mark=join(bin,"fired"); const git=realGitPath();
 writeFileSync(join(bin,"git"), `#!/bin/sh\ncase "$*" in *"${match}"*)\nif [ ! -e '${mark}' ]; then : > '${mark}'; ${script(git)}; fi;;\nesac\nexec '${git}' "$@"\n`);
 chmodSync(join(bin,"git"),0o755); const prior=process.env["PATH"]; process.env["PATH"]=`${bin}${delimiter}${prior}`;
 return {restore:()=>{process.env["PATH"]=prior;}, fired:()=>existsSync(mark)};
};
const oneTask = async(f: BootstrapRuntimeFixture, label:string) => {
 const s=await standardRun(f,label,{tasks:[{key:"one",title:"update readme",category:"docs",spec:{writeTarget:{paths:["README.md"]}}}]});
 const taskId=s.taskIds[0]!; return {...s,taskId,...await staffAndClaim(f,s,taskId)};
};
it("R3 S-TB-07 undo preserves a user's concurrent HEAD selection",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-user-head"); gitSync(s.repo,["branch","user-selected",s.target.baseSha]);
  const hook=intercept("task branch HEAD",git=>`'${git}' "$@"; code=$?; '${git}' symbolic-ref HEAD refs/heads/user-selected; exit "$code"`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();}
  expect(hook.fired()).toBe(true);
  console.error("R3_USER_HEAD",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`)}));
  expect(refused).toMatchObject({ok:false});
  expect(branchOf(s.repo)).toBe("user-selected");
 });
});
it("R3 S-TB-07 an actual completion database error safely undoes the switch",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-completion-db-error");
  const raw=new Database(f.harness.cp.db.file);
  raw.exec(`CREATE TRIGGER r3_refuse_completed BEFORE INSERT ON audit_events WHEN NEW.kind = 'TASK_BRANCH_CREATED' BEGIN SELECT RAISE(ABORT, 'r3 injected database error'); END`); raw.close();
  const refused=await runTask(f,s,s.taskId,s.claimId);
  console.error("R3_COMPLETION_THROW",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`),created:events(f,"TASK_BRANCH_CREATED",s.runId)}));
  expect(refused).toMatchObject({ok:false});
  expect.soft(branchOf(s.repo)).toBe("dev");
  expect.soft(refOf(s.repo,`refs/heads/${s.target.branch}`)).toBeNull();
  expect(await runTask(f,s,s.taskId,s.claimId)).toMatchObject({ok:false,reasonCode:ReasonCode.CONFLICT,evidence:{creationAttempted:true}});
 });
});
it("R3 S-TB-07 a partial read-tree failure preserves both tracked files",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-partial-read-tree");
  const readme="# advanced readme\n", app="module.exports = () => 9;\n";
  writeFiles(s.repo,{"README.md":readme,"src/app.js":app}); commitAll(s.repo,"advance both files");
  const hook=intercept("read-tree -m -u",()=>`chmod 555 '${join(s.repo,"src")}'`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();chmodSync(join(s.repo,"src"),0o755);}
  expect(hook.fired()).toBe(true);
  console.error("R3_PARTIAL_READ_TREE",JSON.stringify({refused,branch:branchOf(s.repo),readme:readFileSync(join(s.repo,"README.md"),"utf8"),app:readFileSync(join(s.repo,"src/app.js"),"utf8"),status:gitSync(s.repo,["status","--porcelain"])}));
  expect(refused).toMatchObject({ok:false});
  expect.soft(readFileSync(join(s.repo,"README.md"),"utf8")).toBe(readme);
  expect.soft(readFileSync(join(s.repo,"src/app.js"),"utf8")).toBe(app);
  expect.soft(gitSync(s.repo,["status","--porcelain"])).toBe("");
 });
});
it("R3 S-TB-07 leftOnBranch preserves files when the reverse read-tree really refuses",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-left-on-branch");
  writeFiles(s.repo,{"README.md":"# advanced base\n"}); commitAll(s.repo,"advance base");
  const hook=intercept("task branch HEAD",git=>`'${git}' "$@"; code=$?; printf '# user edit after moving files\\n' > '${join(s.repo,"README.md")}'; exit "$code"`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();}
  expect(hook.fired()).toBe(true);
  console.error("R3_LEFT_ON_BRANCH",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`),created:events(f,"TASK_BRANCH_CREATED",s.runId)}));
  expect(refused).toMatchObject({ok:false,evidence:{leftOnBranch:true,headMoved:true,filesMoved:true}});
  expect(branchOf(s.repo)).toBe(s.target.branch);
  expect(refOf(s.repo,`refs/heads/${s.target.branch}`)).toBe(s.target.baseSha);
  expect(readFileSync(join(s.repo,"README.md"),"utf8")).toBe("# user edit after moving files\n");
 });
});
it.each(["run","task","repository","branch","base"])("R3 S-TB-03 rejects a COMPLETION with wrong %s",async field=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,`r3-completed-${field}`);
  gitSync(s.repo,["branch",s.target.branch,s.target.baseSha]);
  f.harness.cp.audit.record({kind:"TASK_BRANCH_CREATED",runId:field==="run"?s.bootstrapRunId:s.runId,evidence:{taskId:field==="task"?"task_other":s.taskId,repositoryIdentity:field==="repository"?"github:other/repo":IDENTITY,branch:field==="branch"?"task/other":s.target.branch,baseSha:field==="base"?"0".repeat(40):s.target.baseSha}});
  expect(await runTask(f,s,s.taskId,s.claimId)).toMatchObject({ok:false,reasonCode:ReasonCode.CONFLICT});
  expect(branchOf(s.repo)).toBe("dev");
 });
});

it("R3 S-TB-07 a competitor moving the newly created ref is preserved on readback refusal",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-ref-readback");
  writeFiles(s.repo,{"README.md":"# advanced base\n"}); const advanced=commitAll(s.repo,"advance base");
  const hook=intercept("update-ref -m agent-control-plane: task branch refs/heads/",git=>`'${git}' "$@"; code=$?; '${git}' update-ref 'refs/heads/${s.target.branch}' '${advanced}'; exit "$code"`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();}
  expect(hook.fired()).toBe(true);
  console.error("R3_REF_READBACK",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`)}));
  expect(refused).toMatchObject({ok:false});
  expect(branchOf(s.repo)).toBe("dev");
  expect(refOf(s.repo,`refs/heads/${s.target.branch}`)).toBe(advanced);
  expect(gitSync(s.repo,["status","--porcelain"])).toBe("");
  expect(events(f,"TASK_BRANCH_CREATED",s.runId)).toEqual([]);
 });
});
it.each(["back","forward"])("R3 S-TB-07 names the blocker if symbolic-ref %s fails during undo",async which=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,`r3-undo-${which}`);
  writeFiles(s.repo,{"README.md":"# advanced base\n"}); commitAll(s.repo,"advance base");
  const mark=tempDir("r3-undo-stage-"); const switched=join(mark,"switched"); const undone=join(mark,"undone");
  const bin=tempDir("r3-undo-git-"); const git=realGitPath();
  writeFileSync(join(bin,"git"),`#!/bin/sh
case "$*" in
 *"task branch undone HEAD"*)
  : > '${undone}'
  ${which==="back"?"printf 'injected HEAD rollback blocker\\n' >&2; exit 1":":"}
  ;;
 *"task branch HEAD"*)
  if [ ! -e '${switched}' ]; then
   : > '${switched}'; '${git}' "$@"; code=$?
   printf '# user edit blocks reverse\\n' > '${join(s.repo,"README.md")}'
   exit "$code"
  fi
  ${which==="forward"?`if [ -e '${undone}' ]; then printf 'injected HEAD restore blocker\\n' >&2; exit 1; fi`:":"}
  ;;
esac
exec '${git}' "$@"
`); chmodSync(join(bin,"git"),0o755);
  const prior=process.env["PATH"];process.env["PATH"]=`${bin}${delimiter}${prior}`;
  let refused;
  try{refused=await runTask(f,s,s.taskId,s.claimId);}finally{process.env["PATH"]=prior;}
  expect(existsSync(switched)).toBe(true);expect(existsSync(undone)).toBe(true);
  console.error("R3_UNDO_SYMBOLIC_REF",which,JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`),created:events(f,"TASK_BRANCH_CREATED",s.runId),status:gitSync(s.repo,["status","--porcelain"])}));
  expect(refused).toMatchObject({ok:false});
  expect(readFileSync(join(s.repo,"README.md"),"utf8")).toBe("# user edit blocks reverse\n");
  // The refusal must distinguish a failed rollback from an ordinary late edit.
  expect(JSON.stringify(refused)).toContain(which==="back"?"HEAD rollback blocker":"HEAD restore blocker");
 });
});

it("R3 S-TB-07 deletion CAS preserves a ref a competitor changed after the undo read",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-undo-delete-cas");
  writeFiles(s.repo,{"README.md":"# advanced base\n"}); const advanced=commitAll(s.repo,"advance base");
  const record=f.harness.cp.audit.record.bind(f.harness.cp.audit);
  vi.spyOn(f.harness.cp.audit,"record").mockImplementation(entry=>{
   const result=record(entry);
   if(entry.kind==="TASK_BRANCH_CREATING") writeFileSync(join(s.repo,"README.md"),"# user edit before checkout\n");
   return result;
  });
  const hook=intercept("task branch undone -d",git=>`'${git}' update-ref 'refs/heads/${s.target.branch}' '${advanced}'`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();}
  expect(hook.fired()).toBe(true);
  console.error("R3_DELETE_CAS",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`)}));
  expect(refused).toMatchObject({ok:false,evidence:{created:true,refRemoved:false}});
  expect(branchOf(s.repo)).toBe("dev");
  expect(refOf(s.repo,`refs/heads/${s.target.branch}`)).toBe(advanced);
  expect(readFileSync(join(s.repo,"README.md"),"utf8")).toBe("# user edit before checkout\n");
  expect(events(f,"TASK_BRANCH_CREATED",s.runId)).toEqual([]);
 });
});
it("R3 S-TB-07 existing owned branch keeps its ref and user bytes if undo cannot restore files",async()=>{
 await withBootstrapRuntime(async f=>{
  const s=await oneTask(f,"r3-existing-undo");
  const first=await runTask(f,s,s.taskId,s.claimId); expect(first).toMatchObject({ok:true}); await settle(f,first);
  gitSync(s.repo,["checkout","-q","dev"]);
  writeFiles(s.repo,{"README.md":"# advanced base\n"}); commitAll(s.repo,"advance base");
  const hook=intercept("task branch HEAD",git=>`'${git}' "$@"; code=$?; printf '# user edit after moving files\\n' > '${join(s.repo,"README.md")}'; exit "$code"`);
  let refused;
  try {refused=await runTask(f,s,s.taskId,s.claimId);}finally{hook.restore();}
  expect(hook.fired()).toBe(true);
  console.error("R3_EXISTING_UNDO",JSON.stringify({refused,branch:branchOf(s.repo),ref:refOf(s.repo,`refs/heads/${s.target.branch}`)}));
  expect(refused).toMatchObject({ok:false,evidence:{created:false,headMoved:true,filesMoved:true}});
  expect(branchOf(s.repo)).toBe(s.target.branch);
  expect(refOf(s.repo,`refs/heads/${s.target.branch}`)).toBe(s.target.baseSha);
  expect(readFileSync(join(s.repo,"README.md"),"utf8")).toBe("# user edit after moving files\n");
  expect(events(f,"TASK_BRANCH_CREATED",s.runId)).toHaveLength(1);
 });
});
