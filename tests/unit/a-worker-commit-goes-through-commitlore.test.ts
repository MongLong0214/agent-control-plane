import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { COMMITLORE_LIMITS, type CommitLorePort, commitloreRunner, createCommitLoreCliPort } from "../../src/bootstrap/commitlore-observation.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import { latestRelease } from "../helpers/commitlore-release.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1268 — a worker's change, committed by the control plane with `commit-tree` over a private index and with
 * hooks off, goes through CommitLore's own procedure when its run's pinned manifest requires CommitLore:
 *
 * - the worker's prompt carries CommitLore's drafting contract, and its reply must end with one draft, which
 *   is `{"records": []}` when there is nothing to record;
 * - before the commit exists, the pinned CLI verifies and binds that draft (`commit --no-commit`) against the
 *   transcript, which is what the worker was asked without the contract and what it said without the draft,
 *   and against the diff the private index stages (`GIT_INDEX_FILE`); a staged record is applied to the
 *   message by `prepare-commit-msg`;
 * - after it, `post-commit` finalises the capture against the commit, and the commit and the capture are read
 *   back. The transcript and the draft live in the turn's own scratch, never in the worktree.
 *
 * A worker that gave no draft, a record that does not verify, or a pin that is not the newest release leaves
 * no commit, and the worker's bytes where they are. The CLI is the real one (`ACP_TEST_REAL_COMMITLORE`, else
 * the first on PATH); its release lookup confirms its own version unless a witness says otherwise.
 */

const realCommitLore = (): string | null => {
  const explicit = process.env["ACP_TEST_REAL_COMMITLORE"];
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const directory of (process.env["PATH"] ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
    try {
      accessSync(join(directory, "commitlore"), constants.X_OK);
      return join(directory, "commitlore");
    } catch {
      // not here
    }
  }
  return null;
};
const REAL = realCommitLore();
const VERSION = REAL === null ? "" : execFileSync(REAL, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

/** Pins the run to a manifest whose CommitLore mode is `mode`, as dispatch pins a managed project's run. */
const pinManifest = (world: WorkerWorld, mode: "required" | "preferred"): void => {
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

/** `commitlore init` in the worker's checkout, as a CommitLore-enabled repository has it: its hooks are what lets a record be staged. */
const initCommitLore = (repo: string): void => {
  execFileSync(REAL as string, ["init", "--mcp-scope", "none", "--no-unattended", "--no-agent-hooks"], {
    cwd: repo,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tempDir("acp-1268-init-home-"), GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "ignore",
    timeout: 60_000,
  });
};

const requiredWorld = (options: { init?: boolean } = {}): WorkerWorld => {
  const world = seedWorkerWorld(makeCore());
  pinManifest(world, "required");
  if (REAL !== null && options.init !== false) initCommitLore(world.repoPath);
  return world;
};

const realPort = (version = VERSION): CommitLorePort =>
  createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string, latestRelease(version)));

const fakeFor = (world: WorkerWorld, reply: string): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, reply };
  adapters.push(adapter);
  return adapter;
};

const makeRunner = (world: WorkerWorld, adapter: FakeWorkerAdapter, options: WorkerTurnOptions): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix), ...options },
  );

const runTurn = async (world: WorkerWorld, runner: WorkerTurnRunner): Promise<string> => {
  const started = await runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
  });
  if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
  await runner.settled(started.value.executionId);
  return started.value.executionId;
};

const draft = (records: unknown[]): string => `\`\`\`commitlore-draft\n${JSON.stringify({ records })}\n\`\`\``;
const SAID = "Changed app() to return 2. Callers that expected 1 now get 2.";
const warnRecord = (quote: string) => ({
  trailers: [{ key: "Warn", value: "callers that expected 1 now get 2" }],
  evidence: [{ key: "Warn", source: "transcript", quote, locator: "L1-L1" }],
});

const head = (world: WorkerWorld): string => gitSync(world.repoPath, ["rev-parse", "HEAD"]);
const messageOf = (world: WorkerWorld, commit: string): string => gitSync(world.repoPath, ["log", "-1", "--format=%B", commit]);
const succeededEvidence = (world: WorkerWorld): Record<string, unknown> => {
  const events = world.audit.byKind(WorkerTurnEvent.SUCCEEDED);
  expect(events).toHaveLength(1);
  return events[0]!.evidence as Record<string, unknown>;
};
const failedEvidence = (world: WorkerWorld): Record<string, unknown> => {
  const events = world.audit.byKind(WorkerTurnEvent.FAILED);
  expect(events, "the turn was expected to fail").toHaveLength(1);
  return events[0]!.evidence as Record<string, unknown>;
};
/** Nothing committed, the worker's bytes still in the worktree, and nothing of CommitLore's there either. */
const nothingCommitted = (world: WorkerWorld, base: string): void => {
  expect(head(world)).toBe(base);
  expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
  expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe("module.exports = () => 2;\n");
  expect(readdirSync(world.repoPath).filter((name) => name.startsWith("commitlore"))).toEqual([]);
};

