import { callCtoTool } from '../helpers/cto-tool.ts';
import { GenesisGitHub, genesisBundle, genesisFile, genesisPlanFixture } from '../helpers/genesis-github.ts';
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { readProcessStartToken } from '../../src/core/process-argv.ts';
import { CanonicalSelfClaim, hostSessionRegistryAbsent } from '../../src/registry/canonical-self-claim.ts';
import { Daemon } from '../../src/daemon/daemon.ts';
import { reviewBootstrapPlan } from '../helpers/bootstrap-plan.ts';
import { bindCeo, dispatchBootstrapRun, decideThroughHermes } from '../helpers/harness.ts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { bytesDigest, genesisDigest, parseGenesis } from '../../src/bootstrap/genesis-bundle.ts';
import { bootstrapPlanPreflight, executablePlanOf, planForSubmission } from '../../src/bootstrap/bootstrap-plan.ts';
import { produceRepoFactoryResult } from '../../src/bootstrap/repo-factory-producer.ts';
import { digestOf } from '../../src/core/digest.ts';
import { ResidentProjectProvisioning } from '../../src/bootstrap/resident-project-provisioning.ts';
import { CanonicalSessionRegistry } from '../../src/registry/canonical-session-registry.ts';
import { retireProject } from '../../src/registry/project-retirement.ts';
import type { HostOperation, HostProjectProvisioner, ProjectAllocation, HostObservation } from '../../src/runtime/host-project-provisioner.ts';
import { git } from '../../src/git/git.ts';
import { Db } from '../../src/db/database.ts';
import { redact } from '../../src/db/audit.ts';
import { MIGRATIONS } from '../../src/db/migrations.ts';
import { makeHarness } from '../helpers/harness.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';
import { RunKind } from '../../src/domain/types.ts';

