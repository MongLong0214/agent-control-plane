import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { RunKind } from "../../src/domain/types.ts";
import type { HostProjectProvisioner } from "../../src/runtime/host-project-provisioner.ts";
import { reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { type GenesisFault, GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R1-01 — a confirmed genesis bootstrap resumes every step through the composed runner (not
 * the producer alone) after a lost response, on the same CEO confirmation: the runner reconciles each
 * pending request at its own target — `genesis`, `main` or `dev`, the genesis PR by its marker, the
 * merge by the PR showing merged — and lets the read-only verification repeat. Nothing is sent twice.
 * A write GitHub does not show stays refused. Local verification runs in the real sandbox.
 */
const contract = { goal: "bootstrap", why: "owner request", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };

async function attempt(fault: GenesisFault) {
  const root = realpathSync(tempDir("v52-runner-recovery-"));
  const home = join(root, "home");
  mkdirSync(home);
  const port = new GenesisGitHub(root);
  port.fault = fault;
  // Activation is outside this review: the host never becomes ready, so a resumed run stops at WRITTEN.
  const host: HostProjectProvisioner = { async invoke() { throw new Error("host readiness remains pending"); } };
  const h = makeHarness({ repoFactory: { workRoot: join(root, "factory"), githubPort: port }, residentProvisioner: { home, port: host } });
  h.cp.residentProjects.attachSubscriber(async () => true);
  // The earlier attempt's writer is a process proven gone, as after a crash.
  const exited = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const writer = { pid: exited.pid!, startToken: readProcessStartToken(exited.pid!)!, startedAt: new Date().toISOString(), processGroup: exited.pid! };
  const gone = new Promise((resolve) => exited.once("exit", resolve));
  exited.kill("SIGKILL");
  await gone;
  h.cp.bootstrapProducer.attachWriterLock(() => true, () => writer);
  const run = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
  if (!run.allowed) throw new Error(run.message);
  await dispatchBootstrapRun(h.cp, h.clock, run.value.runId);
  const f = genesisPlanFixture();
  const reviewed = await reviewBootstrapPlan(h, run.value.runId, { ...f.artifact.content, requestDigest: h.cp.runs.get(run.value.runId)!.contractDigest });
  const confirmation = { runId: run.value.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId: reviewed.ceoSessionId, rationale: "reviewed" };
  const first = await h.cp.bootstrapProducer.produceAndActivateApproved(confirmation);
  expect(first.allowed).toBe(false);
  expect(port.fault, "the injected failure fired").toBeNull();
  const again = await h.cp.bootstrapProducer.produceAndActivateApproved(confirmation);
  const application = h.cp.bootstrapApplications.get(run.value.runId);
  const close = () => h.cp.close();
  return { port, again, application, close, target: { owner: "acme", name: "fixture" } };
}

describe("V52-R1-01 every confirmed genesis step resumes on the same confirmation", () => {
  it.each([
    "protect-main", "push-genesis", "open-pr", "verify-ci", "merge-pr",
    "create-repository-readback", "create-dev", "protect-dev", "set-default-branch", "resources",
  ] as const)("a lost response after %s resumes to WRITTEN without a second write", async (fault) => {
    const r = await attempt(fault);
    expect(r.application?.phase, JSON.stringify(r.again)).toBe("WRITTEN");
    expect(r.port.creates).toBe(1);
    expect(r.port.opens).toBe(1);
    expect(r.port.merges).toBe(1);
    expect(r.port.writes.filter((w) => w.method === "pushBranch").map((w) => w.target)).toEqual(["acme/fixture#genesis"]);
    expect(r.port.writes.filter((w) => w.method === "protectBranch").map((w) => w.target)).toEqual(["acme/fixture#main", "acme/fixture#dev"]);
    expect(r.port.events.filter((e) => e === "create-dev")).toHaveLength(1);
    expect(r.port.events.filter((e) => e === "set-default-branch")).toHaveLength(1);
    const repo = r.port.repository("acme", "fixture")!;
    expect(repo.defaultBranch).toBe("dev");
    expect((await r.port.observeBranch(r.target, "dev"))?.headSha).toBe(r.port.pull?.mergeCommitSha);
    r.close();
  });

  it("verification repeats at the PR head, and the visibly merged PR is reconciled, not merged again", async () => {
    const verify = await attempt("verify-ci");
    expect(verify.port.ciHeads.filter((head) => head === verify.port.pull!.headSha)).toHaveLength(2);
    verify.close();
    const merged = await attempt("merge-pr");
    expect(merged.port.merges).toBe(1);
    expect(merged.port.events.filter((e) => e === "merge")).toHaveLength(1);
    merged.close();
  });

  it.each(["open-pr-unsent", "merge-pr-unsent"] as const)("a %s request GitHub does not show stays in doubt and is not sent again", async (fault) => {
    const r = await attempt(fault);
    expect(r.again.allowed).toBe(false);
    if (!r.again.allowed) {
      expect(r.again.evidence["refusal"]).toBe("UNCONFIRMED_PENDING_REQUEST");
      expect(r.again.evidence["operationId"]).toBe(fault === "open-pr-unsent" ? "acp-genesis-open" : "acp-genesis-merge");
    }
    expect(r.application?.phase).toBe("RESERVED");
    expect(r.port.merges).toBe(0);
    expect(r.port.opens).toBe(fault === "open-pr-unsent" ? 0 : 1);
    r.close();
  });

  it("a create whose answer was lost is never adopted by name: the application strands and nothing is re-created", async () => {
    const r = await attempt("create-repository");
    expect(r.again.allowed).toBe(false);
    if (!r.again.allowed) expect(r.again.evidence["refusal"]).toBe("BOOTSTRAP_APPLICATION_STRANDED");
    expect(r.application?.phase).toBe("STRANDED");
    expect(r.port.creates).toBe(1);
    expect(r.port.writes.filter((w) => w.method !== "createRepository")).toEqual([]);
    r.close();
  });
});
