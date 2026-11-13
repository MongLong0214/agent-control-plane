import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor, RunKind } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { frozenStandardReviewEvidence, STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES } from "../../src/review/standard-review-evidence.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { dispatchRun, normalized } from "../helpers/contract-change.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1268 — a required execution report reaches the reviewer whole: an `execution-log` file may be its whole source,
 * up to 64 KiB, and inside it an exact `sha256:<64hex>` token the bundle lists in `recordedDigests` (a recovery
 * digest of a backed-up file) is not a credential. Every other grade, every bare 64-hex and every unlisted token
 * keeps today's rules. Every marker is synthetic.
 */
type Args = Record<string, unknown>;

/** A synthetic `commitlore init --json`-like report of about `bytes` bytes that records `digests`, one per backed-up file. */
const reportOf = (digests: readonly string[], bytes: number): string => {
  const lines = ["{", `  "command": "init",`, `  "steps": [`];
  digests.forEach((digest, i) => lines.push(`    {"step": "backup", "file": ".git/hooks/hook-${i}", "digest": "${digest}", "status": "ok"},`));
  for (let i = 0; lines.join("\n").length < bytes - 40; i += 1) lines.push(`    {"step": "index", "entry": ${i}, "note": "synthetic report line ${i}"},`);
  lines.push(`    {"step": "done"}`, "  ]", "}");
  return `${lines.join("\n")}\n`;
};
const recorded = (count: number): Array<{ digest: string; what: string }> =>
  Array.from({ length: count }, (_, i) => ({ digest: sha256(`synthetic backup ${i}`), what: `.git/hooks/hook-${i} backup` }));
const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

interface FileOptions { grade?: string; omitted?: boolean; originalSha256?: string; ranges?: Args[]; path?: string }
const fileOf = (body: string, options: FileOptions = {}): Args => {
  const bytes = Buffer.from(body, "utf8");
  return { path: options.path ?? "logs/commitlore-init.json", sha256: sha256(bytes), origin: "commitlore init --json, captured by the run's CTO",
    grade: options.grade ?? "execution-log", bodyBase64: bytes.toString("base64"),
    excerpt: { originalSha256: options.originalSha256 ?? sha256(bytes), omitted: options.omitted ?? false,
      ranges: options.ranges ?? [{ section: "result", startLine: 1, endLine: lineCount(body) }] } };
};

const addsCommand = (id: string) => (base: ProjectManifest): ProjectManifest => normalized({
  ...base,
  verificationCommands: [...base.verificationCommands, { ...base.verificationCommands[0]!, id, argv: ["node", `${id}.js`] }],
  verificationProfiles: { ...base.verificationProfiles, standard: [...base.verificationProfiles.standard, id] },
});

let projectSeq = 0;

async function fixture() {
  const h = makeHarness();
  const { projectId } = await registerFixtureProject(h, `execution-log-${++projectSeq}`);
  const lineage = digestOf("execution log evidence lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const servers: Array<{ close(): Promise<void> }> = [];
  async function connect(kind: "cto" | "hermes", sessionId: string) {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "review-evidence-execution-log", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  }
  const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const manifest = addsCommand("execution-log-check")(run.base);
  const submitted = createCtoMcpPort(h.cp).submitPlan(run.runId, { summary: "change the project contract", projectManifestDigest: manifestDigest(manifest), projectManifest: manifest });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ allowed: true });
  const coverage = `${projectId}:#manifest/${manifestDigest(manifest)}`;
  const contractDigest = h.cp.runs.require(run.runId).contractDigest;
  const cto = await connect("cto", run.ownerSessionId);
  const bundleOf = (files: Args[], recordedDigests?: unknown): string =>
    JSON.stringify({ runId: run.runId, contractDigest, missing: [], files, ...(recordedDigests === undefined ? {} : { recordedDigests }) });
  let key = 0;
  const stage = (evidenceBody: string) => cto("review_evidence_stage", { idempotencyKey: `stage-${++key}`, runId: run.runId, contractDigest,
    evidenceBody, expectedSha256: sha256(evidenceBody) });
  const attach = async (evidenceBody: string) => (await connect("hermes", h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId))("review_evidence_attach",
    { idempotencyKey: `attach-${++key}`, runId: run.runId, contractDigest, stagedBy: h.cp.runs.require(run.runId).ownerRoleKey!, expectedSha256: sha256(evidenceBody) });
  const submit = async () => {
    h.scripted.script({ match: /Contract change review/, text: reviewerPass([coverage]) });
    await h.cp.continuity.evaluate("contract change candidate");
    return h.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId, ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest", recommendation: "activate the contract change", residualRisk: [] });
  };
  const reviewerInputs = () => h.scripted.invocations.map((call) => call.prompt).filter((prompt) => prompt.startsWith("# Contract change review"));
  return { h, run, bundleOf, stage, attach, submit, reviewerInputs,
    close: async () => { for (const s of servers.reverse()) await s.close(); h.cp.close(); } };
}

