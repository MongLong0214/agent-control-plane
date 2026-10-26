import { afterAll, expect, it } from "vitest";

import { ExecutionMode } from "../../src/domain/types.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { requireSeatbelt, seatbeltStatus } from "../helpers/seatbelt.ts";

afterAll(cleanupTempDirs);

const GITHUB_TOKEN_SHAPE = `ghp_${"A1b2C3d4".repeat(5)}`;
const LONG_BASE64 = "Ab9+/Zq7".repeat(10);
const EMBEDDED = "Kx7/Lp2+".repeat(9);

/**
 * #1223 P1 on the changed output path only: the official verification command runs in the real
 * seatbelt sandbox (no stand-in for `runSandboxed`), prints credential-shaped strings, and neither
 * the stored VERIFICATION excerpt nor the reviewer's input carries them.
 */
it("an official sandbox run's credential-shaped output is redacted before storage and before review", async (ctx) => {
  if (!seatbeltStatus().applies) requireSeatbelt(ctx);
  const harness = makeHarness();
  try {
    writeFiles(harness.repoPath, { "print.js": [
      "console.log('Tests 3 passed');",
      `console.log(${JSON.stringify(GITHUB_TOKEN_SHAPE)});`,
      `console.log(${JSON.stringify(LONG_BASE64)});`,
      `console.error(${JSON.stringify(`key=${EMBEDDED}== in a line`)});`,
    ].join("\n") + "\n" });
    commitAll(harness.repoPath, "a command that prints credential shapes");
    const command = { ...fixtureManifest("x").verificationCommands[0]!, id: "print", argv: ["node", "print.js"] };
    const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", {
      verificationCommands: [command], verificationProfiles: { simple: ["print"], standard: ["print"], guarded: ["print"] },
    });
    bindCeo(harness);
    const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"],
        priority: "NORMAL", humanGate: [], references: [] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const run = dispatched.value;
    const tasks = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
    if (!tasks.allowed) throw new Error(tasks.message);
    const task = harness.cp.tasks.ready(run.runId)[0]!;
    const execution = harness.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: bindWorker(harness, task.taskId),
      provider: "scripted", model: "scripted-worker", repositoryId });
    if (!execution.allowed) throw new Error(execution.message);
    const head = applyPassingChange(harness.repoPath);
    harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS",
      coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });

    const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2", recommendation: "merge" });
    const stored = harness.cp.artifacts.list<VerificationReport>(run.runId, "VERIFICATION").at(-1)?.content;
    expect(stored?.results[0], JSON.stringify(outcome)).toMatchObject({ commandId: "print", source: "local", status: "PASS",
      enforcement: { mechanism: "seatbelt" } });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });

    const excerpt = stored!.results[0]!.output!;
    expect(excerpt).toMatchObject({ redacted: true, truncated: false, stdout: "Tests 3 passed\n[redacted]\n[redacted]\n",
      stderr: "key=[redacted] in a line\n" });
    const prompt = harness.scripted.invocations.find((call) => call.prompt.startsWith("# Candidate review"))!.prompt;
    expect(prompt).toContain("Tests 3 passed");
    for (const secret of [GITHUB_TOKEN_SHAPE, LONG_BASE64, EMBEDDED.slice(0, 16)]) {
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(prompt).not.toContain(secret);
    }
  } finally { harness.cp.close(); }
}, 120_000);
