import { appendFileSync, chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES } from "../../src/core/mcp-limits.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/**
 * GAP 2 — a STANDARD_WORK run's review evidence bundle read from a file the server names itself,
 * `<stateRoot>/review-evidence/<runId>/<expectedSha256>`, instead of passing inline through the CTO's MCP call.
 * The caller names only the digest. Everything after the read is the inline path's, unchanged. Every marker is synthetic.
 */
type Args = Record<string, unknown>;
const MARKER = "SYNTHETIC-FILE-EXCERPT-2b9e";
const SOURCE = "a synthetic private source the excerpt is cut from";
const EXCERPT = { originalSha256: sha256(SOURCE), omitted: true, ranges: [{ section: "result", startLine: 1, endLine: 2 }] };
const bundleFor = (runId: string, contractDigest: string, text: string): string => {
  const bytes = Buffer.from(`## result\n${text}\n`, "utf8");
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the source"], files: [{ path: "handoff/excerpt.md", sha256: sha256(bytes),
    origin: "private handoff, synthetic", grade: "review-original", bodyBase64: bytes.toString("base64"), excerpt: EXCERPT }] });
};
const CANDIDATE_SCHEMA = "acp.standard-review-evidence-candidate.v1";
const fileModule = () => import("../../src/review/review-evidence-file.ts");

let projectSeq = 0;
async function fixture() {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h, `file-evidence-${++projectSeq}`);
  bindCeo(h);
  const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
    acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const stateRoot = dirname(h.cp.config.databasePath);
  const servers: Array<{ close(): Promise<void> }> = [];
  const connect = async (sessionId: string) => {
    const session = h.cp.sessions.require(sessionId);
    const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "standard-review-evidence-file", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    return async (args: Args): Promise<Args> => {
      const result = await client.callTool({ name: "review_evidence_stage", arguments: args }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  };
  const cto = await connect(run.ownerSessionId!);
  const body = (text: string, runId = run.runId, contractDigest = run.contractDigest) => bundleFor(runId, contractDigest, text);
  const stageArgs = (key: string, args: Args): Args => ({ idempotencyKey: key, runId: run.runId, contractDigest: run.contractDigest, ...args });
  /** Stages from the derived file: the caller names the digest, never a path. */
  const stageFile = (key: string, expectedSha256: string, args: Args = {}) => cto(stageArgs(key, { evidenceFromFile: true, expectedSha256, ...args }));
  const stageInline = (key: string, evidenceBody: string, args: Args = {}) => cto(stageArgs(key, { evidenceBody, expectedSha256: sha256(evidenceBody), ...args }));
  const evidenceRoot = join(stateRoot, "review-evidence");
  const runDir = (runId = run.runId) => join(evidenceRoot, runId);
  /** Places bytes where the stage reads them, as the preparation helper would: 0700 directories, a 0600 file. */
  const place = (bytes: string | Buffer, name = sha256(bytes), runId = run.runId): string => {
    mkdirSync(runDir(runId), { recursive: true, mode: 0o700 });
    chmodSync(evidenceRoot, 0o700);
    chmodSync(runDir(runId), 0o700);
    const path = join(runDir(runId), name);
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };
  const candidates = () => h.cp.artifacts.list<Args>(run.runId, "HANDOFF").filter((a) => a.content["schema"] === CANDIDATE_SCHEMA);
  return { h, run, stateRoot, evidenceRoot, runDir, connect, cto, body, stageFile, stageInline, place, candidates,
    close: async () => { for (const s of servers.reverse()) await s.close(); h.cp.close(); } };
}

/** A private state root holding one correctly placed bundle, for the reader on its own. */
const placedRoot = (runId: string, bytes: string) => {
  const root = tempDir("acp-evidence-root-");
  chmodSync(root, 0o700);
  const dir = join(root, "review-evidence", runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "review-evidence"), 0o700);
  chmodSync(dir, 0o700);
  const expectedSha256 = sha256(bytes);
  const path = join(dir, expectedSha256);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { root, path, expectedSha256 };
};

