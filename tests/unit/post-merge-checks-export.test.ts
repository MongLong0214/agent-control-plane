import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import {
  reproduceRunEvidenceExport,
  RunEvidenceExporter,
  sealRunEvidenceExport,
  verifyRunEvidenceExport,
  type RunEvidenceExport,
} from "../../src/export/run-evidence.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 (b) — the export tells post-merge outcomes apart (`quality.postMergeChecks`), and only a
 * PASSED or a legitimate NONE_DECLARED satisfies the post-merge fact Gate A reads. The receipts are
 * inserted the way github-kernel `postMergeVerify` and `mergeExecute` write them.
 */

type Harness = ReturnType<typeof makeHarness>;
type Check = { name: string; conclusion: string | null };

const contract = {
  goal: "tell post-merge outcomes apart",
  why: "a failed post-merge must not satisfy Gate A",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["the export tells post-merge outcomes apart"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);

async function runWith(h: Harness, declared: string[], projectId = "pm-project") {
  const project = await registerFixtureProject(h, projectId, { postMergeCommands: declared });
  const created = h.cp.runs.create({
    projectId: project.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const pinned = h.cp.runs.pinManifest(created.value.runId, h.cp.projects.get(project.projectId)!.activeManifestDigest!);
  if (!pinned.allowed) throw new Error(pinned.message);
  return { runId: created.value.runId, identity: project.identity };
}

/** A merge_execute receipt reserved PENDING and completed after its reread, as the kernel does. */
function recordMerge(h: Harness, runId: string, identity: string, sha: string, pull = 1): void {
  const key = `merge_execute:test:${runId}:${identity}:${sha}`;
  const receiptId = `rcp_${sha256(key).slice(7, 31)}`;
  const at = h.clock.nowIso();
  h.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
        resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
        response_json, created_at, reread_at, verified, status)
     VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, ?, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [receiptId, key, runId, identity, `acme/fixture#${pull}`, digestOf({ head: sha }), digestOf({ key }), at],
  );
  h.cp.db.run(
    `UPDATE github_receipts SET status = 'APPLIED', verified = 1, after_state_digest = ?, reread_at = ?, response_json = ?
      WHERE receipt_id = ?`,
    [sha256(sha), at, JSON.stringify({ mergeCommitSha: sha }), receiptId],
  );
}

/** The post_merge_verify receipt github-kernel writes: response and after-state digest as it computes them. */
function recordPostMerge(
  h: Harness,
  runId: string,
  identity: string,
  sha: string,
  response: { checks: Check[]; noChecksDeclared?: true },
): void {
  const key = `post_merge_verify:${identity}:${sha}`;
  const at = h.clock.nowIso();
  h.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
        resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
        response_json, created_at, reread_at, verified, status)
     VALUES (?, ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [
      `rcp_${sha256(key).slice(7, 31)}`, key, runId, identity, `acme/fixture@${sha}`,
      response.noChecksDeclared ? digestOf(response) : digestOf(response.checks),
      digestOf({ mergeCommitSha: sha, requiredChecks: response.checks.map((check) => check.name) }),
      JSON.stringify(response), at, at,
    ],
  );
}

function exported(h: Harness, runId: string): RunEvidenceExport {
  const result = new RunEvidenceExporter(h.cp.db, h.cp.artifacts, h.clock, h.cp.audit).exportRun(runId);
  if (!result.allowed) throw new Error(result.message);
  return result.value;
}

function postMergeFact(bundle: RunEvidenceExport): unknown {
  const facts = bundle.baseline.quality["facts"] as Array<Record<string, unknown>>;
  return facts.find((fact) => fact["name"] === "postMergeVerification")?.["present"];
}

