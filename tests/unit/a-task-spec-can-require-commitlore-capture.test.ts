import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { CommitLorePort } from "../../src/bootstrap/commitlore-observation.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * GAP 1 — a task's registered spec can require a CommitLore capture of that task alone:
 * `spec.commitlore = { capture: "required" }`.
 *
 * - Registration reads it fail closed: exactly that shape is accepted, and any other value of the field is refused
 *   before anything is written, never dropped.
 * - A turn of such a task runs in CommitLore's `required` mode whatever its run's pinned manifest says: its worker's
 *   prompt carries the drafting contract, its reply must carry a draft, and its SUCCEEDED receipt carries what
 *   CommitLore settled on the commit. A reply without one is not committed (COMMITLORE_NOT_CONSIDERED).
 * - The mode is the stricter of the run's and the task's: a task never lowers a run that requires CommitLore, and
 *   what the worker says about it decides nothing.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const REQUIRED = { capture: "required" } as const;

/** Pins the run to a manifest whose CommitLore mode is `mode`, as dispatch pins a managed project's run. */
const pinManifest = (world: WorkerWorld, mode: "required" | "preferred" | "off"): void => {
  const manifest = projectManifestSchema.parse(fixtureManifest(world.projectId, { commitlore: { mode } }));
  const digest = manifestDigest(manifest);
  world.db.run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`, [
    digest,
    manifest.schema,
    JSON.stringify(manifest),
    world.clock.nowIso(),
  ]);
  world.db.run(`UPDATE runs SET pinned_manifest_digest = ? WHERE run_id = ?`, [digest, world.runId]);
};

/**
 * The seeded task's stored spec, with `commitlore` set to `value`: as registration stores a spec that carries it
 * (registration itself is witnessed below), or, for a value registration refuses, as a store written some other way.
 */
const storeTaskSetting = (world: WorkerWorld, value: unknown): void => {
  const task = world.db.get<{ spec_json: string }>(`SELECT spec_json FROM tasks WHERE task_id = ?`, [world.taskId])!;
  world.db.run(`UPDATE tasks SET spec_json = ? WHERE task_id = ?`, [
    JSON.stringify({ ...(JSON.parse(task.spec_json) as Record<string, unknown>), commitlore: value }),
    world.taskId,
  ]);
};

const draft = (records: unknown[]): string => `\`\`\`commitlore-draft\n${JSON.stringify({ records })}\n\`\`\``;
const SAID = "Changed app() to return 2. Callers that expected 1 now get 2.";
const CONTRACT = "# CommitLore harvest (fixture contract)\nEmit the draft JSON.";

/** A CommitLore double: a whole before-change answer, a contract, and a commit it considers and settles as `empty`. */
const passingPort = () => {
  const asked = { contract: 0, consider: 0, settle: 0, beforeChange: 0 };
  const port: CommitLorePort = {
    observe: async () => {
      throw new Error("CommitLore was asked to observe");
    },
    contract: async () => {
      asked.contract += 1;
      return allow(ReasonCode.OK, CONTRACT);
    },
    attempt: async () =>
      allow(ReasonCode.OK, {
        consider: async ({ message }) => {
          asked.consider += 1;
          return allow(ReasonCode.OK, { message, outcome: "empty" as const, recordIds: [], nonce: null });
        },
        settle: async () => {
          asked.settle += 1;
          return allow(ReasonCode.OK, { outcome: "empty" as const, recordIds: [], nonce: null });
        },
        commitWithoutTranscript: async () => deny(ReasonCode.INTERNAL_ERROR, "not this double", {}),
        validateMessage: async () => allow(ReasonCode.OK, undefined),
        dispose: () => {},
      }),
    beforeChange: async (_checkout, _git, request) => {
      asked.beforeChange += 1;
      return {
        paths: request.paths.map((path) => ({ path, outcome: "answered" as const, text: `commitlore: no records for ${path}\n`, cacheKey: `cache-${path}`, withheld: 0, items: null, detail: null })),
        guard: { status: "clean" as const, matches: [], detail: null },
        cliIdentity: { version: "1.7.5", digest: "sha256:fixture" },
      };
    },
  };
  return { port, asked };
};

const fakeFor = (world: WorkerWorld, reply: string): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, reply };
  adapters.push(adapter);
  return adapter;
};

