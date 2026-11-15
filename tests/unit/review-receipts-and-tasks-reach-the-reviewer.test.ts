import { afterAll, describe, expect, it } from "vitest";

import { ExecutionMode } from "../../src/domain/types.ts";
import {
  type ExecutionEvidence, type ReceiptEvidence, candidateEvidenceSection,
} from "../../src/review/candidate-review-evidence.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

// #1410 — a live 42-task run reached the blind reviewer with 39 receipt bodies and 15 tasks cut for
// character budget, and the reviewer blocked on "delegation and rollback evidence unestablished".

afterAll(cleanupTempDirs);

const RECEIPTS = 42;
const TASKS = 57;
const IDENTITY = "github:acme/fixture";
/** A task the PLAN names by its key, not its task id (a v35 task of the live run). */
const KEYED_TASK = "command-match-shell-whitespace";

const prepare = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "many tasks", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["every task has a receipt"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const runId = dispatched.value.runId;
  const specs = Array.from({ length: TASKS }, (_, i) => ({
    key: `t${i}`, title: i === TASKS - 1 ? KEYED_TASK : `task-${i}`, category: "implementation" as const,
    ...(i % 3 === 1 ? { dependsOn: [`t${i - 1}`] } : {}),
  }));
  const submitted = harness.cp.tasks.submit(runId, specs);
  if (!submitted.allowed) throw new Error(submitted.message);
  return { harness, runId, tasks: submitted.value };
};

const receiptFor = (runId: string, index: number, taskId: string, unit: string | undefined): ReceiptEvidence => ({
  runId, taskId, executionId: `exec_${String(index).padStart(3, "0")}`, status: "SUCCEEDED", repository: IDENTITY,
  baseHead: "b".repeat(40), commitHead: "a".repeat(40), diffDigest: `sha256:${"d".repeat(64)}`,
  snapshotDiffDigest: `sha256:${"5".repeat(64)}`, recomputedDiffDigest: `sha256:${"d".repeat(64)}`, linked: true, mismatches: [],
  workerSessionId: `sess_worker_${String(index).padStart(3, "0")}`,
  ...(unit === undefined ? {} : { workUnit: unit }),
  checks: { namesTask: true, resultReproduced: true, commitIsCandidateHead: true, baseIsSnapshotBase: true, diffDigestAgrees: true },
});

const evidenceOf = (receipts: ReceiptEvidence[]): ExecutionEvidence => ({
  commandSource: "the pinned manifest sha256:x, profile standard", commands: [], results: [],
  repositories: [{ repository: IDENTITY, baseHead: "b".repeat(40), candidateHead: "a".repeat(40), linkedExecutionIds: receipts.map((r) => r.executionId) }],
  receipts, receiptsNotListed: { outsideCandidateHistory: 0, notACandidateRepository: 0, noCommitReceipt: 0, overListLimit: 0, unchecked: 0 },
});

const fenceAfter = (text: string, heading: string, info: "json" | "jsonl"): string =>
  text.split(`## ${heading}\n`)[1]!.split(`\`\`\`${info}\n`)[1]!.split("\n```")[0]!;

interface RenderedTasks {
  taskSummary: { total: number; listed: number; truncated: boolean; workUnits?: { declared: number; tasksInAUnit: number; unresolvedRefs?: string[] } };
  tasks: Array<{ taskId: string; state: string; dependsOn?: string[]; workUnit?: string }>;
}
interface RenderedExecution {
  receipts: { total: number; listed: number; notListed: Record<string, number>; digestDetail: { listed: number; notListed: number } };
  cutForSize: boolean;
}

