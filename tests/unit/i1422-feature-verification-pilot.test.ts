import { afterAll, describe, expect, it } from "vitest";

import { RunState } from "../../src/domain/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, reviewerPass, startWorkBranch } from "../helpers/harness.ts";
import { startReviewedRun, stageOf } from "../helpers/review-round-run.ts";

afterAll(cleanupTempDirs);

/**
 * #1422 Task A pilot — one feature, from acceptance to evidence, through the production pipeline.
 *
 * Feature: "saving a note persists it". The project's official command (`verify`, pinned in the
 * manifest) does not stop at the call's own answer: it saves, then reads the state back through a
 * separate read, and prints each assertion with its expected and actual values. The scenario is a
 * real process the sandbox executes on the frozen candidate; only the reviewer is scripted, so the
 * review text is a fixture result and never live reviewer evidence. Provenance: local sandbox
 * execution (`source: "local"`), not CI and not a live probe.
 *
 * The representative failure: a candidate whose `save` answers `{ ok: true }` and writes nothing.
 * Everything an exit-code-only or "the call returned ok" check looks at passes; the read-back fails.
 */

const NOTES_BASE = `module.exports = {
  // Known defect: answers ok and persists nothing.
  save: () => ({ ok: true }),
  list: () => [],
};
`;
const NOTES_STILL_BROKEN = `module.exports = {
  // Validates its input now, but still persists nothing.
  save: (_dir, text) => (typeof text === 'string' && text ? { ok: true } : { ok: false }),
  list: () => [],
};
`;
const NOTES_FIXED = `const fs = require('node:fs');
const path = require('node:path');
const file = (dir) => path.join(dir, 'notes.json');
module.exports = {
  save: (dir, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(dir), JSON.stringify([...module.exports.list(dir), text]));
    return { ok: true };
  },
  list: (dir) => (fs.existsSync(file(dir)) ? JSON.parse(fs.readFileSync(file(dir), 'utf8')) : []),
};
`;
// Each assertion prints its label with expected and actual; a failure names where it stopped.
const VERIFY = `const path = require('node:path');
const notes = require('./src/notes.js');
const dir = path.join(process.cwd(), '.verify-notes');
const check = (label, expected, actual) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  console.log((pass ? 'ok' : 'not ok') + ' - ' + label + ': expected ' + JSON.stringify(expected) + ', actual ' + JSON.stringify(actual));
  if (!pass) { console.error('FAIL at "' + label + '" (scenario: save a note, then read it back)'); process.exitCode = 1; }
};
check('save reports ok', true, notes.save(dir, 'hello').ok);
check('read back after save', ['hello'], notes.list(dir));
`;

