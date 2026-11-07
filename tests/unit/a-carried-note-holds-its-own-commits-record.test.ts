import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { NO_HUMAN_GATE_DIGEST } from "../../src/github/github-kernel.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { WorkerTurnEvent } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  type Harness,
  approveReviewedCandidateForFinalization,
  bindWorker,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const WORK_BRANCH = "feature/F1-thing";
const X_ID = "r-xcommit01";
const Y_ID = "r-ycommit01";
const X_EARLY_ID = "r-xearly01";

/**
 * #1268 slice 1 — a governed freeze holds only commits a SUCCEEDED worker receipt of the run accounts for. `commit`
 * is its own task's worker turn, recorded as the harness records the head's (`driveToReviewedCandidate`) and slice 1's
 * witness records one: the execution opened and closed SUCCEEDED, and the receipt naming the commit with the
 * CommitLore outcome a settled turn records, its record ids exactly the commit's own `Record-Id` trailers.
 */
const recordWorkerTurn = (harness: Harness, runId: string, commit: string, recordIds: string[]): void => {
  const submitted = harness.cp.tasks.submit(runId, [{ key: "prepare", title: "prepare app()", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const taskId = submitted.value[0]!.taskId;
  const workerSessionId = bindWorker(harness, taskId);
  const repository = harness.cp.db.get<{ repository_id: string }>(`SELECT repository_id FROM run_repositories WHERE run_id = ?`, [runId]);
  const opened = harness.cp.tasks.startExecution({
    runId, taskId, ownerBindingGeneration: harness.cp.runs.require(runId).ownerBindingGeneration!, workerSessionId,
    provider: "scripted", model: "scripted-worker", repositoryId: repository!.repository_id,
  });
  if (!opened.allowed) throw new Error(opened.message);
  const resultDigest = `sha256:${commit}`;
  const closed = harness.cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest });
  if (!closed.allowed) throw new Error(closed.message);
  harness.cp.audit.record({
    kind: WorkerTurnEvent.SUCCEEDED,
    runId,
    sessionId: workerSessionId,
    evidence: {
      executionId: opened.value.executionId, resultDigest, taskId, commitHead: commit,
      commitlore: { outcome: "recorded", recordIds, nonce: "capture-nonce" },
    },
  });
};

/** GitHub's merged-PR snapshot and its base ref, as `tests/scenarios/github-kernel.test.ts` models them. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") return response;
    const merge = response as { merged?: unknown; sha?: unknown };
    const pull = github.pulls.find((entry) => entry.number === Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]));
    if (merge.merged !== true || typeof merge.sha !== "string" || !pull) return response;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = merge.sha;
    github.setBranch(pull.base.ref, merge.sha);
    return response;
  };
};

/**
 * The candidate is base..head = {X, head}. X is a recorded commit: its own trailer block declares X_ID, and an
 * earlier record block in its message declares X_EARLY_ID. The head records nothing.
 * Y is a recorded commit outside the candidate (branch `side`, on the base): its trailer block declares Y_ID.
 * The setup is the one the #1269 notes scenarios use, with X committed on the work branch before the run. The run
 * is governed (CommitLore `required`) unless `governed` is false (`preferred`, the fixture manifest's own mode).
 */
const setup = async (options: {
  governed?: boolean;
  xLimit?: string;
  /** X's message as ISO-8859-1 bytes, committed with that `encoding` header (`declared`) or with none (null). */
  xLatin1?: { declared: "ISO-8859-1" | null };
} = {}) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  harness.cp.verification.attachCi({
    fetch: async (repositoryIdentity, head) => [{
      commandId: "project-ci", repositoryIdentity, head, conclusion: "success" as const, workflowDigest: "sha256:approved",
      creatorIdentity: "github-actions", completedAt: "2026-08-12T00:00:00.000Z", nonVacuous: true,
    }],
    approvedWorkflowDigests: async () => ["sha256:approved"],
    trustedCreators: async () => ["github-actions"],
  });

  const repo = harness.repoPath;
  gitSync(repo, ["checkout", "-q", "-b", WORK_BRANCH]);
  writeFiles(repo, { "src/app.js": "module.exports = () => 1 + 0;\n" });
  const xMessage = `prepare app()\n\nLimit: an earlier record of X\nRecord-Id: ${X_EARLY_ID}\n\n` +
    `Record-Id: ${X_ID}\nLimit: ${options.xLimit ?? "app() keeps one export, the record of X"}`;
  let x: string;
  if (options.xLatin1 === undefined) {
    x = commitAll(repo, xMessage);
  } else {
    gitSync(repo, ["add", "-A"]);
    if (options.xLatin1.declared !== null) {
      const file = join(repo, ".git", "X_MESSAGE");
      writeFileSync(file, Buffer.from(xMessage, "latin1"));
      gitSync(repo, ["-c", `i18n.commitEncoding=${options.xLatin1.declared}`, "commit", "-q", "-F", file]);
      x = gitSync(repo, ["rev-parse", "HEAD"]);
    } else {
      // `git commit` re-encodes a message that is not UTF-8 as if it were Latin-1, so the object is written directly.
      const who = "ACP Test <test@example.invalid> 1786000000 +0000";
      const header = `tree ${gitSync(repo, ["write-tree"])}\nparent ${gitSync(repo, ["rev-parse", "HEAD"])}\nauthor ${who}\ncommitter ${who}\n\n`;
      const object = Buffer.concat([Buffer.from(header), Buffer.from(`${xMessage}\n`, "latin1")]);
      x = execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], { input: object }).toString("utf8").trim();
      gitSync(repo, ["update-ref", "HEAD", x]);
    }
  }
  if (options.governed !== false) {
    // X's turn is recorded in the run once the run exists, before its one freeze; the harness records the head's.
    const freeze = harness.cp.pipeline.freeze.bind(harness.cp.pipeline);
    vi.spyOn(harness.cp.pipeline, "freeze").mockImplementationOnce(async (runId, attemptId) => {
      recordWorkerTurn(harness, runId, x, [X_EARLY_ID, X_ID]);
      return freeze(runId, attemptId);
    });
  }

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: WORK_BRANCH,
    manifestOverrides: {
      commitlore: { mode: options.governed === false ? "preferred" : "required" },
      ciWorkflows: [{ path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null, unapprovedFirstActivation: true, repositoryRole: "primary" }],
      verificationProfiles: { simple: ["project-ci"], standard: ["project-ci"], guarded: ["project-ci"] },
      verificationCommands: [parseVerificationCommand({
        id: "project-ci", argv: ["node", "verify.js"], repositoryRole: "primary", evidenceMode: "TRUSTED_CI", timeoutSeconds: 60,
      })],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await approveReviewedCandidateForFinalization(harness, driven);
  installDaemonFinalizerGitHubFixture(harness);

  // Y, made without moving the checkout: the base's tree, one parent (the base), a record of its own.
  const y = gitSync(repo, [
    "commit-tree", `${driven.baseHead}^{tree}`, "-p", driven.baseHead,
    "-m", `document y\n\nRecord-Id: ${Y_ID}\nLimit: y.md is generated, the record of Y\nWarn: do not edit y.md by hand`,
  ]);
  gitSync(repo, ["update-ref", "refs/heads/side", y]);

  const gate = await harness.cp.github.gatePublish({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    contractDigest: driven.contractDigest,
    verificationDigest: driven.verificationDigest,
    blindReviewDigest: driven.blindReviewDigest,
    humanGateDigest: NO_HUMAN_GATE_DIGEST,
    bindingGeneration: driven.ownerBindingGeneration,
    exactHead: driven.candidateHead,
    timestamp: "2026-08-12T00:00:00.000Z",
  }, driven.identity);
  if (!gate.allowed) throw new Error(gate.message);
  const caller = { ownerSessionId: driven.ownerSessionId, ownerBindingGeneration: driven.ownerBindingGeneration };
  const pr = await harness.cp.github.prPrepare({
    runId: driven.runId, repositoryIdentity: driven.identity, head: driven.workBranch, base: "dev",
    title: "candidate", body: "", exactHeadSha: driven.candidateHead, ...caller,
  });
  if (!pr.allowed) throw new Error(pr.message);
  const input = {
    runId: driven.runId, repositoryIdentity: driven.identity, pullNumber: pr.value.pullNumber,
    exactHeadSha: driven.candidateHead, expectedBaseSha: driven.baseHead, mergeStrategy: "merge_commit" as const, ...caller,
  };
  const merge = () => harness.cp.github.mergeExecute(input);
  return { harness, github, repo, x, y, base: driven.baseHead, head: driven.candidateHead, input, merge };
};

