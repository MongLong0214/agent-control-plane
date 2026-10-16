import { afterAll, describe, expect, it } from "vitest";

import { ArtifactKind, Role } from "../../src/domain/types.ts";
import type { ReviewerEgressProbe, ReviewerEgressRecord } from "../../src/runtime/provider.ts";
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

type Reviewer = ReturnType<typeof harnessFor>["reviewer"];

const scriptPass = (harness: ReturnType<typeof harnessFor>["harness"], reviewer: Reviewer, identity: string): void => {
  // driveToReviewedCandidate scripts the harness's own reviewer; a GPT double needs its own answer.
  if (reviewer !== harness.scripted) {
    reviewer.script({ match: /Candidate review/, text: reviewerPass([`${identity}:src/app.js`]) });
  }
};

/** Rewrites only the direct-socket probes the reviewer returns; returns every probe it sent. */
const rewriteDirectProbes = (
  reviewer: Reviewer,
  rewrite: (probe: ReviewerEgressProbe) => ReviewerEgressProbe,
): ReviewerEgressProbe[] => {
  const sent: ReviewerEgressProbe[] = [];
  const invoke = reviewer.invoke.bind(reviewer);
  reviewer.invoke = async (request) => {
    const result = await invoke(request);
    if (!result.egressEvidence) return result;
    return {
      ...result,
      egressEvidence: result.egressEvidence.map((record) => ({
        ...record,
        probes: {
          ...record.probes,
          directSocket: record.probes.directSocket.map((probe) => {
            const rewritten = rewrite(probe);
            sent.push(rewritten);
            return rewritten;
          }),
        },
      })),
    };
  };
  return sent;
};

describe("runtime-shaped reviewer egress evidence is persisted by the blind-review gate", () => {
  for (const { provider, model } of GATES) {
    it(`stores a ${provider} BLIND_REVIEW whose direct-socket probes carry indeterminate: false`, async () => {
      const { harness, reviewer } = harnessFor(provider, model);
      try {
        const project = await registerFixtureProject(harness);
        scriptPass(harness, reviewer, project.identity);
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

    it(`stores a ${provider} BLIND_REVIEW from legacy probes that carry no indeterminate field`, async () => {
      const { harness, reviewer } = harnessFor(provider, model);
      try {
        const project = await registerFixtureProject(harness);
        scriptPass(harness, reviewer, project.identity);
        rewriteDirectProbes(reviewer, ({ indeterminate: _legacy, ...probe }) => probe);
        const reviewed = await driveToReviewedCandidate(harness, { registeredProject: project });
        const stored = harness.cp.artifacts.latest<{ egressEvidence: ReviewerEgressRecord[] }>(
          reviewed.runId,
          ArtifactKind.BLIND_REVIEW,
        );
        const probes = (stored?.content.egressEvidence ?? []).flatMap((record) => record.probes.directSocket);
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) expect("indeterminate" in probe).toBe(false);
      } finally {
        harness.cp.close();
      }
    });

    for (const [shape, rewrite] of [
      // R2: everything else still claims a sandbox refusal; only the indeterminate flag says otherwise.
      ["only indeterminate set to true", (probe: ReviewerEgressProbe) => ({ ...probe, indeterminate: true })],
      // The runtime's shape for a socket that neither opened nor was refused.
      ["the runtime's indeterminate shape", (probe: ReviewerEgressProbe) => ({
        ...probe, connected: false, blocked: false, indeterminate: true, errorCode: null,
      })],
    ] as const) {
      it(`refuses a ${provider} review whose direct-socket probes have ${shape}`, async () => {
        const { harness, reviewer } = harnessFor(provider, model);
        try {
          const project = await registerFixtureProject(harness);
          scriptPass(harness, reviewer, project.identity);
          const sent = rewriteDirectProbes(reviewer, rewrite);
          await expect(driveToReviewedCandidate(harness, { registeredProject: project }))
            .rejects.toThrow("ISOLATION_LOST: reviewer egress evidence is incomplete or unsafe");
          expect(sent.length).toBeGreaterThan(0);
          for (const probe of sent) {
            expect(probe.indeterminate).toBe(true);
            if (shape === "only indeterminate set to true") {
              expect(probe).toMatchObject({ connected: false, blocked: true, errorCode: "EPERM" });
            }
          }
          const runs = harness.cp.db.all<{ run_id: string }>("SELECT run_id FROM runs");
          expect(runs.length).toBeGreaterThan(0);
          for (const { run_id } of runs) {
            expect(harness.cp.artifacts.latest(run_id, ArtifactKind.BLIND_REVIEW)).toBeNull();
          }
        } finally {
          harness.cp.close();
        }
      });
    }
  }
});
