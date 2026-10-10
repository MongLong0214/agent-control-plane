import { afterAll, afterEach, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { isAdoptedCanonicalRuntime } from "../../src/registry/canonical-self-claim.ts";
import type { SessionHandle } from "../../src/runtime/provider.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #246 PR-C C4-R2 — review 3 of the recovery slice. A replacement a refused failover will not use is
 * stopped through its provider only when it is proven to be nobody's — no ACTIVE assignment and no
 * adopted canonical runtime — and recovery refuses a holder that moved once its attestation
 * completed. These are the review's witnesses with only their harness adapted (no review-tree
 * output files).
 */
afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

// A verified canonical target at the registry boundary, as the self-claim writer supplies it.
// State changes below use bind, switchTo and revoke; there is no raw SQL or file forgery.
const canonicalTarget = {
  executorKind: 'claude-cli', targetLocator: 'review-canonical-conversation',
  targetLocatorDigest: 'sha256:' + 'a'.repeat(64),
};

it('Q20 distinguishing registry witness: a revoked canonical actor still points at the unused driven spawn', async () => {
  await withBootstrapRuntime(async f => {
    const cp = f.harness.cp;
    cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
    const manifest = fixtureManifest('r3-canonical-owner');
    expect(cp.projects.register({projectId:'r3-canonical-owner',name:'canonical',manifest,authorization:cp.manifestAuthorizationForTests(manifest)}).allowed).toBe(true);
    await registerFixtureProject(f.harness, 'r3-q20-spawn');
    const bootstrap = await f.dispatchBootstrap();
    const canonicalSession = cp.sessions.create({ provider: 'claude', model: 'opus' });
    cp.sessions.transition(canonicalSession.sessionId, SessionLifecycle.READY, 'fixture canonical runtime');
    const canonical = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: 'r3-canonical-owner',
      sessionId: canonicalSession.sessionId, verifiedTarget: canonicalTarget });
    if (!canonical.allowed) throw new Error(canonical.message);
    const winner = cp.sessions.create({ provider: 'scripted', model: 'winner' });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, 'fixture winner');
    const ready = cp.doctor.sessionReadiness.bind(cp.doctor);
    let spawned = '';
    vi.spyOn(cp.doctor, 'sessionReadiness').mockImplementationOnce(async id => {
      spawned = id;
      const moved = cp.bindings.switchTo({ role: Role.PRIMARY_CTO, roleKey: canonical.value.roleKey,
        projectId: 'r3-canonical-owner', sessionId: id, mode: 'PREFERRED',
        reason: 'canonical actor moves while spawn readiness is awaited', conversation: 'SURVIVED' });
      if (!moved.allowed) throw new Error(moved.message);
      expect(cp.bindings.revoke(canonical.value.roleKey, 'canonical role released').allowed).toBe(true);
      const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: 'r3-q20-spawn', sessionId: winner.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      return ready(id);
    });
    const stop = vi.spyOn(f.claude, 'stopSession');
    const refused = await cp.cto.ensureDrivenPrimaryCto('r3-q20-spawn', bootstrap.runId);
    const row = cp.sessions.require(spawned);
    const records = cp.audit.byKind('PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP');
    const isCanonical = isAdoptedCanonicalRuntime(cp.db, spawned);
    expect(refused.allowed).toBe(false);
    expect(isCanonical).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe(SessionLifecycle.READY);
    expect(records).toMatchObject([{ sessionId: spawned, evidence: { outcome: 'REMAINING_OWNERSHIP_UNVERIFIED' } }]);
  });
});

it('retirement must protect a revoked canonical actor whose runtime is the replacement', async () => {
  await withBootstrapRuntime(async f => {
    const cp = f.harness.cp;
    const manifest = fixtureManifest('r3-canonical-failover-owner');
    expect(cp.projects.register({projectId:'r3-canonical-failover-owner',name:'canonical',manifest,authorization:cp.manifestAuthorizationForTests(manifest)}).allowed).toBe(true);
    await registerFixtureProject(f.harness, 'r3-canonical-failover');
    const canonicalSession = cp.sessions.create({ provider: 'claude', model: 'opus' });
    cp.sessions.transition(canonicalSession.sessionId, SessionLifecycle.READY, 'fixture canonical runtime');
    const canonical = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: 'r3-canonical-failover-owner',
      sessionId: canonicalSession.sessionId, verifiedTarget: canonicalTarget });
    if (!canonical.allowed) throw new Error(canonical.message);
    const initial = await cp.cto.ensurePrimaryCto('r3-canonical-failover', 'fixture');
    if (!initial.allowed) throw new Error(initial.message);
    const winner = cp.sessions.create({ provider: 'scripted', model: 'winner' });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, 'fixture winner');
    let replacement = '';
    cp.continuity.attach({ readiness: { checkSession: async id => {
      replacement = id;
      const moved = cp.bindings.switchTo({ role: Role.PRIMARY_CTO, roleKey: canonical.value.roleKey,
        projectId: 'r3-canonical-failover-owner', sessionId: id, mode: 'PREFERRED',
        reason: 'canonical actor moves during awaited readiness', conversation: 'SURVIVED' });
      if (!moved.allowed) throw new Error(moved.message);
      expect(cp.bindings.revoke(canonical.value.roleKey, 'canonical role released').allowed).toBe(true);
      expect(cp.bindings.revoke(initial.value.roleKey, 'concurrent holder replacement').allowed).toBe(true);
      const bound = cp.bindings.bind({role: Role.PRIMARY_CTO,projectId:'r3-canonical-failover',sessionId:winner.sessionId});
      if (!bound.allowed) throw new Error(bound.message);
      return allow(ReasonCode.OK,undefined);
    } } });
    const stop = vi.spyOn(f.gpt, 'stopSession');
    f.loseClaude();
    const refused = await cp.continuity.failover(initial.value.roleKey,Role.PRIMARY_CTO,{projectId:'r3-canonical-failover'},'canonical refusal');
    const row = cp.sessions.require(replacement);
    const records = cp.audit.byKind('CONTINUITY_REPLACEMENT_CLEANUP');
    const isCanonical = isAdoptedCanonicalRuntime(cp.db,replacement);
    expect(refused.allowed).toBe(false);
    expect(isCanonical).toBe(true);
    expect.soft(stop).not.toHaveBeenCalled();
    expect.soft(row.lifecycle).toBe(SessionLifecycle.READY);
    expect.soft(records).toMatchObject([{sessionId:replacement,evidence:{outcome:'REMAINING_OWNERSHIP_UNVERIFIED'}}]);
  });
});