describe("every receipt and task of a run reaches the reviewer (#1410)", () => {
  // The room the review gives the evidence when the diff is small: the 120,000-char reviewer budget less the envelope.
  for (const room of [0, 20_000, 60_000]) {
    it(`lists all ${RECEIPTS} receipt rows and all ${TASKS} tasks at a room of ${room}, none counted as over the character budget`, async () => {
      const { harness, runId, tasks } = await prepare();
      try {
        // The PLAN's units: most tasks by task id, the last one by its PLAN key.
        const ids = tasks.map((task) => task.taskId);
        const units = [
          { key: "unit-a", tasks: ids.slice(0, 28) },
          { key: "unit-b", tasks: [...ids.slice(28, TASKS - 1), KEYED_TASK] },
        ];
        harness.cp.artifacts.put(runId, "PLAN", { summary: "fixture", workUnits: units });
        const receipts = ids.slice(0, RECEIPTS).map((taskId, i) => receiptFor(runId, i, taskId, i < 28 ? "unit-a" : "unit-b"));
        const text = candidateEvidenceSection(harness.cp.db, runId, [], evidenceOf(receipts), room).join("\n");

        const control = JSON.parse(fenceAfter(text, "Control-plane evidence", "json")) as RenderedTasks;
        expect(control.taskSummary).toMatchObject({ total: TASKS, listed: TASKS, truncated: false });
        expect(control.tasks.map((task) => task.taskId).sort()).toEqual([...ids].sort());
        // Every task is in its unit, the PLAN-key one included, and none is reported unresolved.
        expect(control.tasks.every((task) => task.workUnit !== undefined)).toBe(true);
        expect(control.tasks.find((task) => task.taskId === ids[TASKS - 1])!.workUnit).toBe("unit-b");
        expect(control.taskSummary.workUnits).toEqual({ declared: 2, tasksInAUnit: TASKS });
        // Dependencies are rows of their own.
        expect(control.tasks.find((task) => task.taskId === ids[1])!.dependsOn).toEqual([ids[0]]);

        const execution = JSON.parse(fenceAfter(text, "Untrusted execution evidence", "json")) as RenderedExecution;
        expect(execution.receipts).toMatchObject({ total: RECEIPTS, listed: RECEIPTS });
        expect(execution.receipts.notListed["overCharBudget"]).toBeUndefined();
        expect(execution.receipts.notListed["overListLimit"]).toBe(0);
        // With no room at all the repository list is cut and said so; the rows are not what is cut.
        expect(execution.cutForSize).toBe(room === 0);

        const rows = fenceAfter(text, "Untrusted execution evidence", "jsonl").split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(rows).toHaveLength(RECEIPTS);
        expect(rows.map((row) => row["executionId"])).toEqual(receipts.map((r) => r.executionId));
        expect(new Set(rows.map((row) => row["workerSessionId"])).size).toBe(RECEIPTS);
        for (const [i, row] of rows.entries()) {
          expect(row).toMatchObject({ taskId: ids[i], repository: IDENTITY, status: "SUCCEEDED", linked: true,
            workUnit: i < 28 ? "unit-a" : "unit-b",
            checks: { namesTask: true, resultReproduced: true, commitIsCandidateHead: true, baseIsSnapshotBase: true, diffDigestAgrees: true } });
          // The three full digests are not in a row.
          expect(JSON.stringify(row)).not.toContain("sha256:");
        }
        // The rows, not the digest detail, are what the reviewer always gets: they stay small enough for the reviewer bound.
        expect(text.length).toBeLessThan(60_000);
      } finally { harness.cp.close(); }
    }, 60_000);
  }

  it("names a unit reference no task answers instead of dropping it, and reports a disagreeing receipt in its row", async () => {
    const { harness, runId, tasks } = await prepare();
    try {
      const ids = tasks.map((task) => task.taskId);
      harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "unit-a", tasks: [...ids.slice(0, 5), "no-such-task"] }] });
      const bad: ReceiptEvidence = { ...receiptFor(runId, 0, ids[0]!, "unit-a"), linked: false, recomputedDiffDigest: null,
        mismatches: ["the receipt's diffDigest is not the frozen change's"],
        checks: { namesTask: true, resultReproduced: true, commitIsCandidateHead: true, baseIsSnapshotBase: true, diffDigestAgrees: false } };
      const text = candidateEvidenceSection(harness.cp.db, runId, [], evidenceOf([bad]), 0).join("\n");
      const control = JSON.parse(fenceAfter(text, "Control-plane evidence", "json")) as RenderedTasks;
      expect(control.taskSummary.workUnits).toEqual({ declared: 1, tasksInAUnit: 5, unresolvedRefs: ["unit-a:no-such-task"] });
      const [row] = fenceAfter(text, "Untrusted execution evidence", "jsonl").split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(row).toMatchObject({ linked: false, mismatches: ["the receipt's diffDigest is not the frozen change's"],
        checks: { diffDigestAgrees: false } });
    } finally { harness.cp.close(); }
  }, 60_000);

  it("still cuts superseded (CANCELLED) tasks by budget, and says that only those are unlisted", async () => {
    const { harness, runId } = await prepare();
    try {
      const old = harness.cp.tasks.submit(runId, Array.from({ length: 300 }, (_, i) => ({ key: `old-${i}`, title: `old-${i}`, category: "implementation" as const })));
      expect(old.allowed).toBe(true);
      expect(harness.cp.tasks.cancelAll(runId, "superseded")).toBeGreaterThan(300);
      const text = candidateEvidenceSection(harness.cp.db, runId, [], evidenceOf([]), 30_000).join("\n");
      const control = JSON.parse(fenceAfter(text, "Control-plane evidence", "json")) as RenderedTasks & { taskSummary: { unlisted?: Record<string, number> } };
      expect(control.taskSummary.truncated).toBe(true);
      expect(Object.keys(control.taskSummary.unlisted ?? {})).toEqual(["CANCELLED"]);
      expect(control.taskSummary.listed + (control.taskSummary.unlisted?.["CANCELLED"] ?? 0)).toBe(control.taskSummary.total);
    } finally { harness.cp.close(); }
  }, 60_000);
});
