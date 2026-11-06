import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { ExecutionMode, Role, roleKeyFor, RunKind, RunState } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { frozenStandardReviewEvidence } from "../../src/review/standard-review-evidence.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { dispatchRun, normalized } from "../helpers/contract-change.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, decideThroughHermes, fixtureManifest, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1347 — review evidence excerpts may quote ACP's own `sha256:<64hex>` digests of the run's project's stored
 * records (a VERIFICATION artifact, a frozen candidate, a pinned or activated manifest). ACP confirms each one in
 * its own records of that project, binds what it found to the stage, the attachment and the freeze, and exempts
 * only those exact tokens from the long-base64 shape. Every marker is synthetic.
 */
type Args = Record<string, unknown>;
const SOURCE = "a synthetic official record the excerpt is cut from";
const EXCERPT = { originalSha256: sha256(SOURCE), omitted: true, ranges: [{ section: "excerpt", startLine: 1, endLine: 4 }] };
const bundleFor = (runId: string, contractDigest: string, text: string): string => {
  const bytes = Buffer.from(`## official records\n${text}\n`, "utf8");
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the records"], files: [{ path: "records/excerpt.md", sha256: sha256(bytes),
    origin: "ACP run_artifacts, read-only", grade: "review-original", bodyBase64: bytes.toString("base64"), excerpt: EXCERPT }] });
};
const addsCommand = (id: string) => (base: ProjectManifest): ProjectManifest => normalized({
  ...base,
  verificationCommands: [...base.verificationCommands, { ...base.verificationCommands[0]!, id, argv: ["node", `${id}.js`] }],
  verificationProfiles: { ...base.verificationProfiles, standard: [...base.verificationProfiles.standard, id] },
});
const CANDIDATE_SCHEMA = "acp.standard-review-evidence-candidate.v1";
const ATTACHED_SCHEMA = "acp.standard-review-evidence-attached.v1";

let projectSeq = 0;

async function fixture() {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, `evidence-digests-${++projectSeq}`);
  const lineage = digestOf("review evidence digests lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const servers: Array<{ close(): Promise<void> }> = [];
  async function connect(kind: "cto" | "hermes", sessionId: string) {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "review-evidence-digests", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  }
  const planned = async (project: string, propose: (base: ProjectManifest) => ProjectManifest) => {
    const run = await dispatchRun(h, project, RunKind.CONTRACT_CHANGE);
    const manifest = propose(run.base);
    const submitted = createCtoMcpPort(h.cp).submitPlan(run.runId, { summary: "change the project contract", projectManifestDigest: manifestDigest(manifest), projectManifest: manifest });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ allowed: true });
    return { ...run, manifest, coverage: `${project}:#manifest/${manifestDigest(manifest)}`, contractDigest: h.cp.runs.require(run.runId).contractDigest };
  };
  type Planned = Awaited<ReturnType<typeof planned>>;
  const ceo = () => h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
  const stagedBy = (run: Planned) => h.cp.runs.require(run.runId).ownerRoleKey!;
  const stage = async (run: Planned, key: string, text: string) => {
    const evidenceBody = bundleFor(run.runId, run.contractDigest, text);
    return (await connect("cto", run.ownerSessionId))("review_evidence_stage", { idempotencyKey: key, runId: run.runId,
      contractDigest: run.contractDigest, evidenceBody, expectedSha256: sha256(evidenceBody) });
  };
  const attach = async (run: Planned, key: string, text: string) =>
    (await connect("hermes", ceo()))("review_evidence_attach", { idempotencyKey: key, runId: run.runId, contractDigest: run.contractDigest,
      stagedBy: stagedBy(run), expectedSha256: sha256(bundleFor(run.runId, run.contractDigest, text)) });
  const submit = async (run: Planned) => {
    h.scripted.script({ match: /Contract change review/, text: reviewerPass([run.coverage]) });
    await h.cp.continuity.evaluate("contract change candidate");
    return h.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId, ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest", recommendation: "activate the contract change", residualRisk: [] });
  };
  const activate = async (run: Planned) => {
    expect(await submit(run)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    await h.cp.continuity.evaluate("confirm the contract change");
    const confirmed = await decideThroughHermes(h, { runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: h.cp.runs.currentCandidate(run.runId)!, rationale: "evidence digests witness" });
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
    const finalized = await new ApprovedRunFinalizer(h.cp, `activate-${run.runId}`).finalizeApprovedRun(run.runId);
    expect(finalized, JSON.stringify(finalized)).toMatchObject({ allowed: true });
  };
  /** A reviewed CONTRACT_CHANGE run of a project: its frozen candidate and the BLIND_REVIEW of it. */
  const reviewed = async (project: string, id: string) => {
    const run = await planned(project, addsCommand(id));
    expect(await submit(run)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const snapshot = h.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)!;
    return { run, snapshot, artifact: h.cp.artifacts.list(run.runId, "BLIND_REVIEW").at(-1)! };
  };
  /** A reviewed STANDARD_WORK run of the fixture project, with one passing change: its frozen candidate and its VERIFICATION artifact. */
  const verifiedWork = async () => {
    if (!h.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(h);
    const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
      acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
    const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract, repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
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
    const head = applyPassingChange(h.repoPath, "feature/evidence-digests");
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    h.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });
    const outcome = await h.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "app returns 2", recommendation: "merge" });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const snapshot = h.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)!;
    const [verification] = h.cp.artifacts.list(run.runId, "VERIFICATION");
    expect(verification?.candidateSnapshotDigest).toBe(snapshot.candidateSnapshotDigest);
    return { run, snapshot, artifact: verification! };
  };
  const handoffs = (runId: string, schema: string) => h.cp.artifacts.list<Args>(runId, "HANDOFF").filter((a) => a.content["schema"] === schema);
  const tamper = (artifactId: string, content: Args) => {
    const raw = new Database(h.cp.db.raw.name);
    try {
      raw.function("acp_evidence_write_authorized", () => 0);
      raw.exec("DROP TRIGGER IF EXISTS run_artifacts_content_immutable");
      raw.prepare("UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?").run(JSON.stringify(content), artifactId);
    } finally { raw.close(); }
  };
  return { h, projectId, planned, stage, attach, submit, activate, reviewed, verifiedWork, handoffs, tamper,
    close: async () => { for (const s of servers.reverse()) await s.close(); h.cp.close(); } };
}

