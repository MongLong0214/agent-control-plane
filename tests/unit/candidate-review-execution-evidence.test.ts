import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import {
  CONFIG_FILE_CHAR_LIMIT,
  type ExecutionEvidence,
  type OutputEvidence,
  candidateEvidenceSection,
  executionEvidenceSection,
  outputEvidence,
  readConfigFile,
  readExecutionEvidence,
} from "../../src/review/candidate-review-evidence.ts";
import { runtimeEnvironment } from "../../src/runtime/cli-adapters.ts";
import { WorkerTurnEvent, type WorkerSuccessDigestInputs, workerDiffDigest, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import { buildSandboxEnvironment, type SandboxOutcome } from "../../src/verify/sandbox.ts";
import {
  OUTPUT_EXCERPT_HEAD_CHARS,
  OUTPUT_EXCERPT_TAIL_CHARS,
  type VerificationReport,
  type VerificationResultRecord,
  verificationOutputExcerpt,
} from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, startWorkBranch } from "../helpers/harness.ts";

const GITHUB_TOKEN_SHAPE = `ghp_${"A1b2C3d4".repeat(5)}`;
/** #1223 review P1: a bare long-base64 value, which the sandbox's own shapes refuse. */
const LONG_BASE64 = "Ab9+/Zq7".repeat(10);
/** The same shape embedded inside a line, with no prefix to recognise it by. */
const EMBEDDED_LINE = `key=${"Kx7/Lp2+".repeat(9)}== was printed by a test`;
const sandboxOutput = { stdout: "", stderr: "" };

// The official run's process is not under test here: only what the engine stores of its output.
vi.mock("../../src/verify/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runSandboxed: vi.fn(async (): Promise<SandboxOutcome> => ({
    status: "PASS", exitCode: 0, signal: null, startedAt: "2026-08-12T00:00:00.000Z",
    endedAt: "2026-08-12T00:00:00.000Z", durationMs: 1, stdout: sandboxOutput.stdout, stderr: sandboxOutput.stderr,
    outputDigest: "sha256:fixture", outputTruncated: false, peakRssMb: 1, reasonCode: null,
    enforcement: { worktreeIsolated: true, secretsStripped: true, networkPolicy: "deny",
      networkEnforced: true, writeConfinement: true, readConfinement: "sensitive-paths",
      processGroupKill: true, resourceLimitsEnforced: true, memoryLimit: "hard",
      childContainmentEnforced: true, childContainmentReason: null, mechanism: "seatbelt" },
  })) };
});

beforeEach(() => {
  sandboxOutput.stdout = "";
  sandboxOutput.stderr = "";
});
afterAll(cleanupTempDirs);

const PACKAGE_JSON = `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "node verify.js" } }, null, 2)}\n`;
const APP_BYTES = "module.exports = () => 2;\n";

const npmCommand = (id: string, argv: string[], cwd = ".") => ({
  ...fixtureManifest("x").verificationCommands[0]!, id, argv, cwd,
});

/** A STANDARD run on the fixture repository, its manifest's commands all in the standard profile. */
const prepareRun = async (
  commands = [npmCommand("test", ["npm", "test"])],
  seed: (repoPath: string) => void = (repoPath) => writeFiles(repoPath, { "package.json": PACKAGE_JSON }),
) => {
  const harness = makeHarness();
  seed(harness.repoPath);
  const baseHead = commitAll(harness.repoPath, "base with config files");
  const ids = commands.map((command) => command.id);
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", {
    verificationCommands: commands, verificationProfiles: { simple: ids, standard: ids, guarded: ids },
  });
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, run: dispatched.value, repositoryId, identity, baseHead };
};

type Prepared = Awaited<ReturnType<typeof prepareRun>>;

