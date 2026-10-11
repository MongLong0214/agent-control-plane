import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { bootstrapOperations, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { type Operation, activateAndConfirm, noGitHubCall, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * Issue #246 G0a (RF-018, RF-S20/RF-S21 on the ACP producer path) — the manifest's `commitlore.mode` is
 * never a silent PASS. This producer installs no CommitLore hook and observes no CommitLore record, so a
 * manifest that requires CommitLore is refused as unsupported before any GitHub call, one that prefers
 * it activates with the activation result naming it NOT_OBSERVED, and `off` activates as before.
 *
 * The plans are the push-mode bootstrap the producer already performs, so these witnesses isolate
 * CommitLore from every other change.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const pushOperations = (): Operation[] => bootstrapOperations() as Operation[];

describe("#246 G0a: CommitLore is never a silent PASS on the ACP producer path", () => {
  it("G0a-1: a PLAN whose manifest requires CommitLore is refused as unsupported before any GitHub call, with zero writes", async () => {
    const manifest = cleanTreeManifest("g0a-required", { commitlore: { mode: "required" } });
    const planned = plannedBootstrapOutputs(
      { runId: "run_g0a", planArtifact: { digest: "probe", content: bootstrapPlan(manifest, { operations: pushOperations() }) } },
      manifest,
    );
    expect(planned, JSON.stringify(planned)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { refusal: "UNSUPPORTED_VERIFICATION", commitloreMode: "required" },
    });
    const prepared = await prepareBootstrapRun("g0a-required", { manifest, ops: pushOperations() });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "precondition", refusal: "UNSUPPORTED_VERIFICATION", commitloreMode: "required" },
    });
    noGitHubCall(prepared);
  });

  it("G0a-2: a manifest that prefers CommitLore activates, and BOOTSTRAP_ACTIVATION_RESULT names it NOT_OBSERVED", async () => {
    const prepared = await prepareBootstrapRun("g0a-preferred", { manifest: cleanTreeManifest("g0a-preferred"), ops: pushOperations() });
    const { beforeConfirm, final } = await activateAndConfirm(prepared);
    expect(beforeConfirm["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
    expect(final["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
  });

  it("G0a-3 (control): a manifest with CommitLore off activates as before, with no CommitLore warning", async () => {
    const manifest = cleanTreeManifest("g0a-off", { commitlore: { mode: "off" } });
    const prepared = await prepareBootstrapRun("g0a-off", { manifest, ops: pushOperations() });
    const { final } = await activateAndConfirm(prepared);
    expect((final["warnings"] as unknown[] | undefined) ?? []).toEqual([]);
    expect(JSON.stringify(final)).not.toContain("NOT_OBSERVED");
  });
});