describe("review_evidence_stage from the server-derived file", () => {
  it("stages a file at the derived path exactly as it stages the same body inline", async () => {
    const f = await fixture();
    try {
      const evidenceBody = f.body(MARKER);
      f.place(evidenceBody);
      const fromFile = await f.stageFile("from-file", sha256(evidenceBody));
      expect(fromFile, JSON.stringify(fromFile)).toMatchObject({ ok: true, value: { digest: sha256(evidenceBody), stagedBy: f.run.ownerRoleKey } });
      const [candidate] = f.candidates();
      expect(candidate!.content).toEqual({ schema: CANDIDATE_SCHEMA, runId: f.run.runId, contractDigest: f.run.contractDigest,
        sha256: sha256(evidenceBody), stagedBy: f.run.ownerRoleKey, bodyBase64: Buffer.from(evidenceBody).toString("base64") });
      // The same body inline is the same stage: the identical answer, and no second candidate or receipt.
      const inline = await f.stageInline("inline", evidenceBody);
      expect(inline).toMatchObject({ ok: true });
      expect(inline["value"]).toEqual(fromFile["value"]);
      expect(f.candidates()).toHaveLength(1);
      expect(f.h.cp.audit.forRun(f.run.runId).filter((e) => e.kind === "STANDARD_REVIEW_EVIDENCE_STAGED")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("refuses inline and file input together, and neither", async () => {
    const f = await fixture();
    try {
      const evidenceBody = f.body(MARKER);
      f.place(evidenceBody);
      const both = await f.stageFile("both", sha256(evidenceBody), { evidenceBody });
      expect(both, JSON.stringify(both)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      const neither = await f.cto({ idempotencyKey: "neither", runId: f.run.runId, contractDigest: f.run.contractDigest, expectedSha256: sha256(evidenceBody) });
      expect(neither, JSON.stringify(neither)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(f.candidates()).toHaveLength(0);
      expect(await f.stageFile("file-alone", sha256(evidenceBody))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses a symbolic link for the evidence root, the run directory or the file, and stages once each is direct", async () => {
    const f = await fixture();
    try {
      const evidenceBody = f.body(MARKER);
      const elsewhere = placedRoot(f.run.runId, evidenceBody);
      // The evidence root is a link to a private tree holding a correct file.
      symlinkSync(join(elsewhere.root, "review-evidence"), f.evidenceRoot);
      const viaRoot = await f.stageFile("link-root", sha256(evidenceBody));
      expect(viaRoot, JSON.stringify(viaRoot)).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "SYMLINK", at: "review-evidence" } });
      rmSync(f.evidenceRoot);
      // The run directory is a link.
      mkdirSync(f.evidenceRoot, { mode: 0o700 });
      chmodSync(f.evidenceRoot, 0o700);
      symlinkSync(join(elsewhere.root, "review-evidence", f.run.runId), f.runDir());
      const viaRun = await f.stageFile("link-run", sha256(evidenceBody));
      expect(viaRun, JSON.stringify(viaRun)).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "SYMLINK", at: "run" } });
      rmSync(f.runDir());
      // The file is a link.
      mkdirSync(f.runDir(), { mode: 0o700 });
      chmodSync(f.runDir(), 0o700);
      symlinkSync(elsewhere.path, join(f.runDir(), sha256(evidenceBody)));
      const viaFile = await f.stageFile("link-file", sha256(evidenceBody));
      expect(viaFile, JSON.stringify(viaFile)).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "SYMLINK", at: "file" } });
      rmSync(join(f.runDir(), sha256(evidenceBody)));
      expect(f.candidates()).toHaveLength(0);
      f.place(evidenceBody);
      expect(await f.stageFile("direct", sha256(evidenceBody))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses contents that differ from expectedSha256, and a digest that is not one", async () => {
    const f = await fixture();
    try {
      const named = f.body(MARKER);
      const other = f.body(`${MARKER} other`);
      f.place(other, sha256(named));
      expect(await f.stageFile("bad-digest", sha256(named))).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await f.stageFile("not-a-digest", "sha256:../../state.sqlite")).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(f.candidates()).toHaveLength(0);
      f.place(named);
      expect(await f.stageFile("intact", sha256(named))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses another run's directory, another actor and another contract with the inline path's reasons", async () => {
    const f = await fixture();
    try {
      const evidenceBody = f.body(MARKER);
      // Only another run's directory holds it: nothing is at this run's derived path.
      f.place(evidenceBody, sha256(evidenceBody), "run_other");
      expect(await f.stageFile("other-run-dir", sha256(evidenceBody))).toMatchObject({ ok: false, reasonCode: "NOT_FOUND", evidence: { refusal: "MISSING" } });
      // This run's directory holding a bundle bound to another run is refused as the inline body is.
      const otherRun = f.body(MARKER, "run_other");
      f.place(otherRun);
      const inlineOtherRun = await f.stageInline("inline-other-run", otherRun);
      expect(inlineOtherRun).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(await f.stageFile("file-other-run", sha256(otherRun))).toMatchObject({ ok: false, reasonCode: inlineOtherRun["reasonCode"] });
      // Another contract, as an argument and in the body.
      f.place(evidenceBody);
      const otherContract = digestOf("another contract");
      const inlineContract = await f.stageInline("inline-contract", evidenceBody, { contractDigest: otherContract });
      expect(inlineContract).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.stageFile("file-contract", sha256(evidenceBody), { contractDigest: otherContract })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      const bodyContract = f.body(MARKER, f.run.runId, otherContract);
      f.place(bodyContract);
      expect(await f.stageFile("file-body-contract", sha256(bodyContract))).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      // Another actor: a CTO session that does not own the run.
      const stranger = f.h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" }).sessionId;
      f.h.cp.sessions.transition(stranger, SessionLifecycle.READY, "test");
      const asStranger = await f.connect(stranger);
      const strangerInline = await asStranger({ idempotencyKey: "stranger-inline", runId: f.run.runId, contractDigest: f.run.contractDigest, evidenceBody, expectedSha256: sha256(evidenceBody) });
      expect(strangerInline).toMatchObject({ ok: false });
      const strangerFile = await asStranger({ idempotencyKey: "stranger-file", runId: f.run.runId, contractDigest: f.run.contractDigest, evidenceFromFile: true, expectedSha256: sha256(evidenceBody) });
      expect(strangerFile).toMatchObject({ ok: false, reasonCode: strangerInline["reasonCode"] });
      expect(f.candidates()).toHaveLength(0);
      expect(await f.stageFile("owner", sha256(evidenceBody))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses a file or directory with the wrong mode, and a file with a second name", async () => {
    const f = await fixture();
    try {
      const evidenceBody = f.body(MARKER);
      const path = f.place(evidenceBody);
      chmodSync(path, 0o644);
      expect(await f.stageFile("file-mode", sha256(evidenceBody))).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "MODE", at: "file" } });
      chmodSync(path, 0o600);
      chmodSync(f.runDir(), 0o755);
      expect(await f.stageFile("run-mode", sha256(evidenceBody))).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "MODE", at: "run" } });
      chmodSync(f.runDir(), 0o700);
      chmodSync(f.evidenceRoot, 0o750);
      expect(await f.stageFile("root-mode", sha256(evidenceBody))).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "MODE", at: "review-evidence" } });
      chmodSync(f.evidenceRoot, 0o700);
      const second = join(f.stateRoot, "second-name");
      linkSync(path, second);
      expect(await f.stageFile("linked", sha256(evidenceBody))).toMatchObject({ ok: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "LINKED", at: "file" } });
      rmSync(second);
      expect(f.candidates()).toHaveLength(0);
      expect(await f.stageFile("intact", sha256(evidenceBody))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses a file over the staging limit before reading it", async () => {
    const f = await fixture();
    try {
      const oversize = Buffer.alloc(BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES + 1, 0x20);
      f.place(oversize);
      const refused = await f.stageFile("oversize", sha256(oversize));
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT", evidence: { refusal: "OVERSIZE" } });
      expect(String(refused["message"])).toContain(`${BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES}-byte UTF-8 staging limit`);
      expect(f.candidates()).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("agentctl review-evidence prepare writes the file the stage then accepts", async () => {
    const f = await fixture();
    try {
      const { main } = await import("../../src/cli/agentctl.ts");
      const evidenceBody = f.body(MARKER);
      const source = join(tempDir("acp-evidence-source-"), "bundle.json");
      writeFileSync(source, evidenceBody);
      vi.stubEnv("ACP_STATE_DIR", f.stateRoot);
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
      const prepare = () => main(["review-evidence", "prepare", f.run.runId, source]);
      expect(await prepare()).toBe(0);
      const printed = JSON.parse(out.join("")) as Args;
      expect(printed).toEqual({ runId: f.run.runId, expectedSha256: sha256(evidenceBody), bytes: Buffer.byteLength(evidenceBody) });
      // Again: the same bytes at the same name.
      out.length = 0;
      expect(await prepare()).toBe(0);
      expect(JSON.parse(out.join(""))).toEqual(printed);
      vi.mocked(process.stdout.write).mockRestore();
      const written = join(f.runDir(), sha256(evidenceBody));
      expect(statSync(f.evidenceRoot).mode & 0o777).toBe(0o700);
      expect(statSync(f.runDir()).mode & 0o777).toBe(0o700);
      expect(statSync(written).mode & 0o777).toBe(0o600);
      expect(readFileSync(written, "utf8")).toBe(evidenceBody);
      expect(await f.stageFile("prepared", String(printed["expectedSha256"]))).toMatchObject({ ok: true, value: { digest: sha256(evidenceBody) } });
    } finally { await f.close(); }
  });
});