describe("review evidence quoting ACP's own digests of the run's project", () => {
  it("stages, attaches and freezes a bundle quoting the project's VERIFICATION artifact, candidate snapshot and pinned manifest, binding one reference set", async () => {
    const f = await fixture();
    try {
      const earlier = await f.verifiedWork();
      const run = await f.planned(f.projectId, addsCommand("evidence-check"));
      const pin = f.h.cp.runs.require(run.runId).pinnedManifestDigest!;
      const text = [
        `VERIFICATION artifact: ${earlier.artifact.digest} (run ${earlier.run.runId})`,
        `candidate snapshot: ${earlier.snapshot.candidateSnapshotDigest}`,
        `pinned manifest: ${pin}`,
      ].join("\n");
      const staged = await f.stage(run, "stage-digests", text);
      expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
      const references = [
        { kind: "VERIFICATION", digest: earlier.artifact.digest, runId: earlier.run.runId, artifactId: earlier.artifact.artifactId, activationEventId: null },
        { kind: "CANDIDATE_SNAPSHOT", digest: earlier.snapshot.candidateSnapshotDigest, runId: earlier.run.runId, artifactId: earlier.snapshot.artifactId, activationEventId: null },
        // The earliest run of the project that pins it.
        { kind: "MANIFEST", digest: pin, runId: earlier.run.runId, artifactId: null, activationEventId: null },
      ].sort((a, b) => (a.digest! < b.digest! ? -1 : 1));
      expect((staged["value"] as Args)["verifiedReferences"]).toEqual(references);
      const [candidate] = f.handoffs(run.runId, CANDIDATE_SCHEMA);
      expect(candidate!.content["verifiedReferences"]).toEqual(references);
      const receipt = f.h.cp.audit.forRun(run.runId).find((e) => e.kind === "STANDARD_REVIEW_EVIDENCE_STAGED")!;
      expect(receipt.evidence["verifiedReferencesDigest"]).toBe(digestOf(references));

      expect(await f.attach(run, "attach-digests", text)).toMatchObject({ ok: true });
      const [attachment] = f.handoffs(run.runId, ATTACHED_SCHEMA);
      expect(attachment!.content["verifiedReferencesDigest"]).toBe(digestOf(references));

      const outcome = await f.submit(run);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const snapshot = f.h.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)!.content;
      const frozen = frozenStandardReviewEvidence({ artifacts: f.h.cp.artifacts, audit: f.h.cp.audit }, snapshot)!;
      expect(frozen.source.references).toEqual(references);
      expect(frozen.digest).toBe(snapshot.reviewEvidence!.digest);
    } finally { await f.close(); }
  });

  it("binds a manifest the project activated and no run of it pins, by the activation's audit event", async () => {
    const f = await fixture();
    try {
      const run = await f.planned(f.projectId, addsCommand("evidence-check"));
      const change = await f.planned(f.projectId, addsCommand("activated-check"));
      await f.activate(change);
      const activated = manifestDigest(change.manifest);
      expect(f.h.cp.projects.require(f.projectId).activeManifestDigest).toBe(activated);
      const staged = await f.stage(run, "stage-activated", `active manifest: ${activated}`);
      expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
      const event = f.h.cp.audit.forRun(change.runId).find((e) => e.kind === "PROJECT_MANIFEST_ACTIVATED")!;
      expect((staged["value"] as Args)["verifiedReferences"]).toEqual([{ kind: "MANIFEST", digest: activated, runId: null, artifactId: null, activationEventId: event.eventId }]);
    } finally { await f.close(); }
  });

  it("refuses another project's digests, an unregistered or tampered digest, a credential beside verified digests and a bare 64-hex", async () => {
    const f = await fixture();
    try {
      const earlier = await f.reviewed(f.projectId, "earlier-check");
      // Another project in the same store, its manifest stored in the same global manifests table.
      const otherProject = `evidence-digests-other-${projectSeq}`;
      const otherManifest = fixtureManifest(otherProject);
      expect(f.h.cp.projects.register({ projectId: otherProject, name: "other", manifest: otherManifest,
        authorization: f.h.cp.manifestAuthorizationForTests(otherManifest) })).toMatchObject({ allowed: true });
      const foreign = await f.reviewed(otherProject, "foreign-check");
      const foreignManifest = f.h.cp.runs.require(foreign.run.runId).pinnedManifestDigest!;
      const run = await f.planned(f.projectId, addsCommand("evidence-check"));
      const own = earlier.artifact.digest;
      const lastHex = own.at(-1) === "0" ? "1" : "0";
      const slack = ["xoxb", "123456789012345678901234567890"].join("-");
      const refused: Array<[string, string]> = [
        ["another project's artifact", `artifact: ${foreign.artifact.digest}`],
        ["another project's candidate", `candidate: ${foreign.snapshot.candidateSnapshotDigest}`],
        ["another project's manifest", `manifest: ${foreignManifest}`],
        ["an unregistered digest", `artifact: ${digestOf("a record ACP never stored")}`],
        ["a tampered digest", `artifact: ${own.slice(0, -1)}${lastHex}`],
        ["a verified digest beside another project's", `artifact: ${own}\nmanifest: ${foreignManifest}`],
        ["a credential beside verified digests", `artifact: ${own}\ncandidate: ${earlier.snapshot.candidateSnapshotDigest}\nnote ${slack}`],
        ["a bare 64-hex", `artifact ${own.slice("sha256:".length)}`],
        ["a bare 64-hex beside its verified digest", `artifact: ${own}\nagain ${own.slice("sha256:".length)}`],
      ];
      for (const [label, text] of refused) {
        const answer = await f.stage(run, `refused-${label}`, text);
        expect(answer, label).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED" });
        expect(JSON.stringify(answer), label).not.toContain(slack);
      }
      expect(f.handoffs(run.runId, CANDIDATE_SCHEMA)).toEqual([]);
      expect(await f.stage(run, "accepted", `artifact: ${own}`)).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses a candidate whose references or body were swapped after staging, at attach and at the freeze", async () => {
    const f = await fixture();
    try {
      const earlier = await f.reviewed(f.projectId, "earlier-check");
      const run = await f.planned(f.projectId, addsCommand("evidence-check"));
      const text = `artifact: ${earlier.artifact.digest}`;
      expect(await f.stage(run, "stage-a", text)).toMatchObject({ ok: true });
      const [candidate] = f.handoffs(run.runId, CANDIDATE_SCHEMA);
      const original = candidate!.content;
      const swappedReferences = { ...original, verifiedReferences: [{ kind: "CANDIDATE_SNAPSHOT", digest: earlier.snapshot.candidateSnapshotDigest,
        runId: earlier.run.runId, artifactId: earlier.snapshot.artifactId, activationEventId: null }] };
      const swappedBody = { ...original, bodyBase64: Buffer.from(bundleFor(run.runId, run.contractDigest, `candidate: ${earlier.snapshot.candidateSnapshotDigest}`)).toString("base64") };

      const swaps: Array<[string, Args]> = [["references", swappedReferences], ["body", swappedBody]];
      for (const [label, swapped] of swaps) {
        f.tamper(candidate!.artifactId, swapped);
        expect(await f.attach(run, `attach-swapped-${label}`, text), label).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      }
      f.tamper(candidate!.artifactId, original);
      expect(await f.attach(run, "attach-a", text)).toMatchObject({ ok: true });
      for (const [label, swapped] of swaps) {
        f.tamper(candidate!.artifactId, swapped);
        expect(await f.h.cp.pipeline.freeze(run.runId), label).toMatchObject({ allowed: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      }
      expect(f.h.cp.artifacts.list(run.runId, "CANDIDATE_SNAPSHOT")).toEqual([]);
    } finally { await f.close(); }
  });
});