const CONTRACT: TaskContract = {
  goal: "saving a note persists it",
  why: "a saved note must be there when it is read back",
  scope: ["src/notes.js"],
  nonGoals: [],
  acceptance: ["after save('hello'), reading the notes back returns ['hello'] (verify: 'read back after save')"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const CLAIM = "PRODUCER-CLAIM: I ran it by hand and the note persists";

const commitNotes = (source: string, message: string) => (repoPath: string): string => {
  startWorkBranch(repoPath);
  writeFiles(repoPath, { "src/notes.js": source });
  return commitAll(repoPath, message);
};

const verificationOf = (harness: ReturnType<typeof makeHarness>, runId: string): VerificationReport[] =>
  harness.cp.artifacts.list<VerificationReport>(runId, "VERIFICATION").map((artifact) => artifact.content);

describe("#1422 A pilot: acceptance -> usage path -> command -> assertion -> evidence", () => {
  it("a save that answers ok and persists nothing fails on the read-back, with expected and actual, and never reaches a reviewer", async () => {
    const harness = makeHarness({ repoPath: makeRepo({ "README.md": "# notes\n", "src/notes.js": NOTES_BASE, "verify.js": VERIFY }) });
    try {
      const { runId, submit } = await startReviewedRun(harness, commitNotes(NOTES_STILL_BROKEN, "validate input"), CONTRACT);
      const outcome = await submit(CLAIM);
      expect(stageOf(outcome)).toBe("VERIFICATION_FAILED");

      const [report] = verificationOf(harness, runId);
      const snapshot = harness.cp.artifacts.list<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT").at(-1)!.content;
      // Bound to this candidate and this approved contract, and failed for the command's own reason.
      expect(report).toMatchObject({
        status: "FAIL",
        reasonCode: "VERIFICATION_COMMAND_FAILED",
        candidateSnapshotDigest: candidateSnapshotDigest(snapshot),
        contractDigest: digestOf(CONTRACT),
        results: [{ commandId: "verify", source: "local", status: "FAIL", exitCode: 1 }],
      });
      const output = report!.results[0]!.output!;
      // The weak check (the call's own answer) passed; the strong one failed, and says where.
      expect(output.stdout).toContain("ok - save reports ok: expected true, actual true");
      expect(output.stdout).toContain(`not ok - read back after save: expected ["hello"], actual []`);
      expect(output.stderr).toContain(`FAIL at "read back after save" (scenario: save a note, then read it back)`);

      // The owner is handed the same observation, and no reviewer was asked to judge a failed run.
      const revision = harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "REVISION_REQUEST");
      expect(revision).toHaveLength(1);
      expect(JSON.stringify(revision[0]!.payload)).toContain(`actual []`);
      expect(harness.scripted.invocations).toHaveLength(0);
      expect(harness.cp.artifacts.list(runId, "BLIND_REVIEW")).toEqual([]);
    } finally {
      harness.cp.close();
    }
  }, 120_000);

  it("a candidate that persists passes the same command, and the reviewer reads that command's output for that candidate, not the producer's claim or the earlier failure", async () => {
    const harness = makeHarness({ repoPath: makeRepo({ "README.md": "# notes\n", "src/notes.js": NOTES_BASE, "verify.js": VERIFY }) });
    try {
      const { identity, runId, submit } = await startReviewedRun(harness, commitNotes(NOTES_STILL_BROKEN, "validate input"), CONTRACT);
      expect(stageOf(await submit("first attempt"))).toBe("VERIFICATION_FAILED");
      commitNotes(NOTES_FIXED, "persist the note")(harness.repoPath);
      harness.scripted.script({
        match: /Candidate review/,
        text: reviewerPass([`${identity}:src/notes.js`, `${identity}:#verification-output/verify/stdout`]),
      });
      expect(stageOf(await submit(CLAIM))).toBe("COMPLETED_REVIEW");

      const [failed, passed] = verificationOf(harness, runId);
      expect(passed).toMatchObject({ status: "PASS", contractDigest: digestOf(CONTRACT), results: [{ commandId: "verify", status: "PASS" }] });
      // A fixed candidate is a new candidate, verified and reviewed on its own.
      expect(passed!.candidateSnapshotDigest).not.toBe(failed!.candidateSnapshotDigest);

      expect(harness.scripted.invocations).toHaveLength(1);
      const prompt = harness.scripted.invocations[0]!.prompt;
      // Acceptance, as approved; the official command and what it printed for this candidate.
      expect(prompt).toContain(`- ${CONTRACT.acceptance[0]}`);
      const evidence = JSON.parse(prompt.split("## Untrusted execution evidence\n")[1]!.split("```json\n")[1]!.split("\n```")[0]!) as {
        verificationCommands: { commands: Array<{ commandId: string; configFiles: Array<{ path: string; content: string }> }> };
        officialResults: { results: Array<Record<string, unknown>> };
      };
      const [result] = evidence.officialResults.results;
      expect(result).toMatchObject({
        commandId: "verify",
        source: "local",
        status: "PASS",
        candidateSnapshotDigest: passed!.candidateSnapshotDigest,
        contractDigest: digestOf(CONTRACT),
        output: "RETAINED",
      });
      expect(String(result!["stdout"])).toContain(`ok - read back after save: expected ["hello"], actual ["hello"]`);
      // The reviewer can read what the command asserts, so a command that skips the real path is visible to it.
      expect(evidence.verificationCommands.commands[0]!.configFiles[0]).toMatchObject({ path: "verify.js" });
      expect(evidence.verificationCommands.commands[0]!.configFiles[0]!.content).toContain("read back after save");
      // Blind review: neither the producer's claim nor the earlier failed attempt is in the packet.
      expect(prompt).not.toContain(CLAIM);
      expect(String(result!["stdout"])).not.toContain("not ok");
      expect(prompt).not.toContain("Validates its input now");
      expect(prompt).not.toContain(failed!.candidateSnapshotDigest);
    } finally {
      harness.cp.close();
    }
  }, 180_000);

  it("a command whose driver is not there is not a pass: nothing is verified, nothing is reviewed, and the owner is told", async () => {
    const harness = makeHarness({ repoPath: makeRepo({ "README.md": "# notes\n", "src/notes.js": NOTES_BASE, "verify.js": VERIFY }) });
    try {
      const declared = fixtureManifest("fixture-project").verificationCommands[0]!;
      const { runId, submit } = await startReviewedRun(harness, commitNotes(NOTES_FIXED, "persist the note"), CONTRACT, {
        verificationCommands: [{ ...declared, argv: ["./bin/e2e-driver", "verify.js"] }],
      });
      // The command's own driver is absent from the candidate, so the usage path could not run at all.
      expect(stageOf(await submit())).toBe("VERIFICATION_FAILED");
      const [report] = verificationOf(harness, runId);
      expect(report).toMatchObject({ status: "FAIL", results: [{ commandId: "verify", status: "ERROR", exitCode: null }] });
      expect(report!.results[0]!.output!.stderr).toContain("does not lead to an executable file");
      expect(harness.scripted.invocations).toHaveLength(0);
      expect(harness.cp.artifacts.list(runId, "BLIND_REVIEW")).toEqual([]);
      expect(harness.cp.runs.require(runId).state).not.toBe(RunState.READY_FOR_CEO_REVIEW);
    } finally {
      harness.cp.close();
    }
  }, 120_000);
});