afterAll(cleanupTempDirs);
// The genesis fixtures, with CI checks that carry real Actions provenance (review V52-R1-02).
const file = genesisFile;
const bundle = genesisBundle;
const planFixture = genesisPlanFixture;
describe('inline genesis bootstrap',() => {
  it('production composition refuses a legacy PLAN before it can launch a driven primary CTO',() => {
    const h = makeHarness({allowTestEvidenceWriters:false});
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
    const answer = createCtoMcpPort(h.cp).submitPlan(run.value.runId,{summary:'old empty bootstrap'});
    expect(answer.allowed).toBe(false);expect(h.cp.artifacts.latest(run.value.runId,'PLAN')).toBeNull();
    h.cp.close();
  });
  it('matches an independent Python canonical-JSON UTF-8 contract digest',() => {
    // #1240 — a genesis needs at least one issue and milestone; recomputed with Python's canonical JSON, which reproduces the previous pin.
    expect(genesisDigest({"schema":"acp.genesis-bundle.v1","commitMessage":"초기 생성","files":[{"path":"README.md","mode":"100644","contentBase64":"aGVsbG8K","sha256":"sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"}],"branches":{"main":"main","integration":"dev","genesis":"genesis"},"labels":[],"milestones":[{"key":"m1","title":"첫 제품 단계","description":"첫 단계"}],"issues":[{"key":"i1","title":"제품 의도 구현","body":"소유자 의도대로","labels":[],"milestoneKey":"m1"}],"productIntent":{"summary":"제품 의도","references":["https://example.test/design"],"ownerInstructions":["그대로 보존"]}})).toBe('sha256:733f2dd4a9234ad1efc60b37a0f80e1dedd3a56b5071247954d68e7cfe7813a9');
  });
  it('normalizes a shared-contract digest, preserves bytes/product intent, and derives public main/dev protection with no review requirement',() => {
    const f = planFixture();
    expect(genesisDigest(f.genesis)).toBe(digestOf(f.genesis));
    expect(f.outputs.files.map(x => x.path)).toContain('.github/workflows/ci.yml');
    expect(f.outputs.handoff.recentDecisions.join('')).toContain('Preserve this intent');
    expect(f.outputs.handoff.recentDecisions.join('')).toContain(f.genesis.files[0]!.contentBase64);
    const protection = f.outputs.githubOperations.filter(o => o.resourceType === 'branch-protection');
    expect(protection).toHaveLength(2);
    expect(protection.every(o => o.resourceType === 'branch-protection' && o.desiredState.requiredApprovingReviewCount === null && o.desiredState.enforceAdmins === true)).toBe(true);
  });
  it('opens genesis PR, refuses red CI at that head, then merges through the kernel before creating dev',async () => {
    const f = planFixture(); const root = tempDir('genesis-github-'); const port = new GenesisGitHub(root);
    const input = {plan:executablePlanOf(f.outputs,f.binding.planDigest),workDir:join(root,'work'),approvedFiles:f.outputs.files,github:{port,authority:{owner:'acme',visibility:'public' as const,approvedOperations:f.outputs.githubOperations.map(({operationId,resourceIdentity,resourceType}) => ({operationId,resourceIdentity,resourceType}))}}};
    vi.stubEnv('ACP_OPERATOR_TOKEN','unit1-token-must-not-reach-genesis');
    port.ciReady = false;
    const pending = await produceRepoFactoryResult(input);
    expect(pending.allowed).toBe(false);
    expect(port.merges).toBe(0);expect(await port.observeBranch({owner:'acme',name:'fixture'},'dev')).toBeNull();
    expect(port.ciHeads).toContain(port.pull!.headSha);
    expect((await git(port.repository('acme','fixture')!.bare,['rev-list','--count','main'])).stdout.trim()).toBe('1');
    port.ciReady = true;
    const result = await produceRepoFactoryResult(input);
    expect(result.allowed,result.allowed ? '' : result.message+JSON.stringify(result.evidence)).toBe(true);
    if (!result.allowed) return;
    expect(result.value.ciEvidence).toHaveLength(1);
    const repo = port.repository('acme','fixture')!;
    expect((await git(repo.bare,['rev-parse','main'])).stdout).toBe((await git(repo.bare,['rev-parse','dev'])).stdout);
    expect((await git(repo.bare,['rev-list','--count','main'])).stdout.trim()).toBe('3');
    expect((await git(repo.bare,['rev-parse','genesis^'])).stdout.trim()).toBe(port.pull!.baseSha);
    expect(port.events).toEqual(['create-repository','protect-main','push-genesis-branch','open','merge','create-dev','protect-dev','set-default-branch','resources','resources','resources']);
    expect(port.opens).toBe(1);expect(port.merges).toBe(1);
    expect(port.writes.filter(w => w.method === 'pushBranch')).toHaveLength(1);
    vi.unstubAllEnvs();
  });
  it.each(["pending", "missing", "failure", "cancelled", "skipped", "wrong-sha", "wrong-workflow", "unknown", "unrelated-run", "missing-run-suite"] as const)("blocks all later writes at merged main with %s CI, then rechecks M on resume", async state => {
    const f = planFixture(); const root = tempDir("merged-main-"); const port = new GenesisGitHub(root);
    port.mergeCiState = state;
    const input = {plan: executablePlanOf(f.outputs, f.binding.planDigest), workDir: join(root,"work"), approvedFiles:f.outputs.files,
      github:{port,authority:{owner:"acme",visibility:"public" as const,approvedOperations:f.outputs.githubOperations.map(({operationId,resourceIdentity,resourceType})=>({operationId,resourceIdentity,resourceType}))}}};
    const blocked = await produceRepoFactoryResult(input);
    expect(blocked.allowed).toBe(false);
    expect(port.merges).toBe(1);
    for (const operation of ["create-dev","protect-dev","set-default-branch","resources"]) {
      expect(port.events.filter(event=>event===operation),operation).toHaveLength(0);
    }
    expect(port.resources).toBeNull();
    expect(blocked.evidence["refusal"]).toBe(["pending","missing"].includes(state) ? "GENESIS_POST_MERGE_CI_PENDING" : "GENESIS_POST_MERGE_CI_REFUSED");
    const ledgerPath = join(root,"work/github-ledger/primary.json");
    expect(readFileSync(ledgerPath,"utf8")).not.toContain('"postMergeVerification"');
    port.mergeCiState = "success";
    const done = await produceRepoFactoryResult(input);
    expect(done.allowed, done.allowed ? "" : done.message).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath,"utf8")) as {receipts:Array<{resourceIdentity:string;observed:unknown}>};
    expect(ledger.receipts.find(r=>r.resourceIdentity.endsWith("#genesis-merge"))!.observed).toMatchObject({postMergeVerification:{headSha:port.pull!.mergeCommitSha,checkNames:["test"],conclusion:"success"}});
    expect(port.merges).toBe(1);
    const main = port.pull!.mergeCommitSha!;
    await git(port.repository("acme","fixture")!.bare,["update-ref","refs/heads/main",port.pull!.headSha,main]);
    const drift = await produceRepoFactoryResult({...input,checkoutPath:join(root,"work/repositories/retry-main-drift")});
    expect(drift.allowed).toBe(false);
    expect(drift.evidence["refusal"]).toBe("GENESIS_MERGE_DRIFT");
  });
  it('does not resume past pending merged-main CI after main has moved, then re-drives once M is restored and CI succeeds',async()=>{
    const f=planFixture();const root=tempDir('merged-resume-drift-');const port=new GenesisGitHub(root);port.mergeCiState="pending";
    const input={plan:executablePlanOf(f.outputs,f.binding.planDigest),workDir:join(root,"work"),approvedFiles:f.outputs.files,
      github:{port,authority:{owner:"acme",visibility:"public" as const,approvedOperations:f.outputs.githubOperations.map(({operationId,resourceIdentity,resourceType})=>({operationId,resourceIdentity,resourceType}))}}};
    expect((await produceRepoFactoryResult(input)).evidence["refusal"]).toBe("GENESIS_POST_MERGE_CI_PENDING");
    const bare=port.repository("acme","fixture")!.bare;const merge=port.pull!.mergeCommitSha!;
    await git(bare,["update-ref","refs/heads/main",port.pull!.headSha,merge]);port.mergeCiState="success";
    const refused=await produceRepoFactoryResult(input);
    expect(refused.allowed).toBe(false);expect(refused.evidence["refusal"]).toBe("GENESIS_MERGE_DRIFT");
    expect(port.events).not.toContain("create-dev");expect(port.resources).toBeNull();
    await git(bare,["update-ref","refs/heads/main",merge,port.pull!.headSha]);
    expect((await produceRepoFactoryResult(input)).allowed).toBe(true);expect(port.merges).toBe(1);
  });
  it('requires postMergeCommands in addition to the repository role workflow checks at M',async()=>{
    const f=planFixture();const root=tempDir('merged-extra-check-');const port=new GenesisGitHub(root);
    port.mergeCiCheckName="after-merge";port.mergeCiState="failure";
    const plan={...executablePlanOf(f.outputs,f.binding.planDigest),postMergeCommands:["after-merge"]};
    const input={plan,workDir:join(root,"work"),approvedFiles:f.outputs.files,github:{port,authority:{owner:"acme",visibility:"public" as const,approvedOperations:f.outputs.githubOperations.map(({operationId,resourceIdentity,resourceType})=>({operationId,resourceIdentity,resourceType}))}}};
    const refused=await produceRepoFactoryResult(input);
    expect(refused.allowed).toBe(false);expect(refused.evidence["refusal"]).toBe("GENESIS_POST_MERGE_CI_REFUSED");
    expect(port.events).not.toContain("create-dev");
    port.mergeCiState="success";
    const success=await produceRepoFactoryResult(input);expect(success.allowed,JSON.stringify(success)).toBe(true);
    const ledger=JSON.parse(readFileSync(join(root,"work/github-ledger/primary.json"),"utf8")) as {receipts:Array<{resourceIdentity:string;observed:unknown}>};
    expect(ledger.receipts.find(r=>r.resourceIdentity.endsWith("#genesis-merge"))!.observed).toMatchObject({postMergeVerification:{headSha:port.pull!.mergeCommitSha,checkNames:["test","after-merge"]}});
  });
  it.each(Array.from({length:12},(_,i)=>i))('resumes crash before receipt %i without duplicate PR, merge, resources or direct main push',async crashAt => {
    const f=planFixture();const root=tempDir('genesis-crash-');const port=new GenesisGitHub(root);
    let crashed=false;
    const input={plan:executablePlanOf(f.outputs,f.binding.planDigest),workDir:join(root,'work'),approvedFiles:f.outputs.files,github:{port,authority:{owner:'acme',visibility:'public' as const,approvedOperations:f.outputs.githubOperations.map(({operationId,resourceIdentity,resourceType})=>({operationId,resourceIdentity,resourceType}))}},beforeLedgerWrite:(state:{receipts:readonly unknown[];pending:readonly unknown[]})=>{if(!crashed && state.receipts.length === crashAt+1 && state.pending.length===0) {crashed=true;throw new Error('crash before receipt');}}};
    await expect(produceRepoFactoryResult(input)).rejects.toThrow('crash before receipt');expect(crashed).toBe(true);
    const result=await produceRepoFactoryResult(input);expect(result.allowed,result.allowed?'':result.message+JSON.stringify(result.evidence)).toBe(true);
    expect(port.opens).toBe(1);expect(port.merges).toBe(1);
    expect(port.writes.filter(w=>w.method==='pushBranch').map(w=>w.target)).toEqual(['acme/fixture#genesis']);
    expect(port.events.filter(e=>e==='resources')).toHaveLength(3);
    const ledger=JSON.parse(readFileSync(join(root,'work/github-ledger/primary.json'),'utf8')) as {receipts:unknown[];pending:unknown[]};expect(ledger.receipts).toHaveLength(12);expect(ledger.pending).toHaveLength(0);
    if(result.allowed) for (const external of result.value.externalWriteReceipts) {
      const stored=(ledger.receipts as Array<{operationId:string;observed:unknown}>).find(r=>r.operationId===external.operationId)!;
      expect(external.afterStateDigest).toBe(digestOf(stored.observed));
    }
  });
  it('accepts Repo Factory PR 58 six-operation plan unchanged and refuses main pushes, reordered steps and weakened protection',() => {
    const f=planFixture();const content=f.artifact.content;
    const six=f.outputs.githubOperations.filter(o=>o.resourceType!=='genesis-bootstrap' && o.resourceType!=='genesis-resources');
    expect(six.map(o=>o.operationId)).toEqual(['create-repository','protect-main','push-genesis-branch','create-dev','protect-dev','set-default-branch']);
    const submit=(ops:unknown[])=>planForSubmission({kind:'PROJECT_BOOTSTRAP',projectId:null},{...content,githubOperations:ops});
    expect(submit(six).allowed).toBe(true);
    expect(submit(six.map(o=>o.resourceIdentity.endsWith('#genesis') ? {...o,resourceIdentity:'github:acme/fixture#main'}:o)).allowed).toBe(false);
    expect(submit([six[0],six[2],six[1],...six.slice(3)]).allowed).toBe(false);
    expect(submit(six.map(o=>o.resourceType==='branch-protection' ? {...o,desiredState:{...o.desiredState,allowForcePushes:true}}:o)).allowed).toBe(false);
  });
  it('refuses secret bytes, traversal, corrupted bytes, missing tests and unpinned workflow before publication',() => {
    const f = planFixture();
    for (const bad of [ {...bundle(),files:[file('../oops','text')]}, {...bundle(),issues:[{...bundle().issues[0]!,body:'password=supersecret123'}]}, {...bundle(),files:[file('secret.txt','api_key=abcdefghijklmnopqrstuvwxyz')]}, {...bundle(),files:[{...file('test.js','valid'),sha256:bytesDigest(Buffer.from('different'))}]}]) expect(() => parseGenesis(bad)).toThrow();
    const bad = {...f.manifest,ciWorkflows:[{...f.manifest.ciWorkflows[0]!,approvedDigest:bytesDigest(Buffer.from('other'))}]};
    expect(bootstrapPlanPreflight({runId:'run_genesis',planArtifact:f.artifact,manifest:bad}).allowed).toBe(false);
  });
});

