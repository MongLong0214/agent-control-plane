import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResidentProjectProvisioning } from "../../src/bootstrap/resident-project-provisioning.ts";
import { RunKind } from "../../src/domain/types.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner, ProjectAllocation } from "../../src/runtime/host-project-provisioner.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * Review V52-R2-01, the observe-after-activation sibling — activation runs its readbacks again after the
 * resident CTO acknowledged its handoff (the watchdog's next resume). By then the CTO may have commits
 * or unfinished edits. Once a resident of this allocation has been observed on the approved checkout,
 * later passes ask the host for the development rule and accept the CTO's later head; before that,
 * any other head is refused.
 */
const contract = { goal: "bootstrap", why: "owner request", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };

class Host implements HostProjectProvisioner {
  head: ((a: ProjectAllocation) => string) = (a) => a.head;
  calls: Array<{ op: HostOperation; requirement: unknown }> = [];
  async invoke(op: HostOperation, a: ProjectAllocation): Promise<HostObservation> {
    this.calls.push({ op, requirement: (a as ProjectAllocation & { checkoutRequirement?: unknown }).checkoutRequirement });
    const checkout = { path: a.clonePath, origin: "https://github.com/acme/fixture.git", head: this.head(a), repositoryNodeId: a.repositoryNodeId };
    if (op === "ensure-checkout") return { checkout };
    if (op === "ensure-buzz") return { buzz: { pubkey: "a".repeat(64), roomId: a.roomId, rosterVerified: true, nonceEventId: "b".repeat(64), nonceReadable: true } };
    if (op === "ensure-routing") return { routing: { generation: 1, roomId: a.roomId } };
    return { checkout, resident: { pid: 12345, startedAt: "start", cwd: a.clonePath, sessionUuid: a.sessionUuid, tmuxName: a.tmuxName, tmuxAncestry: true, bridgeSessionId: "rc" } };
  }
}

function setup() {
  const h = makeHarness();
  const host = new Host();
  const run = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
  if (!run.allowed) throw new Error(run.message);
  h.cp.projects.register({ projectId: "resident", name: "resident" });
  const service = new ResidentProjectProvisioning(h.cp.db, h.clock, host, join(h.root, "home"), h.root);
  service.attachSubscriber(async () => false);
  service.remember({ runId: run.value.runId, candidateSnapshotDigest: "candidate", ceoSessionId: "ceo" }, "resident", {});
  const input = { runId: run.value.runId, projectId: "resident", repositoryIdentity: "github:acme/fixture", repositoryNodeId: "R_node", head: "f".repeat(40), packet: {} };
  return { h, host, service, input };
}

describe("V52-R2-01 activation re-entry after the CTO took over its clone", () => {
  it("accepts the CTO's later head once the resident was observed on the approved checkout", async () => {
    const { h, host, service, input } = setup();
    await service.ensure(input);
    expect(host.calls.filter((c) => c.requirement !== undefined)).toEqual([]);
    host.head = () => "e".repeat(40);
    host.calls = [];
    const again = await service.ensure(input);
    expect(again.observations.checkout?.head).toBe("e".repeat(40));
    expect(host.calls.filter((c) => c.op === "ensure-checkout" || c.op === "observe").map((c) => c.requirement)).toEqual(["development", "development"]);
    // The fleet entry `ensure-resident` writes keeps the frozen allocation, with no activation-time flag.
    expect(host.calls.find((c) => c.op === "ensure-resident")?.requirement).toBeUndefined();
    h.cp.close();
  });

  it("refuses any other head before the resident has been observed on the approved checkout", async () => {
    const { h, host, service, input } = setup();
    host.head = () => "e".repeat(40);
    await expect(service.ensure(input)).rejects.toThrow();
    expect(host.calls.map((c) => c.requirement)).toEqual([undefined]);
    expect(service.evidence(input.runId)).toBeNull();
    h.cp.close();
  });
});
