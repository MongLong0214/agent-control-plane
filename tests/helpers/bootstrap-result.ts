import { vi } from "vitest";

import type { RunState } from "../../src/domain/types.ts";
import type { BootstrapRuntimeFixture } from "./bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys } from "./bootstrap-plan.ts";
import { reviewerPass, reviewerRevise } from "./harness.ts";

/**
 * The provider a project-less bootstrap run's result path reaches, scripted for the bootstrap runtime
 * fixture: the harness's reviewer answers the BOOTSTRAP_PLAN review the pipeline asks for inside
 * `result_submit`. Nothing here writes a review, touches a task or moves a run; the owner's tools and
 * the pipeline do. No worker is staffed: the PLAN's task stays READY until CEO CONFIRM settles it.
 */

/**
 * The scripted reviewer answers the run under review — the one whose candidate pipeline attempt is
 * running, read when the review is asked — covering exactly what its current PLAN plans: PASS, or
 * REVISE. With `hold`, each review waits for it first, so a row can act while the review is in progress.
 */
export const passBootstrapPlanReviews = (
  f: BootstrapRuntimeFixture,
  options: { verdict?: "PASS" | "REVISE"; hold?: Promise<void> } = {},
): { asked: () => number } => {
  const scripted = f.harness.scripted;
  const invoke = scripted.invoke.bind(scripted);
  let asked = 0;
  vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
    if (/Bootstrap plan review/.test(request.prompt)) {
      asked += 1;
      if (options.hold) await options.hold;
      const reviewing = f.harness.cp.db.all<{ run_id: string }>(
        `SELECT run_id FROM candidate_pipeline_attempts WHERE state = 'RUNNING' ORDER BY started_at`,
      );
      for (const { run_id: runId } of reviewing) {
        const keys = bootstrapCoverageKeys(f.harness, runId);
        scripted.script({
          match: /Bootstrap plan review/,
          text: options.verdict === "REVISE" ? reviewerRevise(keys, "revise the bootstrap plan") : reviewerPass(keys),
        });
      }
    }
    return invoke(request);
  });
  return { asked: () => asked };
};

/** The run's state, its current candidate, and whether a candidate pipeline attempt is running for it. */
export const resultState = (f: BootstrapRuntimeFixture, runId: string) => ({
  state: f.harness.cp.runs.require(runId).state as RunState,
  candidate: f.harness.cp.runs.currentCandidate(runId),
  attempts: f.harness.cp.db.all<{ state: string }>(
    `SELECT state FROM candidate_pipeline_attempts WHERE run_id = ?`,
    [runId],
  ).map((row) => row.state),
});
