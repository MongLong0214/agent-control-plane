import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RunState } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
  makeHarness,
  ownerDecisionReceipt,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * FD-R1-DUP (review r1 of #1145). Every required owner question is bound once, by its stable id, and a
 * question named twice is refused rather than bound once. The task contract is the durable source of the
 * declarations, and the gate's own derivation drops repeated declarations, so the refusal has to read
 * them as declared, before that happens: an exact repeat, a repeat that differs only in surrounding
 * space, and two spellings that normalise to one question. Nothing here substitutes the derivation; the
 * declarations are stored by run creation exactly as a task contract carries them.
 */
const QUESTION = "custom owner question";

const recordApproval = (harness: ReturnType<typeof makeHarness>, runId: string, item: string): void => {
  const recorded = harness.cp.ceo.recordOwnerDecision({
    runId,
    item,
    approved: true,
    note: `approve ${item}`,
    receipt: ownerDecisionReceipt(harness, runId, item, true, `approve ${item}`),
  });
  if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
};

describe("FD-R1-DUP: an owner question declared twice in the durable task contract is refused, never bound once", () => {
  it.each([
    ["declared twice exactly", [QUESTION, QUESTION], [QUESTION]],
    ["declared twice, once with surrounding space", [QUESTION, `  ${QUESTION} `], [QUESTION]],
    ["declared in two spellings that normalise to one question, each approved", [QUESTION, "Custom  Owner Question"], [QUESTION, "Custom  Owner Question"]],
  ])("FD-R1-DUP a question %s leaves the gate unsatisfied, CONFIRM refused and the daemon finalizer writing nothing", async (_label, declared, approved) => {
    const github = new FakeGitHub();
    const harness = makeHarness({ githubClient: github });
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    const driven = await driveToReviewedCandidate(harness, { workBranch: "feature/F1-duplicate-declaration", humanGate: declared });
    // The durable contract carries the declarations as given.
    expect(harness.cp.artifacts.latest<{ humanGate?: unknown }>(driven.runId, "TASK_CONTRACT")?.content.humanGate).toEqual(declared);
    for (const item of approved) recordApproval(harness, driven.runId, item);

    expect(harness.cp.ceo.humanGateStatus(driven.runId)).toMatchObject({ required: true, satisfied: false });
    expect(harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED,
      message: "the human-gate definition names an item more than once",
    });
    expect(harness.cp.ceo.humanGateBinding(driven.runId)).toMatchObject({ satisfied: false, humanGateDigest: null });

    // The CEO cannot confirm it, so the daemon finalizer has nothing to finalize and writes nothing.
    await expect(approveReviewedCandidateForFinalization(harness, driven)).rejects.toThrow(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.CEO_APPROVED);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-fd-r1-dup-") });
    try {
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
      expect((await daemon.finalizeApprovedRun(driven.runId)).allowed).toBe(false);
    } finally {
      await daemon.stop();
    }
    expect(github.calls).toEqual([]);
  });

  it("FD-R1-DUP control: one declaration of each question, each approved, binds the gate", async () => {
    const harness = makeHarness({ githubClient: new FakeGitHub() });
    const declared = [QUESTION, "another owner question"];
    const driven = await driveToReviewedCandidate(harness, { workBranch: "feature/F1-duplicate-declaration", humanGate: declared });
    for (const item of declared) recordApproval(harness, driven.runId, item);
    expect(harness.cp.ceo.humanGateStatus(driven.runId)).toEqual({ required: true, items: declared, satisfied: true });
    expect(harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId).allowed).toBe(true);
  });
});
