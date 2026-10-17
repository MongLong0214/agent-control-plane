/**
 * Review round 2 of #1099, the reviewer's blocker reproduction (ACP-S2-R2-01), kept as written apart
 * from paths, isolation (the database and every directory live under `tempDir`; HOME is the suite's
 * isolated one) and a lint exemption for its evidence line.
 *
 * Each account-identity read had its own 20 s around the `/usage` read, so two identity reads that
 * time out plus a 10 s usage read put a healthy reading past the doctor's 45 s capacity deadline.
 */
import { afterAll, expect, it, vi } from "vitest";
import { join } from "node:path";
import { ClaudeUsageCollector, COLLECTOR_TIMEOUT_MS } from "../../src/capacity/usage-collectors.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { CAPACITY_SWEEP_BUDGET_MS } from "../../src/doctor/doctor.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";
import { tempDir, cleanupTempDirs } from "../helpers/fixtures.ts";
afterAll(cleanupTempDirs);
it("identity timeouts do not make a successful usage read miss the doctor deadline", async () => {
 const clock = new ManualClock("2026-08-13T00:00:00.000Z");
 const pause = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
 const collector = new ClaudeUsageCollector({clock,binary:"injected-fixture",nonInteractive:{
  async run(){await pause(10000); return {code:0,stderr:"",stdout:JSON.stringify({is_error:false,result:"Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)"})};}
 },accountIdentity:{async run(input){await pause(input.timeoutMs);return {code:null,timedOut:true,stdout:"",stderr:""};}}});
 const adapter = new TestProductionAdapter(clock,"claude");
 adapter.probeCapacity=async()=>({...await collector.collect(),runtimeHealth:"HEALTHY" as const});
 const root=tempDir("acp-budget-regression-");
 const cp=new ControlPlane({clock,adapters:[adapter],databasePath:join(root,"state.sqlite"),worktreeRoot:join(root,"worktrees"),capacityDir:join(root,"capacity"),secretsDir:join(root,"secrets")});
 vi.useFakeTimers();
 try {
  const pending=cp.doctor.run("capacity");
  await vi.advanceTimersByTimeAsync(CAPACITY_SWEEP_BUDGET_MS+1);
  const report=await pending;
  const atDeadline=cp.capacity.current("claude");
  await vi.advanceTimersByTimeAsync(10000);
  // eslint-disable-next-line no-console -- the reviewer's evidence line, kept as written
  console.log("BUDGET",JSON.stringify({collectorBudget:COLLECTOR_TIMEOUT_MS,doctorBudget:CAPACITY_SWEEP_BUDGET_MS,atDeadline:atDeadline?.sensorHealth??null,after:cp.capacity.current("claude")?.sensorHealth,codes:report.findings.map(f=>f.code)}));
  expect(report.findings.some(f=>f.code==="CAPACITY_SWEEP_NOT_REACHED")).toBe(false);
 } finally {vi.useRealTimers();cp.close();}
});
