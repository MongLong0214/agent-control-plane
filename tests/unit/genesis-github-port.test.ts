import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesDigest } from '../../src/bootstrap/genesis-bundle.ts';
import { createGitHubApiWritePort } from '../../src/bootstrap/github-write-port.ts';
import { mergeBootstrapGenesis, type GitHubClient } from '../../src/github/github-kernel.ts';

const target={owner:'acme',name:'fixture'};
const repository={id:42,full_name:'acme/fixture'};
const head='a'.repeat(40), base='b'.repeat(40), merge='c'.repeat(40);
const workflow='name: ci\n';
const workflows=[{path:'.github/workflows/ci.yml',checkName:'test',approvedDigest:bytesDigest(Buffer.from(workflow))}];
// Review V52-R1-02 — each check names its Actions suite and job; the fixture answers both at the head.
const check=(sha=head,conclusion:string|null='success')=>({id:7,name:'test',head_sha:sha,status:'completed',conclusion,app:{slug:'github-actions'},check_suite:{id:9},details_url:'https://github.com/acme/fixture/actions/runs/11/job/7'});
const protection={allow_force_pushes:{enabled:false},allow_deletions:{enabled:false},enforce_admins:{enabled:true},required_status_checks:{strict:true,contexts:['test']}};
const pr={number:1,body:'marker',state:'open',merged:false,merged_at:null,merge_commit_sha:null as string|null,head:{ref:'genesis',sha:head,repo:{full_name:'acme/fixture'}},base:{ref:'main',sha:base}};
function fixture() {
  let merged=false;const calls:Array<{method:string;path:string;body:unknown}>=[];
  const state={provenanceHead:head,suiteId:9 as number | undefined,runId:11 as number | undefined,
    suiteRepository:repository as Partial<typeof repository> | undefined,runRepository:repository as Partial<typeof repository> | undefined,
    runSuiteId:9 as number | undefined,runStatus:"completed" as string | undefined,checks:[check()],protection,parents:[base,head],pull:{...pr},main:base};
  const client:GitHubClient={async request<T>(method:"GET"|"POST"|"PATCH"|"PUT"|"DELETE",path:string,body?:unknown):Promise<T> {
    calls.push({method,path,body});const p=path.replace(/^\//,'');let answer:unknown;
    if(method==='PUT') {merged=true;state.main=merge;answer={merged:true,sha:merge};}
    else if(method==='POST') answer={number:1};
    else if(p.includes('/pulls?')) answer=[state.pull];
    else if(p.endsWith('/pulls/1')) answer={...state.pull,merged,state:merged?'closed':state.pull.state,merge_commit_sha:merged?merge:null};
    else if(p.endsWith('/protection')) answer=state.protection;
    else if(p.includes('/check-runs')) answer={check_runs:state.checks};
    else if(p.includes('/contents/')) answer={encoding:'base64',content:Buffer.from(workflow).toString('base64')};
    else if(p.includes('/git/commits/')) answer={parents:state.parents.map(sha=>({sha}))};
    else if(p.includes('/check-suites/9')) answer={id:state.suiteId,repository:state.suiteRepository,head_sha:state.provenanceHead,app:{slug:'github-actions'}};
    else if(p.includes('/actions/runs/11')) answer={id:state.runId,repository:state.runRepository,check_suite_id:state.runSuiteId,head_sha:state.provenanceHead,path:'.github/workflows/ci.yml',status:state.runStatus,conclusion:'success'};
    else if(p.endsWith('/git/ref/heads/main')) answer={object:{sha:state.main}};
    else throw new Error('unexpected '+method+' '+path);
    return answer as T;
  }};
  return {state,calls,client,port:createGitHubApiWritePort({client})};
}
afterEach(()=>vi.useRealTimers());
describe('genesis production GitHub port and kernel',()=>{
  it('opens only genesis to main and merges once with exact SHA and merge commit parent proof',async()=>{
    const f=fixture();f.state.checks=[check(),check()];await f.port.openGenesisPull!(target,'marker');
    expect(f.calls[0]!.body).toEqual({head:'genesis',base:'main',title:'Bootstrap genesis',body:'marker'});
    const pull=await f.port.observeGenesisPull!(target,'marker');expect(pull).toEqual({number:1,headSha:head,baseSha:base,merged:false,mergeCommitSha:null});
    await f.port.mergeGenesisPull!(target,pull!,workflows);
    const merged=await f.port.observeGenesisPull!(target,'marker');expect(merged?.merged).toBe(true);
    await f.port.mergeGenesisPull!(target,merged!,workflows);
    expect(f.calls.filter(c=>c.method==='PUT')).toEqual([{method:'PUT',path:'/repos/acme/fixture/pulls/1/merge',body:{sha:head,merge_method:'merge'}}]);
    expect(f.calls.some(c=>['PATCH','POST'].includes(c.method) && c.path.includes('/git/refs'))).toBe(false);
  });
  it.each(['ci-failure','failed-matrix-lane','wrong-head','weak-protection','moved-main','wrong-pr-head'] as const)('kernel refuses %s before merge',async fault=>{
    const f=fixture();
    if(fault==='ci-failure') f.state.checks=[check(head,'failure')];
    if(fault==='failed-matrix-lane') f.state.checks=[check(),check(head,'failure')];
    if(fault==='wrong-head') f.state.checks=[check(base)];
    if(fault==='weak-protection') f.state.protection={...protection,enforce_admins:{enabled:false}};
    if(fault==='moved-main') f.state.main=merge;
    if(fault==='wrong-pr-head') f.state.pull={...pr,head:{...pr.head,sha:base}};
    await expect(mergeBootstrapGenesis(f.client,{owner:'acme',repo:'fixture',pullNumber:1,headSha:head,baseSha:base,workflows})).rejects.toThrow();
    expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  });
  it('refuses a merge acknowledgement whose parents do not prove a merge onto autoInit main',async()=>{
    const f=fixture();f.state.parents=[head];
    await expect(f.port.mergeGenesisPull!(target,{number:1,headSha:head,baseSha:base,merged:false,mergeCommitSha:null},workflows)).rejects.toThrow('parent/readback');
  });
  it('refuses ambiguity or a closed unmerged genesis PR',async()=>{
    const f=fixture();f.state.pull={...pr,body:'different bootstrap'};
    await expect(f.port.observeGenesisPull!(target,'marker')).rejects.toThrow('ambiguous');
    f.state.pull={...pr,state:'closed'};
    await expect(f.port.observeGenesisPull!(target,'marker')).rejects.toThrow('identity/state');
  });
  it('observes merged-main checks once without a polling timer and requires postMergeCommands too',async()=>{
    vi.useFakeTimers();const f=fixture();f.state.checks=[];
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test","after-merge"])).toMatchObject({state:"pending"});
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls.filter(c=>c.path.includes('/check-runs'))).toHaveLength(2);
    expect(f.calls.filter(c=>c.path.includes('/check-runs')).every(c=>c.path.includes(`/commits/${merge}/`))).toBe(true);
    f.state.provenanceHead=merge;f.state.checks=[{...check(merge),name:"another-check"}];
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toMatchObject({state:"pending"});
    f.state.provenanceHead=head;
    f.state.checks=[{...check(merge),status:"unknown"}];
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toMatchObject({state:"refused"});
    f.state.checks=[check(merge)];
    // A successful check at M with suite/run provenance at H is never a pass.
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toMatchObject({state:"refused"});
  });
  it.each(["wrong-sha", "unknown-run-status", "missing-run-status"] as const)('refuses %s provenance instead of treating it as pending',async fault=>{
    const f=fixture();
    if (fault === "wrong-sha") f.state.checks=[{...check(base,null),status:"queued"}];
    if (fault === "unknown-run-status") f.state.runStatus="unknown";
    if (fault === "missing-run-status") f.state.runStatus=undefined;
    expect(await f.port.observeGenesisPostMergeCi!(target,head,workflows,["test"])).toMatchObject({state:"refused"});
  });
  it.each([19, undefined])('ACP1201-R1-01: refuses unrelated or missing suite/run identity %s in every genesis observation',async suiteId=>{
    const f=fixture();f.state.runSuiteId=suiteId;
    f.state.provenanceHead=merge;f.state.checks=[check(merge)];
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toMatchObject({state:"refused"});
    f.state.runStatus="in_progress";
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toMatchObject({state:"refused"});
    f.state.runStatus="completed";f.state.provenanceHead=head;f.state.checks=[check()];
    expect(await f.port.observeGenesisCi!(target,head,workflows)).toBe(false);
    await expect(f.port.mergeGenesisPull!(target,{number:1,headSha:head,baseSha:base,merged:false,mergeCommitSha:null},workflows)).rejects.toThrow();
    expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  });
  it('ACP1201-R1-01: accepts a real-shaped linked suite/run at M; details_url is only a lookup hint',async()=>{
    const f=fixture();f.state.provenanceHead=merge;
    f.state.checks=[{...check(merge),details_url:'https://integrator.example/actions/runs/11/job/999'}];
    expect(await f.port.observeGenesisPostMergeCi!(target,merge,workflows,["test"])).toEqual({state:"success"});
    expect(f.calls.filter(c=>c.path.includes('/actions/runs/'))).toEqual([
      {method:'GET',path:'repos/acme/fixture/actions/runs/11',body:undefined},
    ]);
  });
  it.each(['missing-suite-id','wrong-suite-id','missing-run-id','wrong-run-id','missing-suite-repository',
    'missing-run-repository','wrong-suite-repository','wrong-run-repository','different-repository-id','missing-repository-id'] as const)(
    'ACP1201-R1-01: refuses %s from GitHub even with a successful approved run',async fault=>{
      const f=fixture();
      if(fault==='missing-suite-id') f.state.suiteId=undefined;
      if(fault==='wrong-suite-id') f.state.suiteId=19;
      if(fault==='missing-run-id') f.state.runId=undefined;
      if(fault==='wrong-run-id') f.state.runId=12;
      if(fault==='missing-suite-repository') f.state.suiteRepository=undefined;
      if(fault==='missing-run-repository') f.state.runRepository=undefined;
      if(fault==='wrong-suite-repository') f.state.suiteRepository={...repository,full_name:'other/fixture'};
      if(fault==='wrong-run-repository') f.state.runRepository={...repository,full_name:'other/fixture'};
      if(fault==='different-repository-id') f.state.runRepository={...repository,id:43};
      if(fault==='missing-repository-id') f.state.runRepository={full_name:repository.full_name};
      expect(await f.port.observeGenesisPostMergeCi!(target,head,workflows,["test"])).toMatchObject({state:'refused'});
      f.state.runStatus='in_progress';
      expect(await f.port.observeGenesisPostMergeCi!(target,head,workflows,["test"])).toMatchObject({state:'refused'});
    });
  it('waits boundedly for exact-head CI and checks workflow bytes',async()=>{
    vi.useFakeTimers();const f=fixture();f.state.checks=[];
    const waiting=f.port.observeGenesisCi!(target,head,workflows);
    await vi.advanceTimersByTimeAsync(1000);f.state.checks=[check()];
    await vi.advanceTimersByTimeAsync(1000);expect(await waiting).toBe(true);
    expect(f.calls.filter(c=>c.path.includes('/check-runs')).length).toBeGreaterThan(1);
    expect(await f.port.observeGenesisCi!(target,head,[{...workflows[0]!,approvedDigest:bytesDigest(Buffer.from('tampered'))}])).toBe(false);
  });
  it('requires every trusted matrix lane green, refuses failures immediately, and never accepts green at another head',async()=>{
    vi.useFakeTimers();const f=fixture();f.state.checks=[check(head,'failure')];
    expect(await f.port.observeGenesisCi!(target,head,workflows)).toBe(false);
    f.state.checks=[check(),check()];expect(await f.port.observeGenesisCi!(target,head,workflows)).toBe(true);
    f.state.checks=[check(),check(head,'failure')];expect(await f.port.observeGenesisCi!(target,head,workflows)).toBe(false);
    f.state.checks=[check(base)];const waiting=f.port.observeGenesisCi!(target,head,workflows);
    await vi.runAllTimersAsync();expect(await waiting).toBe(false);
    expect(f.calls.every(c=>c.method==='GET')).toBe(true);
  });
});
