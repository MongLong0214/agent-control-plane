import Database from "better-sqlite3";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow, deny } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { ExecutionMode, Role, roleKeyFor, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { RunEvidenceExporter } from "../../src/export/run-evidence.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { DogfoodFindingStore, UpstreamDogfoodReporter, type UpstreamIssuePort } from "../../src/quality/upstream-dogfood.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { GitDataGitHub, bareRemoteAt } from "../helpers/git-data-github.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, dispatchBootstrapRun, makeHarness, ownerDecisionReceipt, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A STANDARD_WORK run's private review evidence: the owning CTO stages a bundle, the canonical CEO binds
 * it, and the next freeze carries it into the review. Every marker here is synthetic.
 */
type Args = Record<string, unknown>;
const MARKER = "SYNTHETIC-PRIVATE-EXCERPT-7c41";
const WORK_BRANCH = "feature/F1-evidence";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const GIT_DATA = /\/git\/(?:blobs|trees|commits|refs)$|\/git\/ref\/heads\/|\/branches\?/;
type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const SOURCE = "a synthetic private source the excerpt is cut from";
const EXCERPT = { originalSha256: sha256(SOURCE), omitted: true, ranges: [
  { section: "failure", startLine: 4, endLine: 4 }, { section: "fix", startLine: 9, endLine: 9 }, { section: "result", startLine: 12, endLine: 12 }] };
const fileFor = (body: string, excerpt: Args | undefined = EXCERPT) => {
  const bytes = Buffer.from(body, "utf8");
  return { path: "handoff/excerpt.md", sha256: sha256(bytes), origin: "private handoff, synthetic", grade: "review-original",
    bodyBase64: bytes.toString("base64"), ...(excerpt ? { excerpt } : {}) };
};
const bundleFor = (runId: string, contractDigest: string, text: string, files: Args[] = [fileFor(`## result\n${text}\n`)]) =>
  JSON.stringify({ runId, contractDigest, missing: ["the rest of the source"], files });

async function fixture(options: { finalization?: boolean; humanGate?: string[] } = {}) {
  const github = new FakeGitHub();
  const log: Array<{ method: HttpMethod; path: string; body?: unknown }> = [];
  const holder: { gitData: GitDataGitHub | null } = { gitData: null };
  const router: GitHubClient = {
    request: async <T>(method: HttpMethod, path: string, body?: unknown, requestOptions?: Parameters<GitHubClient["request"]>[3]) => {
      log.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (holder.gitData && GIT_DATA.test(path)) return holder.gitData.request<T>(method, path, body, requestOptions);
      const head = holder.gitData?.head(WORK_BRANCH);
      if (head) github.setBranch(WORK_BRANCH, head);
      return github.request<T>(method, path, body);
    },
  };
  const h = makeHarness(options.finalization ? { githubClient: router } : {});
  if (options.finalization) {
    h.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    writeFiles(h.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
    commitAll(h.repoPath, "add trusted project CI workflow");
  }
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, "fixture-project", options.finalization
    ? { ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }] }
    : {});
  const ceo = bindCeo(h);
  const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
    acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: options.humanGate ?? [], references: [] };
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId: impl.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, impl.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(h.repoPath, WORK_BRANCH);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });

  const lineage = digestOf("standard review evidence lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const servers: Array<{ close(): Promise<void> }> = [];
  const refusals: string[] = [];
  async function connect(kind: "cto" | "hermes", sessionId: string) {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "standard-review-evidence", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      const body = (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
      if (body["ok"] !== true) refusals.push(JSON.stringify(body));
      return body;
    };
  }
  const cto = await connect("cto", run.ownerSessionId!);
  const hermes = await connect("hermes", ceo);
  const stagedBy = run.ownerRoleKey!;
  const stage = (key: string, text: string, overrides: Args = {}) => {
    const evidenceBody = bundleFor(run.runId, run.contractDigest, text);
    return cto("review_evidence_stage", { idempotencyKey: key, runId: run.runId, contractDigest: run.contractDigest, evidenceBody, expectedSha256: sha256(evidenceBody), ...overrides });
  };
  const attach = (key: string, text: string, overrides: Args = {}) => hermes("review_evidence_attach", { idempotencyKey: key, runId: run.runId,
    contractDigest: run.contractDigest, stagedBy, expectedSha256: sha256(bundleFor(run.runId, run.contractDigest, text)), ...overrides });
  const submit = () => h.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app returns 2", recommendation: "merge" });
  const snapshots = () => h.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT");
  const reviews = () => h.cp.artifacts.list<ReviewPacket>(run.runId, "BLIND_REVIEW");
  const reviewerInputs = () => h.scripted.invocations.filter((call) => call.prompt.includes("Candidate review")).map((call) => call.prompt);
  const confirm = (candidateSnapshotDigest: string) => h.cp.ceo.submitCeoDecision({ runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest,
    ceoSessionId: ceo, rationale: "evidence reviewed" });
  const tamper = (artifactId: string, content: Args) => {
    const raw = new Database(h.cp.db.raw.name);
    try {
      raw.function("acp_evidence_write_authorized", () => 0);
      raw.exec("DROP TRIGGER IF EXISTS run_artifacts_content_immutable");
      raw.prepare("UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?").run(JSON.stringify(content), artifactId);
    } finally { raw.close(); }
  };
  return { h, github, holder, log, run, ceo, identity, projectId, contract, connect, cto, hermes, stage, attach, submit, snapshots, reviews, reviewerInputs,
    confirm, tamper, refusals, stagedBy,
    close: async () => { for (const s of servers.reverse()) await s.close(); h.cp.close(); } };
}