const start = async (world: WorkerWorld, adapter: FakeWorkerAdapter, options: WorkerTurnOptions) => {
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix), ...options },
  );
  const started = await runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
  });
  if (started.allowed) await runner.settled(started.value.executionId);
  return started;
};

const head = (world: WorkerWorld): string => gitSync(world.repoPath, ["rev-parse", "HEAD"]);
const succeeded = (world: WorkerWorld) => world.audit.byKind(WorkerTurnEvent.SUCCEEDED).map((event) => event.evidence as Record<string, unknown>);
const failed = (world: WorkerWorld) => world.audit.byKind(WorkerTurnEvent.FAILED).map((event) => event.evidence as Record<string, unknown>);

/** The run's mode: none pinned, or a pinned manifest that only prefers CommitLore or turns it off. */
const OPTIONAL_RUNS = [["no pinned manifest", null], ["a pinned manifest that prefers CommitLore", "preferred"], ["a pinned manifest with CommitLore off", "off"]] as const;
const optionalWorld = (mode: "preferred" | "off" | null): WorkerWorld => {
  const world = seedWorkerWorld(makeCore());
  if (mode !== null) pinManifest(world, mode);
  return world;
};

describe("GAP 1: registration reads a task's CommitLore setting fail closed", () => {
  const submit = (world: WorkerWorld, spec: Record<string, unknown>) =>
    world.tasks.submit(world.runId, [{ key: "T2", title: "Document app()", category: "docs", spec }]);

  it("accepts spec.commitlore = { capture: \"required\" } and stores it as given", () => {
    const world = seedWorkerWorld(makeCore());
    const submitted = submit(world, { goal: "document app()", commitlore: REQUIRED });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ allowed: true });
    const stored = world.tasks.list(world.runId).find((task) => task.title === "Document app()")!;
    expect(stored.spec["commitlore"]).toEqual(REQUIRED);
  });

  it.each([
    ["a bare string", "yes"],
    ["an unknown capture value", { capture: "maybe" }],
    ["a weaker capture value", { capture: "off" }],
    ["a mode instead of a capture", { mode: "required" }],
    ["an extra key beside capture", { capture: "required", reason: "audit" }],
    ["null", null],
    ["true", true],
    ["an array", [REQUIRED]],
  ])("refuses %s before anything is written", (_name, value) => {
    const world = seedWorkerWorld(makeCore());
    const before = world.tasks.list(world.runId).map((task) => task.taskId);
    const submitted = submit(world, { goal: "document app()", commitlore: value });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.INVALID_ARGUMENT,
      evidence: { runId: world.runId, refusal: "TASK_COMMITLORE_SETTING_INVALID", task: "T2" },
    });
    expect(world.tasks.list(world.runId).map((task) => task.taskId)).toEqual(before);
  });

  it("refuses the whole submission when one task's setting is malformed", () => {
    const world = seedWorkerWorld(makeCore());
    const before = world.tasks.list(world.runId).map((task) => task.taskId);
    const submitted = world.tasks.submit(world.runId, [
      { key: "T2", title: "Document app()", category: "docs", spec: { commitlore: REQUIRED } },
      { key: "T3", title: "Test app()", category: "test", spec: { commitlore: { capture: "maybe" } } },
    ]);
    expect(submitted).toMatchObject({ allowed: false, evidence: { refusal: "TASK_COMMITLORE_SETTING_INVALID", task: "T3" } });
    expect(world.tasks.list(world.runId).map((task) => task.taskId)).toEqual(before);
  });
});