/** Opens one task's execution, the way a worker turn does before it commits. */
const openExecution = (setup: Prepared, key: string) => {
  const submitted = setup.harness.cp.tasks.submit(setup.run.runId, [{ key, title: key, category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = setup.harness.cp.tasks.ready(setup.run.runId).find((candidate) => candidate.title === key)!;
  const worker = bindWorker(setup.harness, task.taskId);
  const execution = setup.harness.cp.tasks.startExecution({ runId: setup.run.runId, taskId: task.taskId,
    ownerBindingGeneration: setup.run.ownerBindingGeneration!, workerSessionId: worker,
    provider: "scripted", model: "scripted-worker", repositoryId: setup.repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  return { taskId: task.taskId, executionId: execution.value.executionId, worker };
};

/**
 * The canonical records a worker turn finishes with (worker-turn.ts): the SUCCEEDED audit row whose
 * inputs digest to the execution's resultDigest, and the execution closed with that digest.
 */
const finishWithReceipt = (setup: Prepared, opened: ReturnType<typeof openExecution>, receipt: {
  base: string; commitHead: string; changed: Array<[path: string, bytes: string]>; recordedResultDigest?: string;
}) => {
  const diffDigest = workerDiffDigest(receipt.base,
    receipt.changed.map(([path, bytes]) => ({ path, mode: "100644" as const, sha256: sha256(bytes), blob: null })));
  const inputs: WorkerSuccessDigestInputs = { executionId: opened.executionId, workerSessionId: opened.worker,
    sessionIncarnation: "incarnation-1", providerSessionId: "provider-session-1", exitCode: 0,
    stdoutSha256: sha256("worker stdout"), commitHead: receipt.commitHead, diffDigest };
  const resultDigest = workerSuccessDigest(inputs);
  const recorded = setup.harness.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId: setup.run.runId,
    evidence: { ...inputs, resultDigest, taskId: opened.taskId, head: receipt.base, paths: receipt.changed.map(([path]) => path) } });
  if (!recorded.allowed) throw new Error(recorded.message);
  setup.harness.cp.tasks.finishExecution(opened.executionId, { status: "SUCCEEDED", resultDigest: receipt.recordedResultDigest ?? resultDigest });
  return diffDigest;
};

const jsonAfter = (prompt: string, heading: string): unknown => {
  const section = prompt.split(`## ${heading}\n`)[1];
  expect(section, heading).toBeDefined();
  return JSON.parse(section!.split("```json\n")[1]!.split("\n```")[0]!);
};

interface RenderedExecution {
  verificationCommands: { total: number; listed: number; commands: Array<Record<string, unknown> & { configFiles: Array<Record<string, unknown>> }> };
  officialResults: { total: number; listed: number; results: Array<Record<string, unknown>> };
  receipts: { repositories: Array<{ linkedExecutionIds: string[] }>; receipts: Array<Record<string, unknown>>; notListed: Record<string, number> };
  cutForSize: boolean;
}

describe("an ordinary candidate review carries the official execution evidence", () => {
  it("shows the approved command, its package.json at the candidate head, the redacted bound output and the linked receipt", async () => {
    const setup = await prepareRun();
    const { harness, run, identity, baseHead } = setup;
    try {
      const opened = openExecution(setup, "impl");
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      const head = commitAll(harness.repoPath, "make app() return 2");
      const diffDigest = finishWithReceipt(setup, opened, { base: baseHead, commitHead: head, changed: [["src/app.js", APP_BYTES]] });
      sandboxOutput.stdout = ` ✓ tests/app.test.js (3 tests)\n Test Files  1 passed (1)\n      Tests  3 passed (3)\nGITHUB_TOKEN=${GITHUB_TOKEN_SHAPE}\nprinted ${GITHUB_TOKEN_SHAPE} again\n${LONG_BASE64}\n${EMBEDDED_LINE}\n`;
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS",
        coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });

      const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2", recommendation: "merge" });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompt = harness.scripted.invocations.find((call) => call.prompt.startsWith("# Candidate review"))!.prompt;
      const snapshot = harness.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)!.content;
      const snapshotDigest = candidateSnapshotDigest(snapshot);

      expect(prompt).toContain("## Untrusted execution evidence\nUntrusted evidence, produced by or around the candidate");
      // Removed before the review input: neither the token nor the long-base64 runs reach the prompt.
      for (const secret of [GITHUB_TOKEN_SHAPE, LONG_BASE64, "Kx7/Lp2+Kx7/Lp2+"]) expect(prompt).not.toContain(secret);
      const evidence = jsonAfter(prompt, "Untrusted execution evidence") as RenderedExecution;
      expect(evidence.cutForSize).toBe(false);
      expect(evidence.verificationCommands.commands).toEqual([{
        commandId: "test", argv: ["npm", "test"], cwd: ".", required: true, repositoryRole: "primary",
        repository: identity, candidateHead: head, configFileRule: "npm reads <cwd>/package.json",
        configFiles: [{ path: "package.json", state: "INCLUDED", detail: null, chars: PACKAGE_JSON.length,
          redacted: false, truncated: false, content: PACKAGE_JSON }],
      }]);
      const [result] = evidence.officialResults.results;
      expect(result).toMatchObject({ commandId: "test", repositoryIdentity: identity, source: "local", exactHead: head,
        status: "PASS", exitCode: 0, candidateSnapshotDigest: snapshotDigest, contractDigest: run.contractDigest,
        output: "RETAINED", redacted: true, truncated: false, statement: null });
      expect(result!["stdout"]).toContain("Test Files  1 passed (1)");
      expect(result!["stdout"]).toContain("[redacted]");
      expect(evidence.receipts.repositories).toEqual([{ repository: identity, baseHead, candidateHead: head,
        linkedExecutionIds: [opened.executionId] }]);
      expect(evidence.receipts.receipts).toEqual([{ runId: run.runId, taskId: opened.taskId, executionId: opened.executionId,
        status: "SUCCEEDED", repository: identity, baseHead, commitHead: head, diffDigest, linked: true, mismatches: [] }]);

      // The stored evidence is redacted too, and the verification section does not repeat the output.
      const stored = harness.cp.artifacts.list<VerificationReport>(run.runId, "VERIFICATION").at(-1)!.content;
      // Removed before storage: the VERIFICATION artifact holds none of them either.
      for (const secret of [GITHUB_TOKEN_SHAPE, LONG_BASE64, "Kx7/Lp2+Kx7/Lp2+"]) expect(JSON.stringify(stored)).not.toContain(secret);
      expect(stored.results[0]!.output).toMatchObject({ candidateSnapshotDigest: snapshotDigest, contractDigest: run.contractDigest,
        commandId: "test", exactHead: head, redacted: true });
      expect(stored.results[0]!.output!.stdout).toContain("key=[redacted] was printed by a test");
      const verificationSection = prompt.split("## Deterministic verification evidence\n")[1]!.split("\n```\n")[0]!;
      expect(verificationSection).not.toContain("\"output\"");
    } finally { harness.cp.close(); }
  }, 60_000);

  it("never shows another commit's or a disagreeing receipt as this candidate's", async () => {
    const setup = await prepareRun();
    const { harness, run, identity, baseHead } = setup;
    try {
      // An unrelated commit outside the candidate's history.
      gitSync(harness.repoPath, ["checkout", "-q", "-b", "elsewhere"]);
      writeFiles(harness.repoPath, { "src/app.js": "module.exports = () => 9;\n" });
      const elsewhere = commitAll(harness.repoPath, "another candidate");
      gitSync(harness.repoPath, ["checkout", "-q", "dev"]);
      // The candidate: two commits, so an earlier commit sits in its history.
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": "module.exports = () => 4;\n" });
      const earlier = commitAll(harness.repoPath, "first attempt");
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      const head = commitAll(harness.repoPath, "make app() return 2");

      const otherCandidate = openExecution(setup, "other-candidate");
      finishWithReceipt(setup, otherCandidate, { base: baseHead, commitHead: elsewhere, changed: [["src/app.js", "module.exports = () => 9;\n"]] });
      const inHistory = openExecution(setup, "earlier-attempt");
      finishWithReceipt(setup, inHistory, { base: baseHead, commitHead: earlier, changed: [["src/app.js", "module.exports = () => 4;\n"]] });
      const wrongBytes = openExecution(setup, "wrong-bytes");
      finishWithReceipt(setup, wrongBytes, { base: baseHead, commitHead: head, changed: [["src/app.js", "module.exports = () => 3;\n"]] });
      const wrongBase = openExecution(setup, "wrong-base");
      finishWithReceipt(setup, wrongBase, { base: earlier, commitHead: head, changed: [["src/app.js", APP_BYTES]] });
      const unreproduced = openExecution(setup, "unreproduced");
      finishWithReceipt(setup, unreproduced, { base: baseHead, commitHead: head, changed: [["src/app.js", APP_BYTES]],
        recordedResultDigest: sha256("some other result") });

      const frozen = await harness.cp.pipeline.freeze(run.runId);
      if (!frozen.allowed) throw new Error(frozen.message);
      const evidence = await readExecutionEvidence(harness.cp.db, { runId: run.runId, snapshot: frozen.value,
        snapshotDigest: candidateSnapshotDigest(frozen.value), contractDigest: run.contractDigest,
        verification: { results: [] } as unknown as VerificationReport, checkoutOf: () => harness.repoPath });

      expect(evidence.repositories).toEqual([{ repository: identity, baseHead, candidateHead: head, linkedExecutionIds: [] }]);
      expect(evidence.receipts.every((receipt) => !receipt.linked)).toBe(true);
      const byExecution = new Map(evidence.receipts.map((receipt) => [receipt.executionId, receipt]));
      expect(byExecution.has(otherCandidate.executionId)).toBe(false);
      expect(evidence.receiptsNotListed.outsideCandidateHistory).toBe(1);
      expect(byExecution.get(inHistory.executionId)!.mismatches).toEqual([
        "commitHead is an earlier commit in the candidate's history, not the candidate head; containment does not link a receipt"]);
      expect(byExecution.get(wrongBytes.executionId)!.mismatches).toEqual(["the receipt's diffDigest is not the frozen change's"]);
      expect(byExecution.get(wrongBase.executionId)!.mismatches).toEqual([`the receipt's base head is not the snapshot's baseHead ${baseHead}`]);
      expect(byExecution.get(unreproduced.executionId)!.mismatches).toEqual(["no success record of this execution reproduces its resultDigest"]);
    } finally { harness.cp.close(); }
  }, 60_000);

  it("reads config files only inside the frozen tree, and names what it does not read", async () => {
    const setup = await prepareRun([
      npmCommand("linked", ["npm", "test"]),
      npmCommand("through-link", ["pnpm", "test"], "pkg"),
      npmCommand("status", ["git", "status", "--porcelain"]),
    ], (repoPath) => {
      // package.json is a link to a host file, and pkg/ a link out of the tree.
      symlinkSync("/etc/hosts", join(repoPath, "package.json"));
      symlinkSync("..", join(repoPath, "pkg"));
    });
    const { harness, run } = setup;
    try {
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      commitAll(harness.repoPath, "make app() return 2");
      const frozen = await harness.cp.pipeline.freeze(run.runId);
      if (!frozen.allowed) throw new Error(frozen.message);
      const evidence = await readExecutionEvidence(harness.cp.db, { runId: run.runId, snapshot: frozen.value,
        snapshotDigest: candidateSnapshotDigest(frozen.value), contractDigest: run.contractDigest,
        verification: { results: [] } as unknown as VerificationReport, checkoutOf: () => harness.repoPath });
      const files = Object.fromEntries(evidence.commands.map((command) => [command.commandId, command.configFiles]));
      expect(files["linked"]).toMatchObject([{ path: "package.json", state: "NOT_A_REGULAR_FILE", content: "",
        detail: "a symbolic link; it is not followed" }]);
      expect(files["through-link"]).toMatchObject([{ path: "pkg/package.json", state: "ABSENT", content: "" }]);
      expect(files["status"]).toEqual([]);
      expect(evidence.commands.find((command) => command.commandId === "status")!.configFileRule)
        .toBe("no config-file rule for this command; its config files are omitted, not guessed");
      expect(JSON.stringify(evidence)).not.toMatch(/localhost|broadcasthost/);
    } finally { harness.cp.close(); }
  }, 60_000);

  it("refuses a '..' or absolute path before any read; a pinned manifest cannot carry one, a run-scoped command can", async () => {
    const repo = makeRepo({ "README.md": "fixture\n", "inner/run.js": "console.log(1);\n",
      "inner/token.js": `module.exports = "${GITHUB_TOKEN_SHAPE}";\n`,
      // A token across the stored cut: redacted whole first, so the cut keeps no prefix of it.
      "inner/long.js": `${"a ".repeat((CONFIG_FILE_CHAR_LIMIT - 10) / 2)}${GITHUB_TOKEN_SHAPE}\n` });
    const head = gitSync(repo, ["rev-parse", "HEAD"]);
    expect(await readConfigFile(repo, head, ".", "../outside.js")).toMatchObject({ state: "OUTSIDE_CANDIDATE_TREE", content: "",
      detail: "a '..' segment can leave the candidate tree" });
    expect(await readConfigFile(repo, head, "inner", "../../etc/hosts")).toMatchObject({ state: "OUTSIDE_CANDIDATE_TREE", content: "" });
    expect(await readConfigFile(repo, head, ".", "/etc/hosts")).toMatchObject({ state: "OUTSIDE_CANDIDATE_TREE", content: "",
      detail: "an absolute path is outside the candidate tree" });
    expect(await readConfigFile(repo, head, "inner", "./run.js")).toMatchObject({ path: "inner/run.js", state: "INCLUDED", content: "console.log(1);\n" });
    expect(await readConfigFile(repo, head, "inner", "token.js")).toMatchObject({ state: "INCLUDED", redacted: true,
      content: "module.exports = \"[redacted]\";\n" });
    const long = await readConfigFile(repo, head, "inner", "long.js");
    expect(long).toMatchObject({ state: "INCLUDED", redacted: true });
    expect(long.content).not.toContain(GITHUB_TOKEN_SHAPE.slice(0, 8));
  });
});

