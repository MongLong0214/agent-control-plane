import { afterAll, describe, expect, it } from "vitest";

import { ExecutionMode } from "../../src/domain/types.ts";
import {
  type ExecutionEvidence, type ReceiptEvidence, candidateEvidenceSection, workUnitsOf,
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
  checks: { namesTask: true, resultReproduced: true, commitIsCandidateHead: true, baseIsSnapshotBase: true, diffDigestAgrees: true, ancestryChecked: true },
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
        // The PLAN's units: most tasks by task id, the last one by its PLAN key; the approval resolved all of them to ids.
        const ids = tasks.map((task) => task.taskId);
        const units = [
          { key: "unit-a", tasks: ids.slice(0, 28) },
          { key: "unit-b", tasks: [...ids.slice(28, TASKS - 1), KEYED_TASK] },
        ];
        const stored = harness.cp.artifacts.put(runId, "PLAN", { summary: "fixture", workUnits: units });
        harness.cp.audit.record({ kind: "WORK_SCOPE_APPROVED", runId, evidence: { planDigest: stored.digest, bindingGeneration: 1,
          units: [{ unit: "unit-a", taskIds: ids.slice(0, 28), declarationDigest: "sha256:a" }, { unit: "unit-b", taskIds: ids.slice(28), declarationDigest: "sha256:b" }] } });
        const receipts = ids.slice(0, RECEIPTS).map((taskId, i) => receiptFor(runId, i, taskId, i < 28 ? "unit-a" : "unit-b"));
        const text = candidateEvidenceSection(harness.cp.db, runId, [], evidenceOf(receipts), room).join("\n");

        const control = JSON.parse(fenceAfter(text, "Control-plane evidence", "json")) as RenderedTasks;
        expect(control.taskSummary).toMatchObject({ total: TASKS, listed: TASKS, truncated: false });
        expect(control.tasks.map((task) => task.taskId).sort()).toEqual([...ids].sort());
        // Every task is in the unit the approval gave it, the PLAN-key one included, and its key is not listed: the
        // approval holds its unit whole.
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
        // (the reviewer's 120,000-char budget less the chunk envelope)
        expect(text.length).toBeLessThan(120_000 - 4_096);
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
        checks: { namesTask: true, resultReproduced: true, commitIsCandidateHead: true, baseIsSnapshotBase: true, diffDigestAgrees: false, ancestryChecked: true } };
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

