import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ContinuityMode, Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { CONTINUITY_MODE_MAX_AGE_MS } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * A CEO CONFIRM is refused while continuity's last evaluation is older than five minutes. A daemon
 * restart leaves exactly that gap — no evaluation at startup and the first sweep minutes later — so the
 * CEO's door re-evaluates first, as the candidate pipeline does before its packet: a current NORMAL is
 * admitted, SURVIVAL is still refused, a failed evaluation refuses, and the age limit is unchanged.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>;

const ceoDecisionTool = (harness: Harness): ToolHandler => {
  const server = createHermesServer(createHermesMcpPort(harness.cp), () => allow(ReasonCode.OK, { actor: "hermes-daemon" }));
  return (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools["ceo_decision_submit"]!.handler;
};

/** A STANDARD_WORK run at READY_FOR_CEO_REVIEW with its published packet, the CEO bound. */
const readyForCeo = async () => {
  const harness = makeHarness();
  const driven = await driveToReviewedCandidate(harness);
  await harness.cp.continuity.evaluate("packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "ready",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  const ceoSessionId = harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
  const tool = ceoDecisionTool(harness);
  const confirm = async (key: string) => (await tool({
    idempotencyKey: key,
    runId: driven.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    ceoSessionId,
    rationale: "confirm",
  })).structuredContent ?? {};
  const ceoDecisions = () => harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_DECISION").length;
  return { harness, driven, confirm, ceoDecisions };
};

/** The only provider stops answering: coverage is gone, and an evaluation moves continuity to SURVIVAL. */
const loseEveryProvider = (harness: Harness): void => {
  harness.scripted.setRuntimeHealth("UNAVAILABLE");
  harness.scripted.setCapacity(null);
};

describe("a CEO CONFIRM re-evaluates continuity first", () => {
  it("a CONFIRM after the last evaluation is 6 minutes old is admitted, on an evaluation made for it", async () => {
    const f = await readyForCeo();
    try {
      f.harness.clock.advance(6 * 60_000);
      expect(f.harness.cp.continuity.modeAgeMs()).toBeGreaterThan(CONTINUITY_MODE_MAX_AGE_MS);
      const evaluate = vi.spyOn(f.harness.cp.continuity, "evaluate");
      expect(await f.confirm("confirm-after-gap")).toMatchObject({ ok: true, value: { state: RunState.CEO_APPROVED } });
      expect(evaluate).toHaveBeenCalledWith("pre-completion");
      expect(f.harness.cp.continuity.modeAgeMs()).toBe(0);
      expect(f.ceoDecisions()).toBe(1);
    } finally {
      f.harness.cp.close();
    }
  });

  it("in SURVIVAL the refreshed CONFIRM is still refused", async () => {
    const f = await readyForCeo();
    try {
      f.harness.clock.advance(6 * 60_000);
      loseEveryProvider(f.harness);
      expect(await f.confirm("confirm-in-survival")).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
      });
      expect(f.harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);
      expect(f.harness.cp.runs.require(f.driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(f.ceoDecisions()).toBe(0);
    } finally {
      f.harness.cp.close();
    }
  });

  it("an evaluation that throws refuses the CONFIRM, even beside a NORMAL evaluated a moment ago", async () => {
    const f = await readyForCeo();
    try {
      expect(f.harness.cp.continuity.assertCompletionAllowed(f.driven.runId).allowed).toBe(true);
      vi.spyOn(f.harness.cp.continuity, "evaluate").mockRejectedValue(new Error("capacity sensor failed"));
      expect(await f.confirm("confirm-evaluation-throws")).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
      });
      expect(f.harness.cp.runs.require(f.driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(f.ceoDecisions()).toBe(0);
    } finally {
      f.harness.cp.close();
    }
  });

  it("a refused CONFIRM records no CEO decision: its key replays the refusal, and a new key is a new request", async () => {
    const f = await readyForCeo();
    try {
      f.harness.clock.advance(6 * 60_000);
      loseEveryProvider(f.harness);
      const refused = await f.confirm("confirm-k1");
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION });
      expect(f.ceoDecisions()).toBe(0);

      // Coverage returns. The first key still answers with its durable first response.
      f.harness.scripted.setRuntimeHealth("HEALTHY");
      f.harness.clock.advance(6 * 60_000);
      expect(await f.confirm("confirm-k1")).toEqual(refused);
      expect(f.ceoDecisions()).toBe(0);
      expect(f.harness.cp.runs.require(f.driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

      // A new key is a new request, decided on a fresh evaluation, not a replay of the refusal.
      expect(await f.confirm("confirm-k2")).toMatchObject({ ok: true, value: { state: RunState.CEO_APPROVED } });
      expect(f.ceoDecisions()).toBe(1);
    } finally {
      f.harness.cp.close();
    }
  });

  it("FINAL_REVISE is not a completion and asks no evaluation", async () => {
    const f = await readyForCeo();
    try {
      const evaluate = vi.spyOn(f.harness.cp.continuity, "evaluate");
      const tool = ceoDecisionTool(f.harness);
      const revised = (await tool({
        idempotencyKey: "revise",
        runId: f.driven.runId,
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: f.driven.candidateSnapshotDigest,
        ceoSessionId: f.harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId,
        rationale: "revise",
      })).structuredContent;
      expect(revised).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      f.harness.cp.close();
    }
  });
});
