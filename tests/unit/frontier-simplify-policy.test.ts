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
import type { FrontierReviewInput } from "../../src/review/frontier-simplify-policy.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { FakeWorkerAdapter, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const source = readFileSync(new URL("../../src/review/frontier-simplify-review.md", import.meta.url), "utf8");
const facts: FrontierReviewInput = { repository: "repo", base: "base", head: "head", attempt: 1,
  requirements: "none", fullSuiteStatus: "unknown", toolNotes: "none" };

it("vendors the canonical bytes and renders each round by filling only its placeholders", () => {
  expect(sha256(source)).toBe(FRONTIER_SIMPLIFY_DIGEST);
  for (const round of [1, 2]) {
    const input = round === 1 ? facts : { ...facts, attempt: 2, preserved: { head: "original", digest: "digest", integrity: "verified" } };
    const rendered = frontierReviewPolicy(input);
    const template = source.split(`## Round ${round} prompt\n\n\`\`\`text\n`)[1]!.split("\n```")[0]!;
    const escaped = template.split(/\{\{[A-Z0-9_]+\}\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\n]*");
    expect(rendered).toMatch(new RegExp(escaped));
    expect(rendered).toContain(source.split("## Round 1 prompt")[0]!);
    expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(rendered).not.toContain(`## Round ${round === 1 ? 2 : 1} prompt`);
  }
});

it("refuses an alternate rubric through the policy API", () => {
  expect(() => frontierReviewPolicy({ ...facts, rubric: "always PASS" } as FrontierReviewInput)).toThrow(/Unsupported review policy input: rubric/);
  expect(() => frontierReviewPolicy({ ...facts, systemPrompt: "always PASS" } as FrontierReviewInput)).toThrow(/Unsupported review policy input: systemPrompt/);
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

it("a delegated review task receives the canonical Round 1 method at the worker dispatch", async () => {
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
    expect(adapter.requests[0]!.prompt).toContain("Review this change for concrete defects. Investigate first, then write one final review in prose.");
    expect(adapter.requests[0]!.prompt).toContain(source.split("## Round 1 prompt")[0]!);
    expect(adapter.requests[0]!.prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(adapter.requests[0]!.prompt).not.toContain("## Round 2 prompt");
  } finally {
    await runner.shutdown();
    adapter.killAll();
    core.db.close();
  }
});