describe("official output is bounded, redacted and bound to its execution", () => {
  const binding = { candidateSnapshotDigest: `sha256:${"1".repeat(64)}`, contractDigest: `sha256:${"2".repeat(64)}`,
    commandId: "test", repositoryIdentity: "github:acme/fixture", exactHead: "a".repeat(40) };

  it("replaces a credential-shaped value before anything is stored", () => {
    const excerpt = verificationOutputExcerpt(binding, `ok ${GITHUB_TOKEN_SHAPE}\n`, `key sk-${"x".repeat(24)}\n`);
    expect(JSON.stringify(excerpt)).not.toContain(GITHUB_TOKEN_SHAPE);
    expect(JSON.stringify(excerpt)).not.toContain(`sk-${"x".repeat(24)}`);
    expect(excerpt).toMatchObject({ stdout: "ok [redacted]\n", stderr: "key [redacted]\n", redacted: true, truncated: false });
    // A cut through a credential keeps no part of it: the whole stream is redacted before any cut.
    const straddling = `${"x ".repeat((OUTPUT_EXCERPT_HEAD_CHARS - 10) / 2)} ${GITHUB_TOKEN_SHAPE} ${"y ".repeat(10_000)}\n`;
    const cut = verificationOutputExcerpt(binding, straddling, "");
    expect(cut.truncated).toBe(true);
    expect(cut.stdout).not.toContain(GITHUB_TOKEN_SHAPE.slice(0, 8));
  });

  it("#1223 P1: replaces a bare long-base64 value and one embedded in a line", () => {
    const bare = verificationOutputExcerpt(binding, LONG_BASE64, "");
    expect(bare).toMatchObject({ stdout: "[redacted]", redacted: true });
    const embedded = verificationOutputExcerpt(binding, "", `${EMBEDDED_LINE}\n`);
    expect(embedded).toMatchObject({ stderr: "key=[redacted] was printed by a test\n", redacted: true });
    // Hex digests have the same shape and are replaced too: over-redaction, marked as redaction.
    expect(verificationOutputExcerpt(binding, `digest ${"0a".repeat(32)}\n`, "")).toMatchObject({ stdout: "digest [redacted]\n", redacted: true });
  });

  it("the sandbox still drops a long-base64 environment value, now from the shared list", () => {
    const command = { ...fixtureManifest("x").verificationCommands[0]!, envAllowlist: ["TZ"] };
    expect(buildSandboxEnvironment(command, tempDir("acp-env-"), { TZ: "Ab9+/Zq7".repeat(8) }).TZ).toBeUndefined();
    expect(buildSandboxEnvironment(command, tempDir("acp-env-"), { TZ: "Etc/UTC" }).TZ).toBe("Etc/UTC");
  });

  it("an agent CLI's environment drops the same shapes, from the shared list", () => {
    vi.stubEnv("ACP_TEST_LONG_VALUE", "Ab9+/Zq7".repeat(8));
    vi.stubEnv("ACP_TEST_EMBEDDED_VALUE", `prefix ${GITHUB_TOKEN_SHAPE}`);
    vi.stubEnv("ACP_TEST_PLAIN_VALUE", "/opt/tools/bin");
    try {
      const env = runtimeEnvironment(["ACP_TEST_LONG_VALUE", "ACP_TEST_EMBEDDED_VALUE", "ACP_TEST_PLAIN_VALUE"], tempDir("acp-runtime-env-"));
      expect(env["ACP_TEST_LONG_VALUE"]).toBeUndefined();
      expect(env["ACP_TEST_EMBEDDED_VALUE"]).toBeUndefined();
      expect(env["ACP_TEST_PLAIN_VALUE"]).toBe("/opt/tools/bin");
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps the head and tail of oversized output and marks the cut", () => {
    const long = `HEAD-LINE\n${"x ".repeat(10_000)}\nTest Files  4 passed (4)\n`;
    const excerpt = verificationOutputExcerpt(binding, long, "");
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.stdoutChars).toBe(long.length);
    expect(excerpt.stdout.startsWith("HEAD-LINE\n")).toBe(true);
    expect(excerpt.stdout.endsWith("Test Files  4 passed (4)\n")).toBe(true);
    expect(excerpt.stdout).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/);
    expect(excerpt.stdout.length).toBeLessThan(OUTPUT_EXCERPT_HEAD_CHARS + OUTPUT_EXCERPT_TAIL_CHARS + 64);
  });

  it("redacts a stored excerpt again before the review input, whatever it was stored with", () => {
    const stored = { ...verificationOutputExcerpt(binding, "PASS\n", ""), stdout: `PASS ${LONG_BASE64}\n` };
    expect(shown(stored)).toMatchObject({ output: "RETAINED", stdout: "PASS [redacted]\n", redacted: true });
  });

  const report = (results: VerificationResultRecord[]): VerificationReport => ({ runId: "run", candidateSnapshotDigest: binding.candidateSnapshotDigest,
    contractDigest: binding.contractDigest, expectedInputs: results.length, observedInputs: results.length, results, status: "PASS", reasonCode: "OK", gaps: [] });
  const snapshot = { repositories: [{ identity: binding.repositoryIdentity, candidateHead: binding.exactHead }] } as unknown as CandidateSnapshot;
  const record = (output?: VerificationResultRecord["output"]): VerificationResultRecord => ({ commandId: "test", repositoryIdentity: binding.repositoryIdentity,
    source: "local", exactHead: binding.exactHead, startedAt: "t", endedAt: "t", exitCode: 0, outputDigest: "sha256:o", outputTruncated: false,
    status: "PASS", reasonCode: null, ...(output === undefined ? {} : { output }) });
  const shown = (output?: VerificationResultRecord["output"]): OutputEvidence => {
    const result = record(output);
    return outputEvidence({ snapshot, snapshotDigest: binding.candidateSnapshotDigest, contractDigest: binding.contractDigest, verification: report([result]) }, result);
  };

  it("says not retained for a result stored without output, and shows none", () => {
    expect(shown()).toMatchObject({ output: "NOT_RETAINED", stdout: "", stderr: "",
      statement: "output not retained: this result was recorded without its output, and none is shown or reconstructed" });
  });

  it("omits output bound to another snapshot, contract or head", () => {
    const own = verificationOutputExcerpt(binding, "PASS 3 tests\n", "");
    expect(shown(own)).toMatchObject({ output: "RETAINED", stdout: "PASS 3 tests\n" });
    for (const other of [{ candidateSnapshotDigest: `sha256:${"9".repeat(64)}` }, { contractDigest: `sha256:${"8".repeat(64)}` },
      { exactHead: "b".repeat(40) }, { commandId: "lint" }]) {
      expect(shown({ ...own, ...other }), JSON.stringify(other)).toMatchObject({ output: "NOT_THIS_EXECUTION", stdout: "", stderr: "",
        statement: "the stored output is not bound to this snapshot, contract, command and candidate head; it is omitted" });
    }
  });
});

