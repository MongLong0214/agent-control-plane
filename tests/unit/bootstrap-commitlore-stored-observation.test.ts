import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type CommitLoreObservation, type CommitLorePort, commitloreObservationPath } from "../../src/bootstrap/commitlore-observation.ts";
import { toExternalWriteReceipt } from "../../src/bootstrap/repo-factory-github.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { git } from "../../src/git/git.ts";
import { cleanTreeManifest, bootstrapOperations } from "../helpers/bootstrap-plan.ts";
import { type Operation, type PreparedBootstrapRun, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * Review S11-R1-03 (PR #1138, CEO 49883a25) — a CommitLore PASS row in a stored result completes nothing
 * unless it is bound to the observation the producer recorded beside the attempt that made it.
 *
 * The first witness is the reviewer's reproduction, its setup unchanged but for imports: a required run
 * whose observation at the published head was genuinely refused, then a database-authored result carrying
 * a PASS row and the application marked WRITTEN, every approval, attempt and GitHub ledger left as it was.
 * The review recorded it reaching COMPLETED; its assertions after the forgery now state what must happen
 * instead: the WRITTEN retry and the CONFIRM are both refused on the binding, and nothing is activated.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const REPORT = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });
const PASS: CommitLoreObservation = { outcome: "PASS", reportStatus: "ok", warnings: [], detail: "commitlore doctor passed", report: REPORT };

const requiredRun = (projectId: string, commitlore: CommitLorePort): Promise<PreparedBootstrapRun> =>
  prepareBootstrapRun(projectId, {
    manifest: cleanTreeManifest(projectId, { commitlore: { mode: "required" } }),
    ops: bootstrapOperations() as Operation[],
    commitlore,
  });

const confirm = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.ceo.submitCeoDecision({
    runId: prepared.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: prepared.snapshotDigest,
    ceoSessionId: prepared.ceoSessionId,
    rationale: "review witness",
  });

