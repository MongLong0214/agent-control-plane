import { spawn } from "node:child_process";
import { once } from "node:events";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";
import { createHermesIncumbentAdoption, type GatewayIncumbentProof } from "../../src/bootstrap/hermes-incumbent-adoption.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { readHermesTargetHead } from "../../src/session/hermes-target-head.ts";

afterAll(cleanupTempDirs);

it("re-adopts the same CEO actor after revocation, following its head inside the lineage", async () => {
  const h = makeHarness();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    let childToken: string | null = null;
    for (let attempt = 0; attempt < 20 && !childToken; attempt++) {
      childToken = readProcessStartToken(child.pid!);
      if (!childToken) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(childToken).not.toBeNull();
    const target = { sessionId: "configured-ancestor", lineageRootDigest: `sha256:${"a".repeat(64)}` };
    const head = "authenticated-live-head";
    const home = tempDir("acp-adopt-repeat-");
    symlinkSync(process.execPath, join(home, "node"));
    writeFileSync(join(home, "producer.mjs"), `
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fields = {
  domain: 'hermes.target-bind', version: 1, actor_id: request.actor_id,
  binding_generation: request.binding_generation,
  executor_runtime_identity: request.executor_runtime_identity,
  requested_session_id: request.session_id,
  lineage_root_digest: request.expected_lineage_root_digest,
};
const canonical = JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
process.stdout.write(JSON.stringify({ ...fields, receipt_digest: 'sha256:' + createHash('sha256').update(canonical).digest('hex') }));
`);
    const hermesExecutable = new URL("../fixtures/hermes-target-bind-producer.sh", import.meta.url).pathname;
    const old = h.cp.sessions.create({ provider: "hermes", model: "old", osPid: 2147483647 });
    expect(h.cp.sessions.transition(old.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: old.sessionId }).allowed).toBe(true);
    expect(h.cp.bindings.revoke("CEO", "old process died").allowed).toBe(true);
    expect(h.cp.sessions.transition(old.sessionId, SessionLifecycle.ERROR).allowed).toBe(true);

    const adopt = (proof: GatewayIncumbentProof) =>
      createHermesIncumbentAdoption(h.cp, {
        gatewayOrigin: async () => proof, lineageRootDigest: target.lineageRootDigest,
        hermesExecutable, hermesProfile: "fixture", hermesHome: home,
        executorRuntimeIdentity: "fixture-runtime",
      }).adopt({ gatewayPid: proof.process_pid, gatewayStartToken: proof.process_started_at });
    const firstProof = { session_id: head, lineage_root_digest: target.lineageRootDigest,
      process_pid: child.pid!, process_started_at: childToken! };
    const first = await adopt(firstProof);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    const stored = h.cp.db.get<{ target_locator: string; target_locator_digest: string }>(
      "SELECT target_locator, target_locator_digest FROM actor_target_bindings WHERE target_actor_id = ?", [first.value.actorId]);
    expect(stored).toEqual({ target_locator: head, target_locator_digest: target.lineageRootDigest });
    expect(h.cp.bindings.revoke("CEO", "adopted process died").allowed).toBe(true);
    child.kill();
    await once(child, "exit");
    expect(h.cp.sessions.transition(first.value.sessionId, SessionLifecycle.ERROR).allowed).toBe(true);
    const token = readProcessStartToken(process.pid);
    expect(token).not.toBeNull();
    const nextProof = { session_id: head, lineage_root_digest: target.lineageRootDigest,
      process_pid: process.pid, process_started_at: token! };
    const beforeSessions = h.cp.sessions.list();
    const beforeAssignments = h.cp.db.all("SELECT assignment_id FROM assignments");
    const beforeAudit = h.cp.db.all("SELECT event_id FROM audit_events");
    // Another lineage is another conversation, whatever head it names.
    const wrongLineage = await adopt({ ...nextProof, lineage_root_digest: `sha256:${"b".repeat(64)}` });
    expect(wrongLineage.allowed).toBe(false);
    expect(h.cp.sessions.list()).toEqual(beforeSessions);
    expect(h.cp.db.all("SELECT assignment_id FROM assignments")).toEqual(beforeAssignments);
    expect(h.cp.db.all("SELECT event_id FROM audit_events")).toEqual(beforeAudit);
    expect(h.cp.bindings.active("CEO")).toBeNull();
    // A compression rotated the head inside the lineage while the Gateway was down: that head is
    // adopted and the target follows it, with no configured head to agree with.
    const rotated = "rotated-live-head";
    const second = await adopt({ ...nextProof, session_id: rotated });
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    expect(second.value.actorId).toBe(first.value.actorId);
    expect(second.value.bindingGeneration).toBe(first.value.bindingGeneration + 1);
    expect(h.cp.bindings.active("CEO")?.sessionId).toBe(second.value.sessionId);
    expect(readHermesTargetHead(h.cp.db, first.value.actorId)).toMatchObject({ head: rotated, bornLocator: head });
  } finally {
    if (child.exitCode === null) child.kill();
    h.cp.close();
  }
});