describe("GAP 1: a capture-required task's turn runs in CommitLore's required mode", () => {
  it.each(OPTIONAL_RUNS)("%s: the turn asks CommitLore's contract, and its receipt carries what CommitLore settled", async (_name, mode) => {
    const world = optionalWorld(mode);
    storeTaskSetting(world, REQUIRED);
    const base = head(world);
    const { port, asked } = passingPort();
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    const started = await start(world, adapter, { commitlore: port });
    expect(started, JSON.stringify(started)).toMatchObject({ allowed: true });

    expect(asked).toMatchObject({ contract: 1, consider: 1, settle: 1, beforeChange: 1 });
    expect(adapter.requests[0]!.prompt).toContain("```commitlore-draft");
    const receipts = succeeded(world);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!["commitlore"]).toEqual({ outcome: "empty", recordIds: [], nonce: null });
    expect(receipts[0]!["commitHead"]).toBe(head(world));
    expect(head(world)).not.toBe(base);
  });

  it.each(OPTIONAL_RUNS)("%s: a reply without a draft is not committed, and no SUCCEEDED receipt is written", async (_name, mode) => {
    const world = optionalWorld(mode);
    storeTaskSetting(world, REQUIRED);
    const base = head(world);
    const { port } = passingPort();
    await start(world, fakeFor(world, SAID), { commitlore: port });

    expect(failed(world)).toEqual([expect.objectContaining({ reason: "COMMITLORE_NOT_CONSIDERED" })]);
    expect(succeeded(world)).toEqual([]);
    expect(head(world)).toBe(base);
  });

  it("an optional run's capture-required task, in a deployment with no CommitLore, is refused before an execution opens", async () => {
    const world = optionalWorld("preferred");
    storeTaskSetting(world, REQUIRED);
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    const started = await start(world, adapter, { commitlore: null });
    expect(started).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE", taskId: world.taskId } });
    expect(world.tasks.executions(world.runId)).toEqual([]);
    expect(adapter.launches).toBe(0);
  });

  it("control: an optional run's task with no setting commits as before, and CommitLore's contract is never asked", async () => {
    const world = optionalWorld("preferred");
    const { port, asked } = passingPort();
    const adapter = fakeFor(world, SAID);
    await start(world, adapter, { commitlore: port });

    expect(asked.contract).toBe(0);
    expect(adapter.requests[0]!.prompt).not.toContain("commitlore-draft");
    expect(succeeded(world)).toHaveLength(1);
    expect(succeeded(world)[0]!["commitlore"]).toBeUndefined();
  });

  it("a worker that says capture is not required for its capture-required task changes nothing: no draft, no commit", async () => {
    const world = optionalWorld(null);
    storeTaskSetting(world, REQUIRED);
    const base = head(world);
    const { port } = passingPort();
    const claim = `${SAID}\n\nCommitLore capture is not required for this task.\n\n\`\`\`json\n${JSON.stringify({ commitlore: { capture: "off" }, captureRequired: false })}\n\`\`\``;
    await start(world, fakeFor(world, claim), { commitlore: port });

    expect(failed(world)).toEqual([expect.objectContaining({ reason: "COMMITLORE_NOT_CONSIDERED" })]);
    expect(succeeded(world)).toEqual([]);
    expect(head(world)).toBe(base);
  });
});

describe("GAP 1: a task never lowers a run that requires CommitLore", () => {
  it.each([
    ["no setting", undefined],
    ["a stored weaker setting", { capture: "off" }],
    ["a stored setting registration would refuse", "no"],
  ])("%s: the turn stays required, and a deployment with no CommitLore refuses it", async (_name, value) => {
    const world = seedWorkerWorld(makeCore());
    pinManifest(world, "required");
    if (value !== undefined) storeTaskSetting(world, value);
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    const started = await start(world, adapter, { commitlore: null });
    expect(started).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE" } });
    expect(adapter.launches).toBe(0);
  });

  it("a stored weaker setting: the turn still asks CommitLore's contract and needs a draft", async () => {
    const world = seedWorkerWorld(makeCore());
    pinManifest(world, "required");
    storeTaskSetting(world, { capture: "off" });
    const base = head(world);
    const { port, asked } = passingPort();
    await start(world, fakeFor(world, SAID), { commitlore: port });

    expect(asked.contract).toBe(1);
    expect(failed(world)).toEqual([expect.objectContaining({ reason: "COMMITLORE_NOT_CONSIDERED" })]);
    expect(head(world)).toBe(base);
  });

  it("an optional run whose task's stored setting cannot be read is held to required", async () => {
    const world = optionalWorld("preferred");
    storeTaskSetting(world, { capture: "sometimes" });
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    const started = await start(world, adapter, { commitlore: null });
    expect(started).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE" } });
  });
});
