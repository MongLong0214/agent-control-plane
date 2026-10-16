import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { bootstrapCoverageKeys, bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The REVISION_RETURNED_TO_CTO row of a blind-review verdict, kept. It carried the review packet
 * whole — the reviewer's findings text and the egress JSONL among it — so the audit refused the row
 * and kept `{auditEvidenceRejected:true}` (live run_7717, both REVISE rounds). The row now holds a
 * fixed field list: counts, severities and digests, and the digest of the stored BLIND_REVIEW
 * artifact the findings are read from. The revision delivered to the CTO still carries the findings.
 */

const contract = {
  goal: "bootstrap",
  why: "new repository",
  scope: [],
  nonGoals: [],
  acceptance: ["repository created"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

// The three MAJOR findings run_7717's reviewer returned, in its words' shape: free-form, over 200 characters.
const FINDINGS = [
  "The plan is missing the repository and initial-commit readback: nothing in the planned outputs reads the created repository back from GitHub, so a create that silently produced something else would be accepted as the planned repository.",
  "Application-result processing and manifest activation are missing: the planned outputs end at the create operation and never parse a result or activate the project manifest the PLAN carries, so the project would never become active.",
  "There is no PRIMARY_CTO handoff and ACK in the plan: the handoff package is planned but nothing requires the incoming primary CTO to acknowledge it before the run completes, so the project could be left without an owner.",
];

describe("W3: the REVISION_RETURNED_TO_CTO row of a REVISE verdict keeps bounded evidence", () => {
  it("no auditEvidenceRejected and no findings text; counts, severities and digests name the stored review, and the delivery keeps the findings", async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    let seq = 0;
    const call = (name: string, args: Record<string, unknown>) =>
      callCtoToolAsOwner(h, runId, name, { idempotencyKey: `revision-audit-${++seq}`, runId, ...args });

    expect((await call("plan_submit", {
      plan: bootstrapPlan(cleanTreeManifest("revision-audit")),
      tasks: [{ key: "create", title: "create repository", category: "implementation" }],
    })).body).toMatchObject({ ok: true });
    h.scripted.script({
      match: /Bootstrap plan review/,
      text: JSON.stringify({
        verdict: "REVISE",
        coveredFiles: bootstrapCoverageKeys(h, runId),
        omittedItems: [],
        findings: FINDINGS.map((text, i) => ({
          category: "correctness",
          severity: i === 2 ? "BLOCKER" : "MAJOR",
          repository: "github:acme/fixture",
          path: null,
          summary: text,
          detail: `${text} Required change: state it.`,
        })),
      }),
    });
    const submitted = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(submitted.body, submitted.text).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
    const candidate = (submitted.body["value"] as { snapshotDigest: string }).snapshotDigest;

    const rows = h.cp.audit.byKind("REVISION_RETURNED_TO_CTO").filter((row) => row.runId === runId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
    expect(row.evidence).not.toHaveProperty("auditEvidenceRejected");

    const review = h.cp.artifacts.latestForSnapshot<ReviewPacket>(runId, "BLIND_REVIEW", candidate)!;
    expect(review.producedBy).toBe("blind-review-gate");
    expect(row.evidence).toEqual({
      stage: "blind-review",
      candidateSnapshotDigest: candidate,
      reviewArtifactDigest: review.digest,
      reviewKind: "BOOTSTRAP_PLAN",
      verdict: "REVISE",
      findings: 3,
      findingsBySeverity: { INFO: 0, MINOR: 0, MAJOR: 2, BLOCKER: 1 },
      findingDigests: review.content.findings.map((finding) => digestOf(finding)),
      coveredFiles: review.content.coveredFiles.length,
      omittedItems: 0,
      planDigest: review.content.bootstrapPlan!.planDigest,
      bootstrapPlanIntentDigest: review.content.bootstrapPlanIntentDigest,
    });
    const stored = JSON.stringify(row.evidence);
    for (const text of FINDINGS) expect(stored).not.toContain(text.slice(0, 40));

    // The delivered revision is separate from the audit summary: it still carries every finding.
    const delivered = h.cp.outbox.listByRun(runId).filter((message) => message.kind === "REVISION_REQUEST");
    expect(delivered).toHaveLength(1);
    const payload = JSON.stringify(delivered[0]!.payload);
    for (const text of FINDINGS) expect(payload).toContain(text);
  });
});