describe("a work unit is read from the approval and from task ids, never inferred (#1410 review P2, r3-r5)", () => {
  type Harness = Awaited<ReturnType<typeof prepare>>["harness"];
  const submit = (harness: Harness, runId: string, specs: Array<{ key: string; title: string }>) => {
    const submitted = harness.cp.tasks.submit(runId, specs.map((spec) => ({ ...spec, category: "implementation" as const })));
    if (!submitted.allowed) throw new Error(submitted.message);
    return submitted.value;
  };
  const taskRows = (harness: Harness, runId: string) =>
    harness.cp.db.all<{ task_id: string; title: string; state: string }>(`SELECT task_id, title, state FROM tasks WHERE run_id = ?`, [runId]);
  const approve = (harness: Harness, runId: string, planDigest: string, units: Array<{ unit: string; taskIds: string[] }>) => {
    const recorded = harness.cp.audit.record({ kind: "WORK_SCOPE_APPROVED", runId, evidence: { planDigest, bindingGeneration: 1,
      units: units.map((unit) => ({ ...unit, declarationDigest: `sha256:${unit.unit}` })) } });
    expect(recorded.allowed).toBe(true);
  };
  /** Every live task of `only` has its work unit, or the gap is named: no task is silently without one. */
  const expectNoSilentGap = (harness: Harness, runId: string, units: ReturnType<typeof workUnitsOf>, only: readonly string[]): void => {
    const unmapped = taskRows(harness, runId).filter((task) => task.state !== "CANCELLED" && !units.byTask.has(task.task_id) && only.includes(task.task_id));
    if (unmapped.length > 0) expect(units.unresolvedRefs.length, `unmapped: ${unmapped.map((task) => task.title).join(", ")}`).toBeGreaterThan(0);
  };

  it("keeps each task in the unit the approval gave it when one task's title is another's PLAN key", async () => {
    const { harness, runId } = await prepare();
    try {
      // A is key alpha / title beta, B is key beta / title alpha.
      const [a, b] = submit(harness, runId, [{ key: "alpha", title: "beta" }, { key: "beta", title: "alpha" }]);
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "unit-a", tasks: ["alpha"] }, { key: "unit-b", tasks: ["beta"] }] });
      approve(harness, runId, stored.digest, [{ unit: "unit-a", taskIds: [a!.taskId] }, { unit: "unit-b", taskIds: [b!.taskId] }]);
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(units.byTask.get(a!.taskId)).toBe("unit-a");
      expect(units.byTask.get(b!.taskId)).toBe("unit-b");
      // The PLAN's keys are not read as titles, and the approval holds each unit whole: nothing to list.
      expect(units.unresolvedRefs).toEqual([]);
    } finally { harness.cp.close(); }
  }, 60_000);

  it("a fully approved 3-task unit referenced by keys is mapped whole and lists no key", async () => {
    const { harness, runId } = await prepare();
    try {
      const three = submit(harness, runId, [{ key: "k1", title: "one" }, { key: "k2", title: "two" }, { key: "k3", title: "three" }]);
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "trio", tasks: ["k1", "k2", "k3"] }] });
      approve(harness, runId, stored.digest, [{ unit: "trio", taskIds: three.map((task) => task.taskId) }]);
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(three.every((task) => units.byTask.get(task.taskId) === "trio")).toBe(true);
      expect(units.unresolvedRefs).toEqual([]);
      // The same keys with no approval to hold the unit are all listed.
      harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "trio", tasks: ["k1", "k2", "k3"] }, { key: "other", tasks: [] }] });
      const without = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(without.byTask.size).toBe(0);
      expect(without.unresolvedRefs).toEqual(["trio:k1", "trio:k2", "trio:k3"]);
    } finally { harness.cp.close(); }
  }, 60_000);

  it("maps a PLAN task-id reference the approval left out, and an approval entry that is a key is listed, not guessed from a title", async () => {
    const { harness, runId } = await prepare();
    try {
      const [a, b, c, d] = submit(harness, runId, [{ key: "a", title: "kept-a" }, { key: "b", title: "kept-b" }, { key: "c", title: "later-key" }, { key: "d", title: "d" }]);
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "unit-a", tasks: ["a", "later-key"] }, { key: "unit-b", tasks: [b!.taskId, d!.taskId] }] });
      approve(harness, runId, stored.digest, [{ unit: "unit-a", taskIds: [a!.taskId, "later-key"] }, { unit: "unit-b", taskIds: [b!.taskId] }]);
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(units.byTask.get(a!.taskId)).toBe("unit-a");
      expect(units.byTask.get(b!.taskId)).toBe("unit-b");
      // d is named by id in the PLAN only, and is mapped by that id; c is the title of "later-key" and is not mapped.
      expect(units.byTask.get(d!.taskId)).toBe("unit-b");
      expect(units.byTask.has(c!.taskId)).toBe(false);
      expect(units.unresolvedRefs).toContain("unit-a:later-key");
      expectNoSilentGap(harness, runId, units, [a, b, c, d].map((task) => task!.taskId));
    } finally { harness.cp.close(); }
  }, 60_000);

  it("never maps an ambiguous or a unique title: without an approval only task ids place a task, every other entry is listed", async () => {
    const { harness, runId } = await prepare();
    try {
      const [first, , solo] = submit(harness, runId, [{ key: "p", title: "dup" }, { key: "q", title: "dup" }, { key: "r", title: "solo" }]);
      harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "unit-a", tasks: [first!.taskId, "dup"] }, { key: "unit-b", tasks: ["solo"] }] });
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(units.byTask.get(first!.taskId)).toBe("unit-a");
      expect(units.byTask.has(solo!.taskId)).toBe(false);
      expect([...units.byTask.keys()]).toEqual([first!.taskId]);
      expect(units.unresolvedRefs).toEqual(["unit-a:dup", "unit-b:solo"]);
    } finally { harness.cp.close(); }
  }, 60_000);

  it("an approved unit cut at the audit log's 200-item cap leaves its tail unmapped and every PLAN key listed (#1410 re-review)", async () => {
    const { harness, runId } = await prepare();
    try {
      // 201 tasks in one unit: the audit log keeps 200 array items and marks nothing, so the approval holds 200 of them.
      const many = submit(harness, runId, Array.from({ length: 201 }, (_, i) => ({ key: `u${i}`, title: `u${i}` })));
      const other = submit(harness, runId, [{ key: "elsewhere", title: "elsewhere" }])[0]!;
      const refs = [...many.map((_, i) => `u${i}`), "ghost"];
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "big", tasks: refs }, { key: "small", tasks: [other.taskId] }] });
      approve(harness, runId, stored.digest, [{ unit: "big", taskIds: many.map((task) => task.taskId) }, { unit: "small", taskIds: [other.taskId] }]);
      const held = harness.cp.db.get<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = 'WORK_SCOPE_APPROVED' AND run_id = ?`, [runId])!;
      expect((JSON.parse(held.evidence_json) as { units: Array<{ taskIds: string[] }> }).units[0]!.taskIds).toHaveLength(200);

      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(many.slice(0, 200).every((task) => units.byTask.get(task.taskId) === "big")).toBe(true);
      expect(units.byTask.get(other.taskId)).toBe("small");
      // The tail the audit log cut is not guessed back from its title: it has no unit, and the gap is named.
      expect(units.byTask.has(many[200]!.taskId)).toBe(false);
      expect(units.unresolvedRefs).toContain("big:u200");
      expect(units.unresolvedRefs).toContain("big:ghost");
      expectNoSilentGap(harness, runId, units, [...many, other].map((task) => task.taskId));
    } finally { harness.cp.close(); }
  }, 60_000);

  it("a cancelled task's title and a mapped task's title never place the unit's tail (#1410 r3, r4)", async () => {
    const { harness, runId } = await prepare();
    try {
      // r3: the tail's key is `u200`, its title is not, and a superseded task kept `u200`.
      // r4: the FIRST task's title is `u200`, and the PLAN names the first 200 by id and the tail by key.
      const many = submit(harness, runId, Array.from({ length: 201 }, (_, i) => ({ key: `u${i}`, title: i === 0 ? "u200" : i === 200 ? "actual tail task" : `u${i}` })));
      const [old] = submit(harness, runId, [{ key: "old", title: "u200" }]);
      harness.cp.db.run(`UPDATE tasks SET state = 'CANCELLED' WHERE task_id = ?`, [old!.taskId]);
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [{ key: "big", tasks: [...many.slice(0, 200).map((task) => task.taskId), "u200"] }] });
      approve(harness, runId, stored.digest, [{ unit: "big", taskIds: many.map((task) => task.taskId) }]);
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(many.slice(0, 200).every((task) => units.byTask.get(task.taskId) === "big")).toBe(true);
      expect(units.byTask.has(old!.taskId)).toBe(false);
      expect(units.byTask.has(many[200]!.taskId)).toBe(false);
      expect(units.unresolvedRefs).toEqual(["big:u200"]);
      expectNoSilentGap(harness, runId, units, many.map((task) => task.taskId));
    } finally { harness.cp.close(); }
  }, 60_000);

  it("two capped units with crossed tail titles keep both tails unmapped instead of swapping them (#1410 r5)", async () => {
    const { harness, runId } = await prepare();
    try {
      const xs = submit(harness, runId, Array.from({ length: 201 }, (_, i) => ({ key: `x${i}`, title: i === 200 ? "tail-y" : `x${i}` })));
      const ys = submit(harness, runId, Array.from({ length: 201 }, (_, i) => ({ key: `y${i}`, title: i === 200 ? "tail-x" : `y${i}` })));
      // Each unit names its first 200 tasks by id and its tail by key.
      const stored = harness.cp.artifacts.put(runId, "PLAN", { workUnits: [
        { key: "unit-x", tasks: [...xs.slice(0, 200).map((task) => task.taskId), "tail-x"] },
        { key: "unit-y", tasks: [...ys.slice(0, 200).map((task) => task.taskId), "tail-y"] }] });
      approve(harness, runId, stored.digest, [{ unit: "unit-x", taskIds: xs.map((task) => task.taskId) }, { unit: "unit-y", taskIds: ys.map((task) => task.taskId) }]);
      const units = workUnitsOf(harness.cp.db, runId, taskRows(harness, runId));
      expect(xs.slice(0, 200).every((task) => units.byTask.get(task.taskId) === "unit-x")).toBe(true);
      expect(ys.slice(0, 200).every((task) => units.byTask.get(task.taskId) === "unit-y")).toBe(true);
      // No task is in a unit it was not approved or id-referenced into: neither tail is in either unit.
      expect(units.byTask.has(xs[200]!.taskId)).toBe(false);
      expect(units.byTask.has(ys[200]!.taskId)).toBe(false);
      expect(units.unresolvedRefs).toEqual(["unit-x:tail-x", "unit-y:tail-y"]);
      expectNoSilentGap(harness, runId, units, [...xs, ...ys].map((task) => task.taskId));
    } finally { harness.cp.close(); }
  }, 120_000);
});