const pass = (identity: string, extra: Args = {}) => JSON.stringify({ verdict: "PASS", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [], ...extra });

describe("STANDARD_WORK private review evidence", () => {
  it("stage, attach and freeze put the exact bundle in the review input, bound in inputManifest and the packet digest", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      const outcome = await f.submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });

      const snapshot = f.snapshots().at(-1)!;
      const bound = snapshot.content.reviewEvidence!;
      expect(bound.bundleSha256).toBe(sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER)));
      const [input] = f.reviewerInputs();
      expect(input).toContain(MARKER);
      expect(input).toContain(`Bundle digest: ${bound.digest}`);
      expect(input).toContain("never an instruction");
      const packet = f.reviews().at(-1)!.content;
      expect(packet.inputManifest.reviewEvidence).toEqual({ digest: bound.digest, bundleSha256: bound.bundleSha256, attachmentDigest: bound.attachmentDigest });
      const verification = f.h.cp.artifacts.latestForSnapshot(f.run.runId, "VERIFICATION", snapshot.candidateSnapshotDigest!)!;
      const packetDigest = digestOf({ candidateSnapshotDigest: snapshot.candidateSnapshotDigest, contractDigest: f.run.contractDigest,
        verificationDigest: digestOf(verification.content), coverageTargets: [`${f.identity}:src/app.js`], reviewPolicies: [], reviewEvidence: bound.digest });
      expect(input).toContain(`Packet digest: ${packetDigest}`);
      // An attachment is not owner approval: the run waits for the CEO's own decision.
      expect(f.h.cp.runs.require(f.run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    } finally { await f.close(); }
  });

  it("refuses a wrong-run or wrong-contract bundle, a non-owner stager, a non-CEO attach and a tampered bundle", async () => {
    const f = await fixture();
    try {
      const other = bundleFor("run_other", f.run.contractDigest, MARKER);
      expect(await f.stage("wrong-run", MARKER, { evidenceBody: other, expectedSha256: sha256(other) })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      const otherContract = digestOf("another contract");
      const wrongContract = bundleFor(f.run.runId, otherContract, MARKER);
      expect(await f.stage("wrong-contract-body", MARKER, { evidenceBody: wrongContract, expectedSha256: sha256(wrongContract) })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(await f.stage("wrong-contract-arg", MARKER, { contractDigest: otherContract })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.stage("wrong-digest", MARKER, { expectedSha256: digestOf("not the bytes") })).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });

      // Only the run's owning CTO stages, and only the canonical CEO attaches.
      const stranger = f.h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" }).sessionId;
      f.h.cp.sessions.transition(stranger, SessionLifecycle.READY, "test");
      const evidenceBody = bundleFor(f.run.runId, f.run.contractDigest, MARKER);
      expect(await (await f.connect("cto", stranger))("review_evidence_stage", { idempotencyKey: "not-owner", runId: f.run.runId,
        contractDigest: f.run.contractDigest, evidenceBody, expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: false });
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await (await f.connect("hermes", stranger))("review_evidence_attach", { idempotencyKey: "not-ceo", runId: f.run.runId,
        contractDigest: f.run.contractDigest, stagedBy: f.stagedBy, expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: false });
      expect(await f.attach("wrong-contract-attach", MARKER, { contractDigest: otherContract })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.attach("wrong-stager", MARKER, { stagedBy: "PRIMARY_CTO:elsewhere" })).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });

      // A candidate changed after staging is never selected, and one changed after its selection is never frozen.
      const candidate = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").find((a) => a.content["schema"] === "acp.standard-review-evidence-candidate.v1")!;
      const original = candidate.content;
      f.tamper(candidate.artifactId, { ...original, bodyBase64: Buffer.from(bundleFor(f.run.runId, f.run.contractDigest, `${MARKER} changed`)).toString("base64") });
      expect(await f.attach("tampered", MARKER)).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      f.tamper(candidate.artifactId, original);
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      f.tamper(candidate.artifactId, { ...original, bodyBase64: Buffer.from(bundleFor(f.run.runId, f.run.contractDigest, `${MARKER} changed`)).toString("base64") });
      const frozen = await f.h.cp.pipeline.freeze(f.run.runId);
      expect(frozen).toMatchObject({ allowed: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });

      // Changed after the freeze: the review fails closed before any reviewer is asked.
      f.tamper(candidate.artifactId, original);
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      const snapshot = await f.h.cp.pipeline.freeze(f.run.runId);
      if (!snapshot.allowed) throw new Error(snapshot.message);
      expect(snapshot.value.reviewEvidence).toBeDefined();
      const verified = await f.h.cp.verification.verify({ runId: f.run.runId, snapshot: snapshot.value,
        commands: f.h.cp.projects.activeManifest(f.projectId)!.manifest.verificationCommands, contractDigest: f.run.contractDigest });
      if (!verified.allowed) throw new Error(verified.message);
      f.tamper(candidate.artifactId, { ...original, bodyBase64: Buffer.from(bundleFor(f.run.runId, f.run.contractDigest, `${MARKER} changed`)).toString("base64") });
      const reviewed = await f.h.cp.review.controlPlaneInvoker()({ runId: f.run.runId, projectId: f.projectId, executionMode: f.run.executionMode,
        snapshot: snapshot.value, contract: f.contract, contractDigest: f.run.contractDigest, verification: verified.value });
      expect(reviewed).toMatchObject({ allowed: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(reviewed.allowed ? "" : reviewed.message).not.toContain(MARKER);
      expect(f.reviewerInputs()).toEqual([]);
      for (const refusal of f.refusals) expect(refusal).not.toContain(MARKER);
    } finally { await f.close(); }
  });

  it("a replacement after review makes the earlier review and approval stale for CONFIRM, and keeps them", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      expect(await f.submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const reviewed = f.h.cp.runs.currentCandidate(f.run.runId)!;

      expect(await f.stage("stage-b", `${MARKER} second`)).toMatchObject({ ok: true });
      expect(await f.attach("attach-b-unnamed", `${MARKER} second`)).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.attach("attach-b", `${MARKER} second`, { replacesSha256: sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER)) })).toMatchObject({ ok: true });
      expect(f.confirm(reviewed)).toMatchObject({ allowed: false, reasonCode: "EVIDENCE_STALE" });
      expect(f.h.cp.runs.require(f.run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      // The earlier selection cannot come back, and nothing was deleted.
      expect(await f.attach("attach-a-again", MARKER, { replacesSha256: sha256(bundleFor(f.run.runId, f.run.contractDigest, `${MARKER} second`)) }))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      const handoffs = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF");
      expect(handoffs.filter((a) => a.content["schema"] === "acp.standard-review-evidence-candidate.v1")).toHaveLength(2);
      expect(handoffs.filter((a) => a.content["schema"] === "acp.standard-review-evidence-attached.v1").map((a) => a.superseded)).toEqual([true, false]);
      expect(f.reviews()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("rolls back a replacement and its audit on denial, keeping the current selection", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.stage("stage-b", `${MARKER} second`)).toMatchObject({ ok: true });
      const handoffs = () => f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").map((a) => [a.digest, a.superseded]);
      const before = handoffs();
      const auditBefore = f.h.cp.audit.forRun(f.run.runId);
      const record = f.h.cp.audit.record.bind(f.h.cp.audit);
      const refused = vi.spyOn(f.h.cp.audit, "record").mockImplementation((input) => {
        const recorded = record(input);
        return input.kind === "STANDARD_REVIEW_EVIDENCE_ATTACHED" ? deny(ReasonCode.CONFLICT, "test denial after attachment and audit writes") : recorded;
      });
      const replaces = sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER));
      try {
        expect(await f.attach("attach-b", `${MARKER} second`, { replacesSha256: replaces })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
        expect(handoffs()).toEqual(before);
        expect(f.h.cp.audit.forRun(f.run.runId)).toEqual(auditBefore);
      } finally { refused.mockRestore(); }
      expect(await f.attach("attach-b-retry", `${MARKER} second`, { replacesSha256: replaces })).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses a replacement while a result_submit is in flight", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.stage("stage-b", `${MARKER} second`)).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity), delayMs: 1_500 });
      const pending = f.cto("result_submit", { idempotencyKey: "submit", runId: f.run.runId, resultSummary: "app returns 2", recommendation: "merge" });
      for (let i = 0; i < 400 && f.reviewerInputs().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.reviewerInputs()).toHaveLength(1);
      const replaces = sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER));
      expect(await f.attach("attach-b", `${MARKER} second`, { replacesSha256: replaces })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await pending).toMatchObject({ ok: true });
      const frozen = f.snapshots().at(-1)!.content.reviewEvidence!;
      expect(f.reviews().at(-1)!.content.inputManifest.reviewEvidence?.digest).toBe(frozen.digest);
      expect(frozen.bundleSha256).toBe(replaces);
    } finally { await f.close(); }
  });

  it("keeps the bootstrap path separate: neither tool accepts the other run kind", async () => {
    const f = await fixture();
    try {
      expect(await f.cto("bootstrap_review_evidence_stage", { idempotencyKey: "bootstrap-tool", runId: f.run.runId, contractDigest: f.run.contractDigest,
        bootstrapPlanDigest: digestOf("plan"), evidenceBody: "{}", expectedSha256: sha256("{}") })).toMatchObject({ ok: false });
      const created = f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: { goal: "Create a product", why: "genesis",
        scope: [], nonGoals: [], priority: "NORMAL", humanGate: [], references: [], acceptance: ["CI passes"] } });
      if (!created.allowed) throw new Error(created.message);
      const bootstrap = await dispatchBootstrapRun(f.h.cp, f.h.clock, created.value.runId);
      const body = bundleFor(bootstrap.runId, bootstrap.contractDigest, MARKER);
      expect(await f.hermes("review_evidence_attach", { idempotencyKey: "standard-tool", runId: bootstrap.runId, contractDigest: bootstrap.contractDigest,
        stagedBy: bootstrap.ownerRoleKey ?? "PRIMARY_CTO:none", expectedSha256: sha256(body) })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
    } finally { await f.close(); }
  });
});

