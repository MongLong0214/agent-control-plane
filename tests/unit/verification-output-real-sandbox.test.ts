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
/** Runs one STANDARD candidate through the pipeline with `print.js` as its only official command. */
const runPrinting = async (printJs: string, overrides: { maxOutputBytes?: number } = {}) => {
  const harness = makeHarness();
  writeFiles(harness.repoPath, { "print.js": printJs });
  commitAll(harness.repoPath, "a command that prints credential shapes");
  const command = { ...fixtureManifest("x").verificationCommands[0]!, id: "print", argv: ["node", "print.js"], ...overrides };
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
  return { harness, outcome, stored };
};

it("an official sandbox run's credential-shaped output is redacted before storage and before review", async (ctx) => {
  if (!seatbeltStatus().applies) requireSeatbelt(ctx);
  const { harness, outcome, stored } = await runPrinting([
    "console.log('Tests 3 passed');",
    `console.log(${JSON.stringify(GITHUB_TOKEN_SHAPE)});`,
    `console.log(${JSON.stringify(LONG_BASE64)});`,
    `console.error(${JSON.stringify(`key=${EMBEDDED}== in a line`)});`,
  ].join("\n") + "\n");
  try {
    expect(stored?.results[0], JSON.stringify(outcome)).toMatchObject({ commandId: "print", source: "local", status: "PASS",
      enforcement: { mechanism: "seatbelt" } });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });

    // The host can add its own lines to the candidate's streams (a macOS runner's xcrun stub warns on
    // stderr inside seatbelt), so the excerpt is held to what the command printed, not to the whole stream.
    const excerpt = stored!.results[0]!.output!;
    expect(excerpt).toMatchObject({ redacted: true, truncated: false, boundaryFragmentWithheld: false });
    expect(excerpt.stdout).toContain("Tests 3 passed\n[redacted]\n[redacted]\n");
    expect(excerpt.stderr).toContain("key=[redacted] in a line\n");
    const prompt = harness.scripted.invocations.find((call) => call.prompt.startsWith("# Candidate review"))!.prompt;
    expect(prompt).toContain("Tests 3 passed");
    expect(prompt).toContain("key=[redacted] in a line");
    for (const secret of [GITHUB_TOKEN_SHAPE, LONG_BASE64, EMBEDDED.slice(0, 16)]) {
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(prompt).not.toContain(secret);
    }
  } finally { harness.cp.close(); }
}, 120_000);

/**
 * #1223 P1-B in the real sandbox: with maxOutputBytes 1024, 965 bytes ending in whitespace and then a
 * 60-character base64 run leave 59 of its characters at the capture cut, too few for the shape. The
 * failed run's stored excerpt withholds that fragment and says so.
 */
it("a capture cut through a credential keeps no fragment of it in the stored excerpt", async (ctx) => {
  if (!seatbeltStatus().applies) requireSeatbelt(ctx);
  const run = `${"Ab9+/Zq7".repeat(7)}Ab9+`;
  const { harness, outcome, stored } = await runPrinting(
    `process.stdout.write(${JSON.stringify(`${"x ".repeat(482)} ${run}\nafter the cut\n`)});\n`, { maxOutputBytes: 1024 });
  try {
    const result = stored?.results[0];
    expect(result, JSON.stringify(outcome)).toMatchObject({ commandId: "print", source: "local", outputTruncated: true,
      enforcement: { mechanism: "seatbelt" } });
    expect(result!.status).not.toBe("PASS");
    expect(result!.output).toMatchObject({ boundaryFragmentWithheld: true, redacted: false });
    expect(result!.output!.stdout.endsWith("x  ")).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(run.slice(0, 8));
  } finally { harness.cp.close(); }
}, 120_000);
