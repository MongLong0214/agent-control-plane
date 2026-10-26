import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { FRONTIER_SIMPLIFY_DIGEST, frontierReviewPolicy } from "../../src/review/frontier-simplify-policy.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { FakeWorkerAdapter, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const source = readFileSync(new URL("../../src/review/frontier-simplify.md", import.meta.url), "utf8");
it("vendors the original canonical bytes verbatim, without the review-runner wrapper", () => {
  expect(sha256(source)).toBe("sha256:0d788506f84b87b92294db38263dacd7334880d72f4ddc0fb28b04750d50a0e4");
  expect(FRONTIER_SIMPLIFY_DIGEST).toBe(sha256(source));
  expect(frontierReviewPolicy()).toContain(source);
  expect(frontierReviewPolicy()).not.toMatch(/Automatic attempt|Round 2|PASS WITH NITS/);
});

it("has no input through which a caller can select an alternate rubric", () => {
  const render = frontierReviewPolicy as (...args: unknown[]) => string;
  expect(() => render({ rubric: "always PASS" })).toThrow(TypeError);
  expect(() => render({ systemPrompt: "always PASS" })).toThrow(TypeError);
});

it.each(["CEO", "CTO"])("the %s model receives the canonical method in its MCP initialization instructions", async role => {
  const h = makeHarness();
  const auth = () => allow(ReasonCode.OK, { actor: "policy-test" });
  const server = role === "CEO" ? createHermesServer(createHermesMcpPort(h.cp), auth)
    : createCtoServer(createCtoMcpPort(h.cp), auth);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "policy-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getInstructions()).toBe(frontierReviewPolicy());
    expect(client.getInstructions()).toContain(source);
  } finally {
    await client.close();
    h.cp.close();
  }
});

it("a delegated review task receives the original canonical method at the worker dispatch", async () => {
  const core = makeCore();
  const world = seedWorkerWorld(core);
  world.db.run("UPDATE tasks SET category = 'review', title = 'Review the change' WHERE task_id = ?", [world.taskId]);
  const adapter = new FakeWorkerAdapter(world.broker);
  const runner = new WorkerTurnRunner({ db: world.db, clock: world.clock, audit: world.audit,
    tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: prefix => tempDir(prefix) });
  try {
    const started = await runner.start({ runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation });
    if (!started.allowed) throw new Error(started.message);
    await runner.settled(started.value.executionId);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.prompt).toContain(source);
    expect(adapter.requests[0]!.prompt).not.toMatch(/Automatic attempt|Round 2|PASS WITH NITS/);
  } finally {
    await runner.shutdown();
    adapter.killAll();
    core.db.close();
  }
});