describe("derived outputs of a review that read private evidence", () => {
  it("leaves no excerpt in the PR, check run, merge message, upstream payload, export or error text, and holds upstream sending", async () => {
    const f = await fixture({ finalization: true });
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      const claimed = f.h.cp.claims.acquire({ runId: f.run.runId, ownerSessionId: f.run.ownerSessionId!, ownerBindingGeneration: f.run.ownerBindingGeneration!,
        ownerRoleKey: f.run.ownerRoleKey!, repositoryIdentity: f.identity, branch: WORK_BRANCH });
      if (!claimed.allowed) throw new Error(claimed.message);
      const quoted = `the handoff says ${MARKER}`;
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity, { findings: [
        { category: "correctness", severity: "MINOR", repository: f.identity, path: "src/app.js", summary: quoted, detail: quoted },
        { category: "method", severity: "MAJOR", repository: f.identity, path: null, summary: quoted, detail: quoted },
      ] }) });
      const outcome = await f.submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(JSON.stringify(f.reviews().at(-1)!.content.findings)).toContain(MARKER);

      // The method finding is recorded bound to the review, with no reviewer text, and held.
      const store = new DogfoodFindingStore({ db: f.h.cp.db, audit: f.h.cp.audit, artifacts: f.h.cp.artifacts, clock: f.h.cp.clock });
      const records = store.list().records.filter((record) => record.binding?.runId === f.run.runId);
      expect(records).toHaveLength(1);
      expect(records[0]!.state).toMatchObject({ status: "NOT_REPORTED", reason: "NOT_PUBLIC_SAFE" });
      expect(JSON.stringify(records)).not.toContain(MARKER);
      const sent: unknown[] = [];
      const port: UpstreamIssuePort = {
        findIssues: async (...args) => { sent.push(args); return []; },
        readIssue: async (...args) => { sent.push(args); throw new Error("no issue"); },
        listComments: async (...args) => { sent.push(args); return []; },
        createIssue: async (...args) => { sent.push(args); return { number: 1 }; },
        createComment: async (...args) => { sent.push(args); return { id: 1 }; },
        readComment: async (...args) => { sent.push(args); throw new Error("no comment"); },
      };
      await new UpstreamDogfoodReporter(store, port, { clock: f.h.cp.clock }).reportDue();
      expect(sent).toEqual([]);

      const exporter = new RunEvidenceExporter(f.h.cp.db, f.h.cp.artifacts, f.h.clock, f.h.cp.audit);
      const exported = exporter.exportRun(f.run.runId);
      if (!exported.allowed) throw new Error(exported.message);
      expect(JSON.stringify(exported.value)).not.toContain(MARKER);
      const reviewArtifact = f.reviews().at(-1)!;
      expect(exported.value.artifactManifest.omittedFields).toContainEqual(expect.objectContaining({ subjectId: reviewArtifact.artifactId, reason: "PRIVATE_BULK_CONTENT" }));

      // CONFIRM and the daemon's finalization: branch, PR, gate check run and squash.
      const snapshot = f.snapshots().at(-1)!;
      const repository = snapshot.content.repositories[0]!;
      f.holder.gitData = new GitDataGitHub(bareRemoteAt(join(tempDir("acp-sre-remote-"), "remote.git"), f.h.repoPath, "dev", repository.baseHead));
      const gitData = f.holder.gitData;
      f.github.setBranch("dev", repository.baseHead);
      f.github.setBranch("main", "m".repeat(40));
      f.github.nextMergeSha = repository.candidateHead;
      f.github.onMerge = ({ mergeSha, pull }) => {
        f.github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
        gitData.setHead(pull.base.ref, mergeSha);
      };
      expect(f.confirm(snapshot.candidateSnapshotDigest!)).toMatchObject({ allowed: true });
      const done = await new ApprovedRunFinalizer(f.h.cp).finalizeApprovedRun(f.run.runId);
      expect(done.allowed, JSON.stringify(done)).toBe(true);
      expect(f.log.some((call) => call.method === "POST" && /\/pulls$/.test(call.path))).toBe(true);
      expect(f.log.some((call) => call.method === "POST" && /\/check-runs$/.test(call.path))).toBe(true);
      expect(f.log.some((call) => call.method === "PUT" && /\/merge$/.test(call.path))).toBe(true);
      expect(JSON.stringify(f.log)).not.toContain(MARKER);
      // ACP sends no merge message of its own: GitHub's commit title and message come from the PR title and the
      // branch's commits, neither of which carries review text.
      const merge = f.log.find((call) => call.method === "PUT" && /\/merge$/.test(call.path))!;
      expect(Object.keys(merge.body as Args).sort()).toEqual(["merge_method", "sha"]);

      expect(f.refusals.length).toBe(0);
      expect(f.h.cp.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(f.ceo);
    } finally { await f.close(); }
  });
});