const contract = {goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL' as const,humanGate:[],references:[]};
class FakeHost implements HostProjectProvisioner {
  fail:HostOperation|null = null;
  actualRoomId:string|null = null;
  allocations:ProjectAllocation[] = [];
  resources = new Set<string>();
  async invoke(op:HostOperation,a:ProjectAllocation):Promise<HostObservation> {
    this.allocations.push({...a});this.resources.add(op+':'+a.sessionUuid);
    if (op === this.fail) {this.fail = null;throw new Error('crash after effect');}
    if (op === 'ensure-checkout') return {checkout:{path:a.clonePath,origin:'https://github.com/acme/fixture.git',head:a.head,repositoryNodeId:a.repositoryNodeId}};
    if (op === 'ensure-buzz') return {buzz:{pubkey:'a'.repeat(64),roomId:this.actualRoomId ?? a.roomId,rosterVerified:true,nonceEventId:'b'.repeat(64),nonceReadable:true}};
    if (op === 'ensure-routing') return {routing:{generation:1,roomId:a.roomId}};
    if (op === 'ensure-resident' || op === 'observe') return {checkout:{path:a.clonePath,origin:'https://github.com/acme/fixture.git',head:a.head,repositoryNodeId:a.repositoryNodeId},resident:{pid:12345,startedAt:'start',cwd:a.clonePath,sessionUuid:a.sessionUuid,tmuxName:a.tmuxName,tmuxAncestry:true,bridgeSessionId:'rc'}};
    return {retired:true};
  }
}
describe('durable resident provisioning and retirement',() => {
  it('does not launch a resident during startup before the subscriber/tool listeners are configured',async () => {
    const h = makeHarness();const host = new FakeHost();
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
    h.cp.projects.register({projectId:'resident',name:'resident'});
    const service = new ResidentProjectProvisioning(h.cp.db,h.clock,host,join(h.root,'home'),h.root);
    service.remember({runId:run.value.runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'resident',{});
    const sessionsBefore = h.cp.db.get<{n:number}>('SELECT count(*) AS n FROM sessions')!.n;
    expect((await h.cp.cto.ensurePrimaryCto('resident',run.value.runId)).allowed).toBe(false);
    expect((await h.cp.cto.ensureDrivenPrimaryCto('resident',run.value.runId)).allowed).toBe(false);
    expect(h.cp.db.get<{n:number}>('SELECT count(*) AS n FROM sessions')!.n).toBe(sessionsBefore);
    await expect(service.ensure({runId:run.value.runId,projectId:'resident',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'f'.repeat(40),packet:{}})).rejects.toThrow();
    expect([...host.resources].some(key => key.startsWith('ensure-resident:'))).toBe(false);h.cp.close();
  });
  it('persists intended room name before creation, adopts relay room ID before routing, and refuses later ID drift',async()=>{
    const h=makeHarness();const host=new FakeHost();host.actualRoomId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const run=h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if(!run.allowed) throw new Error(run.message);
    h.cp.projects.register({projectId:'resident',name:'resident'});
    const service=new ResidentProjectProvisioning(h.cp.db,h.clock,host,join(h.root,'home'),h.root);service.attachSubscriber(async()=>false);
    service.remember({runId:run.value.runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'resident',{});
    const invoke=host.invoke.bind(host);host.invoke=async(op,a)=>{
      expect(service.allocation(a.runId)?.roomName).toBe('resident');
      if(op==='ensure-routing') expect(service.allocation(a.runId)?.roomId).toBe(host.actualRoomId);
      return invoke(op,a);
    };
    const input={runId:run.value.runId,projectId:'resident',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'f'.repeat(40),packet:{}};
    await service.ensure(input);expect(service.allocation(input.runId)?.roomId).toBe(host.actualRoomId);
    const roomId=host.actualRoomId;host.actualRoomId='ffffffff-ffff-4fff-8fff-ffffffffffff';
    await expect(service.ensure(input)).rejects.toThrow();expect(service.allocation(input.runId)?.roomId).toBe(roomId);h.cp.close();
  });
  it.each(['ensure-checkout','ensure-buzz','ensure-routing','ensure-resident','observe'] as const)('recovers a crash after %s without reallocating resources or asking for another CONFIRM',async failed => {
    const h = makeHarness();const host = new FakeHost();
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:"STANDARD",contract});if (!run.allowed) throw new Error(run.message);
    h.cp.projects.register({projectId:'resident',name:'resident'});
    const confirmation = {runId:run.value.runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'};
    let service = new ResidentProjectProvisioning(h.cp.db,h.clock,host,join(h.root,'home'),h.root);service.attachSubscriber(async () => false);
    service.remember(confirmation,'resident',{plan:'frozen'});host.fail = failed;
    const input = {runId:run.value.runId,projectId:'resident',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'f'.repeat(40),packet:{bytes:bundle()}};
    await expect(service.ensure(input)).rejects.toThrow();
    const allocation = service.allocation(input.runId);
    service = new ResidentProjectProvisioning(h.cp.db,h.clock,host,join(h.root,'home'),h.root);service.attachSubscriber(async () => false);
    const observed = await service.ensure(input);
    expect(service.pending()).toEqual([confirmation]);
    expect(service.allocation(input.runId)).toEqual(allocation);
    expect(new Set(host.allocations.map(a => a.sessionUuid)).size).toBe(1);
    expect(service.confirmedRoom(observed.allocation.roomId)).toBe(true);
    expect(observed.claimSessionId).toBeNull(); // process/RC alone never complete activation
    expect(service.ready(input.runId,'other-session')).toBe(false);
    expect(() => service.remember({...confirmation,candidateSnapshotDigest:'changed'},'resident',{})).toThrow();
    h.cp.close();
  });
  it.each(['cwd','uuid','rc','ancestry','missing'] as const)('refuses a stale or missing %s readback even when the process was launched',async wrong => {
    const h = makeHarness();const host = new FakeHost();const invoke = host.invoke.bind(host);
    host.invoke = async (op,a) => {
      const value = await invoke(op,a);
      if (op !== 'observe') return value;
      if (wrong === 'missing') return {};
      const r = value.resident!;
      if (wrong === 'cwd') r.cwd = '/wrong';
      if (wrong === 'uuid') r.sessionUuid = 'wrong';
      if (wrong === 'rc') r.bridgeSessionId = '';
      if (wrong === 'ancestry') Object.assign(r,{tmuxAncestry:false});
      return value;
    };
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
    h.cp.projects.register({projectId:'resident',name:'resident'});
    const service = new ResidentProjectProvisioning(h.cp.db,h.clock,host,join(h.root,'home'),h.root);service.attachSubscriber(async () => false);
    service.remember({runId:run.value.runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'resident',{});
    await expect(service.ensure({runId:run.value.runId,projectId:'resident',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'f'.repeat(40),packet:{}})).rejects.toThrow();
    expect(service.row(run.value.runId)?.status).toBe('PENDING');h.cp.close();
  });
  it('coalesces identical env/DB entitlements, refuses conflicts and suppresses retired env entries',() => {
    const h = makeHarness();h.cp.projects.register({projectId:'resident',name:'resident'});
    const registry = new CanonicalSessionRegistry(h.cp.db);
    const entry = {sessionUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId:'resident',buzzActorId:'a'.repeat(64),buzzAddress:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
    registry.grant(entry,null);
    expect(registry.effective([entry])).toEqual([entry]);
    expect(() => registry.effective([{...entry,buzzActorId:'c'.repeat(64)}])).toThrow();
    registry.revoke('resident',h.clock.nowIso());expect(registry.effective([entry])).toEqual([]);
    expect(() => registry.grant(entry,null)).toThrow();h.cp.close();
  });
  it('retires without deleting history, refuses resume and releases an active repository identity for a replacement',async () => {
    const h = makeHarness();h.cp.projects.register({projectId:'old',name:'old'});
    const registered = await h.cp.repositories.register({checkoutPath:h.repoPath,identity:'github:acme/fixture',projectId:'old',repositoryRole:'primary',activeManifestDigest:null});
    expect(registered.allowed).toBe(true);
    const retired = await retireProject(h.cp,'old','replacement');expect(retired.allowed).toBe(true);
    expect(h.cp.projects.get('old')?.retiredAt).toBeTruthy();expect(h.cp.projects.setSuspended('old',false,true).allowed).toBe(false);
    expect(h.cp.repositories.byIdentity('github:acme/fixture')).toBeNull();
    expect(h.cp.db.get('SELECT 1 FROM repositories WHERE project_id = ?',['old'])).toBeTruthy();h.cp.close();
  });
  it('upgrades the released v50 image through v51 and v52 and preserves repository history',() => {
    const raw = new Database(':memory:');raw.exec(readFileSync(new URL('../../src/db/schema-v50.sql',import.meta.url),'utf8'));raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,migration_id TEXT,checksum TEXT,applied_at TEXT)');
    raw.exec("INSERT INTO projects(project_id,name,created_at) VALUES ('old','old','2026-01-01'); INSERT INTO repositories(rowid,repository_id,identity,checkout_path,project_id,created_at) VALUES (42,'repo-old','github:acme/reuse','/old','old','2026-01-01')");
    MIGRATIONS.find(m => m.toVersion === 51)!.apply(raw);MIGRATIONS.find(m => m.toVersion === 52)!.apply(raw);
    expect(raw.prepare('SELECT rowid,repository_id,identity FROM repositories').get()).toEqual({rowid:42,repository_id:'repo-old',identity:'github:acme/reuse'});
    raw.exec("UPDATE repositories SET retired_at = '2026-10-23' WHERE repository_id = 'repo-old'; INSERT INTO repositories(repository_id,identity,checkout_path,project_id,created_at) VALUES ('repo-new','github:acme/reuse','/old','old','2026-10-23')");
    expect(raw.prepare('SELECT count(*) AS n FROM repositories').get()).toEqual({n:2});
    expect(raw.prepare('PRAGMA table_info(projects)').all()).toEqual(expect.arrayContaining([expect.objectContaining({name:'buzz_address'}),expect.objectContaining({name:'retired_at'})]));raw.close();
    const fresh = new Db(join(tempDir('genesis-fresh-'),'state.sqlite'));fresh.close();
  });
});

it('completes a reviewed genesis bootstrap on its resident claim and same-session ACK, resuming the original CEO CONFIRM',async () => {
  // Exercise the CI runner's long slash-joined base64-shaped path without any credential segment.
  const root = join(realpathSync(tempDir('resident-complete-')), 'a'.repeat(32), 'b'.repeat(32));
  const home = join(root,'home');mkdirSync(home,{recursive:true});
  const port = new GenesisGitHub(root);const host = new FakeHost();
  const h = makeHarness({repoFactory:{workRoot:join(root,'factory'),githubPort:port},residentProvisioner:{home,port:host}});
  const doctor = h.cp.doctor.run.bind(h.cp.doctor);
  const probe = vi.spyOn(h.cp.doctor,'run').mockImplementation(async (...args) => ({...await doctor(...args),status:'HEALTHY',findings:[]}));
  const startedAt = readProcessStartToken(process.pid)!;
  const invoke = host.invoke.bind(host);
  host.invoke = async (op,a) => {
    if (op === 'ensure-checkout' && !existsSync(a.clonePath)) {
      mkdirSync(join(home,'projects'),{recursive:true});await git(root,['clone','-b','dev',port.repository('acme','fixture')!.bare,a.clonePath]);await git(a.clonePath,['remote','set-url','origin','https://github.com/acme/fixture.git']);
    }
    const value = await invoke(op,a);
    if (value.resident) {value.resident.pid = process.pid;value.resident.startedAt = startedAt;}
    if (op === 'ensure-resident') {
      mkdirSync(join(home,'.claude','sessions'),{recursive:true});writeFileSync(join(home,'.claude','sessions',`${process.pid}.json`),JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:'rc'}),{mode:0o600});
      if (!h.cp.bindings.activePrimaryCto(a.projectId)) {
        const claim = new CanonicalSelfClaim(h.cp.db,h.clock,h.cp.audit,h.cp.sessions,h.cp.bindings,{isAllowedActor:() => true},async () => ({allowed:true,reasonCode:'OK',evidence:{},value:a.roomId}),{canonicalSessions:[{sessionUuid:a.sessionUuid,projectId:a.projectId,buzzActorId:'a'.repeat(64),buzzAddress:a.roomId}],canonicalBuzzChannelId:a.roomId,expectedPeerProtocolVersion:'test',expectedPeerIdentity:'test'}, {processInspector:{snapshot:pid => pid === 100 ? {pid,ppid:process.pid,argv:['node','mcp'],command:'node mcp',cwd:a.clonePath,cwdProbeFailure:null,startedAt:'peer'} : pid === process.pid ? {pid,ppid:1,argv:['/test/claude','--session-id',a.sessionUuid],command:'claude',cwd:a.clonePath,cwdProbeFailure:null,startedAt} : null},imageInspector:{resolve:() => null},transcriptReader:{locate:() => ({path:'/test/transcript',sizeBytes:10})},hostSessionRegistryReader:{read:() => hostSessionRegistryAbsent('test')},processSignal:() => {}});
        const admitted = await claim.claim({callerPid:100,claimedSessionUuid:a.sessionUuid,projectId:a.projectId,expectedBindingGeneration:1,peerProtocolVersion:'test',peerIdentity:'test',buzzPurpose:'test'});
        expect(admitted.allowed,JSON.stringify(admitted)).toBe(true);
      }
    }
    return value;
  };
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
  await dispatchBootstrapRun(h.cp,h.clock,run.value.runId);
  const ceoSessionId = bindCeo(h);
  const resolutions=["Accept stage-one bootstrap; verify seeded issue acceptance in follow-on STANDARD_WORK.","The resident CTO owns every seeded issue's follow-on acceptance."];
  for (const resolution of resolutions) {
    const opened = h.cp.ceo.openEscalation({runId:run.value.runId,openedBySessionId:h.cp.runs.require(run.value.runId).ownerSessionId!,openedAt:h.clock.nowIso(),question:"stage split?",options:["yes"],ctoRecommendation:"yes",whyItMatters:"acceptance",blocksCriticalPath:true});
    if (!opened.allowed) throw new Error(opened.message);
    expect(h.cp.ceo.resolveEscalation(run.value.runId,resolution,ceoSessionId,{escalationId:opened.value.escalationId!}).allowed).toBe(true);
  }
  const f = planFixture();
  const genesis = {...f.genesis,issues:Array.from({length:7},(_,i)=>({...f.genesis.issues[0]!,key:`issue-${i+1}`,title:`Seeded issue ${i+1}`,body:`Acceptance for seeded issue ${i+1}\n\nWork unit ${i+1} of 7: issue-${i+1}`}))};
  const reviewed = await reviewBootstrapPlan(h,run.value.runId,{...f.artifact.content,genesis,githubOperations:undefined,summary:"이번 단계는 부트스트랩까지만 수행하고 각 이슈의 인수 조건 검증은 후속 작업에서 진행한다",requestDigest:h.cp.runs.get(run.value.runId)!.contractDigest});
  const refused = await h.cp.bootstrapProducer.produceAndActivateApproved({runId:run.value.runId,candidateSnapshotDigest:'unreviewed-candidate',ceoSessionId:reviewed.ceoSessionId});
  expect(refused.allowed).toBe(false);expect(h.cp.residentProjects.row(run.value.runId)).toBeUndefined();
  const first = await decideThroughHermes(h,{runId:run.value.runId,decision:'CONFIRM',candidateSnapshotDigest:reviewed.snapshotDigest,ceoSessionId:reviewed.ceoSessionId,rationale:'create and activate'});
  expect(first.allowed).toBe(false);
  expect(createCtoMcpPort(h.cp).submitPlan(run.value.runId,{summary:'replace the confirmed plan'}).allowed).toBe(false);
  const pending = h.cp.db.get<{handoff_id:string;to_session_id:string}>(`SELECT handoff_id,to_session_id FROM handoffs WHERE project_id = ? AND status = 'PENDING'`,[f.manifest.projectId]);
  expect(pending,JSON.stringify(first)).toBeTruthy();if (!pending) throw new Error('handoff missing');
  expect(h.cp.bootstrap.acknowledgeActivationHandoff(pending.handoff_id,'wrong-session').allowed).toBe(false);
  const recipient = h.cp.sessions.require(pending.to_session_id);
  const peer = {sessionId:recipient.sessionId,incarnation:recipient.incarnation};
  const message = h.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${pending.handoff_id}`)!;
  const originalPayload = JSON.stringify(message.payload);
  const delivered = (message.payload as {handoff:{recentDecisions:string[];queuedWork:unknown[];recommendedNextAction:string}}).handoff;
  const frozen = h.cp.artifacts.latest<{authenticatedCeoDecisions:unknown[]}>(run.value.runId,"PLAN")!.content.authenticatedCeoDecisions;
  expect(delivered.recentDecisions.map(x=>JSON.parse(x) as {authenticatedCeoDecision?:unknown}).filter(x=>x.authenticatedCeoDecision).map(x=>x.authenticatedCeoDecision)).toEqual(frozen);
  expect(frozen).toHaveLength(2);
  expect(delivered.queuedWork).toEqual([]);
  expect(delivered.recommendedNextAction).toContain("existing runs");
  for (const issue of genesis.issues) expect(delivered.recommendedNextAction).toContain(JSON.stringify(issue.body));
  // Inspect the produced tree, commit messages and actual seeding calls, beyond the PLAN projection.
  const publishedBare=port.repository("acme","fixture")!.bare;
  const publishedFiles=await Promise.all(genesis.files.map(async file=>(await git(publishedBare,["show",`${port.pull!.mergeCommitSha}:${file.path}`])).stdout));
  const publicArtifacts=JSON.stringify({files:publishedFiles,commits:(await git(publishedBare,["log","--all","--format=%B"])).stdout,resources:port.resources});
  for (const resolution of resolutions) expect(publicArtifacts).not.toContain(resolution);
  const confirmation = {runId:run.value.runId,candidateSnapshotDigest:reviewed.snapshotDigest,ceoSessionId:reviewed.ceoSessionId,rationale:"create and activate"};
  for (const state of ["pending","failure","unrelated-run","missing-run-suite"] as const) {
    port.mergeCiState = state;
    const retry = await h.cp.bootstrapProducer.produceAndActivateApproved(confirmation);
    expect(retry.allowed).toBe(false);
    expect(retry.evidence["refusal"],JSON.stringify(retry)).toBe(state === "pending" ? "GENESIS_POST_MERGE_CI_PENDING" : "GENESIS_POST_MERGE_CI_REFUSED");
    expect(h.cp.runs.require(run.value.runId).state).not.toBe("COMPLETED");
    expect(JSON.stringify(h.cp.outbox.get(message.messageId)!.payload)).toBe(originalPayload);
  }
  port.mergeCiState = "success";
  const bare=port.repository("acme","fixture")!.bare;const merge=port.pull!.mergeCommitSha!;
  await git(bare,["update-ref","refs/heads/main",port.pull!.headSha,merge]);
  const moved=await h.cp.bootstrapProducer.produceAndActivateApproved(confirmation);
  expect(moved.allowed).toBe(false);expect(moved.evidence["refusal"]).toBe("GENESIS_MERGE_DRIFT");
  expect(h.cp.runs.require(run.value.runId).state).not.toBe("COMPLETED");
  expect(JSON.stringify(h.cp.outbox.get(message.messageId)!.payload)).toBe(originalPayload);
  await git(bare,["update-ref","refs/heads/main",merge,port.pull!.headSha]);

  const listed = await callCtoTool(h,peer,'role_dispatch_pending');
  expect(listed).toMatchObject({ok:true,value:{messages:expect.arrayContaining([
    expect.objectContaining({messageId:message.messageId,kind:'HANDOFF_PACKAGE',payload:expect.objectContaining({handoffId:pending.handoff_id})}),
  ])}});
  const received = (listed.value as {messages:Array<{messageId:string;payloadDigest:string;bindingGeneration:number;payload:{handoffId:string}}>}).messages
    .find(row => row.messageId === message.messageId)!;
  expect(h.cp.bootstrap.acknowledgeActivationHandoff(pending.handoff_id,pending.to_session_id,'stale').allowed).toBe(false);
  const acked = await callCtoTool(h,peer,'handoff_ack',{
    idempotencyKey:'resident-bootstrap-ack',handoffId:received.payload.handoffId,messageId:received.messageId,
    payloadDigest:received.payloadDigest,bindingGeneration:received.bindingGeneration,
  });
  expect(acked,JSON.stringify(acked)).toMatchObject({ok:true});
  expect(h.cp.outbox.get(message.messageId)?.status).toBe('ACKED');
  expect(h.cp.db.all('SELECT * FROM outbox_sent_destinations WHERE message_id = ?',[message.messageId])).toEqual([]);
  const daemon = new Daemon(h.cp,{stateDir:join(root,'daemon')});h.cp.bootstrapProducer.attachWriterLock(() => true);
  await daemon.resumeResidentProjects();
  expect(h.cp.runs.get(run.value.runId)?.state).toBe('COMPLETED');
  expect(h.cp.residentProjects.row(run.value.runId)?.status).toBe('COMPLETE');
  expect(JSON.stringify(h.cp.outbox.get(message.messageId)!.payload)).toBe(originalPayload);
  expect(port.writes.filter(w => w.method === 'pushBranch')).toHaveLength(1);
  expect(h.cp.sessions.get(pending.to_session_id)?.provider).toBe('claude');
  // #1227 — the same daemon pass gives the activated project's worker turns their own clone beside
  // the resident's clone, which stays on dev where the resident works.
  const allocation = h.cp.residentProjects.allocation(run.value.runId)!;
  const registered = h.cp.repositories.byIdentity(allocation.repositoryIdentity)!;
  expect(registered.checkoutPath).toBe(join(home,'projects','.acp-worker-checkouts',registered.repositoryId));
  expect(registered.checkoutPath).not.toBe(allocation.clonePath);
  expect((await git(allocation.clonePath,['symbolic-ref','--short','HEAD'])).stdout.trim()).toBe('dev');
  expect((await git(registered.checkoutPath,['rev-parse','HEAD'])).stdout).toBe((await git(allocation.clonePath,['rev-parse','HEAD'])).stdout);
  // Its own git dir, not the clone's; its origin the repository's own remote, as the clone has it.
  expect((await git(registered.checkoutPath,['rev-parse','--git-common-dir'])).stdout.trim()).toBe('.git');
  expect((await git(registered.checkoutPath,['remote','get-url','origin'])).stdout).toBe((await git(allocation.clonePath,['remote','get-url','origin'])).stdout);
  // The raw paths and isolation are checked above; the durable audit stores their privacy projection.
  // Do not grant this audit writer a location exemption merely to make the assertion pass.
  const movedPaths = redact({from:allocation.clonePath,to:registered.checkoutPath,branch:null});
  expect(JSON.stringify(movedPaths)).toContain('[redacted]');
  expect(h.cp.audit.byKind('REPOSITORY_CHECKOUT_MOVED').map(row => row.evidence)).toEqual([expect.objectContaining(movedPaths as Record<string,unknown>)]);
  probe.mockRestore();h.cp.close();
});
