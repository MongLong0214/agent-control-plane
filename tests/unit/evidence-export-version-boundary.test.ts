import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import {
  evidenceExportRefusal,
  reproduceBaselineEvidenceExport,
  reproduceRunEvidenceExport,
  RunEvidenceExporter,
  verifyBaselineEvidenceExport,
  verifyRunEvidenceExport,
} from "../../src/export/run-evidence.ts";
import { finalizeNoRepositoryRun, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 (b), CEO option 3 — v2 changed the quality projection (`postMergeChecks`), so new run and baseline
 * exports are issued as v2. A v1 bundle is refused as a version mismatch, never reproduced by a v1 engine; a
 * damaged v2 is refused as an integrity failure. Both readings stay `false` on the boolean APIs, and
 * `evidenceExportRefusal` tells them apart. The v1 bundles here are synthetic, built the way a v1 producer sealed.
 */

const contract = {
  goal: "issue a v2 evidence export",
  why: "a v1 bundle must read as a version mismatch",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["v1 is a version mismatch, a damaged v2 an integrity failure"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

type Bundle = Record<string, unknown> & { integrity?: unknown };

/** Seals the way both export versions do: sha256 over canonical JSON with only the checksum omitted. */
const sealAs = (value: Bundle, schema: string): Bundle => {
  const { integrity: _integrity, ...rest } = value;
  const integrity = { algorithm: "sha256", checksumScope: "canonical JSON with integrity.checksum omitted" };
  const unsigned = { ...rest, schema };
  return { ...unsigned, integrity: { ...integrity, checksum: digestOf({ ...unsigned, integrity }) } };
};

/** A v1-format run bundle: v1 schema id and no #1189 (b) fields, sealed consistently. */
const asV1Run = (run: Bundle): Bundle => {
  const copy = structuredClone(run) as Bundle & { baseline: Record<string, Record<string, unknown>> };
  delete copy.baseline["quality"]!["postMergeChecks"];
  delete copy.baseline["qualitySource"]!["postMergeCheckInputs"];
  return sealAs(copy, "agent-control-plane.run-evidence-export.v1");
};

async function fixture() {
  const h = makeHarness();
  const { projectId } = await registerFixtureProject(h);
  const finalized = await finalizeNoRepositoryRun(h, projectId, contract, {
    baselineHarness: { evidenceSource: "PRODUCTION", acpBinaryVersion: "production-build" },
  });
  const exporter = new RunEvidenceExporter(h.cp.db, h.cp.artifacts, h.cp.clock, h.cp.audit);
  const run = exporter.exportRun(finalized.runId);
  const baseline = exporter.exportBaseline({ from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" });
  if (!run.allowed) throw new Error(run.message);
  if (!baseline.allowed) throw new Error(baseline.message);
  expect(baseline.value.runs.map((entry) => entry.run.runId)).toEqual([finalized.runId]);
  return { h, run: run.value as unknown as Bundle, baseline: baseline.value as unknown as Bundle };
}

describe("#1189 (b) evidence export version boundary", () => {
  it("issues v2 run and baseline bundles that reproduce and verify", async () => {
    const { h, run, baseline } = await fixture();
    expect(run["schema"]).toBe("agent-control-plane.run-evidence-export.v2");
    expect(baseline["schema"]).toBe("agent-control-plane.baseline-export.v2");
    expect(reproduceRunEvidenceExport(run)).toBe(true);
    expect(verifyRunEvidenceExport(run, h.cp.db)).toBe(true);
    expect(reproduceBaselineEvidenceExport(baseline)).toBe(true);
    expect(verifyBaselineEvidenceExport(baseline, h.cp.db)).toBe(true);
    expect(evidenceExportRefusal(run)).toBe(null);
    expect(evidenceExportRefusal(run, h.cp.db)).toBe(null);
    expect(evidenceExportRefusal(baseline)).toBe(null);
    expect(evidenceExportRefusal(baseline, h.cp.db)).toBe(null);
  });

  it("refuses a synthetic v1 run or baseline bundle as a version mismatch, on reproduce and on verify", async () => {
    const { h, run, baseline } = await fixture();
    const v1Run = asV1Run(run);
    const v1Baseline = sealAs({ ...structuredClone(baseline), runs: [v1Run] }, "agent-control-plane.baseline-export.v1");
    expect(reproduceRunEvidenceExport(v1Run)).toBe(false);
    expect(verifyRunEvidenceExport(v1Run, h.cp.db)).toBe(false);
    expect(reproduceBaselineEvidenceExport(v1Baseline)).toBe(false);
    expect(verifyBaselineEvidenceExport(v1Baseline, h.cp.db)).toBe(false);
    expect(evidenceExportRefusal(v1Run)).toBe("VERSION_MISMATCH");
    expect(evidenceExportRefusal(v1Run, h.cp.db)).toBe("VERSION_MISMATCH");
    expect(evidenceExportRefusal(v1Baseline)).toBe("VERSION_MISMATCH");
    expect(evidenceExportRefusal(v1Baseline, h.cp.db)).toBe("VERSION_MISMATCH");
  });

  it("refuses a tampered v2 as an integrity failure, a reason distinct from the version mismatch", async () => {
    const { h, run, baseline } = await fixture();
    // An edited claim, resealed: the envelope is consistent, the projection is not.
    const edited = structuredClone(run) as Bundle & { baseline: Record<string, Record<string, unknown>> };
    edited.baseline["quality"]!["requiredFactCoverage"] = 1;
    const resealed = sealAs(edited, "agent-control-plane.run-evidence-export.v2");
    // A damaged envelope: the checksum no longer covers the bytes.
    const damaged = structuredClone(run) as Bundle & { exportedAt: string };
    damaged.exportedAt = "2031-01-01T00:00:00.000Z";
    const gateEdited = structuredClone(baseline) as Bundle & { gateAAssessment: { gaps: string[] } };
    gateEdited.gateAAssessment.gaps = [];
    const baselineResealed = sealAs(gateEdited, "agent-control-plane.baseline-export.v2");
    for (const bundle of [resealed, damaged]) {
      expect(reproduceRunEvidenceExport(bundle)).toBe(false);
      expect(verifyRunEvidenceExport(bundle, h.cp.db)).toBe(false);
      expect(evidenceExportRefusal(bundle)).toBe("INTEGRITY_FAILURE");
      expect(evidenceExportRefusal(bundle, h.cp.db)).toBe("INTEGRITY_FAILURE");
    }
    expect(reproduceBaselineEvidenceExport(baselineResealed)).toBe(false);
    expect(verifyBaselineEvidenceExport(baselineResealed, h.cp.db)).toBe(false);
    expect(evidenceExportRefusal(baselineResealed)).toBe("INTEGRITY_FAILURE");
    expect(evidenceExportRefusal(baselineResealed, h.cp.db)).toBe("INTEGRITY_FAILURE");
  });
});