it('S07 distinguishing completion witness: the holder moves after attestation settles and before recovery returns', async()=>{
  await withBootstrapRuntime(async f=>{
    const cp=f.harness.cp;
    const {binding}=await drivenPrimary(f,'r3-completion-move');
    cp.sessionRuntime.release(binding.sessionId);
    const other=cp.sessions.create({provider:'scripted',model:'other runtime'});
    cp.sessions.transition(other.sessionId,SessionLifecycle.READY,'fixture other runtime');
    const attest=cp.sessionRuntime.attest.bind(cp.sessionRuntime);
    let observedCompletion=false;
    vi.spyOn(cp.sessionRuntime,'attest').mockImplementationOnce((...args)=>{
      const completion=attest(...args);
      // A completion observer is registered before recovery awaits the same real attestation.
      // The attestation has already done its own post-turn eligibility check when this runs.
      void completion.then(result=>{
        if(!result.allowed) return;
        observedCompletion=true;
        const moved=cp.bindings.switchTo({role:Role.PRIMARY_CTO,roleKey:binding.roleKey,projectId:binding.projectId,
          sessionId:other.sessionId,mode:'PREFERRED',reason:'runtime moves at completed-attestation boundary',conversation:'SURVIVED'});
        if(!moved.allowed) throw new Error(moved.message);
      });
      return completion;
    });
    const result=await cp.cto.recoverDrivenPrimaryCto(binding.roleKey,{capacity:cp.capacity,runtime:cp.sessionRuntime});
    expect(observedCompletion).toBe(true);
    expect(result).toMatchObject({allowed:false,reasonCode:ReasonCode.BINDING_GENERATION_STALE});
    expect(cp.bindings.active(binding.roleKey)?.sessionId).toBe(other.sessionId);
  });
});

it('replacement retirement remains ERROR with no STOPPED evidence until its provider stop returns', async () => {
  await withBootstrapRuntime(async f => {
    const cp=f.harness.cp;
    await registerFixtureProject(f.harness,'r3-delayed-stop');
    const initial=await cp.cto.ensurePrimaryCto('r3-delayed-stop','fixture');
    if(!initial.allowed) throw new Error(initial.message);
    const winner=cp.sessions.create({provider:'scripted',model:'winner'});
    cp.sessions.transition(winner.sessionId,SessionLifecycle.READY,'fixture winner');
    const start=f.gpt.startSession.bind(f.gpt);
    let unused: SessionHandle|null=null;
    vi.spyOn(f.gpt,'startSession').mockImplementationOnce(async spec=>{
      expect(cp.bindings.revoke(initial.value.roleKey,'concurrent holder').allowed).toBe(true);
      expect(cp.bindings.bind({role:Role.PRIMARY_CTO,projectId:'r3-delayed-stop',sessionId:winner.sessionId}).allowed).toBe(true);
      unused=await start(spec);return unused;
    });
    let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve});
    let entered=false;
    const stop=f.gpt.stopSession.bind(f.gpt);
    vi.spyOn(f.gpt,'stopSession').mockImplementationOnce(async handle=>{entered=true;await barrier;return stop(handle)});
    f.loseClaude();
    const pending=cp.continuity.failover(initial.value.roleKey,Role.PRIMARY_CTO,{projectId:'r3-delayed-stop'},'delayed stop');
    await vi.waitFor(()=>expect(entered).toBe(true));
    const row=cp.db.get<{session_id:string}>('SELECT session_id FROM sessions WHERE incarnation LIKE ?',[(unused! as SessionHandle).externalSessionId+'#%'])!;
    try {
      expect(cp.sessions.require(row.session_id).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(cp.audit.byKind('CONTINUITY_REPLACEMENT_CLEANUP')).toHaveLength(0);
      const moved=cp.bindings.switchTo({role:Role.PRIMARY_CTO,roleKey:initial.value.roleKey,projectId:'r3-delayed-stop',sessionId:row.session_id,mode:'PREFERRED',reason:'adopt during stop',conversation:'SURVIVED'});
      expect(moved).toMatchObject({allowed:false,reasonCode:ReasonCode.SESSION_NOT_READY});
    } finally {release()}
    expect((await pending).allowed).toBe(false);
    expect(cp.sessions.require(row.session_id).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(cp.audit.byKind('CONTINUITY_REPLACEMENT_CLEANUP')).toMatchObject([{sessionId:row.session_id,evidence:{outcome:'STOPPED'}}]);
  });
});