/** A git answer as raw bytes, which `gitSync`'s UTF-8 string cannot keep. */
const execRaw = (repo: string, args: readonly string[]): Buffer => execFileSync("git", ["-C", repo, ...args]);

/** A commit's own trailer block, as git reads it. */
const trailersOf = (repo: string, commit: string): string => gitSync(repo, ["log", "-1", "--format=%(trailers:only,unfold)", commit]);

type Fixture = Awaited<ReturnType<typeof setup>>;

/** `content` as `commit`'s CommitLore note in the checkout (replacing one with `replace`); its blob id. */
const noteOn = (fixture: Fixture, commit: string, content: string, replace = false): string => {
  gitSync(fixture.repo, ["notes", "--ref=commitlore", "add", ...(replace ? ["-f"] : []), "-m", content, commit]);
  return gitSync(fixture.repo, ["notes", "--ref=commitlore", "list", commit]);
};

const mergeReceipts = (fixture: Fixture) =>
  fixture.harness.cp.db.all<{ status: string; verified: number }>(`SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`);

/** Refused before the merge PUT: nothing reserved, no merge sent, nothing on the remote notes ref. */
const expectRefusedBeforeMerge = (fixture: Fixture, refused: Decision<unknown>, refusal: string, objects: string[]): void => {
  expect(refused.reasonCode, refused.allowed ? "" : refused.message).toBe(ReasonCode.VERIFICATION_GAP);
  if (refused.allowed) throw new Error("expected a refusal");
  expect(refused.evidence).toMatchObject({ phase: "preflight-notes", ref: "refs/notes/commitlore", refusal, objects });
  expect(fixture.github.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect(fixture.github.mergeCount).toBe(0);
  expect(fixture.github.notesRef).toBeNull();
  expect(mergeReceipts(fixture)).toEqual([]);
};

describe("#1268 slice 2 — a carried note holds the record of the commit it is attached to", () => {
  it.each([
    ["variant 1: Y's record copied verbatim", (yRecord: string) => yRecord],
    ["variant 2: Y's record with its Record-Id edited to X's", (yRecord: string) => yRecord.replace(`Record-Id: ${Y_ID}`, `Record-Id: ${X_ID}`)],
  ] as const)("a note on X whose content is Y's record is not carried to the remote (%s)", async (_label, forge) => {
    const fixture = await setup();

    // The candidate holds X and not Y; X and Y each declare their own record in their own trailers.
    const candidate = gitSync(fixture.repo, ["rev-list", `${fixture.base}..${fixture.head}`]).split("\n");
    expect(candidate).toContain(fixture.x);
    expect(candidate).not.toContain(fixture.y);
    expect(trailersOf(fixture.repo, fixture.x)).toContain(`Record-Id: ${X_ID}`);
    const yRecord = trailersOf(fixture.repo, fixture.y);
    expect(yRecord).toContain(`Record-Id: ${Y_ID}`);

    // The note is attached to X; its body is Y's record.
    gitSync(fixture.repo, ["notes", "--ref=commitlore", "add", "-m", forge(yRecord), fixture.x]);
    const note = gitSync(fixture.repo, ["notes", "--ref=commitlore", "show", fixture.x]);
    expect(note).toContain("Limit: y.md is generated, the record of Y");
    expect(note).not.toContain("the record of X");
    const blob = gitSync(fixture.repo, ["notes", "--ref=commitlore", "list", fixture.x]);

    const merged = await fixture.merge();
    const carried = fixture.github.remoteNoteFor(fixture.x);
    expect(
      carried,
      `mergeExecute answered ${merged.reasonCode}${merged.reasonCode === ReasonCode.OK ? "" : ` (${merged.allowed ? "" : merged.message})`}; ` +
        `the remote refs/notes/commitlore carries blob ${carried ?? "none"} for X ${fixture.x} (the checkout's note blob is ${blob})`,
    ).toBeUndefined();
    expectRefusedBeforeMerge(fixture, merged, "COMMITLORE_NOTE_UNBOUND", [fixture.x]);
  });

  it("a note carrying Provenance: inherited is refused as unsupported on the governed carry path, not as forged", async () => {
    const fixture = await setup();
    noteOn(fixture, fixture.x, `${trailersOf(fixture.repo, fixture.x)}\nProvenance: inherited ${fixture.y}`);
    const refused = await fixture.merge();
    expect(fixture.github.remoteNoteFor(fixture.x), `mergeExecute answered ${refused.reasonCode}`).toBeUndefined();
    expectRefusedBeforeMerge(fixture, refused, "COMMITLORE_NOTE_INHERITED_UNSUPPORTED", [fixture.x]);
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.message).toContain("unsupported on the governed carry path");
    expect(refused.message).not.toMatch(/forg/i);
  });

  it("one bad note among good ones: none is published", async () => {
    const fixture = await setup();
    const good = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    // The head records nothing of its own, so a record note on it belongs to no record of the head.
    noteOn(fixture, fixture.head, trailersOf(fixture.repo, fixture.y));
    const refused = await fixture.merge();
    expect(fixture.github.remoteNoteFor(fixture.x), `mergeExecute answered ${refused.reasonCode}; X's own note ${good}`).toBeUndefined();
    expect(fixture.github.remoteNoteFor(fixture.head)).toBeUndefined();
    expectRefusedBeforeMerge(fixture, refused, "COMMITLORE_NOTE_UNBOUND", [fixture.head]);
  });

  it("a note replaced after the check is never copied: the proven merge waits for its notes", async () => {
    const fixture = await setup();
    const checked = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    let replaced = "";
    // During the merge PUT, after the notes were checked, the checkout's note on X becomes Y's record.
    fixture.github.onMerge = () => {
      replaced = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.y), true);
    };
    const pending = await fixture.merge();
    expect(replaced).not.toBe(checked);
    const carried = fixture.github.remoteNoteFor(fixture.x);
    expect(carried, `mergeExecute answered ${pending.reasonCode}; checked ${checked}, replaced by ${replaced}`).toBeUndefined();
    expect(pending.reasonCode).toBe(ReasonCode.MERGE_NOTES_PENDING);
    if (pending.allowed) throw new Error("expected the merge to wait for its notes");
    expect(pending.evidence).toMatchObject({ phase: "postflight-notes", refusal: "COMMITLORE_NOTE_CHANGED", objects: [fixture.x] });
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.notesRef).toBeNull();
    expect(mergeReceipts(fixture)).toEqual([{ status: "PENDING", verified: 0 }]);
  });

  it("settle on an already-merged pull: the merge stands, notes-incomplete is recorded, and nothing is published", async () => {
    const fixture = await setup();
    noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    fixture.github.refuseNotesWrite = true;
    const first = await fixture.merge();
    expect(first.reasonCode, first.allowed ? "" : first.message).toBe(ReasonCode.MERGE_NOTES_PENDING);
    const mergeCommitSha = fixture.github.pulls[0]!.merge_commit_sha!;

    // Before the settlement, X's note becomes Y's record under X's Record-Id.
    noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.y).replace(`Record-Id: ${Y_ID}`, `Record-Id: ${X_ID}`), true);
    // The next attempt settles the PENDING receipt by reading the merged pull (as the #1269 scenario does): no PUT.
    const settled = await fixture.merge();
    const carried = fixture.github.remoteNoteFor(fixture.x);
    expect(carried, `the settlement answered ${settled.reasonCode}`).toBeUndefined();
    expect(settled.reasonCode).toBe(ReasonCode.MERGE_NOTES_PENDING);
    if (settled.allowed) throw new Error("expected the settlement to wait for its notes");
    expect(settled.evidence).toMatchObject({
      phase: "postflight-notes", refusal: "COMMITLORE_NOTE_UNBOUND", objects: [fixture.x], mergeCommitSha, pullNumber: fixture.input.pullNumber,
    });
    expect(fixture.github.pulls[0]!.merged).toBe(true);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.notesRef).toBeNull();
    expect(mergeReceipts(fixture)).toEqual([{ status: "PENDING", verified: 0 }]);
    expect(fixture.harness.cp.audit.byKind("MERGE_NOTES_PENDING").map((entry) => entry.evidence)).toEqual([
      expect.objectContaining({ mergeCommitSha }),
      expect.objectContaining({ mergeCommitSha, notesReasonCode: ReasonCode.VERIFICATION_GAP }),
    ]);
  });

  it("an own-mirror note is carried (one block of two), and a commit with no note passes", async () => {
    const fixture = await setup();
    const own = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    const merged = await fixture.merge();
    expect(merged.reasonCode, merged.allowed ? "" : merged.message).toBe(ReasonCode.OK);
    expect(fixture.github.remoteNoteFor(fixture.x)).toBe(own);
    expect(fixture.github.remoteNoteFor(fixture.head)).toBeUndefined();
  });

  it("an own-mirror note is carried whatever encoding git displays commit messages in", async () => {
    const fixture = await setup({ xLimit: "app() keeps one export, the record of X, café" });
    const own = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    expect(gitSync(fixture.repo, ["notes", "--ref=commitlore", "show", fixture.x])).toContain("café");
    // Only how `git log` shows messages changes; the commit and the note are the same UTF-8 bytes.
    gitSync(fixture.repo, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    gitSync(fixture.repo, ["config", "log.showSignature", "true"]);
    gitSync(fixture.repo, ["config", "log.decorate", "full"]);
    const merged = await fixture.merge();
    expect(merged.reasonCode, merged.allowed ? "" : `${merged.message} ${JSON.stringify(merged.evidence)}`).toBe(ReasonCode.OK);
    expect(fixture.github.remoteNoteFor(fixture.x)).toBe(own);
  });

  it("a commit that declares encoding ISO-8859-1 is read in it: its UTF-8 own-mirror note is carried", async () => {
    const fixture = await setup({ xLimit: "app() keeps one export, the record of X, café", xLatin1: { declared: "ISO-8859-1" } });
    const raw = execRaw(fixture.repo, ["cat-file", "commit", fixture.x]);
    expect(raw.includes(Buffer.from("\nencoding ISO-8859-1\n"))).toBe(true);
    expect(raw.includes(Buffer.from("café", "latin1"))).toBe(true);
    // The note is the same record in UTF-8, as `git log` gives it in this checkout's default display encoding.
    const own = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.x));
    expect(gitSync(fixture.repo, ["notes", "--ref=commitlore", "show", fixture.x])).toContain("café");
    const merged = await fixture.merge();
    expect(merged.reasonCode, merged.allowed ? "" : `${merged.message} ${JSON.stringify(merged.evidence)}`).toBe(ReasonCode.OK);
    expect(fixture.github.remoteNoteFor(fixture.x)).toBe(own);
  });

  it("a message that is not UTF-8 and declares no encoding is refused as unreadable", async () => {
    const fixture = await setup({ xLimit: "app() keeps one export, the record of X, café", xLatin1: { declared: null } });
    const raw = execRaw(fixture.repo, ["cat-file", "commit", fixture.x]);
    expect(raw.includes(Buffer.from("\nencoding "))).toBe(false);
    expect(raw.includes(Buffer.from("café", "latin1"))).toBe(true);
    noteOn(fixture, fixture.x, `Record-Id: ${X_ID}\nLimit: app() keeps one export, the record of X`);
    const refused = await fixture.merge();
    expect(refused.reasonCode, refused.allowed ? "" : `${refused.message} ${JSON.stringify(refused.evidence)}`).toBe(ReasonCode.VERIFICATION_GAP);
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.evidence).toMatchObject({ phase: "preflight-notes", ref: "refs/notes/commitlore", refusal: "COMMITLORE_NOTE_UNREADABLE" });
    expect(fixture.github.calls.filter((call) => call.method === "PUT")).toEqual([]);
    expect(fixture.github.notesRef).toBeNull();
  });

  it("a non-governed run is unchanged: its notes are carried as they are", async () => {
    const fixture = await setup({ governed: false });
    const copied = noteOn(fixture, fixture.x, trailersOf(fixture.repo, fixture.y));
    const merged = await fixture.merge();
    expect(merged.reasonCode, merged.allowed ? "" : merged.message).toBe(ReasonCode.OK);
    expect(fixture.github.remoteNoteFor(fixture.x)).toBe(copied);
  });
});
