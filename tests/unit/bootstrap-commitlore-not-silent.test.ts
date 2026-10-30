import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import { projectManifestSchema } from "../../src/contracts/manifest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { bootstrapOperations, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { type Operation, noGitHubCall, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * Issue #246 G0a (RF-018, RF-S20/RF-S21 on the ACP producer path) — the manifest's `commitlore.mode` is
 * never a silent PASS. A manifest that requires CommitLore is planned as approved and, with nothing to
 * observe CommitLore with, refused before any GitHub call (#246 B3 enforces it where it can be observed:
 * `bootstrap-commitlore-mode.test.ts`). #1268 — a new project requires CommitLore: a bootstrap manifest that
 * prefers it or turns it off is refused before anything is written, as activation would refuse it after.
 *
 * The plans are the push-mode bootstrap the producer already performs, so these witnesses isolate
 * CommitLore from every other change.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const pushOperations = (): Operation[] => bootstrapOperations() as Operation[];

describe("#246 G0a: CommitLore is never a silent PASS on the ACP producer path", () => {
  it("G0a-1: a PLAN whose manifest requires CommitLore is planned as approved, and with no CommitLore observer refused before any GitHub call, with zero writes", async () => {
    const manifest = cleanTreeManifest("g0a-required", { commitlore: { mode: "required" } });
    const planned = plannedBootstrapOutputs(
      { runId: "run_g0a", planArtifact: { digest: "probe", content: bootstrapPlan(manifest, { operations: pushOperations() }) } },
      manifest,
    );
    expect(planned.allowed, JSON.stringify(planned)).toBe(true);
    const prepared = await prepareBootstrapRun("g0a-required", { manifest, ops: pushOperations(), commitlore: null });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "precondition", refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE", commitloreMode: "required" },
    });
    noGitHubCall(prepared);
  });

  it("G0a-3 (#1268): a new project whose manifest leaves the mode out requires CommitLore: with none to run it is refused, never let through as preferred", async () => {
    const { commitlore: _omitted, ...input } = cleanTreeManifest("g0a-omitted");
    const manifest = projectManifestSchema.parse(input);
    expect(manifest.commitlore).toEqual({ mode: "required" });
    const prepared = await prepareBootstrapRun("g0a-omitted", { manifest, ops: pushOperations(), commitlore: null });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      evidence: { stage: "precondition", refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE", commitloreMode: "required" },
    });
    noGitHubCall(prepared);
  });

  it.each(["preferred", "off"] as const)("G0a-2 (#1268): a new project whose manifest says %s is refused before anything is written", async (mode) => {
    const manifest = cleanTreeManifest(`g0a-${mode}`, { commitlore: { mode } });
    const prepared = await prepareBootstrapRun(`g0a-${mode}`, { manifest, ops: pushOperations() });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "precondition", refusal: "COMMITLORE_MODE_NOT_REQUIRED", commitloreMode: mode },
    });
    noGitHubCall(prepared);
  });
});
