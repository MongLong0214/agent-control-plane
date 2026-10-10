import { describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, projectManifestSchema, type ProjectManifest } from "../../src/contracts/manifest.ts";
import {
  ContractChangeRefusal,
  contractChangeCoverageTarget,
  contractChangePlanForSubmission,
  contractChangeWorkflowEvidence,
  currentContractChangePlan,
  sameContractChangeBinding,
  verificationBarLowerings,
} from "../../src/registry/contract-change-plan.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/** Issue #246 B2-a — the CONTRACT_CHANGE PLAN rules, measured without a control plane. */

const PROJECT = "cc-unit";
const base: ProjectManifest = projectManifestSchema.parse(fixtureManifest(PROJECT));
const baseDigest = manifestDigest(base);
const workflow = { path: ".github/workflows/ci.yml", checkName: "ci", approvedDigest: sha256("ci"), unapprovedFirstActivation: false, repositoryRole: "primary" };
const proposed: ProjectManifest = projectManifestSchema.parse({ ...base, postMergeCommands: ["verify"], ciWorkflows: [workflow] });
const run = { kind: "CONTRACT_CHANGE", projectId: PROJECT, pinnedManifestDigest: baseDigest };
const lookup = (digest: string) => (digest === baseDigest ? base : null);
const plan = (manifest: ProjectManifest = proposed) => ({ summary: "s", projectManifestDigest: manifestDigest(manifest), projectManifest: manifest });

describe("contractChangePlanForSubmission", () => {
  it("stores the PLAN with the normalized manifest and nothing else changed", () => {
    const admitted = contractChangePlanForSubmission(run, plan(), lookup);
    expect(admitted.allowed).toBe(true);
    expect(admitted.allowed && admitted.value).toEqual({ summary: "s", projectManifestDigest: manifestDigest(proposed), projectManifest: proposed });
  });

  it("refuses when the run names no project", () => {
    const refused = contractChangePlanForSubmission({ ...run, projectId: null }, plan(), lookup);
    expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(refused.evidence["refusal"]).toBe(ContractChangeRefusal.PROJECT_MISSING);
  });

  it("refuses when the base cannot be read back by its digest: no pin, nothing stored, or content that does not hash to it", () => {
    for (const [pinned, read] of [
      [null, lookup],
      [baseDigest, () => null],
      [baseDigest, () => ({ ...base, postMergeCommands: ["tampered"] })],
    ] as const) {
      const refused = contractChangePlanForSubmission({ ...run, pinnedManifestDigest: pinned }, plan(), read);
      expect(refused.reasonCode).toBe(ReasonCode.CONTRACT_UNVERIFIED);
      expect(refused.evidence["refusal"]).toBe(ContractChangeRefusal.BASE_UNAVAILABLE);
    }
  });
});

describe("currentContractChangePlan", () => {
  it("binds the stored PLAN by digest and re-validates it; a PLAN stored without a manifest has no candidate", () => {
    const current = currentContractChangePlan(run, { digest: "sha256:plan", content: plan() }, lookup);
    expect(current.allowed).toBe(true);
    expect(current.allowed && current.value.binding).toEqual({ planDigest: "sha256:plan", manifestDigest: manifestDigest(proposed), baseManifestDigest: baseDigest });
    const dropped = currentContractChangePlan(run, { digest: "sha256:old", content: { summary: "s", projectManifestDigest: manifestDigest(proposed) } }, lookup);
    expect(dropped.evidence).toMatchObject({ refusal: ContractChangeRefusal.MANIFEST_MISSING, planDigest: "sha256:old" });
    expect(currentContractChangePlan(run, null, lookup).evidence["refusal"]).toBe(ContractChangeRefusal.MANIFEST_MISSING);
  });

  it("records the CI workflows a later activation must verify, marking an entry the base already declares", () => {
    const withBaseWorkflow = projectManifestSchema.parse({ ...base, ciWorkflows: [workflow] });
    const further = projectManifestSchema.parse({ ...withBaseWorkflow, ciWorkflows: [workflow, { ...workflow, checkName: "e2e", path: ".github/workflows/e2e.yml" }] });
    expect(contractChangeWorkflowEvidence(withBaseWorkflow, further).map((entry) => [entry.checkName, entry.unchangedFromBase, entry.repositoryRemote])).toEqual([
      ["ci", true, "github:acme/fixture"],
      ["e2e", false, "github:acme/fixture"],
    ]);
  });
});

describe("verificationBarLowerings", () => {
  it("finds nothing in a stricter manifest and nothing in the base itself", () => {
    expect(verificationBarLowerings(base, proposed)).toEqual([]);
    expect(verificationBarLowerings(base, base)).toEqual([]);
  });

  it("treats TRUSTED_CI for a LOCAL_COMMAND as a lowering: it drops the local evidence", () => {
    const ciOnly = projectManifestSchema.parse({
      ...base,
      verificationCommands: base.verificationCommands.map((command) => ({ ...command, evidenceMode: "TRUSTED_CI" })),
    });
    expect(verificationBarLowerings(base, ciOnly).map((entry) => entry.kind)).toEqual(["EVIDENCE_MODE_DOWNGRADED"]);
  });

  it("treats a moved workflow path as dropping the approved one", () => {
    const withWorkflow = projectManifestSchema.parse({ ...base, ciWorkflows: [workflow] });
    const moved = projectManifestSchema.parse({ ...base, ciWorkflows: [{ ...workflow, path: ".github/workflows/other.yml" }] });
    expect(verificationBarLowerings(withWorkflow, moved).map((entry) => entry.kind)).toEqual(["CI_WORKFLOW_DROPPED"]);
  });
});

describe("binding helpers", () => {
  it("compares every digest of a binding, and keys the manifest coverage item by project", () => {
    const binding = { planDigest: "p", manifestDigest: "m", baseManifestDigest: "b" };
    expect(sameContractChangeBinding(binding, { ...binding })).toBe(true);
    for (const field of ["planDigest", "manifestDigest", "baseManifestDigest"] as const) {
      expect(sameContractChangeBinding(binding, { ...binding, [field]: "x" })).toBe(false);
    }
    expect(sameContractChangeBinding(null, binding)).toBe(false);
    expect(contractChangeCoverageTarget(PROJECT, { manifestDigest: "sha256:abc" })).toEqual({ identity: PROJECT, path: "#manifest/sha256:abc" });
  });
});