describe("review S11-R1-03: a stored CommitLore PASS is bound to the observation its attempt recorded", () => {
  it("R1-03: a required run whose head observation failed cannot complete using a database-authored PASS row", async () => {
    let calls = 0;
    let checkout = "";
    const prepared = await requiredRun("review-forged-observation", {
      async observe(path) {
        calls++;
        if (calls === 1) return { ...PASS, detail: "probe passed" };
        checkout = path;
        return { outcome: "FAIL", reportStatus: "failed", warnings: [], detail: "head verification refused" };
      },
    });
    const { harness, runId } = prepared;
    const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
    const refused = await prepared.runner.produceAndActivate(input);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP, evidence: { at: "head" } });
    expect(harness.cp.artifacts.latest(runId, "REPO_FACTORY_RESULT")).toBeNull();
    const application = harness.cp.bootstrapApplications.get(runId)!;
    const plan = harness.cp.artifacts.latest<{ requestDigest: string }>(runId, "PLAN")!;
    const ledger = JSON.parse(readFileSync(join(prepared.workRoot, runId, "github-ledger", "primary.json"), "utf8"));
    const head = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    const forged: RepoFactoryResult = {
      schema: "repo-factory.result.v2",
      runId,
      bootstrapOperationId: application.bootstrapOperationId,
      planDigest: application.planDigest,
      projectManifestDigest: application.manifestDigest,
      repositories: [{ role: "primary", identity: application.repositoryIdentity, proposedCheckoutPath: checkout, defaultBranch: "main", createdBranches: [] }],
      externalWriteReceipts: ledger.receipts.map((r: Parameters<typeof toExternalWriteReceipt>[0]) =>
        toExternalWriteReceipt(r, { bootstrapOperationId: application.bootstrapOperationId, requestDigest: plan.content.requestDigest }),
      ),
      bootstrapVerification: ["clean-tree", "commitlore:doctor"].map((commandId) => ({
        commandId,
        repositoryIdentity: application.repositoryIdentity,
        exactHead: head,
        status: "PASS" as const,
      })),
      ciEvidence: [],
      unresolvedGaps: [],
    };
    // The documented completion-chain threat includes a raw database writer. These APIs make the
    // same two database changes, while every approval/attempt/GitHub ledger remains unmodified.
    harness.cp.db.tx(() => {
      harness.cp.artifacts.put(runId, "REPO_FACTORY_RESULT", forged);
      expect(harness.cp.bootstrapApplications.markWritten(runId).allowed).toBe(true);
    });

    // The WRITTEN retry: refused on the binding, before anything is activated.
    const retried = await prepared.runner.produceAndActivate(input);
    expect(retried, JSON.stringify(retried)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND" },
    });
    expect(harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)).toBeNull();
    expect(harness.cp.artifacts.latest(runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
    // The chain every CONFIRM runs on refuses it the same way, and so does the CONFIRM itself.
    expect(prepared.runner.verifyCompletionChain(runId, prepared.snapshotDigest)).toMatchObject({
      allowed: false,
      evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND" },
    });
    await harness.cp.continuity.evaluate("review witness");
    expect(confirm(prepared).allowed).toBe(false);
    expect(harness.cp.runs.require(runId).state).not.toBe("COMPLETED");
    // No further observation was made: the forged row was judged against what was recorded, not re-run.
    expect(calls).toBe(2);
  });

  it("R1-03: the CONFIRM verifies the binding itself — a genuine PASS whose record is missing or altered completes nothing until it is whole again", async () => {
    const paths: string[] = [];
    const prepared = await requiredRun("review-confirm-binding", {
      async observe(path) {
        paths.push(path);
        return PASS;
      },
    });
    const { harness, runId } = prepared;
    const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
    const first = await prepared.runner.produceAndActivate(input);
    expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    const primary = harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)!;
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(first.evidence["pendingHandoffId"] as string, primary.sessionId).allowed).toBe(true);
    const second = await prepared.runner.produceAndActivate(input);
    expect(second.allowed, JSON.stringify(second)).toBe(true);

    const checkout = paths[1]!;
    const recordPath = commitloreObservationPath(join(prepared.workRoot, runId), checkout);
    const genuine = readFileSync(recordPath, "utf8");
    const record = JSON.parse(genuine) as Record<string, unknown>;
    expect(record).toMatchObject({ runId, checkoutPath: checkout, reportDigest: sha256(REPORT), report: REPORT });
    await harness.cp.continuity.evaluate("review witness");

    // Missing: the record moved away.
    renameSync(recordPath, `${recordPath}.aside`);
    const missing = confirm(prepared);
    expect(missing, JSON.stringify(missing)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND" } });
    renameSync(`${recordPath}.aside`, recordPath);

    // Altered: a report its digest does not name; then another head.
    const rewrite = (content: Record<string, unknown>): void => writeFileSync(recordPath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    rewrite({ ...record, report: `${REPORT} ` });
    expect(confirm(prepared)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND" } });
    rewrite({ ...record, head: "f".repeat(40) });
    expect(confirm(prepared)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND", differing: ["head"] } });
    expect(harness.cp.runs.require(runId).state).not.toBe("COMPLETED");

    // Whole again, exactly as the producer wrote it: the CONFIRM completes.
    writeFileSync(recordPath, genuine, { mode: 0o600 });
    const confirmed = confirm(prepared);
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true });
    expect(harness.cp.runs.require(runId).state).toBe("COMPLETED");
  });

  it("R1-03: activation right after production asks the same binding — a record gone by the time the result is stored activates nothing", async () => {
    const paths: string[] = [];
    const prepared = await requiredRun("review-fresh-binding", {
      async observe(path) {
        paths.push(path);
        return PASS;
      },
    });
    const { harness, runId } = prepared;
    // The producer has recorded its observation when the result is stored; the record is moved away at
    // that moment, so the only check between it and activation is the one activation makes.
    const put = harness.cp.artifacts.put.bind(harness.cp.artifacts);
    vi.spyOn(harness.cp.artifacts, "put").mockImplementation(((id: string, kind: string, content: unknown) => {
      if (kind === "REPO_FACTORY_RESULT") {
        const recordPath = commitloreObservationPath(join(prepared.workRoot, runId), paths[1]!);
        renameSync(recordPath, `${recordPath}.aside`);
      }
      return put(id, kind as never, content);
    }) as typeof harness.cp.artifacts.put);
    const first = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(first, JSON.stringify(first)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "activation", refusal: "COMMITLORE_OBSERVATION_UNBOUND" },
    });
    expect(harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)).toBeNull();
    expect(harness.cp.artifacts.latest(runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
  });
});