describe("#1189 (b) post-merge checks told apart in the run-evidence export", () => {
  it("reads a failed post-merge as FAILED and no longer lets it satisfy the Gate A post-merge fact", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit", "e2e"]);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, {
      checks: [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "failure" }],
    });
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("FAILED");
    expect(bundle.baseline.quality["complete"]).toBe(false);
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    expect(reproduceRunEvidenceExport(bundle)).toBe(true);
    expect(verifyRunEvidenceExport(bundle, h.cp.db)).toBe(true);
  });

  it("treats neutral and skipped as the kernel's check policy does: not a success", async () => {
    for (const conclusion of ["neutral", "skipped"]) {
      const h = makeHarness();
      const { runId, identity } = await runWith(h, ["unit"]);
      recordMerge(h, runId, identity, SHA);
      recordPostMerge(h, runId, identity, SHA, { checks: [{ name: "unit", conclusion }] });
      const bundle = exported(h, runId);
      expect(postMergeFact(bundle)).toBe(false);
      expect(bundle.baseline.quality["postMergeChecks"]).toBe("FAILED");
      expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    }
  });

  it("reads every declared check succeeding on the merge SHA as PASSED, which satisfies the fact", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit", "e2e"]);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, {
      checks: [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "success" }],
    });
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(true);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("PASSED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    expect(verifyRunEvidenceExport(bundle, h.cp.db)).toBe(true);
  });

  it("reads no declared checks as NONE_DECLARED, kept apart from PASSED, and the fact is satisfied as not applicable", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, []);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, { checks: [], noChecksDeclared: true });
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(true);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("NONE_DECLARED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    expect(verifyRunEvidenceExport(bundle, h.cp.db)).toBe(true);
  });

  it("does not let a noChecksDeclared receipt erase checks the pinned manifest declares", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit"]);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, { checks: [], noChecksDeclared: true });
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("UNOBSERVED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
  });

  it("reads pending, null and missing checks as UNOBSERVED, never as a PASS or a recorded FAIL", async () => {
    const unanswered: Check[][] = [
      [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "incomplete:pending" }],
      [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "incomplete:in_progress" }],
      [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "pending" }],
      [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: null }],
      [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "missing" }],
      // A declared check the receipt does not carry at all.
      [{ name: "unit", conclusion: "success" }],
    ];
    for (const checks of unanswered) {
      const h = makeHarness();
      const { runId, identity } = await runWith(h, ["unit", "e2e"]);
      recordMerge(h, runId, identity, SHA);
      recordPostMerge(h, runId, identity, SHA, { checks });
      const bundle = exported(h, runId);
      expect(postMergeFact(bundle)).toBe(false);
      expect(bundle.baseline.quality["postMergeChecks"], JSON.stringify(checks)).toBe("UNOBSERVED");
      expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    }
  });

  it("reads a failure next to an unanswered check as FAILED", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit", "e2e"]);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, {
      checks: [{ name: "unit", conclusion: "failure" }, { name: "e2e", conclusion: "incomplete:queued" }],
    });
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("FAILED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
  });

  it("does not use another run's receipt for the same repository and merge SHA", async () => {
    const h = makeHarness();
    const project = await registerFixtureProject(h, "pm-project", { postMergeCommands: ["unit"] });
    const runFor = () => {
      const created = h.cp.runs.create({
        projectId: project.projectId,
        executionMode: ExecutionMode.STANDARD,
        contract,
        repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!created.allowed) throw new Error(created.message);
      expect(h.cp.runs.pinManifest(created.value.runId, h.cp.projects.get(project.projectId)!.activeManifestDigest!).allowed)
        .toBe(true);
      return created.value.runId;
    };
    const other = runFor();
    const runId = runFor();
    recordMerge(h, other, project.identity, SHA);
    recordPostMerge(h, other, project.identity, SHA, { checks: [{ name: "unit", conclusion: "success" }] });
    recordMerge(h, runId, project.identity, SHA, 2);

    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("UNOBSERVED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("UNAVAILABLE");
    // The other run keeps its own answer.
    expect(exported(h, other).baseline.quality["postMergeChecks"]).toBe("PASSED");
  });

  it("does not use a receipt for an older merge SHA in place of this run's verified merge", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit"]);
    recordPostMerge(h, runId, identity, OLD_SHA, { checks: [{ name: "unit", conclusion: "success" }] });
    recordMerge(h, runId, identity, SHA);
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("UNOBSERVED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");

    // An older merge of this run that was verified does not answer for a later merge that was not.
    const h2 = makeHarness();
    const second = await runWith(h2, ["unit"]);
    recordMerge(h2, second.runId, second.identity, OLD_SHA);
    recordPostMerge(h2, second.runId, second.identity, OLD_SHA, { checks: [{ name: "unit", conclusion: "success" }] });
    recordMerge(h2, second.runId, second.identity, SHA, 2);
    const later = exported(h2, second.runId);
    expect(postMergeFact(later)).toBe(false);
    expect(later.baseline.quality["postMergeChecks"]).toBe("UNOBSERVED");
    expect(later.baseline.quality["postMergeVerification"]).toBe("PRESENT");
  });

  it("does not let a receipt taken under another declared set answer for the set now declared on the same merge SHA", async () => {
    // Each receipt is written as postMergeVerify would have written it under the earlier set; the trusted set
    // the export reads now is the pinned manifest's, and the receipt's checks are compared against it.
    const cases: Array<{ now: string[]; then: { checks: Check[]; noChecksDeclared?: true } }> = [
      { now: ["unit", "e2e"], then: { checks: [], noChecksDeclared: true } },
      { now: ["unit", "e2e"], then: { checks: [{ name: "unit", conclusion: "success" }] } },
      { now: ["unit"], then: { checks: [{ name: "unit", conclusion: "success" }, { name: "e2e", conclusion: "success" }] } },
    ];
    for (const { now, then } of cases) {
      const h = makeHarness();
      const { runId, identity } = await runWith(h, now);
      recordMerge(h, runId, identity, SHA);
      recordPostMerge(h, runId, identity, SHA, then);
      const bundle = exported(h, runId);
      expect(postMergeFact(bundle), JSON.stringify({ now, then })).toBe(false);
      expect(bundle.baseline.quality["postMergeChecks"], JSON.stringify({ now, then })).toBe("UNOBSERVED");
      expect(bundle.baseline.quality["postMergeVerification"]).toBe("PRESENT");
    }
  });

  it("reads a run with no verified merge as UNOBSERVED", async () => {
    const h = makeHarness();
    const { runId } = await runWith(h, ["unit"]);
    const bundle = exported(h, runId);
    expect(postMergeFact(bundle)).toBe(false);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("UNOBSERVED");
    expect(bundle.baseline.quality["postMergeVerification"]).toBe("UNAVAILABLE");
  });

  it("does not reproduce a bundle whose carried post-merge response was edited and resealed", async () => {
    const h = makeHarness();
    const { runId, identity } = await runWith(h, ["unit"]);
    recordMerge(h, runId, identity, SHA);
    recordPostMerge(h, runId, identity, SHA, { checks: [{ name: "unit", conclusion: "failure" }] });
    const bundle = exported(h, runId);
    expect(bundle.baseline.quality["postMergeChecks"]).toBe("FAILED");

    const edited = structuredClone(bundle);
    const inputs = edited.baseline.qualitySource["postMergeCheckInputs"] as { responses: Array<{ checks: Check[] }> };
    inputs.responses[0]!.checks = [{ name: "unit", conclusion: "success" }];
    const facts = edited.baseline.quality["facts"] as Array<Record<string, unknown>>;
    facts.find((fact) => fact["name"] === "postMergeVerification")!["present"] = true;
    edited.baseline.quality["postMergeChecks"] = "PASSED";
    const { integrity: _integrity, ...unsigned } = edited;
    const resealed = sealRunEvidenceExport(unsigned);
    // The response no longer matches the digest its receipt recorded, so it is not an observation.
    expect(reproduceRunEvidenceExport(resealed)).toBe(false);
  });
});
