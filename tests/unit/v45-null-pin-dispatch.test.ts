import { afterAll, describe, expect, it } from "vitest";

import { RunKind, RunState } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { createRun, firstManifest, operatorRegisteredProject, rawFirstActivation } from "../helpers/first-activation.ts";
import { makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #512 (v45), CEO 1edb842a and design E7 — what dispatch does with a run whose pin is still NULL once
 * its project's first activation has set M1.
 *
 * - A9-a: a run with no history (created while the project was NULL, never dispatched, no PLAN,
 *   candidate, review, approval or execution) is pinned to M1 at dispatch, in the same write that
 *   makes it ACTIVE, and the dispatch records that this was its first pin.
 * - A9-b: an ordinary run with history under the NULL pin is refused on re-dispatch with a named
 *   reason; its pin stays NULL and nothing earlier is reused.
 * - A9: the same for a NULL-pinned CONTRACT_CHANGE dispatched earlier; it continues only by cancel
 *   and a new run.
 *
 * The activation itself is written with the raw handle (`rawFirstActivation`): it is the
 * precondition here, not what is measured. RED at A0's head: there is no first-activation table, so
 * no project can leave NULL, and today's COALESCE would pin the A9/A9-b runs to M1.
 */

/** Drives a dispatched run back to REVISION_REQUIRED the way a CEO FINAL_REVISE leaves it. */
const toRevisionRequired = (h: Harness, runId: string): void => {
  for (const state of [RunState.READY_FOR_CEO_REVIEW, RunState.REVISION_REQUIRED]) {
    const moved = h.cp.runs.transition(runId, state, "a revision under the NULL pin", {});
    if (!moved.allowed) throw new Error(`${moved.reasonCode}: ${moved.message}`);
  }
};

const activateM1 = async (h: Harness, project: Awaited<ReturnType<typeof operatorRegisteredProject>>): Promise<string> => {
  const first = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE);
  return rawFirstActivation(h, {
    projectId: project.projectId,
    runId: first.runId,
    registrationEventId: project.registrationEventId,
    manifest: firstManifest(project.projectId),
  });
};

const dispatchedAudits = (h: Harness, runId: string) => h.cp.audit.forRun(runId).filter((entry) => entry.kind === "DISPATCHED");

describe("A9-a: an ordinary run with no history takes M1 as its first pin, atomically, at dispatch", () => {
  it("created while NULL, dispatched after the first activation: pinned M1, the dispatch names it the first pin, planning reads M1", async () => {
    const h = makeHarness();
    const project = await operatorRegisteredProject(h, "a9a-first-pin");
    const run = await createRun(h, project.projectId, RunKind.STANDARD_WORK, { dispatch: false });
    expect(run).toMatchObject({ state: RunState.QUEUED, pinnedManifestDigest: null, dispatchedAt: null });
    const m1 = await activateM1(h, project);

    const dispatched = await h.cp.runs.dispatch(run.runId);
    expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ allowed: true, value: { state: RunState.ACTIVE, pinnedManifestDigest: m1 } });
    expect(dispatchedAudits(h, run.runId).map((entry) => entry.evidence)).toEqual([
      expect.objectContaining({ pinnedManifestDigest: m1, manifestPin: { firstPin: true, from: null, to: m1 } }),
    ]);
    // Planning starts from that digest: the owner's contract view is M1's.
    const contract = createCtoMcpPort(h.cp).contractForRun(run.runId) as { pinnedManifestDigest: string | null; verificationCommands: Array<{ id: string }> };
    expect(contract.pinnedManifestDigest).toBe(m1);
    expect(contract.verificationCommands.map((command) => command.id)).toEqual(firstManifest(project.projectId).verificationCommands.map((command) => command.id));
  });

  it("a QUEUED CONTRACT_CHANGE created while NULL becomes an ordinary contract change of M1 at its first dispatch", async () => {
    const h = makeHarness();
    const project = await operatorRegisteredProject(h, "a9a-cc-first-pin");
    const run = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE, { dispatch: false });
    const m1 = await activateM1(h, project);
    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({ allowed: true, value: { pinnedManifestDigest: m1 } });
  });
});

describe("A9-b: an ordinary run with history under the NULL pin is refused, not re-pinned", () => {
  it("re-dispatch from REVISION_REQUIRED after the first activation is refused with a named reason; the pin stays NULL", async () => {
    const h = makeHarness();
    const project = await operatorRegisteredProject(h, "a9b-history");
    const run = await createRun(h, project.projectId, RunKind.STANDARD_WORK);
    expect(run.pinnedManifestDigest).toBeNull();
    const planned = createCtoMcpPort(h.cp).submitPlan(run.runId, { summary: "a plan made under no manifest" });
    expect(planned.allowed, JSON.stringify(planned)).toBe(true);
    toRevisionRequired(h, run.runId);
    const m1 = await activateM1(h, project);
    const before = dispatchedAudits(h, run.runId).length;

    const refused = await h.cp.runs.dispatch(run.runId);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_PIN_SUPERSEDED",
      evidence: {
        refusal: "NULL_PIN_HAS_HISTORY",
        pinnedManifestDigest: null,
        active: m1,
        history: ["DISPATCHED", "PLAN"],
        recovery: "CANCEL_AND_REPLAN",
      },
    });
    expect(h.cp.runs.require(run.runId)).toMatchObject({ state: RunState.REVISION_REQUIRED, pinnedManifestDigest: null });
    expect(dispatchedAudits(h, run.runId)).toHaveLength(before);
  });

  it("while the project is still NULL, the same re-dispatch proceeds as before and the pin stays NULL", async () => {
    const h = makeHarness();
    const project = await operatorRegisteredProject(h, "a9b-still-null");
    const run = await createRun(h, project.projectId, RunKind.STANDARD_WORK);
    toRevisionRequired(h, run.runId);
    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({ allowed: true, value: { state: RunState.ACTIVE, pinnedManifestDigest: null } });
  });
});

describe("A9: a NULL-pinned CONTRACT_CHANGE dispatched earlier is refused after another run activated M1", () => {
  it("refused on re-dispatch, its pin stays NULL, and it continues only by cancel and a new run, which pins M1", async () => {
    const h = makeHarness();
    const project = await operatorRegisteredProject(h, "a9-cc");
    const run = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE);
    toRevisionRequired(h, run.runId);
    const m1 = await activateM1(h, project);

    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_PIN_SUPERSEDED",
      evidence: { refusal: "NULL_PIN_CONTRACT_CHANGE_SUPERSEDED", pinnedManifestDigest: null, active: m1, history: ["DISPATCHED"] },
    });
    expect(h.cp.runs.require(run.runId)).toMatchObject({ state: RunState.REVISION_REQUIRED, pinnedManifestDigest: null });

    expect(h.cp.runs.transition(run.runId, RunState.CANCELLED, "superseded by the first activation", {}).allowed).toBe(true);
    const next = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE);
    expect(next.pinnedManifestDigest).toBe(m1);
  });
});
