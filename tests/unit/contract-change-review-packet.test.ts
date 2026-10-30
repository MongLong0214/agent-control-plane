import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { sha256 } from "../../src/core/digest.ts";
import { acpError, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { credentialBearingField, prohibitedDurableField } from "../../src/db/audit.ts";
import { registryView } from "../../src/db/registry-view.ts";
import { RunKind, RunState, type RunRow } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { idempotentMcpMutation, ok } from "../../src/mcp/shared.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import type { ContractChangeReviewContext } from "../../src/review/contract-change-review-context.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { buildNoRepositoryCandidateSnapshot, candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { callCtoToolAsOwner } from "../helpers/bootstrap-plan.ts";
import { CONTRACT_CHANGE_CONTRACT, WORKFLOW, WORKFLOW_PATH } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { FIRST_IDENTITY, createRun, firstManifest, firstPlan, operatorRegisteredProject, revisionsFor, unitTestsWorkflow } from "../helpers/first-activation.ts";
import { makeHarness, reviewerPass, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1254 / #1255 — a first-activation CONTRACT_CHANGE review, end to end through the candidate pipeline
 * and the review gate with the harness's scripted reviewer.
 *
 * #1254: a reviewer that names the run's own PLAN or manifest by `sha256:` digest in its omitted items
 * or a finding had its whole review refused at storage, and the refusal left nothing behind. A digest
 * is now kept when it names a record the store holds; any other credential shape is still refused, and
 * a refused review leaves a record without its text.
 *
 * #1255: the review packet now carries the CTO's PLAN, labelled as the CTO's, and ACP's own readback
 * captured at the candidate's freeze: the project's registration, its repositories' stored observation
 * and checkout, and each bound workflow revision read at its exact commit.
 */

const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;
/** `sha256()` answers `sha256:<hex>`; `hex()` is the bare 64-hex form. */
const hex = (text: string): string => sha256(text).slice("sha256:".length);
const UNBOUND = sha256("a value no record of this store has");

const PLAN_TEXT = {
  summary: "Activate the project's first manifest. No repository content changes; the registration is preserved.",
  repositoryContentChange: false,
  risks: ["The checkout is on another branch; the workflow is read by object id at the bound commit."],
  verificationIntent: ["The project's CI check stays the quality bar."],
};

interface FirstActivation {
  h: Harness;
  repoPath: string;
  projectId: string;
  run: RunRow;
  m1: ProjectManifest;
  bound: string;
  registrationEventId: number;
  planDigest: string;
  coverage: string;
}

let projectSeq = 0;
const SECOND_IDENTITY = "github:acme/second";

/**
 * An operator-registered NULL project, a dispatched first-activation run and its PLAN, not yet submitted.
 * With `secondCheckout`, the project also registers a `secondary` repository there, and M1 names it.
 */
const firstActivation = async (
  planText: Record<string, unknown> = PLAN_TEXT,
  workflows: Parameters<typeof firstManifest>[1] = [unitTestsWorkflow],
  options: { secondCheckout?: string } = {},
): Promise<FirstActivation> => {
  const repoPath = makeRepo({ "README.md": "# fixture\n", "verify.js": "console.log('ok')\n", [WORKFLOW_PATH]: WORKFLOW }, "dev");
  const h = makeHarness({ repoPath });
  const projectId = `review-packet-${++projectSeq}`;
  const project = await operatorRegisteredProject(h, projectId);
  if (options.secondCheckout !== undefined) {
    const second = await h.cp.repositories.register({
      checkoutPath: options.secondCheckout, projectId, repositoryRole: "secondary", identity: SECOND_IDENTITY,
    });
    if (!second.allowed) throw new Error(`${second.reasonCode}: ${second.message}`);
  }
  const bound = gitSync(repoPath, ["rev-parse", "HEAD"]);
  const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const m1 = firstManifest(projectId, workflows, options.secondCheckout === undefined ? {} : {
    repositories: [
      { role: "primary", remote: FIRST_IDENTITY, manifestRoot: "." },
      { role: "secondary", remote: SECOND_IDENTITY, manifestRoot: "." },
    ],
  });
  const submitted = createCtoMcpPort(h.cp).submitPlan(run.runId, { ...firstPlan(m1, revisionsFor(m1, bound)), ...planText });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  await h.cp.continuity.evaluate("contract change review packet");
  return {
    h, repoPath, projectId, run, m1, bound,
    registrationEventId: project.registrationEventId,
    planDigest: h.cp.artifacts.latest(run.runId, "PLAN")!.digest,
    coverage: `${projectId}:#manifest/${manifestDigest(m1)}`,
  };
};

const submit = (r: FirstActivation) => r.h.cp.pipeline.submitResult({
  runId: r.run.runId,
  ownerSessionId: r.run.ownerSessionId!,
  ownerBindingGeneration: r.run.ownerBindingGeneration!,
  resultSummary: "the project's first manifest",
  recommendation: "activate it",
  residualRisk: [],
});

/** A reviewer answer that BLOCKs with one omitted item and one finding. */
const blocking = (r: FirstActivation, omitted: string, detail: string): string => JSON.stringify({
  verdict: "BLOCK",
  coveredFiles: [r.coverage],
  omittedItems: [omitted],
  findings: [{ category: "evidence", severity: "BLOCKER", repository: r.projectId, path: null, summary: "evidence is missing", detail }],
});

const contractChangePrompts = (h: Harness): string[] =>
  h.scripted.invocations.map((call) => call.prompt).filter((prompt) => prompt.startsWith("# Contract change review"));

/** The fenced JSON block that follows `heading` in a prompt. */
const fencedJsonAfter = (prompt: string, heading: string): unknown => {
  const at = prompt.indexOf(heading);
  if (at < 0) throw new Error(`the prompt has no ${heading} section`);
  const open = prompt.indexOf("```json\n", at);
  const close = prompt.indexOf("\n```", open + 8);
  return JSON.parse(prompt.slice(open + 8, close));
};

/** The readback's schema, written out so this file states the stored shape it reads. */
const CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA = "acp.contract-change-review-context.v1";

const storedContext = (h: Harness, runId: string, candidate: string): ContractChangeReviewContext | null =>
  h.cp.artifacts.list<ContractChangeReviewContext>(runId, "HANDOFF")
    .find((artifact) => artifact.candidateSnapshotDigest === candidate && artifact.content.schema === CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA)
    ?.content ?? null;

describe("#1254: a review that names the run's own records by digest is stored", () => {
  it("the exact omitted-item sentence naming the PLAN, and a finding naming the manifest, are stored as written", async () => {
    const r = await firstActivation();
    try {
      const omitted = `The full PLAN identified by ${r.planDigest}, including firstActivation and repositoryContentChange.`;
      const detail = `The proposed manifest ${manifestDigest(r.m1)} cannot be judged without the registration facts.`;
      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, omitted, detail) });
      const result = await submit(r);
      expect(result.allowed, JSON.stringify(result)).toBe(true);
      expect(result.allowed && result.value.stage).toBe("REVISION_REQUIRED");
      const candidate = r.h.cp.runs.currentCandidate(r.run.runId)!;
      const stored = r.h.cp.artifacts.latestForSnapshot<ReviewPacket>(r.run.runId, "BLIND_REVIEW", candidate)!.content;
      expect(stored.verdict).toBe("BLOCK");
      expect(stored.omittedItems).toEqual([omitted]);
      expect(stored.findings[0]!.detail).toBe(detail);
      expect(stored.findings[0]!.redacted).toBeUndefined();
      // The audit row's copy of the omitted items keeps the digest too.
      const completed = r.h.cp.audit.forRun(r.run.runId).filter((row) => row.kind === "BLIND_REVIEW_COMPLETED");
      expect(completed).toHaveLength(1);
      expect(completed[0]!.evidence["omittedItems"]).toEqual([omitted]);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("a token in the same field is refused; the refusal is recorded without it, the run waits, and a retry stores one review", async () => {
    const r = await firstActivation();
    try {
      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, `token ${TOKEN} beside ${r.planDigest}`, "detail") });
      const refused = await submit(r);
      expect(refused.allowed, JSON.stringify(refused)).toBe(true);
      expect(refused.allowed && refused.value).toMatchObject({ stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
      const candidate = r.h.cp.runs.currentCandidate(r.run.runId)!;
      expect(r.h.cp.artifacts.latestForSnapshot(r.run.runId, "BLIND_REVIEW", candidate)).toBeNull();
      expect(r.h.cp.runs.require(r.run.runId).state).toBe(RunState.ACTIVE);

      const audit = r.h.cp.audit.forRun(r.run.runId);
      const frozen = audit.filter((row) => row.kind === "CANDIDATE_FROZEN").at(-1)!;
      const refusal = audit.filter((row) => row.kind === "BLIND_REVIEW_STORAGE_REFUSED");
      expect(refusal).toHaveLength(1);
      expect(refusal[0]!.reasonCode).toBe(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED);
      expect(refusal[0]!.runId).toBe(r.run.runId);
      expect(refusal[0]!.sessionId).toEqual(expect.any(String));
      expect(refusal[0]!.evidence).toMatchObject({
        candidateSnapshotDigest: candidate,
        kind: "BLIND_REVIEW",
        field: "omittedItems",
        verdict: "BLOCK",
        findings: 1,
        attemptId: frozen.evidence["attemptId"],
      });
      expect(JSON.stringify(audit)).not.toContain(TOKEN);
      expect(audit.filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")).toHaveLength(1);

      // The retry is a new submission: a new candidate, and its review stored once.
      r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
      const retried = await submit(r);
      expect(retried.allowed, JSON.stringify(retried)).toBe(true);
      expect(r.h.cp.runs.require(r.run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      const after = r.h.cp.audit.forRun(r.run.runId);
      expect(after.filter((row) => row.kind === "BLIND_REVIEW_COMPLETED")).toHaveLength(1);
      expect(after.filter((row) => row.kind === "BLIND_REVIEW_STORAGE_REFUSED")).toHaveLength(1);
      expect(r.h.cp.artifacts.list(r.run.runId, "BLIND_REVIEW")).toHaveLength(1);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("a result_submit refused at review storage answers the same on a replay of its key; a new key reviews again", async () => {
    const r = await firstActivation();
    try {
      const call = (key: string) => callCtoToolAsOwner(r.h, r.run.runId, "result_submit", {
        idempotencyKey: key, runId: r.run.runId, resultSummary: "the project's first manifest", recommendation: "activate it",
      });
      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, `token ${TOKEN}`, "detail") });
      const first = await call("result-review-refused-1");
      expect(first.body, first.text).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED } });
      expect(first.text).not.toContain(TOKEN);
      const replay = await call("result-review-refused-1");
      expect(replay).toEqual(first);
      r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
      const next = await call("result-review-refused-2");
      expect(next.body, next.text).toMatchObject({ ok: true });
      expect(r.h.cp.runs.require(r.run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    } finally { r.h.cp.close(); }
  }, 60_000);
});

describe("#1254: a digest or id in text is set aside only when it names a record the store holds", () => {
  it("artifact text: the run's own digests and an accepted Buzz event id store; another run's, an unbound one and a token refuse", async () => {
    const r = await firstActivation();
    const other = await createRun(r.h, r.projectId, RunKind.CONTRACT_CHANGE);
    try {
      const put = (runId: string, note: string) => () => r.h.cp.artifacts.put(runId, "HANDOFF", { note });
      const eventId = hex("an accepted Buzz event");
      r.h.cp.db.run(`INSERT INTO buzz_events (event_id, payload_json) VALUES (?, ?)`, [eventId, "{}"]);
      const contractDigest = r.h.cp.runs.require(r.run.runId).contractDigest;
      for (const note of [
        `PLAN ${r.planDigest}, contract ${contractDigest}.`,
        `manifest ${manifestDigest(r.m1)}`,
        `PLAN by bare hex ${r.planDigest.slice("sha256:".length)}`,
        `Buzz event ${eventId}`,
      ]) {
        expect(put(r.run.runId, note), note).not.toThrow();
      }
      for (const note of [
        `unbound ${UNBOUND}`,
        `unbound bare ${UNBOUND.slice("sha256:".length)}`,
        `exposed=${hex("not an id")}`,
        `${r.planDigest} ${TOKEN}`,
        `Buzz event ${hex("an event never accepted")}`,
        // G-3: the PLAN declares this workflow digest, and ACP has not read the workflow yet (no freeze).
        `workflow ${sha256(WORKFLOW)}`,
      ]) {
        expect(put(r.run.runId, note), note).toThrow(/contains a credential/);
      }
      // Bound to the run it names: this run's PLAN is not another run's record.
      expect(put(other.runId, `PLAN ${r.planDigest}`)).toThrow(/contains a credential/);
      // The workflow bytes ACP read for a review are a record once that readback is stored.
      const observed = sha256("workflow bytes read at the bound commit");
      expect(put(r.run.runId, `observed ${observed}`)).toThrow(/contains a credential/);
      r.h.cp.artifacts.put(r.run.runId, "HANDOFF", {
        schema: CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA, runId: r.run.runId,
        workflowRevisions: [{ read: { status: "READ", observedDigest: observed } }],
      });
      expect(put(r.run.runId, `observed ${observed}`)).not.toThrow();
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("run_create: references naming an accepted Buzz event store; an unknown 64-hex id is refused", async () => {
    const r = await firstActivation();
    try {
      const eventId = hex("a Buzz event the run was asked from");
      r.h.cp.db.run(`INSERT INTO buzz_events (event_id, payload_json) VALUES (?, ?)`, [eventId, "{}"]);
      const create = (references: string[]) => {
        try {
          return r.h.cp.runs.create({
            projectId: r.projectId, kind: RunKind.CONTRACT_CHANGE, executionMode: r.run.executionMode,
            contract: { ...CONTRACT_CHANGE_CONTRACT, references }, repositories: [],
          });
        } catch (error) {
          return { allowed: false as const, error };
        }
      };
      const accepted = create([`Buzz event ${eventId}`, `buzz:${eventId}`]);
      expect(accepted.allowed, JSON.stringify(accepted)).toBe(true);
      expect(create([`Buzz event ${hex("an event never accepted")}`]).allowed).toBe(false);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("audit text: a bound digest in a rationale is kept, an unbound one is redacted", async () => {
    const r = await firstActivation();
    try {
      const record = (rationale: string) => {
        const recorded = r.h.cp.audit.record({ kind: "TEST_RATIONALE", runId: r.run.runId, evidence: { rationale } });
        expect(recorded.allowed).toBe(true);
        return r.h.cp.audit.byKind("TEST_RATIONALE").at(-1)!.evidence["rationale"];
      };
      expect(record(`confirm PLAN ${r.planDigest}`)).toBe(`confirm PLAN ${r.planDigest}`);
      expect(record(`confirm PLAN ${UNBOUND}`)).toBe("confirm PLAN sha256:[redacted]");
    } finally { r.h.cp.close(); }
  }, 60_000);
});

describe("#1255: the CONTRACT_CHANGE first-activation packet carries the PLAN and ACP's readback at freeze", () => {
  it("the packet holds the CTO's PLAN fields, the workflow's observed digest at its bound commit and the repository readback, matching the stored rows", async () => {
    const r = await firstActivation();
    try {
      r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
      const result = await submit(r);
      expect(result.allowed, JSON.stringify(result)).toBe(true);
      const prompts = contractChangePrompts(r.h);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;

      const plan = r.h.cp.artifacts.latest<Record<string, unknown>>(r.run.runId, "PLAN")!.content;
      expect(prompt).toContain("### The CTO's PLAN");
      expect(prompt).toContain("ACP has not verified what it states.");
      const shown = fencedJsonAfter(prompt, "### The CTO's PLAN") as Record<string, unknown>;
      expect(shown).toMatchObject({
        summary: PLAN_TEXT.summary,
        firstActivation: true,
        repositoryContentChange: false,
        risks: PLAN_TEXT.risks,
        verificationIntent: PLAN_TEXT.verificationIntent,
        workflowRevisions: revisionsFor(r.m1, r.bound),
        projectManifestDigest: manifestDigest(r.m1),
      });
      // Every field shown is the stored PLAN's own; the manifest itself is the proposed manifest above.
      expect(shown).toEqual(Object.fromEntries(Object.keys(shown).map((key) => [key, plan[key]])));
      expect(shown).not.toHaveProperty("projectManifest");
      expect(prompt).toContain("Not shown, over the packet bound (not truncated): none");

      const candidate = r.h.cp.runs.currentCandidate(r.run.runId)!;
      const readback = fencedJsonAfter(prompt, "### ACP readback at the candidate's freeze") as ContractChangeReviewContext;
      expect(readback).toEqual(storedContext(r.h, r.run.runId, candidate));
      expect(readback).toMatchObject({ candidateSnapshotDigest: candidate, planDigest: r.planDigest });
      // The project's registration and active manifest, as stored.
      expect(readback.project).toMatchObject({
        projectId: r.projectId,
        activeManifestDigest: null,
        registrations: [{ eventId: r.registrationEventId, activeManifestDigest: null }],
        bootstrapApplications: 0,
      });
      // The repository: its stored observation and its checkout as read at the freeze.
      const row = r.h.cp.db.get<{ identity: string; last_observed_head: string | null; drift_state: string }>(
        `SELECT identity, last_observed_head, drift_state FROM repositories WHERE project_id = ?`, [r.projectId])!;
      expect(readback.repositories).toHaveLength(1);
      expect(readback.repositories[0]).toMatchObject({
        identity: row.identity,
        role: "primary",
        registration: "REGISTERED",
        lastObservedHead: row.last_observed_head,
        driftState: row.drift_state,
        checkout: { status: "READ", head: gitSync(r.repoPath, ["rev-parse", "HEAD"]), branch: "dev", clean: true },
      });
      expect(readback.repositories[0]!.registeredEvents).toHaveLength(1);
      // The bound workflow revision, read at its exact commit with the bytes' digest the PLAN binds.
      expect(readback.workflowRevisions).toEqual([{
        ...revisionsFor(r.m1, r.bound)[0]!,
        read: {
          status: "READ",
          observedDigest: sha256(WORKFLOW),
          blobSha: gitSync(r.repoPath, ["rev-parse", `${r.bound}:${WORKFLOW_PATH}`]),
          readVia: "LOCAL",
        },
      }]);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("a PLAN field over the packet bound is named with its size, not shown and not cut", async () => {
    // Words, not one unbroken run: a long run of letters is itself a credential shape.
    const long = "risk ".repeat(200).concat("x");
    const r = await firstActivation({ ...PLAN_TEXT, risks: ["a short risk", long] });
    try {
      r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
      expect((await submit(r)).allowed).toBe(true);
      const prompt = contractChangePrompts(r.h)[0]!;
      const shown = fencedJsonAfter(prompt, "### The CTO's PLAN") as Record<string, unknown>;
      expect(shown).not.toHaveProperty("risks");
      expect(shown).toMatchObject({ summary: PLAN_TEXT.summary, firstActivation: true });
      expect(prompt).toContain("Not shown, over the packet bound (not truncated): risks[1]: 1001 characters, bound 1000");
      expect(prompt).not.toContain(long.slice(0, 200));
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("the packet shows the readback captured at the freeze, not values read at review time, and names a missing one", async () => {
    const r = await firstActivation();
    try {
      const frozen = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(frozen.allowed, JSON.stringify(frozen)).toBe(true);
      if (!frozen.allowed) return;
      const atFreeze = gitSync(r.repoPath, ["rev-parse", "HEAD"]);
      // After the freeze: the checkout moves, and the registry records drift.
      writeFiles(r.repoPath, { "later.txt": "after the freeze\n" });
      const later = commitAll(r.repoPath, "after the freeze");
      r.h.cp.db.run(`UPDATE repositories SET drift_state = 'DRIFTED' WHERE project_id = ?`, [r.projectId]);

      const contract = r.h.cp.artifacts.latest<TaskContract>(r.run.runId, "TASK_CONTRACT")!.content;
      const review = (snapshot: typeof frozen.value) => {
        r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
        return r.h.cp.review.controlPlaneInvoker()({
          kind: "CONTRACT_CHANGE", runId: r.run.runId, snapshot, contract, contractDigest: r.run.contractDigest,
        });
      };
      const reviewed = await review(frozen.value);
      expect(reviewed.allowed, JSON.stringify(reviewed)).toBe(true);
      const readback = fencedJsonAfter(contractChangePrompts(r.h).at(-1)!, "### ACP readback at the candidate's freeze") as ContractChangeReviewContext;
      expect(readback.candidateSnapshotDigest).toBe(candidateSnapshotDigest(frozen.value));
      expect(readback.repositories[0]!.checkout).toMatchObject({ status: "READ", head: atFreeze });
      expect(readback.repositories[0]!.driftState).not.toBe("DRIFTED");
      expect(JSON.stringify(readback)).not.toContain(later);

      // A candidate frozen with no readback stored (as before this change) is reviewed with it named missing.
      // The candidate digest covers the PLAN, not the freeze time, so a new PLAN makes a new candidate.
      const replanned = createCtoMcpPort(r.h.cp).submitPlan(r.run.runId, {
        ...firstPlan(r.m1, revisionsFor(r.m1, r.bound)), ...PLAN_TEXT, summary: "The same first activation, restated.",
      });
      expect(replanned.allowed, JSON.stringify(replanned)).toBe(true);
      const binding = { ...frozen.value.contractChange!, planDigest: r.h.cp.artifacts.latest(r.run.runId, "PLAN")!.digest };
      const bare = buildNoRepositoryCandidateSnapshot({ runId: r.run.runId, contractDigest: r.run.contractDigest, contractChange: binding }, r.h.cp.clock);
      const bareDigest = candidateSnapshotDigest(bare);
      r.h.cp.artifacts.put(r.run.runId, "CANDIDATE_SNAPSHOT", bare, bareDigest);
      r.h.cp.runs.promoteCandidate(r.run.runId, bareDigest);
      expect(storedContext(r.h, r.run.runId, bareDigest)).toBeNull();
      const again = await review(bare);
      expect(again.allowed, JSON.stringify(again)).toBe(true);
      expect(contractChangePrompts(r.h).at(-1)).toContain("MISSING: ACP stored no readback for this candidate");
    } finally { r.h.cp.close(); }
  }, 60_000);
});

/** The run's audit rows of one kind. */
const auditOf = (r: FirstActivation, kind: string) => r.h.cp.audit.forRun(r.run.runId).filter((row) => row.kind === kind);

/** Reviews the run's current candidate with a passing answer and returns the readback section of its prompt. */
const reviewCurrent = async (r: FirstActivation, snapshot: Parameters<typeof candidateSnapshotDigest>[0]): Promise<string> => {
  const contract = r.h.cp.artifacts.latest<TaskContract>(r.run.runId, "TASK_CONTRACT")!.content;
  r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([r.coverage]) });
  const reviewed = await r.h.cp.review.controlPlaneInvoker()({
    kind: "CONTRACT_CHANGE", runId: r.run.runId, snapshot, contract, contractDigest: r.run.contractDigest,
  });
  expect(reviewed.allowed, JSON.stringify(reviewed)).toBe(true);
  const prompt = contractChangePrompts(r.h).at(-1)!;
  return prompt.slice(prompt.indexOf("### ACP readback at the candidate's freeze"));
};

describe("#1279 G-1..G-6: counterexamples to the restored #1254/#1255 change", () => {
  it("G-1: a bound digest's hex skips the long-base64 shape only: `ghp_<bound hex>` is refused in artifact text and a review, and redacted in audit text", async () => {
    const r = await firstActivation();
    try {
      const boundHex = r.planDigest.slice("sha256:".length);
      const ghp = `ghp_${boundHex}`;
      const put = (note: string) => () => r.h.cp.artifacts.put(r.run.runId, "HANDOFF", { note });
      expect(put(`PLAN ${boundHex}`)).not.toThrow();
      expect(put(`see ${ghp}`)).toThrow(/contains a credential/);
      expect(put(`Authorization: Bearer ${boundHex}`)).toThrow(/contains a credential/);
      expect(r.h.cp.audit.record({ kind: "TEST_RATIONALE", runId: r.run.runId, evidence: { rationale: `confirm ${ghp}` } }).allowed).toBe(true);
      expect(r.h.cp.audit.byKind("TEST_RATIONALE").at(-1)!.evidence["rationale"]).toBe("confirm [redacted]");

      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, `the PLAN ${ghp}`, "evidence is missing") });
      const refused = await submit(r);
      expect(refused.allowed && refused.value, JSON.stringify(refused)).toMatchObject({ stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
      expect(auditOf(r, "BLIND_REVIEW_STORAGE_REFUSED").map((row) => row.evidence["field"])).toEqual(["omittedItems"]);
      expect(r.h.cp.artifacts.list(r.run.runId, "BLIND_REVIEW")).toEqual([]);
      expect(JSON.stringify(r.h.cp.audit.forRun(r.run.runId))).not.toContain(ghp);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G-2: a whole digest in a reviewer's field is exempt only when bound; a field typed as a digest keeps the whole-value rule", async () => {
    const r = await firstActivation();
    try {
      // The store's own check, at the BLIND_REVIEW write site of this run.
      const site = { writer: "BLIND_REVIEW", runId: r.run.runId, registry: registryView(r.h.cp.db) };
      const field = (record: Record<string, unknown>) => credentialBearingField(record, 0, [], site);
      expect(field({ omittedItems: [UNBOUND] })).toBe("omittedItems");
      expect(field({ omittedItems: [UNBOUND.slice("sha256:".length)] })).toBe("omittedItems");
      expect(field({ findings: [{ detail: UNBOUND }] })).toBe("detail");
      expect(field({ coveredFiles: [UNBOUND] })).toBe("coveredFiles");
      expect(field({ omittedItems: [r.planDigest] })).toBeNull();
      expect(field({ coveredFiles: [r.coverage] })).toBeNull();
      expect(field({ candidateSnapshotDigest: UNBOUND, inputManifest: { reviewerPromptDigests: [UNBOUND] } })).toBeNull();

      // End to end: an unbound digest as a whole omitted item refuses the review; the bound one is stored.
      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, UNBOUND, "evidence is missing") });
      const refused = await submit(r);
      expect(refused.allowed && refused.value, JSON.stringify(refused)).toMatchObject({ stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
      expect(auditOf(r, "BLIND_REVIEW_STORAGE_REFUSED").map((row) => row.evidence["field"])).toEqual(["omittedItems"]);
      expect(r.h.cp.artifacts.list(r.run.runId, "BLIND_REVIEW")).toEqual([]);

      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, r.planDigest, "evidence is missing") });
      const stored = await submit(r);
      expect(stored.allowed && stored.value.stage, JSON.stringify(stored)).toBe("REVISION_REQUIRED");
      const packet = r.h.cp.artifacts.list<ReviewPacket>(r.run.runId, "BLIND_REVIEW").at(-1)!.content;
      expect(packet.omittedItems).toEqual([r.planDigest]);

      // run_create: a task contract types no field as a digest, so a whole 64-hex reference is one only when bound.
      const eventId = hex("a Buzz event a run was asked from, named whole");
      r.h.cp.db.run(`INSERT INTO buzz_events (event_id, payload_json) VALUES (?, ?)`, [eventId, "{}"]);
      const create = (references: string[]) => {
        try {
          return r.h.cp.runs.create({
            projectId: r.projectId, kind: RunKind.CONTRACT_CHANGE, executionMode: r.run.executionMode,
            contract: { ...CONTRACT_CHANGE_CONTRACT, references }, repositories: [],
          }).allowed;
        } catch { return false; }
      };
      expect(create([eventId])).toBe(true);
      expect(create([hex("an event never accepted, named whole")])).toBe(false);
      expect(create([UNBOUND])).toBe(false);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G-3: a workflow digest the PLAN only declares binds nothing; the bytes ACP read at the bound commit do", async () => {
    const declared = sha256("workflow bytes a PLAN declared and ACP never read");
    const r = await firstActivation(PLAN_TEXT, [{ ...unitTestsWorkflow, approvedDigest: declared }]);
    try {
      const plan = r.h.cp.artifacts.latest<{ workflowRevisions: Array<{ fileDigest: string }> }>(r.run.runId, "PLAN")!.content;
      expect(plan.workflowRevisions[0]!.fileDigest).toBe(declared);
      const put = (note: string) => () => r.h.cp.artifacts.put(r.run.runId, "HANDOFF", { note });
      expect(put(`workflow ${declared}`)).toThrow(/contains a credential/);
      expect(put(`workflow ${declared.slice("sha256:".length)}`)).toThrow(/contains a credential/);
      // The manifest the PLAN carries is hashed by ACP and checked against the digest the PLAN names.
      expect(put(`manifest ${manifestDigest(r.m1)}`)).not.toThrow();

      // A freeze reads the workflow at the bound commit: its real bytes' digest is now a record, the declared one is not.
      const frozen = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(frozen.allowed, JSON.stringify(frozen)).toBe(true);
      expect(put(`workflow ${sha256(WORKFLOW)}`)).not.toThrow();
      expect(put(`workflow ${declared}`)).toThrow(/contains a credential/);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G-4: a token in a finding's detail refuses the review before anything is stored and records the refusal", async () => {
    const r = await firstActivation();
    try {
      r.h.scripted.script({ match: /Contract change review/, text: blocking(r, "the registration facts", `the log printed ${TOKEN}`) });
      const refused = await submit(r);
      expect(refused.allowed && refused.value, JSON.stringify(refused)).toMatchObject({ stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
      expect(r.h.cp.artifacts.list(r.run.runId, "BLIND_REVIEW")).toEqual([]);
      const refusal = auditOf(r, "BLIND_REVIEW_STORAGE_REFUSED");
      expect(refusal).toHaveLength(1);
      expect(refusal[0]!.evidence).toMatchObject({
        candidateSnapshotDigest: r.h.cp.runs.currentCandidate(r.run.runId)!, kind: "BLIND_REVIEW", field: "detail", verdict: "BLOCK", findings: 1,
      });
      expect(auditOf(r, "BLIND_REVIEW_COMPLETED")).toEqual([]);
      expect(auditOf(r, "BLIND_REVIEW_UNAVAILABLE")).toHaveLength(1);
      expect(r.h.cp.runs.require(r.run.runId).state).toBe(RunState.ACTIVE);
      expect(JSON.stringify(r.h.cp.audit.forRun(r.run.runId))).not.toContain(TOKEN);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G-5: HEAD advanced before the freeze: the readback shows the recomputed DRIFTED and its cause beside the stored value", async () => {
    const r = await firstActivation();
    try {
      writeFiles(r.repoPath, { "before-freeze.txt": "moved before the freeze\n" });
      const moved = commitAll(r.repoPath, "moved before the freeze");
      const frozen = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(frozen.allowed, JSON.stringify(frozen)).toBe(true);
      if (!frozen.allowed) return;
      const section = await reviewCurrent(r, frozen.value);
      const readback = fencedJsonAfter(section, "### ACP readback at the candidate's freeze") as ContractChangeReviewContext;
      expect(readback.repositories[0]).toMatchObject({
        lastObservedHead: r.bound,
        driftState: "IN_SYNC",
        checkout: { status: "READ", head: moved, branch: "dev", clean: true, observedDriftState: "DRIFTED", observedDriftCauses: ["HEAD_NOT_ACCEPTED_HEAD"] },
      });
      expect(section).toContain("observedDriftState and observedDriftCauses are the drift ACP recomputed");
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G-6: freeze, a credential-shaped branch, freeze again: the readback is named missing with its refusal, never the first freeze's", async () => {
    const r = await firstActivation();
    try {
      const first = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(first.allowed, JSON.stringify(first)).toBe(true);
      if (!first.allowed) return;
      const candidate = candidateSnapshotDigest(first.value);
      const earlier = storedContext(r.h, r.run.runId, candidate)!;
      expect(earlier.repositories[0]!.checkout).toMatchObject({ status: "READ", branch: "dev" });

      gitSync(r.repoPath, ["checkout", "-q", "-b", TOKEN]);
      const second = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(second.allowed, JSON.stringify(second)).toBe(true);
      if (!second.allowed) return;
      expect(candidateSnapshotDigest(second.value)).toBe(candidate);

      const section = await reviewCurrent(r, second.value);
      expect(section).toContain("MISSING: ACP stored no readback for this candidate: the readback ACP read at its latest freeze");
      expect(section).toContain(`refused at storage (${ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED}, field branch)`);
      expect(section).not.toContain(earlier.freezeId);
      expect(section).not.toContain(TOKEN);

      // Each freeze names what it stored for the readback; the refused one holds none of the refused text.
      const frozen = auditOf(r, "CANDIDATE_FROZEN").map((row) => row.evidence["reviewContext"]);
      expect(frozen).toMatchObject([
        { status: "STORED", freezeId: earlier.freezeId },
        { status: "REFUSED", reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, field: "branch" },
      ]);
      expect(JSON.stringify(r.h.cp.artifacts.list(r.run.runId, "HANDOFF"))).not.toContain(TOKEN);
    } finally { r.h.cp.close(); }
  }, 60_000);
});

describe("#1254 sibling: an MCP mutation whose handler throws a refusal keeps that refusal as its outcome", () => {
  const request = { toolName: "effect", arguments: {}, authority: () => allow(ReasonCode.OK, {}) };

  it("a replay of the key returns the same refusal without running the handler; a new key runs it again", async () => {
    const h = makeHarness();
    let runs = 0;
    const refuse = () => {
      runs += 1;
      throw acpError(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, "BLIND_REVIEW contains a credential and cannot be stored as evidence", {
        runId: "run_0123456789abcdef01234567", kind: "BLIND_REVIEW", field: "omittedItems",
      });
    };
    try {
      const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "refused-1", refuse, request);
      expect(first.isError).toBe(true);
      expect(first.structuredContent).toEqual({
        ok: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        message: "BLIND_REVIEW contains a credential and cannot be stored as evidence",
        evidence: { runId: "run_0123456789abcdef01234567", kind: "BLIND_REVIEW", field: "omittedItems" },
      });
      expect(await idempotentMcpMutation(h.cp, { actor: "peer" }, "refused-1", refuse, request)).toEqual(first);
      expect(runs).toBe(1);
      expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "refused-2", () => ok("done"), request)).structuredContent)
        .toMatchObject({ ok: true });
    } finally { h.cp.close(); }
  });

  it("a thrown refusal carrying a token is kept by its reason code alone", async () => {
    const h = makeHarness();
    try {
      const leak = () => { throw acpError(ReasonCode.INVALID_ARGUMENT, `bad value ${TOKEN}`, { value: TOKEN }); };
      const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "refused-secret", leak, request);
      expect(first.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: {} });
      expect(JSON.stringify(first)).not.toContain(TOKEN);
      const row = h.cp.db.get<{ result_json: string }>(`SELECT result_json FROM inbound_messages WHERE nonce = 'refused-secret'`)!;
      expect(row.result_json).not.toContain(TOKEN);
      expect(await idempotentMcpMutation(h.cp, { actor: "peer" }, "refused-secret", leak, request)).toEqual(first);
    } finally { h.cp.close(); }
  });
});

describe("#1279 G3: free text needs a bound digest; a readback's drift rests on the head it shows", () => {
  const thrower = (error: unknown) => () => { throw error; };

  it("G3-1: a thrown refusal is free text: an unbound digest or id in its evidence or message is not stored; a bound one and ACP's ids are", async () => {
    const r = await firstActivation();
    try {
      const request = { toolName: "effect", arguments: { runId: r.run.runId }, authority: () => allow(ReasonCode.OK, {}) };
      const call = (key: string, error: unknown) => idempotentMcpMutation(r.h.cp, { actor: "peer" }, key, thrower(error), request);
      const stored = (key: string) => r.h.cp.db.get<{ result_json: string }>(`SELECT result_json FROM inbound_messages WHERE nonce = ?`, [key])!.result_json;
      const unboundHex = UNBOUND.slice("sha256:".length);

      // The review's repro: the exact unbound 64-hex as a whole evidence value.
      const repro = await call("g3-evidence", acpError(ReasonCode.INVALID_ARGUMENT, "refused input", { detail: unboundHex }));
      expect(repro.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: {} });
      expect(stored("g3-evidence")).not.toContain(unboundHex);
      // The same as a whole digest, and as a whole message.
      await call("g3-digest", acpError(ReasonCode.INVALID_ARGUMENT, "refused input", { detail: UNBOUND }));
      expect(stored("g3-digest")).not.toContain(unboundHex);
      await call("g3-message", acpError(ReasonCode.INVALID_ARGUMENT, UNBOUND));
      expect(stored("g3-message")).not.toContain(unboundHex);

      // Bound to the run the call names: kept as thrown, beside ACP's own ids.
      const evidence = {
        planDigest: r.planDigest, planHex: r.planDigest.slice("sha256:".length), runId: r.run.runId,
        taskId: "task_0123456789abcdef01234567", messageId: "msg_0123456789abcdef01234567",
      };
      const kept = await call("g3-bound", acpError(ReasonCode.CONFLICT, r.planDigest, evidence));
      expect(kept.structuredContent).toEqual({ ok: false, reasonCode: ReasonCode.CONFLICT, message: r.planDigest, evidence });
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G3-1: an unbound whole digest in a PLAN's summary, risks or intents is refused; a bound one stores", async () => {
    const r = await firstActivation();
    try {
      const port = createCtoMcpPort(r.h.cp);
      const plan = (text: Record<string, unknown>) => () => port.submitPlan(r.run.runId, { ...firstPlan(r.m1, revisionsFor(r.m1, r.bound)), ...PLAN_TEXT, ...text });
      for (const text of [
        { summary: UNBOUND }, { summary: UNBOUND.slice("sha256:".length) },
        { risks: [UNBOUND] }, { verificationIntent: [UNBOUND] }, { repositoryIntent: [UNBOUND] },
      ]) {
        expect(plan(text), JSON.stringify(text)).toThrow(/PLAN contains a credential/);
      }
      expect(plan({ summary: r.planDigest })().allowed).toBe(true);
      expect(plan({ risks: [r.planDigest.slice("sha256:".length)] })().allowed).toBe(true);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G3-1: an unbound whole digest in a HANDOFF's note is refused; a bound one stores", async () => {
    const r = await firstActivation();
    try {
      const put = (note: unknown) => () => r.h.cp.artifacts.put(r.run.runId, "HANDOFF", { note });
      for (const note of [UNBOUND, UNBOUND.slice("sha256:".length), [UNBOUND]]) {
        expect(put(note), JSON.stringify(note)).toThrow(/HANDOFF contains a credential/);
      }
      expect(put(r.planDigest)).not.toThrow();
      expect(put(r.planDigest.slice("sha256:".length))).not.toThrow();
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G3-1: a CEO's whole rationale is kept only when bound", async () => {
    const r = await firstActivation();
    try {
      const rationale = (text: string) => {
        expect(r.h.cp.audit.record({ kind: "CEO_DECISION", runId: r.run.runId, evidence: { decision: "FINAL_REVISE", rationale: text } }).allowed).toBe(true);
        return r.h.cp.audit.byKind("CEO_DECISION").at(-1)!.evidence["rationale"];
      };
      expect(rationale(UNBOUND)).toBe("sha256:[redacted]");
      expect(rationale(UNBOUND.slice("sha256:".length))).toBe("[redacted]");
      expect(rationale(r.planDigest)).toBe(r.planDigest);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G3-1 unchanged: ACP's own audit id fields (to, channel, nonce, run, task, message ids) keep a whole 64-hex id", async () => {
    const r = await firstActivation();
    try {
      const ids = {
        to: hex("a recipient's public key"), channel: hex("a Buzz channel"), nonce: hex("a Buzz event never accepted"),
        runId: r.run.runId, taskId: "task_0123456789abcdef01234567", messageId: "msg_0123456789abcdef01234567",
      };
      expect(r.h.cp.audit.record({ kind: "TEST_ACP_IDS", runId: r.run.runId, evidence: ids }).allowed).toBe(true);
      expect(r.h.cp.audit.byKind("TEST_ACP_IDS").at(-1)!.evidence).toEqual(ids);
    } finally { r.h.cp.close(); }
  }, 60_000);

  it("G3-2: a head accepted while another repository's inspection awaits git: each repository's drift rests on the head its readback shows", async () => {
    const secondPath = makeRepo({ "README.md": "# second\n" }, "dev");
    const r = await firstActivation(PLAN_TEXT, [unitTestsWorkflow], { secondCheckout: secondPath });
    try {
      const first = r.h.cp.repositories.byIdentity(FIRST_IDENTITY)!;
      const second = r.h.cp.repositories.byIdentity(SECOND_IDENTITY)!;
      const registered = second.lastObservedHead;
      writeFiles(secondPath, { "moved.txt": "moved\n" });
      const moved = commitAll(secondPath, "moved");

      const inspect = r.h.cp.repositories.inspect.bind(r.h.cp.repositories);
      vi.spyOn(r.h.cp.repositories, "inspect").mockImplementation(async (id) => {
        const read = inspect(id);
        // While the first repository's inspection awaits git, the second repository's new head is accepted.
        if (id === first.repositoryId) r.h.cp.repositories.acknowledgeHead(second.repositoryId, moved);
        return read;
      });
      const frozen = await r.h.cp.pipeline.freeze(r.run.runId);
      expect(frozen.allowed, JSON.stringify(frozen)).toBe(true);
      if (!frozen.allowed) return;
      const stored = storedContext(r.h, r.run.runId, candidateSnapshotDigest(frozen.value))!;
      expect(stored.repositories.map((repository) => repository.identity)).toEqual([FIRST_IDENTITY, SECOND_IDENTITY]);
      expect(registered).not.toBe(moved);
      for (const repository of stored.repositories) {
        const { checkout } = repository;
        expect(checkout.status, repository.identity).toBe("READ");
        if (checkout.status !== "READ") continue;
        // The drift agrees with the registry head the readback stores for the repository ...
        expect(checkout.observedDriftCauses.includes("HEAD_NOT_ACCEPTED_HEAD"), repository.identity).toBe(checkout.head !== repository.lastObservedHead);
        expect(checkout.observedDriftState === "IN_SYNC", repository.identity).toBe(checkout.head === repository.lastObservedHead && checkout.clean && repository.driftState !== "DRIFTED");
      }
      // ... which is the head the inspection decided it against, stored beside it.
      for (const repository of stored.repositories) {
        expect(repository.checkout, repository.identity).toMatchObject({ acceptedHead: repository.lastObservedHead });
      }
      expect(stored.repositories[1]).toMatchObject({ lastObservedHead: moved, checkout: { head: moved, acceptedHead: moved, observedDriftState: "IN_SYNC" } });
    } finally { r.h.cp.close(); }
  }, 60_000);
});

describe("#1279 G4: a refusal's keys are text it stores, and content past the scan is not clean", () => {
  const request = { toolName: "effect", arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
  /** `leaf` inside `levels` objects, each holding the next at `detail`. */
  const nested = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> => {
    let value = leaf;
    for (let level = 0; level < levels; level += 1) value = { detail: value };
    return value;
  };
  const storedResult = (h: Harness, key: string): string =>
    h.cp.db.get<{ result_json: string }>(`SELECT result_json FROM inbound_messages WHERE nonce = ?`, [key])!.result_json;

  it("G4-1: a token as an evidence key is neither stored nor replayed; the refusal keeps its reason code", async () => {
    const h = makeHarness();
    let runs = 0;
    const refuse = () => { runs += 1; throw acpError(ReasonCode.INVALID_ARGUMENT, "refused input", { [TOKEN]: "refused" }); };
    try {
      const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "g4-key", refuse, request);
      expect(first.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: {} });
      expect(JSON.stringify(first)).not.toContain(TOKEN);
      expect(storedResult(h, "g4-key")).not.toContain(TOKEN);
      const replay = await idempotentMcpMutation(h.cp, { actor: "peer" }, "g4-key", refuse, request);
      expect(replay).toEqual(first);
      expect(runs).toBe(1);
      // The shared detector finds such a key at any depth and names it without repeating it.
      const found = credentialBearingField({ evidence: { outer: { [TOKEN]: "refused" } } });
      expect(found).not.toBeNull();
      expect(found).not.toContain(TOKEN);
      // A key is read by the field rules a value at its path gets: a whole ACP digest keying a typed record stays storable.
      expect(credentialBearingField({ byDigest: { [UNBOUND]: 1 } })).toBeNull();
    } finally { h.cp.close(); }
  });

  it("G4-2: raw output nested past the old depth-8 scan is not stored; content past any scan is unsafe", async () => {
    const h = makeHarness();
    const PRIVATE = "private model output that must not be stored";
    let runs = 0;
    const refuse = () => {
      runs += 1;
      throw acpError(ReasonCode.INVALID_ARGUMENT, "refused input", nested(8, { rawOutput: PRIVATE }));
    };
    try {
      const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "g4-depth", refuse, request);
      expect(first.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: {} });
      expect(storedResult(h, "g4-depth")).not.toContain(PRIVATE);
      expect(await idempotentMcpMutation(h.cp, { actor: "peer" }, "g4-depth", refuse, request)).toEqual(first);
      expect(runs).toBe(1);
      // Deeper than the scan goes is refused rather than treated as examined and clean.
      expect(prohibitedDurableField(nested(40, { note: "never examined" }))).not.toBeNull();
      expect(prohibitedDurableField(nested(8, { note: "examined" }))).toBeNull();
    } finally { h.cp.close(); }
  });
});