// Each turn here spawns the real CLI some ten times (its checks, its contract, the binding, the application,
// the finalisation and the read-backs), a second or more each under parallel load.
describe.skipIf(REAL === null)("#1268: a worker commit goes through CommitLore (real CLI)", { timeout: 180_000 }, () => {
  it("a draft with nothing to record: committed with no record, CommitLore's consideration bound to that tree, the worker's prompt carrying its contract", async () => {
    const world = requiredWorld();
    const base = head(world);
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort() }));

    const evidence = succeededEvidence(world);
    expect(evidence["commitlore"]).toEqual({ outcome: "empty", recordIds: [], nonce: null });
    const commit = head(world);
    expect(commit).not.toBe(base);
    expect(messageOf(world, commit).trim()).toBe("Make app() return 2");
    const considered = JSON.parse(readFileSync(join(world.repoPath, ".git", "commitlore", "considered.json"), "utf8")) as Record<string, unknown>;
    expect(considered).toMatchObject({ outcome: "empty", records: 0, head: base });
    const prompt = adapter.requests[0]!.prompt;
    expect(prompt).toContain("```commitlore-draft");
    expect(prompt).toContain("# CommitLore harvest");
    expect(gitSync(world.repoPath, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("nothing to record needs no CommitLore hook in the checkout: a repository never initialised commits with no record", async () => {
    const world = requiredWorld({ init: false });
    const base = head(world);
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort() }));

    expect(succeededEvidence(world)["commitlore"]).toEqual({ outcome: "empty", recordIds: [], nonce: null });
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD^"])).toBe(base);
  });

  it("a verified record lands in the commit, and its capture is consumed by that commit", async () => {
    const world = requiredWorld();
    const adapter = fakeFor(world, `${SAID}\n\n${draft([warnRecord("Callers that expected 1 now get 2.")])}`);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort() }));

    const evidence = succeededEvidence(world);
    const recorded = evidence["commitlore"] as { outcome: string; recordIds: string[]; nonce: string };
    expect(recorded.outcome).toBe("recorded");
    expect(recorded.recordIds).toHaveLength(1);
    const commit = head(world);
    const message = messageOf(world, commit);
    expect(message).toContain("Warn: callers that expected 1 now get 2");
    expect(message).toContain(`Record-Id: ${recorded.recordIds[0]}`);
    const shown = JSON.parse(
      execFileSync(REAL as string, ["pending", "show", recorded.nonce, "--json"], {
        cwd: world.repoPath,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tempDir("acp-1268-read-home-") },
        timeout: 30_000,
      }),
    ) as { transaction: Record<string, unknown> };
    expect(shown.transaction).toMatchObject({ consumed: true, consumed_by: commit, phase: "consumed" });
  });

  it.each([
    ["a quote only CommitLore's contract holds", "the CDN times out at 30s"],
    ["a quote only the draft itself holds", "a sentence nobody said outside this draft"],
  ])("%s does not verify: no commit, and the worker's bytes stay", async (_name, quote) => {
    const world = requiredWorld();
    const base = head(world);
    const adapter = fakeFor(world, `${SAID}\n\n${draft([warnRecord(quote)])}`);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort() }));

    const evidence = failedEvidence(world);
    expect(evidence).toMatchObject({ reason: "COMMIT_FAILED" });
    expect(String(evidence["detail"])).toContain("did not verify");
    nothingCommitted(world, base);
  });

  it("a reply with no draft is not a consideration: no commit, and the worker's bytes stay", async () => {
    const world = requiredWorld();
    const base = head(world);
    const adapter = fakeFor(world, SAID);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort() }));

    expect(failedEvidence(world)).toMatchObject({ reason: "COMMITLORE_NOT_CONSIDERED" });
    nothingCommitted(world, base);
  });

  it("a pin that is not the newest release commits nothing, though its draft would verify", async () => {
    const world = requiredWorld();
    const base = head(world);
    const [major, minor, patch] = VERSION.split(".").map(Number) as [number, number, number];
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    await runTurn(world, makeRunner(world, adapter, { commitlore: realPort(`${major}.${minor}.${patch + 1}`) }));

    const evidence = failedEvidence(world);
    expect(String(evidence["detail"])).toContain("ACP_COMMITLORE_BINARY NOT_LATEST");
    nothingCommitted(world, base);
  });
});

describe("#1268: which turns CommitLore governs", () => {
  /** A port that fails any witness reaching it. */
  const untouchable: CommitLorePort = {
    observe: async () => {
      throw new Error("CommitLore was asked to observe");
    },
    contract: async () => {
      throw new Error("CommitLore was asked for its contract");
    },
    attempt: async () => {
      throw new Error("CommitLore was asked to commit");
    },
  };

  it("control: a run whose pinned manifest prefers CommitLore commits as before, and CommitLore is never asked", async () => {
    const world = seedWorkerWorld(makeCore());
    pinManifest(world, "preferred");
    const base = head(world);
    const adapter = fakeFor(world, "changed app.js");
    await runTurn(world, makeRunner(world, adapter, { commitlore: untouchable }));

    expect(head(world)).not.toBe(base);
    expect(succeededEvidence(world)["commitlore"]).toBeUndefined();
    expect(adapter.requests[0]!.prompt).not.toContain("commitlore-draft");
  });

  it("a run that requires CommitLore, in a deployment with none, is refused before an execution opens", async () => {
    const world = seedWorkerWorld(makeCore());
    pinManifest(world, "required");
    const adapter = fakeFor(world, `${SAID}\n\n${draft([])}`);
    const started = await makeRunner(world, adapter, { commitlore: null }).start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
    });
    expect(started).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE" } });
    expect(world.tasks.executions(world.runId)).toEqual([]);
    expect(adapter.launches).toBe(0);
  });
});
