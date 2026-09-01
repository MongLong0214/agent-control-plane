import { afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { createOperatorClient, dispatch as dispatchAgentctl } from "../../src/cli/agentctl.ts";
import { parseRepoFactoryResult, REPO_FACTORY_RESULT_SCHEMA_ID } from "../../src/bootstrap/repo-factory-result.ts";
import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import { ArtifactKind, ExecutionMode, TaskClass } from "../../src/domain/types.ts";
import {
  BASELINE_EXPORT_SCHEMA_ID,
  BASELINE_RECORD_SCHEMA_ID,
  BaselineRecordKind,
  RUN_EVIDENCE_EXPORT_SCHEMA_ID,
} from "../../src/export/baseline-contract.ts";
import { validateExperimentIsolation } from "../../src/export/experiment-isolation.ts";
import {
  assessBaselineMinimum,
  reproduceBaselineEvidenceExport,
  reproduceRunEvidenceExport,
  RunEvidenceExporter,
  sealBaselineEvidenceExport,
  sealRunEvidenceExport,
  verifyBaselineEvidenceExport,
  verifyRunEvidenceExport,
  type RunEvidenceExport,
} from "../../src/export/run-evidence.ts";
import { Db } from "../../src/db/database.ts";
import { migrationChainFrom, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import {
  bindWorker,
  makeHarness,
  makeStartedOperator,
  registerFixtureProject,
  TEST_OPERATOR_TOKEN,
} from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const contract = {
  goal: "record a small baseline run",
  why: "prove the baseline evidence contract",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["the export verifies"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const exporterFor = (harness: ReturnType<typeof makeHarness>): RunEvidenceExporter =>
  new RunEvidenceExporter(harness.cp.db, harness.cp.artifacts, harness.cp.clock, harness.cp.audit);

const reseal = (value: RunEvidenceExport): RunEvidenceExport => {
  const { integrity: _integrity, ...unsigned } = value;
  return sealRunEvidenceExport(unsigned);
};

const resealBaseline = <T extends Parameters<typeof sealBaselineEvidenceExport>[0]>(value: T) => {
  const { integrity: _integrity, ...unsigned } = value as T & { integrity?: unknown };
  return sealBaselineEvidenceExport(unsigned as Parameters<typeof sealBaselineEvidenceExport>[0]);
};

const refreshRecordDigest = (
  bundle: RunEvidenceExport,
  record: RunEvidenceExport["baselineRecords"][number],
): void => {
  if (!record.payload) throw new Error(`record ${record.recordId} has no payload`);
  record.payloadDigest = digestOf({
    schema: BASELINE_RECORD_SCHEMA_ID,
    kind: record.kind,
    runId: bundle.run.runId,
    recordedAt: record.recordedAt,
    payload: record.payload,
  });
};

describe("host-anchored redacted run-evidence export", () => {
  it("covers each included artifact with both its source digest and the export checksum", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({
      executionMode: ExecutionMode.STANDARD,
      contract,
      baselineHarness: { evidenceSource: "TEST", acpBinaryVersion: "test-build" },
    });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    expect(verifyRunEvidenceExport(exported.value, harness.cp.db)).toBe(true);

    const tampered = structuredClone(exported.value);
    const taskContract = tampered.artifactManifest.artifacts.find(
      (artifact) => artifact.kind === ArtifactKind.TASK_CONTRACT,
    );
    expect(taskContract?.content).toBeDefined();
    (taskContract!.content as Record<string, unknown>)["goal"] = "edited after export";

    // Re-sealing models an editor who recomputes the outer checksum. The source artifact
    // digest must still reject the changed claim, so deleting that check fails this test.
    expect(verifyRunEvidenceExport(reseal(tampered), harness.cp.db)).toBe(false);

    const baselineTampered = structuredClone(exported.value);
    const harnessPin = baselineTampered.baselineRecords.find(
      (record) => record.kind === "HARNESS_PINNED",
    );
    expect(harnessPin?.payload).toBeDefined();
    (harnessPin!.payload as Record<string, unknown>)["harnessDigest"] = "sha256:edited";
    refreshRecordDigest(baselineTampered, harnessPin!);
    baselineTampered.baseline.harness = {
      availability: "PRESENT",
      payloadDigest: harnessPin!.payloadDigest,
      ...harnessPin!.payload,
      dispatchContexts: baselineTampered.baseline.harness["dispatchContexts"],
    };

    // Baseline records carry runtime/quality claims too. Re-sealing cannot make an
    // edited payload valid because its source record digest is independently checked.
    expect(reproduceRunEvidenceExport(reseal(baselineTampered))).toBe(true);
    expect(verifyRunEvidenceExport(reseal(baselineTampered), harness.cp.db)).toBe(false);

    const derivedHarnessTampered = structuredClone(exported.value);
    ((derivedHarnessTampered.baseline.harness["harness"] as Record<string, unknown>)["evidenceSource"]) = "PRODUCTION";
    expect(verifyRunEvidenceExport(reseal(derivedHarnessTampered), harness.cp.db)).toBe(false);

    const derivedQualityTampered = structuredClone(exported.value);
    derivedQualityTampered.baseline.quality["requiredFactCoverage"] = 1;
    expect(verifyRunEvidenceExport(reseal(derivedQualityTampered), harness.cp.db)).toBe(false);

    const baselineBundle = sealBaselineEvidenceExport({
      schema: "agent-control-plane.baseline-export.v1",
      window: { from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" },
      runs: [exported.value],
      gateAAssessment: assessBaselineMinimum([exported.value]),
      exportedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(reproduceBaselineEvidenceExport(baselineBundle)).toBe(true);
    const gateTampered = structuredClone(baselineBundle);
    gateTampered.gateAAssessment.gaps = [];
    expect(verifyBaselineEvidenceExport(resealBaseline(gateTampered), harness.cp.db)).toBe(false);
  });

  it("rejects a resealed qualification attack when the source invocation lacks identity and duration", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      baselineHarness: { evidenceSource: "PRODUCTION", acpBinaryVersion: "production-build" },
    });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed).toBe(true);
    if (!dispatched.allowed) return;
    const submitted = harness.cp.tasks.submit(created.value.runId, [
      { key: "qualified", title: "qualified", category: "implementation" },
      { key: "unqualified", title: "unqualified", category: "test" },
    ]);
    expect(submitted.allowed).toBe(true);
    if (!submitted.allowed) return;
    const pinned = harness.cp.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM baseline_records WHERE run_id = ? AND record_kind = 'HARNESS_PINNED'`,
      [created.value.runId],
    );
    const pinnedDigest = (JSON.parse(pinned!.payload_json) as { payload: { harnessDigest: string } }).payload.harnessDigest;

    const started: string[] = [];
    for (const [index, task] of submitted.value.entries()) {
      const execution = harness.cp.tasks.startExecution({
        runId: created.value.runId,
        taskId: task.taskId,
        ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
        workerSessionId: bindWorker(harness, task.taskId),
        provider: "scripted",
        model: "scripted-worker",
        ...(index === 0
          ? { observedProvider: "scripted", observedModel: "scripted-worker", harnessDigest: pinnedDigest }
          : {}),
      });
      expect(execution.allowed).toBe(true);
      if (!execution.allowed) return;
      started.push(execution.value.executionId);
      if (index === 0) {
        expect(harness.cp.tasks.finishExecution(execution.value.executionId, {
          status: "SUCCEEDED",
          resultDigest: digestOf({ task: task.taskId }),
        }).allowed).toBe(true);
      }
    }

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const sourceUnqualified = (exported.value.baseline.runtime["invocations"] as Array<Record<string, unknown>>)
      .find((invocation) => invocation["executionId"] === started[1]);
    expect(sourceUnqualified?.["observedModel"]).toBe(null);
    expect(sourceUnqualified?.["durationMs"]).toBe(null);
    const sourceAssessment = assessBaselineMinimum([exported.value]);
    expect(sourceAssessment.observed.modelIdentityCoverage).toBe(1);
    expect(sourceAssessment.observed.durationCoverage).toBe(1);

    const attack = structuredClone(exported.value);
    const invocation = (attack.baseline.runtime["invocations"] as Array<Record<string, unknown>>)
      .find((entry) => entry["executionId"] === started[1])!;
    invocation["observedProvider"] = "scripted";
    invocation["observedModel"] = "scripted-worker";
    invocation["harnessDigest"] = pinnedDigest;
    invocation["endedAt"] = "2026-08-14T00:00:01.000Z";
    invocation["durationMs"] = 1000;
    invocation["qualificationEligible"] = true;
    const startedRecord = attack.baselineRecords.find(
      (record) => record.kind === BaselineRecordKind.INVOCATION_STARTED && record.payload?.["executionId"] === started[1],
    )!;
    startedRecord.payload!["observedProvider"] = "scripted";
    startedRecord.payload!["observedModel"] = "scripted-worker";
    startedRecord.payload!["harnessDigest"] = pinnedDigest;
    startedRecord.payload!["qualificationEligible"] = true;
    refreshRecordDigest(attack, startedRecord);

    const resealed = reseal(attack);
    // Every public formula has been recomputed: only a source-less reproducer can accept it.
    expect(reproduceRunEvidenceExport(resealed)).toBe(true);
    expect(verifyRunEvidenceExport(resealed, harness.cp.db)).toBe(false);
  });

  it("rejects a resealed graph-fact attack against the durable task graph", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed).toBe(true);
    if (!dispatched.allowed) return;
    const submitted = harness.cp.tasks.submit(created.value.runId, [
      { key: "first", title: "first", category: "implementation" },
      { key: "second", title: "second", category: "test", dependsOn: ["first"] },
    ]);
    expect(submitted.allowed).toBe(true);
    if (!submitted.allowed) return;
    const first = submitted.value[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: first.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId: bindWorker(harness, first.taskId),
      provider: "scripted",
      model: "scripted-worker",
    });
    expect(execution.allowed).toBe(true);
    if (!execution.allowed) return;
    expect(harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: digestOf({ task: first.taskId }),
    }).allowed).toBe(true);

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const attack = structuredClone(exported.value);
    const graph = attack.baseline.graph;
    graph["nodes"] = [];
    graph["edges"] = [{ taskId: "forged", dependsOn: "forged-parent" }];
    graph["nodeCount"] = 0;
    graph["edgeCount"] = 1;
    graph["maxObservedParallelWidth"] = 99;
    graph["criticalPathDurationMs"] = 999999;

    const resealed = reseal(attack);
    expect(reproduceRunEvidenceExport(resealed)).toBe(true);
    expect(verifyRunEvidenceExport(resealed, harness.cp.db)).toBe(false);
  });

  it("excludes an entire unsafe artifact field and names the omission without rewriting it", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({ executionMode: ExecutionMode.STANDARD, contract });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;

    const legacyPrivateArtifact = { privateTranscript: "do not publish this text" };
    harness.cp.db.run(
      `INSERT INTO run_artifacts
         (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'PLAN', ?, NULL, ?, 'legacy-import', ?)`,
      [
        "artifact_legacy_private",
        created.value.runId,
        digestOf(legacyPrivateArtifact),
        canonicalJson(legacyPrivateArtifact),
        harness.clock.nowIso(),
      ],
    );
    const rawEnvironmentArtifact = { env: { CI: "true", PATH: "/usr/bin" } };
    harness.cp.db.run(
      `INSERT INTO run_artifacts
         (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'PLAN', ?, NULL, ?, 'legacy-import', ?)`,
      [
        "artifact_legacy_env",
        created.value.runId,
        digestOf(rawEnvironmentArtifact),
        canonicalJson(rawEnvironmentArtifact),
        harness.clock.nowIso(),
      ],
    );
    const rawDiffArtifact = { diff: "--- a/src/app.js\n+++ b/src/app.js\n+private implementation" };
    harness.cp.db.run(
      `INSERT INTO run_artifacts
         (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'PLAN', ?, NULL, ?, 'legacy-import', ?)`,
      [
        "artifact_legacy_diff",
        created.value.runId,
        digestOf(rawDiffArtifact),
        canonicalJson(rawDiffArtifact),
        harness.clock.nowIso(),
      ],
    );

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const privateArtifact = exported.value.artifactManifest.artifacts.find(
      (artifact) => artifact.artifactId === "artifact_legacy_private",
    );
    expect(privateArtifact).toBeDefined();
    expect(Object.hasOwn(privateArtifact!, "content")).toBe(false);
    expect(exported.value.artifactManifest.omittedFields).toContainEqual({
      subject: "artifact",
      subjectId: "artifact_legacy_private",
      field: "content",
      reason: "PRIVATE_BULK_CONTENT",
      sourceDigest: digestOf(legacyPrivateArtifact),
    });
    expect(exported.value.artifactManifest.omittedFields).toContainEqual({
      subject: "artifact",
      subjectId: "artifact_legacy_env",
      field: "content",
      reason: "RAW_ENV_OR_HEADER_COLLECTION",
      sourceDigest: digestOf(rawEnvironmentArtifact),
    });
    expect(exported.value.artifactManifest.omittedFields).toContainEqual({
      subject: "artifact",
      subjectId: "artifact_legacy_diff",
      field: "content",
      reason: "SOURCE_CODE_OR_PATCH_CONTENT",
      sourceDigest: digestOf(rawDiffArtifact),
    });
    expect(JSON.stringify(exported.value)).not.toContain("do not publish this text");
    expect(JSON.stringify(exported.value)).not.toContain("private implementation");

    // Adding the excluded field back is not a redaction strategy. This assertion fails
    // if the verifier ever permits an excluded credential/transcript field to reappear.
    const leaked = structuredClone(exported.value);
    const leakedArtifact = leaked.artifactManifest.artifacts.find(
      (artifact) => artifact.artifactId === "artifact_legacy_private",
    )!;
    leakedArtifact.content = legacyPrivateArtifact;
    expect(verifyRunEvidenceExport(reseal(leaked), harness.cp.db)).toBe(false);
  });

  it("fails closed instead of silently skipping a malformed baseline source record", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({ executionMode: ExecutionMode.STANDARD, contract });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;

    harness.cp.db.run(
      `INSERT INTO audit_events (at, kind, run_id, evidence_json)
       VALUES (?, 'BASELINE_USAGE_RECORDED', ?, ?)`,
      [harness.clock.nowIso(), created.value.runId, JSON.stringify({ detail: "not canonical JSON", payloadDigest: "sha256:broken" })],
    );

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(false);
    if (exported.allowed) return;
    // Deleting the ledger-integrity check makes this exporter incorrectly succeed.
    expect(exported.reasonCode).toBe("EVIDENCE_MISSING");
  });

  it("routes evidence export through the authenticated operator socket", async () => {
    const running = await makeStartedOperator();
    try {
      const created = running.harness.cp.runs.create({ executionMode: ExecutionMode.STANDARD, contract });
      expect(created.allowed).toBe(true);
      if (!created.allowed) return;

      const client = createOperatorClient({
        socketPath: running.socketPath,
        token: TEST_OPERATOR_TOKEN,
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await dispatchAgentctl(client, "run", ["export", created.value.runId], false)).toBe(0);
        expect(
          await dispatchAgentctl(
            client,
            "baseline",
            ["export", "--from", "2020-01-01T00:00:00.000Z", "--to", "2030-01-01T00:00:00.000Z"],
            false,
          ),
        ).toBe(0);
        const bundles = stdout.mock.calls.map(([value]) => JSON.parse(String(value)) as { schema?: string });
        expect(bundles).toEqual([
          expect.objectContaining({ schema: RUN_EVIDENCE_EXPORT_SCHEMA_ID }),
          expect.objectContaining({ schema: BASELINE_EXPORT_SCHEMA_ID }),
        ]);
      } finally {
        stdout.mockRestore();
      }
    } finally {
      await running.close();
    }
  });
});

describe("v1 baseline recording", () => {
  it("records exact available runtime facts, model drift, usage, graph structure, and classification history", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      baselineHarness: {
        evidenceSource: "TEST",
        acpBinaryVersion: "test-build",
        acpBinaryCommit: "test-commit",
        adapterVersion: "scripted-adapter-v1",
        promptRuleBundleDigest: digestOf({ rules: "test" }),
        verificationContractDigest: digestOf({ verifier: "test" }),
        reviewPolicyDigest: digestOf({ review: "test" }),
        toolPolicyDigest: digestOf({ tools: "restricted" }),
      },
    });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed).toBe(true);
    if (!dispatched.allowed) return;

    const submitted = harness.cp.tasks.submit(created.value.runId, [
      {
        key: "fix",
        title: "fix local behavior",
        category: "implementation",
        taskClass: TaskClass.LOCAL_BUG_FIX,
        taskClassConfidence: 0.8,
        spec: { target: "src/app.js" },
      },
      {
        key: "investigate",
        title: "investigate local behavior",
        category: "investigation",
      },
      {
        key: "integrate",
        title: "integrate the local fix",
        category: "integration",
        dependsOn: ["fix", "investigate"],
      },
    ]);
    expect(submitted.allowed).toBe(true);
    if (!submitted.allowed) return;
    const task = submitted.value[0]!;
    const workerSessionId = bindWorker(harness, task.taskId);

    const wrongHarness = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: task.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId,
      provider: "scripted",
      model: "scripted-worker",
      harnessDigest: "sha256:not-the-pinned-harness",
    });
    expect(wrongHarness.allowed).toBe(false);

    const started = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: task.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId,
      provider: "scripted",
      model: "scripted-worker",
      observedProvider: "scripted",
      observedModel: "scripted-worker-returned-different",
      observedModelVersion: "build-42",
      providerSessionId: "provider-session-1",
      adapterVersion: "scripted-adapter-v1",
    });
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;
    const usage = harness.cp.tasks.recordUsage({
      runId: created.value.runId,
      executionId: started.value.executionId,
      source: "CLI_REPORTED",
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      rawObservationDigest: digestOf({ usage: "raw-output-not-retained" }),
      parserVersion: "usage-parser-v1",
      collectorVersion: "collector-v1",
      confidence: 0.75,
      costConversionVersion: "pricing-v1",
      estimatedCost: 0.02,
      currency: "USD",
    });
    expect(usage.allowed).toBe(true);
    const inventedUnavailableUsage = harness.cp.tasks.recordUsage({
      runId: created.value.runId,
      executionId: started.value.executionId,
      source: "UNAVAILABLE",
      inputTokens: 0,
    });
    expect(inventedUnavailableUsage.allowed).toBe(false);
    const unavailableUsage = harness.cp.tasks.recordUsage({
      runId: created.value.runId,
      executionId: started.value.executionId,
      source: "UNAVAILABLE",
    });
    expect(unavailableUsage.allowed).toBe(true);
    const finished = harness.cp.tasks.finishExecution(started.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: digestOf({ result: "done" }),
      finalTaskClass: TaskClass.LOCAL_BUG_FIX,
      finalTaskClassConfidence: 0.9,
    });
    expect(finished.allowed).toBe(true);
    const fallbackTask = submitted.value[1]!;
    const fallbackWorkerSessionId = bindWorker(harness, fallbackTask.taskId);
    const omittedHarness = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: fallbackTask.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId: fallbackWorkerSessionId,
      provider: "scripted",
      model: "scripted-worker",
      observedProvider: "scripted",
      observedModel: "scripted-worker",
    });
    expect(omittedHarness.allowed).toBe(true);
    if (!omittedHarness.allowed) return;
    const fallbackFinished = harness.cp.tasks.finishExecution(omittedHarness.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: digestOf({ result: "investigation" }),
    });
    expect(fallbackFinished.allowed).toBe(true);
    const rollbackObservation = harness.cp.runs.recordQualityObservation(created.value.runId, {
      fact: "rollbackOrCompensation",
      status: "NOT_OBSERVED",
      source: "OPERATOR",
    });
    expect(rollbackObservation.allowed).toBe(true);

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const runtime = exported.value.baseline.runtime;
    const invocations = runtime["invocations"] as Array<Record<string, unknown>>;
    const invocation = invocations.find((item) => item["executionId"] === started.value.executionId)!;
    expect(invocation["observedModel"]).toBe("scripted-worker-returned-different");
    expect(invocation["providerDriftObserved"]).toBe(false);
    expect(invocation["modelDriftObserved"]).toBe(true);
    expect(invocation["qualificationEligible"]).toBe(false);
    expect(invocation["harnessDigest"]).toBe(null);
    const omittedHarnessInvocation = invocations.find(
      (item) => item["executionId"] === omittedHarness.value.executionId,
    )!;
    expect(omittedHarnessInvocation["observedModel"]).toBe("scripted-worker");
    expect(omittedHarnessInvocation["qualificationEligible"]).toBe(false);
    expect(omittedHarnessInvocation["harnessDigest"]).toBe(null);
    const usageRecords = exported.value.baseline.usage["records"] as Array<Record<string, unknown>>;
    expect(usageRecords.find((item) => item["source"] === "CLI_REPORTED")?.["inputTokens"]).toBe(12);
    const unavailable = usageRecords.find((item) => item["source"] === "UNAVAILABLE")!;
    expect(unavailable["inputTokens"]).toBe(null);
    expect(unavailable["outputTokens"]).toBe(null);
    expect(exported.value.baseline.graph["graphDepth"]).toBe(2);
    expect(exported.value.baseline.graph["maxStructuralReadyWidth"]).toBe(2);
    expect(exported.value.baseline.graph["graphRevisionCount"]).toBe(1);
    expect(exported.value.baseline.graph["graphSnapshots"]).toHaveLength(1);
    expect(
      (exported.value.baseline.graph["graphSnapshots"] as Array<Record<string, unknown>>)[0]?.["graphDepth"],
    ).toBe(2);
    expect(Object.hasOwn(exported.value.baseline.graph, "retryCount")).toBe(false);
    expect(Object.hasOwn(exported.value.baseline.graph, "repairCount")).toBe(false);
    const classifications = exported.value.baseline.taskClassifications["classifications"] as Array<Record<string, unknown>>;
    const fixClassification = classifications.find((item) => item["taskId"] === task.taskId)!;
    const fixHistory = fixClassification["history"] as Array<Record<string, unknown>>;
    expect(fixHistory).toHaveLength(2);
    expect(fixHistory[0]?.["stage"]).toBe("PROPOSED");
    expect(fixHistory[0]?.["confidence"]).toBe(0.8);
    expect(fixHistory[1]?.["stage"]).toBe("FINAL");
    expect(fixHistory[1]?.["confidence"]).toBe(0.9);
    expect(fixHistory[1]?.["replacesPayloadDigest"]).toBe(fixHistory[0]?.["payloadDigest"]);
    expect((fixClassification["final"] as Record<string, unknown>)["classification"]).toBe(
      TaskClass.LOCAL_BUG_FIX,
    );
    const investigationClassification = classifications.find(
      (item) => item["taskId"] === fallbackTask.taskId,
    )!;
    expect(
      (investigationClassification["history"] as Array<Record<string, unknown>>)[0]?.["classification"],
    ).toBe(TaskClass.OTHER);
    expect(
      (exported.value.baseline.quality["rollbackOrCompensation"] as Record<string, unknown>)["status"],
    ).toBe("NOT_OBSERVED");
  });

  it("reports an incomplete baseline as ineligible instead of manufacturing Gate A evidence", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({ executionMode: ExecutionMode.STANDARD, contract });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const assessment = assessBaselineMinimum([exported.value]);
    expect(assessment.eligibleForGateA).toBe(false);
    expect(assessment.observed.productionAttestedProjects).toBe(0);
    expect(assessment.observed.unauthorizedMerges).toBe(null);
    const facts = exported.value.baseline.quality["facts"] as Array<Record<string, unknown>>;
    expect(facts.find((fact) => fact["name"] === "finalOutcome")?.["present"]).toBe(false);
    expect(exported.value.baseline.quality["finalOutcome"]).toEqual({
      availability: "UNAVAILABLE",
      state: null,
    });

    const observedZero = structuredClone(exported.value);
    ((observedZero.baseline.harness["harness"] as Record<string, unknown>)["evidenceSource"]) = "PRODUCTION";
    observedZero.baseline.quality["unauthorizedMerges"] = 0;
    expect(assessBaselineMinimum([observedZero]).observed.unauthorizedMerges).toBe(0);
    const observedPositive = structuredClone(observedZero);
    observedPositive.baseline.quality["unauthorizedMerges"] = 1;
    const positiveAssessment = assessBaselineMinimum([observedPositive]);
    expect(positiveAssessment.observed.unauthorizedMerges).toBe(1);
    expect(positiveAssessment.eligibleForGateA).toBe(false);
    expect(positiveAssessment.gaps).toContain("unauthorized merges observed: 1");
    expect(assessment.gaps.length).toBeGreaterThan(0);
  });

  it("excludes unqualified invocations from Gate A coverage when evidence is mixed", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      baselineHarness: { evidenceSource: "PRODUCTION", acpBinaryVersion: "production-build" },
    });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed).toBe(true);
    if (!dispatched.allowed) return;
    const submitted = harness.cp.tasks.submit(created.value.runId, [
      { key: "qualified", title: "qualified", category: "implementation" },
      { key: "unqualified", title: "unqualified", category: "test" },
    ]);
    expect(submitted.allowed).toBe(true);
    if (!submitted.allowed) return;
    const pinned = harness.cp.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM baseline_records
        WHERE run_id = ? AND record_kind = 'HARNESS_PINNED'`,
      [created.value.runId],
    );
    const pinnedDigest = (JSON.parse(pinned!.payload_json) as { payload: { harnessDigest: string } }).payload.harnessDigest;
    for (const [index, task] of submitted.value.entries()) {
      const workerSessionId = bindWorker(harness, task.taskId);
      const started = harness.cp.tasks.startExecution({
        runId: created.value.runId,
        taskId: task.taskId,
        ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
        workerSessionId,
        provider: "scripted",
        model: "scripted-worker",
        ...(index === 0
          ? { observedProvider: "scripted", observedModel: "scripted-worker", harnessDigest: pinnedDigest }
          : {}),
      });
      expect(started.allowed).toBe(true);
      if (!started.allowed) return;
      if (index === 0) {
        expect(
          harness.cp.tasks.finishExecution(started.value.executionId, {
            status: "SUCCEEDED",
            resultDigest: digestOf({ task: task.taskId }),
          }).allowed,
        ).toBe(true);
      }
    }

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    const runtime = exported.value.baseline.runtime;
    expect(runtime["qualificationEligibleInvocationCount"]).toBe(1);
    const unqualified = (runtime["invocations"] as Array<Record<string, unknown>>)
      .find((invocation) => invocation["qualificationEligible"] !== true)!;
    expect(unqualified["observedModel"]).toBe(null);
    expect(unqualified["durationMs"]).toBe(null);
    const assessment = assessBaselineMinimum([exported.value]);
    expect(assessment.observed.modelIdentityCoverage).toBe(1);
    expect(assessment.observed.durationCoverage).toBe(1);
  });

  it("does not treat a rollback preparation receipt as executed compensation", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({ executionMode: ExecutionMode.STANDARD, contract });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;

    harness.cp.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
          resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
          response_json, created_at, reread_at, verified, status)
       VALUES (?, ?, 'rollback_prepare', ?, ?, 'branch', ?, 0, ?, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
      [
        "rollback-preparation-receipt",
        "rollback_prepare:fixture",
        created.value.runId,
        "github:fixture/repo",
        "rollback/fixture",
        digestOf({ before: true }),
        digestOf({ after: true }),
        digestOf({ request: true }),
        JSON.stringify({ prepared: true }),
        harness.clock.nowIso(),
        harness.clock.nowIso(),
      ],
    );

    const exported = exporterFor(harness).exportRun(created.value.runId);
    expect(exported.allowed).toBe(true);
    if (!exported.allowed) return;
    expect(exported.value.baseline.quality["rollbackPreparationReceipts"]).toHaveLength(1);
    const facts = exported.value.baseline.quality["facts"] as Array<Record<string, unknown>>;
    expect(facts.find((fact) => fact["name"] === "rollbackOrCompensation")?.["present"]).toBe(false);
  });
});