describe("the execution evidence stays inside the reviewer budget", () => {
  const big = (): ExecutionEvidence => ({
    commandSource: "the pinned manifest sha256:x, profile standard",
    commands: Array.from({ length: 6 }, (_, i) => ({ commandId: `c${i}`, argv: ["npm", "run", `c${i}`], cwd: ".", required: true,
      repositoryRole: "primary", repository: "github:acme/fixture", candidateHead: "a".repeat(40), configFileRule: "npm reads <cwd>/package.json",
      configFiles: [{ path: "package.json", state: "INCLUDED" as const, detail: null, chars: 7_000, redacted: false, truncated: false, content: "p\"\n".repeat(2_000) }] })),
    results: Array.from({ length: 6 }, (_, i) => ({ commandId: `c${i}`, repositoryIdentity: "github:acme/fixture", source: "local", exactHead: "a".repeat(40),
      status: "PASS", exitCode: 0, reasonCode: null, candidateSnapshotDigest: "s", contractDigest: "c", outputDigest: "o", captureTruncated: false,
      output: "RETAINED" as const, statement: null, stdoutChars: 4_000, stderrChars: 0, redacted: false, truncated: false,
      stdout: `start\n${"t".repeat(3_990)}\nTests 9 passed\n`, stderr: "" })),
    repositories: [{ repository: "github:acme/fixture", baseHead: "b".repeat(40), candidateHead: "a".repeat(40), linkedExecutionIds: ["e0"] }],
    receipts: Array.from({ length: 30 }, (_, i) => ({ runId: "run", taskId: `t${i}`, executionId: `e${i}`, status: "SUCCEEDED",
      repository: "github:acme/fixture", baseHead: "b".repeat(40), commitHead: "a".repeat(40), diffDigest: "d", linked: i === 0, mismatches: i === 0 ? [] : ["m"] })),
    receiptsNotListed: { outsideCandidateHistory: 0, notACandidateRepository: 0, noCommitReceipt: 0, overListLimit: 0, unchecked: 0 },
  });

  it("charges no more than its budget beyond its budget-0 rendering, and marks every cut", () => {
    const evidence = big();
    const bare = executionEvidenceSection(evidence, 0);
    expect(bare.used).toBe(0);
    expect(bare.lines.join("\n")).toContain("This execution evidence is incomplete: it was cut for size.");
    for (const budget of [50, 400, 2_000, 9_000, 24_000]) {
      const section = executionEvidenceSection(evidence, budget);
      expect(section.lines.join("\n").length - bare.lines.join("\n").length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(section.used).toBeLessThanOrEqual(budget);
      const doc = JSON.parse(section.lines.join("\n").split("```json\n")[1]!.split("\n```")[0]!) as RenderedExecution;
      expect(doc.cutForSize).toBe(true);
      expect(section.lines).toContain("This execution evidence is incomplete: it was cut for size. The listed and total counts and every truncated mark say what is missing; it establishes nothing about what is not shown.");
      const cutText = [...doc.officialResults.results, ...doc.verificationCommands.commands.flatMap((command) => command.configFiles)]
        .some((item) => item["truncated"] === true);
      expect(cutText || doc.officialResults.listed < 6 || doc.receipts.receipts.length < 30).toBe(true);
    }
  });

  it("is whole and unmarked when it fits", () => {
    const evidence = big();
    const section = executionEvidenceSection(evidence, 1_000_000);
    const doc = JSON.parse(section.lines.join("\n").split("```json\n")[1]!.split("\n```")[0]!) as RenderedExecution;
    expect(doc.cutForSize).toBe(false);
    expect(doc.officialResults.results.map((result) => result["stdout"])).toEqual(evidence.results.map((result) => result.stdout));
    expect(section.lines.join("\n")).not.toContain("cut for size");
  });

  it("leaves the rest of the packet's room to the tree and task listings", async () => {
    const setup = await prepareRun();
    try {
      const evidence = big();
      const bare = candidateEvidenceSection(setup.harness.cp.db, setup.run.runId, [], evidence, 0).join("\n").length;
      for (const budget of [1_000, 30_000, 64_000]) {
        const full = candidateEvidenceSection(setup.harness.cp.db, setup.run.runId, [], evidence, budget).join("\n").length;
        expect(full - bare, `budget ${budget}`).toBeLessThanOrEqual(budget);
      }
    } finally { setup.harness.cp.close(); }
  });
});
