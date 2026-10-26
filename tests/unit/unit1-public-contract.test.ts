import { afterAll, expect, it } from 'vitest';
import { bootstrapPlanGuide } from '../../src/bootstrap/bootstrap-plan.ts';
import { createCtoMcpPort } from '../../src/mcp/cto-server.ts';
import { manifestDigest, projectManifestSchema } from '../../src/contracts/manifest.ts';
import { sha256 } from '../../src/core/digest.ts';
import { allow } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { dispatch } from '../../src/cli/agentctl.ts';
import { RunKind } from '../../src/domain/types.ts';
import { fixtureManifest, makeHarness } from '../helpers/harness.ts';
import { cleanupTempDirs } from '../helpers/fixtures.ts';
afterAll(cleanupTempDirs);
const contract = {goal:'Create a product',why:'owner request',scope:[],nonGoals:[],acceptance:['real tests'],priority:'NORMAL' as const,humanGate:[],references:['https://example.test/owner-design']};
it('R1 the public bootstrap guide requires an initialized public repository and real genesis bytes',() => {
  const guide = bootstrapPlanGuide();
  expect(guide.repositoryCreateOperation.shape.desiredState).toEqual({visibility:'public',autoInit:true});
  expect(guide.planFields.some(f => f.field === 'genesis')).toBe(true);
  expect(guide.manifest.example.ciWorkflows?.length).toBeGreaterThan(0);
});
it('R2 production plan_submit refuses the legacy empty bootstrap without storing it',() => {
  const h = makeHarness({allowTestEvidenceWriters:false});
  const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
  expect(createCtoMcpPort(h.cp).submitPlan(run.value.runId,{summary:'create an empty repository'}).allowed).toBe(false);
  expect(h.cp.artifacts.latest(run.value.runId,'PLAN')).toBeNull();h.cp.close();
});
it('R4/R5 fresh databases persist provisioning and canonical entitlement history',() => {
  const h = makeHarness();
  const tables = h.cp.db.all<{name:string}>("SELECT name FROM sqlite_schema WHERE type = 'table'").map(t => t.name);
  expect(tables).toEqual(expect.arrayContaining(['resident_project_provisioning','canonical_session_entitlements','project_retirements']));h.cp.close();
});
it('R6 the public CLI sends project retirement to the operator service',async () => {
  const calls:unknown[] = [];
  const client = {request:async (method:string,params?:Record<string,unknown>) => {calls.push({method,params});return allow(ReasonCode.OK,{});}};
  expect(await dispatch(client,'project',['retire','old-project','owner requested replacement'],false)).toBe(0);
  expect(calls).toEqual([{method:'project.retire',params:{projectId:'old-project',reason:'owner requested replacement'}}]);
});
it('R8 plan_submit stores the originating owner contract alongside inline bytes and digests',() => {
  const h = makeHarness();const content = "require('node:assert').equal(1,1);\n";const ci = 'name: ci\non: [push]\njobs: {}\n';
  const genesis = {schema:'acp.genesis-bundle.v1',commitMessage:'Create project',files:[{path:'test.js',mode:'100644',contentBase64:Buffer.from(content).toString('base64'),sha256:sha256(content)},{path:'.github/workflows/ci.yml',mode:'100644',contentBase64:Buffer.from(ci).toString('base64'),sha256:sha256(ci)}],branches:{main:'main',integration:'dev',genesis:'genesis'},labels:[],milestones:[{key:'m1',title:'First product increment',description:'first increment'}],issues:[{key:'i1',title:'Build the product',body:'As the owner asked',labels:[],milestoneKey:'m1'}],productIntent:{summary:'Owner product',references:contract.references,ownerInstructions:['Preserve accessibility']}};
  const manifest = projectManifestSchema.parse(fixtureManifest('public-intent',{verificationCommands:[{...fixtureManifest('public-intent').verificationCommands[0]!,id:'test',argv:['node','test.js'],repositoryRole:'primary',cwd:'.',timeoutSeconds:30,required:true,evidenceMode:'LOCAL_COMMAND'}],verificationProfiles:{simple:['test'],standard:['test'],guarded:['test']},ciWorkflows:[{repositoryRole:'primary',path:'.github/workflows/ci.yml',checkName:'ci',approvedDigest:sha256(ci),unapprovedFirstActivation:false}]}));
  const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
  const answer = createCtoMcpPort(h.cp).submitPlan(run.value.runId,{summary:'Create product',bootstrapOperationId:'intent',requestDigest:run.value.contractDigest,projectManifest:manifest,projectManifestDigest:manifestDigest(manifest),genesis});
  expect(answer.allowed,JSON.stringify(answer)).toBe(true);
  expect(h.cp.artifacts.latest<Record<string,unknown>>(run.value.runId,'PLAN')?.content).toMatchObject({genesis,originatingContract:contract});h.cp.close();
});
