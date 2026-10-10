import { afterAll, afterEach, expect, it, vi } from "vitest";

import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { isAdoptedCanonicalRuntime } from "../../src/registry/canonical-self-claim.ts";
import type { SessionHandle } from "../../src/runtime/provider.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #246 PR-C C4-R2 — review 3 of the recovery slice. A session a continuity attempt started and will
 * not use is stopped through its provider only when it is proven to be nobody's — no ACTIVE
 * assignment and no adopted canonical runtime — and that holds for a refused failover and for a
 * provisioning refused after the provider started the session alike. The first five bodies are the
 * review's witnesses with only their harness adapted (no review-tree output files); the provisioning
 * siblings after them are this slice's own.
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

it('ROUND1-ESCAPE-02: failover route refusal must stop the provider resource it already started',async()=>{
  await withBootstrapRuntime(async f=>{
    const cp=f.harness.cp;
    const projectId='r3-refused-provider-route';
    await registerFixtureProject(f.harness,projectId);
    const initial=await cp.cto.ensurePrimaryCto(projectId,'fixture');
    if(!initial.allowed) throw new Error(initial.message);
    const start=f.gpt.startSession.bind(f.gpt);
    let unused:SessionHandle|null=null;
    vi.spyOn(f.gpt,'startSession').mockImplementationOnce(async spec=>{unused=await start(spec);return unused});
    cp.continuity.attach({buzz:{connect:async()=>deny(ReasonCode.SESSION_NOT_READY,'fixture route refusal',{})}});
    const stop=vi.spyOn(f.gpt,'stopSession');
    f.loseClaude();
    const refused=await cp.continuity.failover(initial.value.roleKey,Role.PRIMARY_CTO,{projectId},'route refusal');
    expect(refused).toMatchObject({allowed:false,reasonCode:ReasonCode.SESSION_NOT_READY});
    expect(unused).not.toBeNull();
    const resource=unused! as SessionHandle;
    const providerHealth=await f.gpt.probeSession(resource);
    const current=cp.bindings.active(initial.value.roleKey);
    expect(current?.assignmentId).toBe(initial.value.assignmentId);
    expect.soft(stop).toHaveBeenCalledTimes(1);
    expect.soft(providerHealth).toBe('UNAVAILABLE');
  });
});


/** The row a provisioned session was recorded under, found by its provider conversation id. */
const provisionedRow = (f: BootstrapRuntimeFixture, resource: SessionHandle) =>
  f.harness.cp.db.get<{ session_id: string; lifecycle: string }>(
    "SELECT session_id, lifecycle FROM sessions WHERE incarnation LIKE ?",
    [`${resource.externalSessionId}#%`],
  );

/**
 * A failover whose replacement the provider starts, then refused by `refuse` after the start. The
 * started resource is captured, and the real provider probe is kept so its health is read honestly.
 */
const refusedProvisioning = async (
  f: BootstrapRuntimeFixture,
  projectId: string,
  refuse: (
    f: BootstrapRuntimeFixture,
    started: () => SessionHandle | null,
    stop: { mockRejectedValueOnce: (error: Error) => unknown },
  ) => void,
) => {
  const cp = f.harness.cp;
  await registerFixtureProject(f.harness, projectId);
  const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
  if (!initial.allowed) throw new Error(initial.message);
  const start = f.gpt.startSession.bind(f.gpt);
  const probe = f.gpt.probeSession.bind(f.gpt);
  let started: SessionHandle | null = null;
  vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
    started = await start(spec);
    return started;
  });
  const stop = vi.spyOn(f.gpt, "stopSession");
  refuse(f, () => started, stop);
  f.loseClaude();
  const refused = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "refused provisioning");
  const resource = started as SessionHandle | null;
  if (!resource) throw new Error("the provider never started a replacement");
  return { cp, initial, refused, resource, stop, probe, row: provisionedRow(f, resource) };
};