describe("review round 1: evidence binds candidate identity, audit text, owner consent and excerpt size", () => {
  it("R1 a re-freeze after a replacement is a new candidate, and the earlier review's packet confirms neither", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      expect(await f.submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const reviewed = f.h.cp.runs.currentCandidate(f.run.runId)!;
      expect(await f.stage("stage-b", `${MARKER} second`)).toMatchObject({ ok: true });
      expect(await f.attach("attach-b", `${MARKER} second`, { replacesSha256: sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER)) })).toMatchObject({ ok: true });
      expect(f.confirm(reviewed)).toMatchObject({ allowed: false, reasonCode: "EVIDENCE_STALE" });
      const refrozen = await f.h.cp.pipeline.freeze(f.run.runId);
      if (!refrozen.allowed) throw new Error(refrozen.message);
      const current = f.h.cp.runs.currentCandidate(f.run.runId)!;
      expect(current).not.toBe(reviewed);
      expect(f.confirm(current)).toMatchObject({ allowed: false });
      expect(f.confirm(reviewed)).toMatchObject({ allowed: false });
      expect(f.h.cp.runs.require(f.run.runId).state).not.toBe(RunState.CEO_APPROVED);
    } finally { await f.close(); }
  });

  it("R2 omissions and findings that echo private evidence never reach the audit log", async () => {
    const f = await fixture();
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      const echoed = `see ${MARKER}`;
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity, { omittedItems: [echoed], findings: [
        { category: "correctness", severity: "MAJOR", repository: f.identity, path: "src/app.js", summary: echoed, detail: echoed },
        { category: "method", severity: "MAJOR", repository: f.identity, path: null, summary: echoed, detail: echoed },
      ] }) });
      const outcome = await f.submit();
      expect(outcome.allowed).toBe(true);
      const rows = f.h.cp.db.all<Args>("SELECT * FROM audit_events");
      expect(rows.filter((row) => JSON.stringify(row).includes(MARKER)).map((row) => row["kind"])).toEqual([]);
      const completed = f.h.cp.audit.byKind("BLIND_REVIEW_COMPLETED").at(-1)!;
      expect(completed.evidence).toMatchObject({ omittedItems: 1, omittedItemsDigest: digestOf([echoed]), findings: 1 });
    } finally { await f.close(); }
  });

  it("R3 owner consent given under replaced evidence does not count for CONFIRM; consent under the current evidence does", async () => {
    const item = "irreversible production action";
    const f = await fixture({ humanGate: [item] });
    try {
      expect(await f.stage("stage-a", MARKER)).toMatchObject({ ok: true });
      expect(await f.attach("attach-a", MARKER)).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      expect(await f.submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const underA = f.h.cp.runs.currentCandidate(f.run.runId)!;
      expect(f.h.cp.ceo.humanGateStatus(f.run.runId)).toMatchObject({ required: true, satisfied: false });
      const consent = (note: string) => f.h.cp.ceo.recordOwnerDecision({ runId: f.run.runId, item, approved: true, note,
        receipt: ownerDecisionReceipt(f.h, f.run.runId, item, true, note) });
      expect(consent("yes under A")).toMatchObject({ allowed: true });
      expect(f.h.cp.ceo.humanGateStatus(f.run.runId).satisfied).toBe(true);

      expect(await f.stage("stage-b", `${MARKER} second`)).toMatchObject({ ok: true });
      expect(await f.attach("attach-b", `${MARKER} second`, { replacesSha256: sha256(bundleFor(f.run.runId, f.run.contractDigest, MARKER)) })).toMatchObject({ ok: true });
      expect(f.h.cp.ceo.submitCeoDecision({ runId: f.run.runId, decision: "FINAL_REVISE", candidateSnapshotDigest: underA, ceoSessionId: f.ceo,
        rationale: "review again with the replaced evidence" })).toMatchObject({ allowed: true });
      const redispatched = await f.h.cp.runs.dispatch(f.run.runId);
      if (!redispatched.allowed) throw new Error(redispatched.message);
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      expect(await f.submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const underB = f.h.cp.runs.currentCandidate(f.run.runId)!;
      expect(f.reviews().at(-1)!.content.inputManifest.reviewEvidence?.bundleSha256).toBe(sha256(bundleFor(f.run.runId, f.run.contractDigest, `${MARKER} second`)));

      expect(f.h.cp.ceo.humanGateStatus(f.run.runId).satisfied).toBe(false);
      expect(f.confirm(underB)).toMatchObject({ allowed: false, reasonCode: "HUMAN_GATE_UNSATISFIED" });
      expect(consent("yes under B")).toMatchObject({ allowed: true });
      expect(f.confirm(underB)).toMatchObject({ allowed: true });
    } finally { await f.close(); }
  });

  it("R4b accepts allowlist-style excerpts labelled with the neutral excerpt range kind and a short purpose", async () => {
    const f = await fixture();
    try {
      const allowlist = (path: string, line: number, text: string) => ({ ...fileFor(`${text}\n`, { originalSha256: sha256(SOURCE), omitted: true,
        ranges: [{ section: "excerpt", purpose: "owner allowlist entry", startLine: line, endLine: line }] }), path });
      const evidenceBody = bundleFor(f.run.runId, f.run.contractDigest, "", [
        allowlist("handoff/allow-1.md", 12, `${MARKER} allowed path one`), allowlist("handoff/allow-2.md", 40, `${MARKER} allowed path two`)]);
      expect(await f.stage("allowlist", "", { evidenceBody, expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
      expect(await f.attach("attach-allowlist", "", { expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Candidate review/, text: pass(f.identity) });
      expect(await f.submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const [input] = f.reviewerInputs();
      expect(input).toContain(`${MARKER} allowed path one`);
      expect(input).toContain(`${MARKER} allowed path two`);
      expect(input).toContain('"section":"excerpt","purpose":"owner allowlist entry"');
    } finally { await f.close(); }
  });

  it("R4 refuses a whole source, a file without an excerpt declaration, and an excerpt over its size or line bound", async () => {
    const f = await fixture();
    try {
      const conversation = Array.from({ length: 40 }, (_, i) => `owner, turn ${i}: ${i === 7 ? MARKER : "an unrelated private passage"}`).join("\n") + "\n";
      const stageFiles = (key: string, files: Args[]) => {
        const evidenceBody = bundleFor(f.run.runId, f.run.contractDigest, "", files);
        return f.stage(key, "", { evidenceBody, expectedSha256: sha256(evidenceBody) });
      };
      expect(await stageFiles("no-excerpt", [fileFor(conversation, undefined)])).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(await stageFiles("more-lines-than-ranges", [fileFor(conversation)])).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      const whole = fileFor("## result\nall of it\n");
      expect(await stageFiles("whole-source", [{ ...whole, excerpt: { ...EXCERPT, originalSha256: whole.sha256 } }])).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      const oversized = `${"x".repeat(17_000)}\n`;
      expect(await stageFiles("oversized", [fileFor(oversized)])).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")).toEqual([]);
      for (const refusal of f.refusals) expect(refusal).not.toContain(MARKER);
      expect(await f.stage("excerpt", MARKER)).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });
});
