import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { TestProductionAdapter } from "./production-adapter.ts";

const [root, projectId, blockerRunId] = process.argv.slice(2);
if (!root || !projectId) throw new Error("usage: run-suspend-crash.ts ROOT PROJECT_ID");

const clock = new ManualClock("2026-08-12T00:00:00.000Z");
const scripted = new TestProductionAdapter(clock);
const cp = new ControlPlane({
  databasePath: join(root, "state.sqlite"),
  worktreeRoot: join(root, "worktrees"),
  capacityDir: join(root, "capacity"),
  secretsDir: join(root, "secrets"),
  clock,
  adapters: [scripted],
  allowNonProductionAdapters: true,
  ownerIdentities: [{ channel: "cli", actor: "test-owner" }],
  ctoPreference: { provider: "scripted", model: "scripted-cto", effort: null },
});

scripted.stopSession = async () => {
  if (blockerRunId) {
    const binding = cp.bindings.activePrimaryCto(projectId);
    if (!binding) throw new Error("suspend crash fixture lost its primary CTO binding");
    const reassigned = cp.runs.reassignOwner(
      blockerRunId,
      binding,
      "non-active ownership changed during provider stop before process death",
    );
    if (!reassigned.allowed) throw new Error(`${reassigned.reasonCode}: ${reassigned.message}`);
  }
  process.send?.({ type: "SUSPEND_COMMITTED" });
  await new Promise<void>(() => undefined);
};

const result = await cp.cto.suspendProject(
  projectId,
  true,
  "process crash after suspend commit",
  { channel: "cli", actor: "test-owner" },
);
process.send?.({ type: "SUSPEND_RETURNED", result });
process.exitCode = 2;
