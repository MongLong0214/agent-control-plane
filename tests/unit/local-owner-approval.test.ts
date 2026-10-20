import { afterAll, describe, expect, it } from "vitest";

import { deriveHumanGate } from "../../src/ceo/human-gate.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import type { ToolResult } from "../../src/mcp/shared.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, ownerDecisionReceipt, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const ITEM = "irreversible production action";
const contract = {
  goal: "perform an irreversible production action", why: "local owner request", scope: [], nonGoals: [],
  acceptance: ["done"], priority: "NORMAL" as const, humanGate: [ITEM, ITEM], references: [],
};
const localRun = () => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({ executionMode: ExecutionMode.GUARDED, contract });
  if (!created.allowed) throw new Error(created.message);
  harness.cp.runs.promoteCandidate(created.value.runId, digestOf("candidate A"));
  return { harness, runId: created.value.runId };
};

describe("local owner consent", () => {
  it.each([
    "change a public API and publish a release", "add a delete button", "document destructive data migration",
    "do not delete production data", "change paid plan and permission boundary", "add a delete data dialog",
  ])("GUARDED work needs no approval for %s", (goal) => {
    expect(deriveHumanGate({ executionMode: ExecutionMode.GUARDED, goal, scope: [],
      declaredItems: ["arbitrary owner question", "arbitrary owner question"] })).toEqual({ required: false, items: [] });
  });

  it.each(["delete production data", "Can you delete production data?"])("destructive actions still require consent and repeated declarations name one item: %s", (goal) => {
    expect(deriveHumanGate({ executionMode: ExecutionMode.STANDARD, goal, scope: [],
      declaredItems: ["destructive data migration or delete", "destructive data migration or delete"] }))
      .toEqual({ required: true, items: ["destructive data migration or delete"] });
  });

  it("authenticates consent once and retains it across candidate changes and ingress pruning", () => {
    const { harness, runId } = localRun();
    const receipt = ownerDecisionReceipt(harness, runId, ITEM, true, "proceed");
    expect(harness.cp.ceo.recordOwnerDecision({ runId, item: ITEM, approved: true, note: "proceed", receipt }).allowed).toBe(true);
    const binding = harness.cp.ceo.currentHumanGateDecisionDigest(runId);
    harness.cp.runs.promoteCandidate(runId, digestOf("candidate B"));
    harness.clock.advance(24 * 60 * 60 * 1000 + 1);
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, { cli: { allowedActors: [receipt.actor] } });
    expect(guard.admit({ channel: "cli", actor: receipt.actor, nonce: "prune-old-receipt", payload: null }).allowed).toBe(true);
    expect(harness.cp.ceo.humanGateStatus(runId)).toEqual({ required: true, items: [ITEM], satisfied: true });
    expect(harness.cp.ceo.currentHumanGateDecisionDigest(runId)).toEqual(binding);
    expect(harness.cp.ceo.recordOwnerDecision({ runId, item: ITEM, approved: false, note: "forged", owner: { channel: "cli", actor: "owner" } }).allowed).toBe(false);
  });

  it("Hermes admits owner decisions and suspension only on an authenticated owner turn", async () => {
    const { harness, runId } = localRun();
    await registerFixtureProject(harness, "owner-suspend");
    const lineage = digestOf("owner lineage");
    const server = createHermesServer(createHermesMcpPort(harness.cp), () => allow(ReasonCode.OK, { actor: "bound-hermes" }), {
      provenance: { liveHermesSessionId: "owner-session", lineageRootDigest: lineage },
    });
    type Handler = (args: Record<string, unknown>, extra: object) => Promise<ToolResult>;
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    const meta = (principal: "owner" | "peer") => ({ _meta: { [HERMES_PROVENANCE_META_KEY]: {
      principal, session_id: "owner-session", lineage_root_digest: lineage, cron: false,
      delegation_depth: 0, peer_grant: digestOf("peer grant"),
    } } });
    const args = { idempotencyKey: "owner-decision", runId, item: ITEM, approved: true, note: "proceed" };
    try {
      expect((await tools.owner_decision_submit!.handler(args, meta("peer"))).isError).toBe(true);
      expect((await tools.owner_decision_submit!.handler(args, {})).isError).toBe(true);
      expect((await tools.owner_decision_submit!.handler(args, meta("owner"))).isError).toBeUndefined();
      expect(harness.cp.ceo.humanGateStatus(runId).satisfied).toBe(true);
      expect((await tools.cto_suspend!.handler({ idempotencyKey: "suspend", projectId: "owner-suspend", reason: "pause" }, meta("owner"))).isError).toBeUndefined();
      expect(harness.cp.projects.get("owner-suspend")?.suspended).toBe(true);
    } finally {
      await server.close();
    }
  });
});
