import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ResidentProjectProvisioning } from "../../src/bootstrap/resident-project-provisioning.ts";
import { RunKind } from "../../src/domain/types.ts";
import { git } from "../../src/git/git.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner, ProjectAllocation } from "../../src/runtime/host-project-provisioner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { commit, residentGitHost } from "../helpers/resident-git-host.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R1-03 — the host's checkout readback must be Git's own HEAD and branch, not the allocated
 * SHA echoed back after a commit-exists check. Activation requires the clone attached to dev, clean,
 * exactly at the approved genesis head, and never resets it; fleet recovery (`ensure-resident`, long
 * after bootstrap) accepts later development built on that head, in any working state (review
 * V52-R2-01), and never history that does not contain it. Real Git; only GitHub's identity lookup,
 * Claude, tmux, ps and lsof are doubles.
 */
const host = residentGitHost;

describe("V52-R1-03 the host reports Git's own HEAD, and activation requires the approved checkout", () => {
  it("a detached dirty checkout at the autoInit commit fails the readback in every operation, and keeps its edits and HEAD", async () => {
    const h = await host();
    await git(h.clone, ["checkout", "-q", "--detach", h.autoInit]);
    writeFileSync(join(h.clone, "dirty.txt"), "keep edits");
    await expect(h.invoke("ensure-checkout")).rejects.toThrow("detached");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    await expect(h.invoke("observe")).rejects.toThrow("detached");
    expect(readFileSync(join(h.clone, "dirty.txt"), "utf8")).toBe("keep edits");
    expect(await h.head()).toBe(h.autoInit);
  });

  it("a clean dev at the earlier autoInit commit fails the readback and is not moved", async () => {
    const h = await host();
    await git(h.clone, ["reset", "-q", "--hard", h.autoInit]);
    await expect(h.invoke("ensure-checkout")).rejects.toThrow("not on dev at the approved genesis head");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    expect(await h.head()).toBe(h.autoInit);
  });

  it("a clean dev at the approved head passes, and the readback is Git's HEAD", async () => {
    const h = await host();
    const observed = await h.invoke("ensure-checkout");
    expect(observed.checkout?.head).toBe(h.genesis);
    expect(observed.checkout?.head).toBe(await h.head());
    const launched = await h.invoke("ensure-resident");
    expect(launched.checkout?.head).toBe(h.genesis);
    expect((await h.invoke("observe")).checkout?.head).toBe(h.genesis);
  });

  it("fleet recovery accepts later development on dev, a feature branch, unfinished edits or a detached HEAD, never an unrelated history", async () => {
    const h = await host();
    await h.invoke("ensure-checkout");
    const later = await commit(h.clone, "feature.js", "later work on dev");
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(later);
    // The bootstrap requirement stays activation's: a later head is not the approved genesis.
    await expect(h.invoke("observe")).rejects.toThrow("not on dev at the approved genesis head");
    await git(h.clone, ["checkout", "-q", "-b", "feature/next"]);
    const feature = await commit(h.clone, "next.js", "feature work");
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(feature);
    writeFileSync(join(h.clone, "next.js"), "uncommitted");
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(feature);
    expect(readFileSync(join(h.clone, "next.js"), "utf8")).toBe("uncommitted");
    await git(h.clone, ["checkout", "-q", "--", "next.js"]);
    await git(h.clone, ["checkout", "-q", "--detach", later]);
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(later);
    await git(h.clone, ["checkout", "-q", "--orphan", "unrelated"]);
    await commit(h.clone, "other.js", "unrelated history");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    expect(existsSync(join(h.clone, "other.js"))).toBe(true);
  });
});

const contract = { goal: "bootstrap", why: "owner request", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };
describe("V52-R1-03 activation compares the reported HEAD with the approved genesis head", () => {
  it.each(["ensure-checkout", "ensure-resident", "observe"] as const)("refuses activation when %s reports another head", async (step) => {
    const h = makeHarness();
    const host: HostProjectProvisioner = {
      async invoke(op: HostOperation, a: ProjectAllocation): Promise<HostObservation> {
        const checkout = { path: a.clonePath, origin: "https://github.com/acme/fixture.git", head: op === step ? "e".repeat(40) : a.head, repositoryNodeId: a.repositoryNodeId };
        if (op === "ensure-checkout") return { checkout };
        if (op === "ensure-buzz") return { buzz: { pubkey: "a".repeat(64), roomId: a.roomId, rosterVerified: true, nonceEventId: "b".repeat(64), nonceReadable: true } };
        if (op === "ensure-routing") return { routing: { generation: 1, roomId: a.roomId } };
        return { checkout, resident: { pid: 12345, startedAt: "start", cwd: a.clonePath, sessionUuid: a.sessionUuid, tmuxName: a.tmuxName, tmuxAncestry: true, bridgeSessionId: "rc" } };
      },
    };
    const run = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
    if (!run.allowed) throw new Error(run.message);
    h.cp.projects.register({ projectId: "resident", name: "resident" });
    const service = new ResidentProjectProvisioning(h.cp.db, h.clock, host, join(h.root, "home"), h.root);
    service.attachSubscriber(async () => false);
    service.remember({ runId: run.value.runId, candidateSnapshotDigest: "candidate", ceoSessionId: "ceo" }, "resident", {});
    await expect(service.ensure({ runId: run.value.runId, projectId: "resident", repositoryIdentity: "github:acme/fixture", repositoryNodeId: "R_node", head: "f".repeat(40), packet: {} })).rejects.toThrow();
    expect(service.evidence(run.value.runId)).toBeNull();
    h.cp.close();
  });
});