describe("baseline boundary contracts", () => {
  it("requires an offline experiment to use a separate database and artifact root", () => {
    const rejected = validateExperimentIsolation({
      experimentId: "acp2-holdout-1",
      experimentDatabasePath: "/tmp/production/state.sqlite",
      experimentArtifactRoot: "/tmp/production/experiments/acp2-holdout-1",
      productionDatabasePath: "/tmp/production/state.sqlite",
      productionArtifactRoot: "/tmp/production/artifacts",
    });
    expect(rejected.allowed).toBe(false);

    const overlappingArtifacts = validateExperimentIsolation({
      experimentId: "acp2-holdout-1",
      experimentDatabasePath: "/tmp/acp2/acp2-holdout-1.sqlite",
      experimentArtifactRoot: "/tmp/production/artifacts/holdout-1",
      productionDatabasePath: "/tmp/production/state.sqlite",
      productionArtifactRoot: "/tmp/production/artifacts",
    });
    expect(overlappingArtifacts.allowed).toBe(false);

    const prepared = validateExperimentIsolation({
      experimentId: "acp2-holdout-1",
      experimentDatabasePath: "/tmp/acp2/acp2-holdout-1.sqlite",
      experimentArtifactRoot: "/tmp/acp2/artifacts/acp2-holdout-1",
      productionDatabasePath: "/tmp/production/state.sqlite",
      productionArtifactRoot: "/tmp/production/artifacts",
    });
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) return;
    expect(prepared.value.runtimeEnforcement).toBe("NOT_AVAILABLE_IN_V1");
  });

  it("keeps the Repo Factory result boundary strict and the baseline migration ordered", () => {
    const result = {
      schema: REPO_FACTORY_RESULT_SCHEMA_ID,
      runId: "run_bootstrap",
      bootstrapOperationId: "bootstrap_1",
      planDigest: digestOf({ plan: 1 }),
      projectManifestDigest: digestOf({ manifest: 1 }),
      repositories: [{ role: "primary", identity: "github:acme/repo", proposedCheckoutPath: null, defaultBranch: "main", createdBranches: [] }],
      externalWriteReceipts: [{
        bootstrapOperationId: "bootstrap_1",
        requestDigest: digestOf({ request: 1 }),
        operationId: "repo-create",
        resourceType: "repository",
        resourceIdentity: "github:acme/repo",
        preexisting: false,
        beforeStateDigest: null,
        afterStateDigest: digestOf({ after: 1 }),
        createdAt: "2026-08-12T00:00:00.000Z",
        rereadAt: "2026-08-12T00:00:01.000Z",
        verified: true,
      }],
      bootstrapVerification: [{ commandId: "test", repositoryIdentity: "github:acme/repo", exactHead: "a".repeat(40), status: "PASS" }],
      ciEvidence: [],
      unresolvedGaps: [],
    };
    expect(parseRepoFactoryResult(result).allowed).toBe(true);
    expect(parseRepoFactoryResult({ ...result, unversionedExtra: true }).allowed).toBe(false);
    expect(parseRepoFactoryResult({ ...result, schema: "repo-factory.result.v3" }).allowed).toBe(false);
    // Not `toBe(20)`. That restated the constant, so it failed on every correct migration and
    // caught nothing a wrong one would do. The chain below is the real statement — it pins the
    // order and the ids — and this pins that the declared version is where the chain ends.
    expect(migrationChainFrom(12).at(-1)?.toVersion).toBe(SCHEMA_VERSION);
    expect(migrationChainFrom(12).map((migration) => migration.id)).toEqual([
      "v13-finalization-state-machine",
      "v14-baseline-evidence-ledger",
      "v15-durable-verification-worktree-ownership",
      "v16-session-workdir-immutability",
      "v17-telegram-owner-prompts",
      "v18-conversational-actor",
      "v19-session-process-identity",
      "v20-conversational-actor-registry",
      "v21-canonical-turns",
      "v22-canonical-turn-ledger",
      "v23-turn-claimed-at",
      "v24-observation-ledger",
      "v25-ledger-guards",
      "v26-ledger-trigger-bodies",
      "v27-an-observation-carries-its-evidence",
      "v28-an-operator-can-settle-a-turn-nobody-observed",
      "v29-a-dispatch-is-a-fact",
      "v30-a-turn-and-a-reply-are-two-lifecycles",
      "v31-a-generation-means-nothing-without-its-role-key",
      "v32-a-source-can-only-cite-its-turns-own-claim-event",
      "v33-back-up-before-telegram-settlement-state",
      "v34-persist-hermes-target-bind-receipt-evidence",
      "v35-keep-the-admitted-payload-with-its-inbound-row",
    ]);
  });

  it("opens a v13 database through production construction and applies the rest of the chain", () => {
    const harness = makeHarness();
    const databasePath = harness.cp.config.databasePath;
    harness.cp.close();
    const raw = new Database(databasePath);
    try {
      raw.exec("DROP TRIGGER baseline_records_immutable; DROP TRIGGER baseline_records_no_delete; DROP TABLE baseline_records;");
      raw.exec("DROP TRIGGER telegram_owner_prompts_immutable; DROP TRIGGER telegram_owner_prompts_no_delete; DROP TABLE telegram_owner_prompts;");
      raw.exec("DROP TRIGGER conversational_actor_registration_generation_monotonic; DROP TRIGGER conversational_actor_registration_retirement_terminal; DROP TABLE conversational_actor_registrations; DROP TABLE conversational_actor_registry_state;");
      raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(14);
      const v13 = migrationChainFrom(12).find((migration) => migration.toVersion === 13)!;
      raw.function("acp_schema_migration_authorized", () => 1);
      raw.prepare(
        `INSERT INTO schema_migrations
           (version, migration_id, checksum, backup_file, backup_checksum, applied_at)
         VALUES (?, ?, ?, NULL, NULL, ?)`,
      ).run(13, v13.id, v13.checksum(), "2026-08-14T00:00:00.000Z");
      raw.exec(`
        CREATE TRIGGER schema_migrations_immutable
        BEFORE UPDATE ON schema_migrations
        BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE'); END;
        CREATE TRIGGER schema_migrations_no_delete
        BEFORE DELETE ON schema_migrations
        BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE'); END;
      `);
      raw.pragma("user_version = 13");
    } finally {
      raw.close();
    }

    const reopened = new Database(databasePath);
    try {
      expect(Number(reopened.pragma("user_version", { simple: true }))).toBe(13);
      expect(
        reopened.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'baseline_records'").get(),
      ).toEqual({ n: 0 });
    } finally {
      reopened.close();
    }

    const migrated = new Db(databasePath);
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      expect(migrated.get<{ migration_id: string; checksum: string }>(
        "SELECT migration_id, checksum FROM schema_migrations WHERE version = 15",
      )).toEqual({
        migration_id: "v15-durable-verification-worktree-ownership",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(migrated.get<{ migration_id: string; checksum: string }>(
        "SELECT migration_id, checksum FROM schema_migrations WHERE version = 19",
      )).toEqual({
        migration_id: "v19-session-process-identity",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(migrated.get<{ migration_id: string; checksum: string }>(
        "SELECT migration_id, checksum FROM schema_migrations WHERE version = 20",
      )).toEqual({
        migration_id: "v20-conversational-actor-registry",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(migrated.get<{ migration_id: string; checksum: string }>(
        "SELECT migration_id, checksum FROM schema_migrations WHERE version = 16",
      )).toEqual({
        migration_id: "v16-session-workdir-immutability",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(
        migrated.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'baseline_records'",
        ),
      ).toEqual({ n: 1 });
      expect(
        migrated.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'verification_worktrees'",
        ),
      ).toEqual({ n: 1 });
      const triggers = migrated.all<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'baseline_records_%' ORDER BY name",
      );
      expect(triggers.map((trigger) => trigger.name)).toEqual([
        "baseline_records_immutable",
        "baseline_records_no_delete",
        // v26. A census found three provenance tables with UPDATE and DELETE guards and nothing on
        // INSERT, which left `INSERT OR REPLACE` free to rewrite a row by its key.
        "baseline_records_no_replace",
      ]);
      expect(
        triggers.every((trigger) => /BASELINE_RECORD_(IMMUTABLE|NO_REPLACE)/.test(trigger.sql)),
      ).toBe(true);
    } finally {
      migrated.close();
    }

    const rawAfter = new Database(databasePath);
    try {
      const runId = "migration-drill-run";
      rawAfter.prepare(
        `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
         VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'migration drill', 'sha256:contract', ?)`,
      ).run(runId, "2026-08-13T00:00:00.000Z");
      rawAfter.prepare(
        `INSERT INTO baseline_records
           (run_id, record_kind, schema_id, recorded_at, payload_json, payload_digest)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        "GRAPH_SNAPSHOT",
        "agent-control-plane.baseline-record.v1",
        "2026-08-13T00:00:00.000Z",
        "{}",
        `sha256:${"0".repeat(64)}`,
      );
      expect(() => rawAfter.prepare("UPDATE baseline_records SET payload_json = '{}' WHERE record_id = 1").run()).toThrow(
        "BASELINE_RECORD_IMMUTABLE",
      );
      expect(() => rawAfter.prepare("DELETE FROM baseline_records WHERE record_id = 1").run()).toThrow(
        "BASELINE_RECORD_IMMUTABLE",
      );
    } finally {
      rawAfter.close();
    }
  });

  it("restores the original v13 file when v14 fails after its commit", () => {
    const harness = makeHarness();
    const databasePath = harness.cp.config.databasePath;
    harness.cp.close();
    const raw = new Database(databasePath);
    try {
      raw.exec("DROP TRIGGER baseline_records_immutable; DROP TRIGGER baseline_records_no_delete; DROP TABLE baseline_records;");
      raw.exec("DROP TRIGGER telegram_owner_prompts_immutable; DROP TRIGGER telegram_owner_prompts_no_delete; DROP TABLE telegram_owner_prompts;");
      raw.exec("DROP TRIGGER conversational_actor_registration_generation_monotonic; DROP TRIGGER conversational_actor_registration_retirement_terminal; DROP TABLE conversational_actor_registrations; DROP TABLE conversational_actor_registry_state;");
      raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
      raw.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(14);
      const v13 = migrationChainFrom(12).find((migration) => migration.toVersion === 13)!;
      raw.function("acp_schema_migration_authorized", () => 1);
      raw.prepare(
        `INSERT INTO schema_migrations
           (version, migration_id, checksum, backup_file, backup_checksum, applied_at)
         VALUES (?, ?, ?, NULL, NULL, ?)`,
      ).run(13, v13.id, v13.checksum(), "2026-08-14T00:00:00.000Z");
      raw.exec(`
        CREATE TRIGGER schema_migrations_immutable
        BEFORE UPDATE ON schema_migrations
        BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE'); END;
        CREATE TRIGGER schema_migrations_no_delete
        BEFORE DELETE ON schema_migrations
        BEGIN SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE'); END;
      `);
      raw.pragma("user_version = 13");
    } finally {
      raw.close();
    }

    expect(() => new Db(databasePath, {
      afterMigration: (migration) => {
        if (migration.id === "v14-baseline-evidence-ledger") throw new Error("injected v14 post-commit failure");
      },
    })).toThrowError(/original database was restored/);

    const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(Number(restored.pragma("user_version", { simple: true }))).toBe(13);
      expect(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'baseline_records'").get())
        .toEqual({ n: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14").get())
        .toEqual({ n: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 15").get())
        .toEqual({ n: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 13").get())
        .toEqual({ n: 1 });
    } finally {
      restored.close();
    }

    const migrated = new Db(databasePath);
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 14"))
        .toEqual({ migration_id: "v14-baseline-evidence-ledger" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 15"))
        .toEqual({ migration_id: "v15-durable-verification-worktree-ownership" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 16"))
        .toEqual({ migration_id: "v16-session-workdir-immutability" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 17"))
        .toEqual({ migration_id: "v17-telegram-owner-prompts" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 18"))
        .toEqual({ migration_id: "v18-conversational-actor" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 19"))
        .toEqual({ migration_id: "v19-session-process-identity" });
      expect(migrated.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 20"))
        .toEqual({ migration_id: "v20-conversational-actor-registry" });
      expect(
        migrated.get<{ backup_file: string | null; backup_checksum: string | null }>(
          "SELECT backup_file, backup_checksum FROM schema_migrations WHERE version = 14",
        ),
      ).toEqual({
        backup_file: expect.stringContaining("pre-migration-v13"),
        backup_checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    } finally {
      migrated.close();
    }
  });
});
