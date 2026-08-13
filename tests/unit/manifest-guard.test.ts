import { afterEach, describe, expect, it } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ProjectRegistry, type ManagedManifestWrite } from "../../src/registry/project-registry.ts";
import type { ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import { fixtureManifest, makeHarness } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

describe("manifest mutations are guard-bound", () => {
  it("requires managed authorization bound to the exact project and manifest digest", () => {
    const harness = makeHarness();
    const manifest = fixtureManifest("manifest-guard");

    expect(
      harness.cp.projects.storeManifest(
        manifest,
        undefined as unknown as ManagedManifestWrite,
      ),
    ).toMatchObject({ allowed: false, reasonCode: ReasonCode.WRITE_REQUIRES_MANAGED_RUN });

    const authorization = harness.cp.manifestAuthorizationForTests(manifest);
    expect(harness.cp.projects.storeManifest(manifest, authorization)).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.OK,
    });
    const storeGrant = harness.cp.audit.byKind("MANAGED_WRITE_GUARD_CONSUMED").at(-1);
    expect(storeGrant?.evidence).toMatchObject({
      operation: "MANIFEST_CHANGE",
      projectId: manifest.projectId,
      resolvedPath: null,
      targetBranch: null,
      targetWorktreeId: null,
    });

    const registeredManifest = fixtureManifest("manifest-register");
    const registered = harness.cp.projects.register({
      projectId: registeredManifest.projectId,
      name: "registered",
      manifest: registeredManifest,
      authorization: harness.cp.manifestAuthorizationForTests(registeredManifest),
    });
    expect(registered.allowed).toBe(true);
    const registerGrant = harness.cp.audit.byKind("MANAGED_WRITE_GUARD_CONSUMED").at(-1);
    expect(registerGrant?.evidence).toMatchObject({
      operation: "MANIFEST_CHANGE",
      projectId: registeredManifest.projectId,
    });

    const revised = { ...manifest, postMergeCommands: ["verify"] };
    expect(harness.cp.projects.storeManifest(revised, authorization)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CONTRACT_DIGEST_MISMATCH,
    });
    expect(
      harness.cp.projects.storeManifest(manifest, {
        ...authorization,
        projectId: "another-project",
      }),
    ).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONTRACT_DIGEST_MISMATCH });
  });

  it("a rejecting guard prevents storeManifest from changing the database", () => {
    const harness = makeHarness();
    const manifest = fixtureManifest("manifest-store-denied");
    const rejectingGuard = {
      evaluate: () => deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "test guard refusal"),
      consume: () => deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "test guard refusal"),
    } as unknown as ManagedWriteGuard;
    const registry = new ProjectRegistry(harness.cp.db, harness.clock, harness.cp.audit, rejectingGuard);
    const before = harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM manifests")!.n;
    const refused = registry.storeManifest(
      manifest,
      harness.cp.manifestAuthorizationForTests(manifest),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
    expect(harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM manifests")!.n).toBe(before);
  });

  it("a rejecting activation guard leaves both the active project and manifest store unchanged", () => {
    const harness = makeHarness();
    const original = fixtureManifest("manifest-activation-denied");
    const registered = harness.cp.projects.register({
      projectId: original.projectId,
      name: "activation denied",
      manifest: original,
      authorization: harness.cp.manifestAuthorizationForTests(original),
    });
    expect(registered.allowed).toBe(true);
    const revised = { ...original, postMergeCommands: ["verify-revised"] };
    const rejectingGuard = {
      evaluate: () => deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "activation guard refusal"),
      consume: () => deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "activation guard refusal"),
    } as unknown as ManagedWriteGuard;
    const registry = new ProjectRegistry(harness.cp.db, harness.clock, harness.cp.audit, rejectingGuard);
    const beforeActive = harness.cp.projects.require(original.projectId).activeManifestDigest;
    const beforeManifests = harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM manifests")!.n;
    const refused = registry.activateManifest(
      original.projectId,
      revised,
      { runKind: "CONTRACT_CHANGE", runId: null },
      harness.cp.manifestAuthorizationForTests(revised),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
    expect(harness.cp.projects.require(original.projectId).activeManifestDigest).toBe(beforeActive);
    expect(harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM manifests")!.n).toBe(beforeManifests);
  });
});