describe("the review evidence file reader", () => {
  it("refuses a state root that is a symbolic link, and reads the real one", async () => {
    const { readReviewEvidenceFile } = await fileModule();
    const placed = placedRoot("run_reader", "reader bytes");
    const link = join(tempDir("acp-evidence-link-"), "state");
    symlinkSync(placed.root, link);
    expect(readReviewEvidenceFile(link, "run_reader", placed.expectedSha256)).toMatchObject({ allowed: false, reasonCode: "STATE_PATH_INSECURE",
      evidence: { at: "stateRoot" } });
    const read = readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256);
    expect(read.allowed && read.value.toString("utf8")).toBe("reader bytes");
  });

  it("refuses a file replaced after it was opened and checked", async () => {
    const { readReviewEvidenceFile } = await fileModule();
    const placed = placedRoot("run_reader", "reader bytes");
    const replacement = join(dirname(placed.path), "replacement");
    const refused = readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256, (step) => {
      if (step !== "opened") return;
      // The same bytes under a new inode, renamed over the name: the descriptor still reads the old one.
      writeFileSync(replacement, "reader bytes", { mode: 0o600 });
      chmodSync(replacement, 0o600);
      renameSync(replacement, placed.path);
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "REPLACED", at: "file" } });
    expect(readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256)).toMatchObject({ allowed: true });
  });

  it("refuses a file that grows while it is read", async () => {
    const { readReviewEvidenceFile } = await fileModule();
    const placed = placedRoot("run_reader", "reader bytes");
    let grown = false;
    const refused = readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256, (step) => {
      if (step !== "read" || grown) return;
      grown = true;
      appendFileSync(placed.path, " and more");
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "CHANGED_DURING_READ", at: "file" } });
  });

  it("refuses a run directory swapped after it was checked and held", async () => {
    const { readReviewEvidenceFile } = await fileModule();
    const placed = placedRoot("run_reader", "reader bytes");
    const elsewhere = placedRoot("run_reader", "reader bytes");
    const runDir = dirname(placed.path);
    const refused = readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256, (step) => {
      if (step !== "held") return;
      // A private directory holding the same bytes takes the run directory's name.
      renameSync(runDir, `${runDir}.moved`);
      renameSync(dirname(elsewhere.path), runDir);
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: "STATE_PATH_INSECURE", evidence: { refusal: "SWAPPED", at: "file" } });
  });

  it("refuses a file and directories another user owns", async () => {
    const { readReviewEvidenceFile } = await fileModule();
    const placed = placedRoot("run_reader", "reader bytes");
    const uid = process.getuid!();
    const otherUser = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256)).toMatchObject({ allowed: false, reasonCode: "STATE_PATH_INSECURE",
      evidence: { refusal: "OWNER" } });
    otherUser.mockRestore();
    expect(readReviewEvidenceFile(placed.root, "run_reader", placed.expectedSha256)).toMatchObject({ allowed: true });
  });
});