it("a replacement whose provider probe is not HEALTHY is stopped through the provider", async () => {
  await withBootstrapRuntime(async (f) => {
    const out = await refusedProvisioning(f, "r3-probe-degraded", (fx, started) => {
      const real = fx.gpt.probeSession.bind(fx.gpt);
      vi.spyOn(fx.gpt, "probeSession").mockImplementation(async (handle) =>
        handle.externalSessionId === started()?.externalSessionId ? "DEGRADED" : real(handle));
    });
    expect(out.refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
    expect(out.stop).toHaveBeenCalledTimes(1);
    expect(out.stop.mock.calls[0]?.[0]).toMatchObject({ externalSessionId: out.resource.externalSessionId });
    expect(await out.probe(out.resource)).toBe("UNAVAILABLE");
    expect(out.row?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(out.cp.audit.byKind("CONTINUITY_REPLACEMENT_CLEANUP")).toMatchObject([
      { sessionId: out.row?.session_id, evidence: { outcome: "STOPPED", reason: "provider session probe failed" } },
    ]);
    expect(out.cp.bindings.active(out.initial.value.roleKey)?.assignmentId).toBe(out.initial.value.assignmentId);
  });
});

it("a replacement whose provider probe throws is stopped through the provider", async () => {
  await withBootstrapRuntime(async (f) => {
    const out = await refusedProvisioning(f, "r3-probe-threw", (fx, started) => {
      const real = fx.gpt.probeSession.bind(fx.gpt);
      vi.spyOn(fx.gpt, "probeSession").mockImplementation(async (handle) => {
        if (handle.externalSessionId === started()?.externalSessionId) throw new Error("fixture probe failure");
        return real(handle);
      });
    });
    expect(out.refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
    expect(out.stop).toHaveBeenCalledTimes(1);
    expect(await out.probe(out.resource)).toBe("UNAVAILABLE");
    expect(out.row?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(out.cp.audit.byKind("CONTINUITY_REPLACEMENT_CLEANUP")).toMatchObject([
      { sessionId: out.row?.session_id, evidence: { outcome: "STOPPED", reason: "provider session probe threw" } },
    ]);
  });
});

it("a replacement refused by the readiness probe is stopped through the provider", async () => {
  await withBootstrapRuntime(async (f) => {
    const out = await refusedProvisioning(f, "r3-readiness-refused", (fx) => {
      fx.harness.cp.continuity.attach({
        readiness: { checkSession: async () => deny(ReasonCode.SESSION_NOT_READY, "fixture readiness refusal", {}) },
      });
    });
    expect(out.refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
    expect(out.stop).toHaveBeenCalledTimes(1);
    expect(await out.probe(out.resource)).toBe("UNAVAILABLE");
    expect(out.row?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(out.cp.audit.byKind("CONTINUITY_REPLACEMENT_CLEANUP")).toMatchObject([
      { sessionId: out.row?.session_id, evidence: { outcome: "STOPPED", reason: "readiness failed" } },
    ]);
  });
});

it("a refused replacement whose provider stop fails stays ERROR and is recorded as remaining", async () => {
  await withBootstrapRuntime(async (f) => {
    const out = await refusedProvisioning(f, "r3-route-stop-fails", (fx, _started, stop) => {
      fx.harness.cp.continuity.attach({
        buzz: { connect: async () => deny(ReasonCode.SESSION_NOT_READY, "fixture route refusal", {}) },
      });
      stop.mockRejectedValueOnce(new Error("fixture stop failure"));
    });
    expect(out.refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
    expect(out.stop).toHaveBeenCalledTimes(1);
    expect(await out.probe(out.resource)).toBe("HEALTHY");
    expect(out.row?.lifecycle).toBe(SessionLifecycle.ERROR);
    expect(out.cp.audit.byKind("CONTINUITY_REPLACEMENT_CLEANUP")).toMatchObject([
      { sessionId: out.row?.session_id, evidence: { outcome: "REMAINING_STOP_FAILED", reason: "buzz connect failed" } },
    ]);
  });
});