describe("review evidence carrying a whole execution report and its recorded digests (#1268)", () => {
  it("stages, attaches, freezes and shows the reviewer a whole 30 KB execution log whose 66 listed recovery digests pass", async () => {
    const f = await fixture();
    try {
      const listed = recorded(66);
      const report = reportOf(listed.map((r) => r.digest), 30_039);
      expect(Buffer.byteLength(report)).toBeGreaterThan(16_384);
      expect(Buffer.byteLength(report)).toBeGreaterThan(30_000);
      const body = f.bundleOf([fileOf(report)], listed);
      const staged = await f.stage(body);
      expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
      // A recorded digest names no ACP record: nothing is bound as a verified reference.
      expect((staged["value"] as Args)["verifiedReferences"]).toEqual([]);
      expect(await f.attach(body)).toMatchObject({ ok: true });

      const outcome = await f.submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const snapshot = f.h.cp.artifacts.list<CandidateSnapshot>(f.run.runId, "CANDIDATE_SNAPSHOT").at(-1)!.content;
      // The freeze re-read accepts the same bundle, recorded digests included.
      const frozen = frozenStandardReviewEvidence({ artifacts: f.h.cp.artifacts, audit: f.h.cp.audit }, snapshot)!;
      expect(frozen.digest).toBe(snapshot.reviewEvidence!.digest);
      expect(frozen.bundle.recordedDigests).toEqual(listed);
      expect(Buffer.from(frozen.bundle.files[0]!.bodyBase64, "base64").toString("utf8")).toBe(report);

      const [prompt] = f.reviewerInputs();
      expect(prompt).toContain(`\`\`\`text\n${report}\n\`\`\``);
      for (const { digest, what } of listed) expect(prompt).toContain(JSON.stringify({ digest, what }));
    } finally { await f.close(); }
  });

  it("accepts an execution log of exactly 64 KiB and refuses one byte more, and keeps the minimal-excerpt rules for every other grade", async () => {
    const f = await fixture();
    try {
      const atCap = `${"x".repeat(50)}\n`.repeat(Math.floor(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES / 51));
      const exact = atCap + "y".repeat(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES - Buffer.byteLength(atCap) - 1) + "\n";
      expect(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES).toBe(65_536);
      expect(Buffer.byteLength(exact)).toBe(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES);
      const over = `${exact}z`;
      expect(await f.stage(f.bundleOf([fileOf(over)])), "over 64 KiB").toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });

      const report = reportOf([], 30_039);
      const small = reportOf([], 2_000);
      const refused: Array<[string, Args]> = [
        ["a whole review-original file", fileOf(report, { grade: "review-original" })],
        ["a whole review-original file under 16 KiB", fileOf(small, { grade: "review-original" })],
        ["a whole github-api-original file under 16 KiB", fileOf(small, { grade: "github-api-original" })],
        ["a review-original excerpt over 16 KiB", fileOf(report, { grade: "review-original", omitted: true, originalSha256: sha256("a larger source") })],
        ["a whole execution log whose originalSha256 is another source's", fileOf(report, { originalSha256: sha256("a larger source") })],
        ["a whole execution log whose ranges leave a line out", fileOf(report, { ranges: [
          { section: "result", startLine: 1, endLine: 10 }, { section: "result", startLine: 12, endLine: lineCount(report) }] })],
        ["a whole execution log whose ranges stop before its last line", fileOf(report, { ranges: [{ section: "result", startLine: 1, endLine: lineCount(report) - 1 }] })],
        ["an execution-log excerpt that is its whole source", fileOf(report, { omitted: true })],
      ];
      for (const [label, file] of refused) {
        expect(await f.stage(f.bundleOf([file])), label).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      }
      // Overlapping ranges in any order still cover every line.
      const covered = fileOf(report, { ranges: [{ section: "result", startLine: 5, endLine: lineCount(report) }, { section: "excerpt", startLine: 1, endLine: 6 }] });
      expect(await f.stage(f.bundleOf([covered]))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("accepts exactly 64 KiB on its own", async () => {
    const f = await fixture();
    try {
      const atCap = `${"x".repeat(50)}\n`.repeat(Math.floor(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES / 51));
      const exact = atCap + "y".repeat(STANDARD_REVIEW_EXECUTION_LOG_MAX_BYTES - Buffer.byteLength(atCap) - 1) + "\n";
      expect(await f.stage(f.bundleOf([fileOf(exact)]))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses an unlisted or bare digest, a listed digest outside an execution log, and every other credential shape inside one", async () => {
    const f = await fixture();
    try {
      const listed = recorded(2);
      const [first] = listed;
      const hex = first!.digest.slice("sha256:".length);
      const github = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
      const base64Secret = Buffer.from("a synthetic long secret value that is not any digest at all, padded to length").toString("base64");
      expect(base64Secret.length).toBeGreaterThanOrEqual(60);
      const log = (extra: string) => fileOf(`${reportOf(listed.map((r) => r.digest), 2_000)}${extra}\n`);
      const refused: Array<[string, string]> = [
        ["an unlisted sha256 token in an execution log", f.bundleOf([log(`unlisted ${sha256("never recorded")}`)], listed)],
        ["a listed digest's bare hex in an execution log", f.bundleOf([log(`bare ${hex}`)], listed)],
        ["an unlisted bare 64-hex in an execution log", f.bundleOf([log(`bare ${sha256("never recorded").slice("sha256:".length)}`)], listed)],
        ["a listed digest inside a review-original file", f.bundleOf([log(""), fileOf(`## result\n${first!.digest}\n`, {
          grade: "review-original", path: "handoff/excerpt.md", omitted: true, originalSha256: sha256("a larger source") })], listed)],
        ["a GitHub token inside an execution log", f.bundleOf([log(`token ${github}`)], listed)],
        ["a long base64 secret inside an execution log", f.bundleOf([log(`value ${base64Secret}`)], listed)],
        ["a listed digest whose prefix touches the base64 alphabet", f.bundleOf([log(`x${first!.digest}`)], listed)],
      ];
      for (const [label, body] of refused) {
        const answer = await f.stage(body);
        expect(answer, label).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED" });
        expect(JSON.stringify(answer), label).not.toContain(github);
        expect(JSON.stringify(answer), label).not.toContain(hex);
      }
      // The same execution log with its digests listed, and nothing else, stages.
      expect(await f.stage(f.bundleOf([log("")], listed))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses the same digests when the bundle does not list them, and places a refusal inside the list by its key names", async () => {
    const f = await fixture();
    try {
      const listed = recorded(3);
      const report = reportOf(listed.map((r) => r.digest), 2_000);
      const unlisted = await f.stage(f.bundleOf([fileOf(report)], listed.slice(0, 2)));
      expect(unlisted).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED",
        evidence: { rule: "long_base64_run", form: "sha256-64hex", unresolvedDigestCount: 1 } });
      expect(await f.stage(f.bundleOf([fileOf(report)]))).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED",
        evidence: { unresolvedDigestCount: 3 } });
      const github = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
      const label = await f.stage(f.bundleOf([fileOf(report)], [...listed.slice(0, 2), { digest: listed[2]!.digest, what: `backup ${github}` }]));
      expect(label).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED", evidence: { rule: "github_token", at: { field: "$.recordedDigests[2].what" } } });
    } finally { await f.close(); }
  });

  it("keeps the recordedDigests list strict: at most 512 entries, exact digests, short labels and no other keys", async () => {
    const f = await fixture();
    try {
      const report = reportOf([], 2_000);
      const refused: Array<[string, unknown]> = [
        ["513 entries", recorded(513)],
        ["an empty label", [{ digest: sha256("x"), what: "" }]],
        ["a label over 256 characters", [{ digest: sha256("x"), what: "a-".repeat(129) }]],
        ["another key", [{ digest: sha256("x"), what: "a backup", note: "extra" }]],
        ["not an array", { digest: sha256("x"), what: "a backup" }],
      ];
      for (const [label, list] of refused) {
        expect(await f.stage(f.bundleOf([fileOf(report)], list)), label).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      }
      // A listed value that is not an exact lowercase `sha256:<64hex>` is a credential shape before it is a schema error.
      for (const digest of [sha256("x").slice("sha256:".length), sha256("x").toUpperCase()]) {
        expect(await f.stage(f.bundleOf([fileOf(report)], [{ digest, what: "a backup" }]))).toMatchObject({ ok: false, reasonCode: "TRUSTED_CREDENTIAL_LEAK_BLOCKED" });
      }
      expect(await f.stage(f.bundleOf([fileOf(report)], recorded(512)))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });
});
