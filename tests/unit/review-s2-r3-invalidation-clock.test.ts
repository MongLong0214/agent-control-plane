import { afterAll, expect, it } from 'vitest';
import { join } from 'node:path';
import { ControlPlane } from '../../src/app/control-plane.ts';
import { ManualClock } from '../../src/core/clock.ts';
import { sha256 } from '../../src/core/digest.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { Role } from '../../src/domain/types.ts';
import { TestProductionAdapter } from '../../tests/helpers/production-adapter.ts';
import { cleanupTempDirs, tempDir } from '../../tests/helpers/fixtures.ts';
afterAll(cleanupTempDirs);
it.each([false, true])('a second invalidation after a backward wall-clock step cannot undo the first invalidation (second=%s)', async (second) => {
 const clock = new ManualClock('2026-08-12T00:00:00.000Z');
 const root = tempDir('invalidation-clock-');
 const boot = () => {
  const cp = new ControlPlane({clock,adapters:[],databasePath:join(root,'state.sqlite'),worktreeRoot:join(root,'worktrees'),capacityDir:join(root,'capacity'),secretsDir:join(root,'secrets')});
  const adapter = new TestProductionAdapter(clock,'claude');
  for(const role of [Role.CEO,Role.BOOTSTRAP_CTO,Role.PRIMARY_CTO,Role.WORKER]) cp.providers.registerForRole(adapter,role);
  return {cp,adapter};
 };
 const reading = (remainingPercent:number) => ({provider:'claude',sensorHealth:'HEALTHY' as const,runtimeHealth:'HEALTHY' as const,observedAt:clock.nowIso(),source:'fixture;account-digest:'+sha256('fixture-account'),buckets:[{id:'five_hour',remainingPercent,resetAt:'2026-08-12T05:00:00.000Z',capabilities:['cto','ceo','blind-review','worker']}]});
 const first=boot();
 first.adapter.setCapacity(reading(81));
 expect((await first.cp.tasks.admitWorkerFanout('claude','opus')).reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
 clock.advance(60_000);
 first.cp.providers.invalidateCapacityForRole('claude',Role.WORKER);
 clock.advance(-120_000);
 if (second) first.cp.providers.invalidateCapacityForRole('claude',Role.WORKER);
 first.cp.close();
 clock.advance(180_000);
 const again=boot();
 again.adapter.setCapacity(reading(80));
 try {
  const invalidations=again.cp.audit.byKind('CAPACITY_ROLE_INVALIDATED').map(e=>({eventId:e.eventId,at:e.at}));
  const result=await again.cp.tasks.admitWorkerFanout('claude','opus');
  // eslint-disable-next-line no-console
  console.log('INVALIDATION_CLOCK',JSON.stringify({invalidations,result,refusals:again.cp.audit.byKind('CAPACITY_ROLE_OBSERVATION_NOT_RESTORED').map(e=>e.evidence)}));
  expect(result.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
 }finally{again.cp.close();}
});
