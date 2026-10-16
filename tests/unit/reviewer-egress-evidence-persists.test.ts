import { afterAll, describe, expect, it } from "vitest";

import { ArtifactKind, Role } from "../../src/domain/types.ts";
import type { ReviewerEgressRecord } from "../../src/runtime/provider.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * The live direct-socket probe always reports `indeterminate`, as `false` when the sandbox
 * refused the socket. The strict BLIND_REVIEW probe schema did not name that field, so a
 * reviewer that answered behind a finalised egress lease was refused at the artifact write
 * with "BLIND_REVIEW has an invalid evidence envelope". Test evidence that omitted the field
 * hid it. These carry a runtime-shaped probe set through the gate's artifact storage.
 */
const GATES = [
  { provider: "scripted", model: "scripted-reviewer" },
  { provider: "gpt", model: "gpt-6.1-sol" },
] as const;

const harnessFor = (provider: (typeof GATES)[number]["provider"], model: string) => {
  const harness = makeHarness(provider === "scripted"
    ? {}
    : { reviewer: { preferred: { provider, model, effort: "xhigh" }, fallbacks: [] } });
  const reviewer = provider === "scripted" ? harness.scripted : new TestProductionAdapter(harness.clock, provider);
  if (reviewer !== harness.scripted) harness.cp.providers.registerForRole(reviewer, Role.BLIND_REVIEWER);
  return { harness, reviewer };
};

describe("runtime-shaped reviewer egress evidence is persisted by the blind-review gate", () => {
  for (const { provider, model } of GATES) {
    it(`stores a ${provider} BLIND_REVIEW whose direct-socket probes carry indeterminate: false`, async () => {
      const { harness, reviewer } = harnessFor(provider, model);
      try {
        const project = await registerFixtureProject(harness);
        if (reviewer !== harness.scripted) {
          reviewer.script({ match: /Candidate review/, text: reviewerPass([`${project.identity}:src/app.js`]) });
        }
        const reviewed = await driveToReviewedCandidate(harness, { registeredProject: project });
        const stored = harness.cp.artifacts.latest<{ egressEvidence: ReviewerEgressRecord[] }>(
          reviewed.runId,
          ArtifactKind.BLIND_REVIEW,
        );
        const records = stored?.content.egressEvidence ?? [];
        expect(records.map((record) => record.provider)).toContain(provider);
        for (const record of records) {
          expect(record.probes.directSocket.length).toBeGreaterThan(0);
          for (const probe of record.probes.directSocket) {
            expect(probe).toMatchObject({ connected: false, blocked: true, indeterminate: false });
          }
        }
      } finally {
        harness.cp.close();
      }
    });

    it(`still refuses a ${provider} review whose direct-socket probe was indeterminate`, async () => {
      const { harness, reviewer } = harnessFor(provider, model);
      try {
        const project = await registerFixtureProject(harness);
        if (reviewer !== harness.scripted) {
          reviewer.script({ match: /Candidate review/, text: reviewerPass([`${project.identity}:src/app.js`]) });
        }
        const invoke = reviewer.invoke.bind(reviewer);
        reviewer.invoke = async (request) => {
          const result = await invoke(request);
          return {
            ...result,
            ...(result.egressEvidence
              ? {
                egressEvidence: result.egressEvidence.map((record) => ({
                  ...record,
                  probes: {
                    ...record.probes,
                    // The runtime's shape for a socket that neither opened nor was refused.
                    directSocket: record.probes.directSocket.map((probe) => ({
                      ...probe, connected: false, blocked: false, indeterminate: true, errorCode: null,
                    })),
                  },
                })),
              }
              : {}),
          };
        };
        // Refused by the gate's direct-socket check before any artifact write, as before the
        // schema named the field: an indeterminate socket is never proof of the boundary.
        await expect(driveToReviewedCandidate(harness, { registeredProject: project }))
          .rejects.toThrow("ISOLATION_LOST: reviewer egress evidence is incomplete or unsafe");
        const runs = harness.cp.db.all<{ run_id: string }>("SELECT run_id FROM runs");
        for (const { run_id } of runs) {
          expect(harness.cp.artifacts.latest(run_id, ArtifactKind.BLIND_REVIEW)).toBeNull();
        }
      } finally {
        harness.cp.close();
      }
    });
  }
});
