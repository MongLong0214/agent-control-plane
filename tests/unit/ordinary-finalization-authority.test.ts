import { createConnection, type Socket } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { adoptedFixture, DIGEST, LIVE } from "../helpers/adopted-ceo.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * The finalization authority of an ordinary (non-CONTRACT_CHANGE) run, as main has it.
 *
 * The daemon releases its GitHub sequence for a CEO_APPROVED run on `currentCeoConfirmation`,
 * which reads a CEO_DECISION audit row. Two questions are kept apart here, because they are
 * judged differently:
 *
 *   (a) a forged row: does a CEO_DECISION row the CONFIRM path never wrote release the merge?
 *       It needs a raw database writer, and the CEO_APPROVED state that goes with it needs an
 *       in-process caller of the generic transition; no MCP tool offers either.
 *   (b) a normal caller: can a connection authenticated on a CEO door name a *different*
 *       `ceoSessionId` and get a run confirmed, and so completed?
 */

afterAll(cleanupTempDirs);

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";

/** GitHub's merged pull keeps its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merged = response as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return response;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return response;
  };
};

/** A STANDARD_WORK run at READY_FOR_CEO_REVIEW with a published packet; nobody has decided. */
const readyForCeo = async () => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-authority",
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("authority witness packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { github, harness, driven };
};

const runDaemonOnce = async (harness: Harness, prefix: string): Promise<void> => {
  const daemon = new Daemon(harness.cp, { stateDir: tempDir(prefix) });
  const started = await daemon.start();
  expect(started.allowed).toBe(true);
  await daemon.stop();
};

const ceoDecisionRows = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "CEO_DECISION");

/** A READY session with its one-time secret, bound to the CEO role the way a switchover binds it. */
const wireCeo = (harness: Harness, model: string) => {
  const created = harness.cp.sessions.create({ provider: "scripted", model });
  harness.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "wire CEO");
  const switched = harness.cp.bindings.switchTo({
    role: Role.CEO,
    sessionId: created.sessionId,
    reason: "authority witness CEO",
    conversation: "REPLACED",
  });
  if (!switched.allowed) throw new Error(switched.message);
  if (!created.sessionSecret) throw new Error("fixture session has no secret");
  return { sessionId: created.sessionId, sessionSecret: created.sessionSecret };
};

const readySession = (harness: Harness, model: string) => {
  const created = harness.cp.sessions.create({ provider: "scripted", model });
  harness.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "witness stranger");
  if (!created.sessionSecret) throw new Error("fixture session has no secret");
  return { sessionId: created.sessionId, sessionSecret: created.sessionSecret };
};

/** One line-delimited MCP connection to a daemon socket, kept open between requests. */
const openMcp = (socketPath: string, credential: { sessionId: string; sessionSecret: string }) => {
  const socket: Socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  let closed = false;
  const waiters: Array<() => void> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("close", () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("error", () => undefined);
  const lines = (): Record<string, unknown>[] =>
    buffer.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  const send = (line: unknown): void => {
    socket.write(`${JSON.stringify(line)}\n`);
  };
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (closed || Date.now() > deadline) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  const response = async (id: number): Promise<Record<string, unknown> | null> => {
    await until(() => lines().some((line) => line["id"] === id));
    return lines().find((line) => line["id"] === id) ?? null;
  };
  send({ token: "witness-mcp-token", ...credential });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "authority-witness", version: "1" } },
  });
  return {
    initialized: async () => {
      const answer = await response(1);
      if (answer) send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return answer;
    },
    call: async (id: number, args: Record<string, unknown>) => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ceo_decision_submit", arguments: args } });
      const answer = await response(id);
      const result = answer?.["result"] as { structuredContent?: Record<string, unknown> } | undefined;
      return result?.structuredContent ?? null;
    },
    transcript: () => buffer,
    closed: () => closed,
    close: () => socket.destroy(),
  };
};

const confirmArgs = (
  key: string,
  driven: { runId: string; candidateSnapshotDigest: string },
  ceoSessionId: string,
) => ({
  idempotencyKey: key,
  runId: driven.runId,
  decision: "CONFIRM",
  candidateSnapshotDigest: driven.candidateSnapshotDigest,
  ceoSessionId,
  rationale: "authority witness",
});

describe("Step 0 (a): a CEO_DECISION row the CONFIRM path never wrote [Limit candidate: raw writer only]", () => {
  it("control: a CEO_APPROVED state with no CEO_DECISION row releases nothing", async () => {
    const { github, harness, driven } = await readyForCeo();
    // The generic transition is in-process only: no MCP tool takes it, and a raw UPDATE of
    // `runs.state` is refused by runs_state_transition_authority_guard.
    expect(harness.cp.runs.transition(driven.runId, RunState.CEO_APPROVED, "witness: no decision", {
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
    }).allowed).toBe(true);
    await runDaemonOnce(harness, "acp-step0a-control-");
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(github.mergeCount).toBe(0);
  });

  it("a raw-inserted CEO_DECISION row is the whole authority the finalizer asks for: it merges and completes", async () => {
    const { github, harness, driven } = await readyForCeo();
    expect(() =>
      harness.cp.db.run("UPDATE runs SET state = 'CEO_APPROVED' WHERE run_id = ?", [driven.runId]),
    ).toThrow(/RUN_STATE_TRANSITION_AUTHORITY_DENIED/);
    expect(harness.cp.runs.transition(driven.runId, RunState.CEO_APPROVED, "witness: forged decision", {
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
    }).allowed).toBe(true);
    // The forgery: nothing about this row says the CONFIRM path wrote it.
    harness.cp.db.run(
      `INSERT INTO audit_events (at, kind, run_id, session_id, evidence_json)
       VALUES (?, 'CEO_DECISION', ?, 'nobody', ?)`,
      [
        harness.clock.nowIso(),
        driven.runId,
        JSON.stringify({ decision: "CONFIRM", candidateSnapshotDigest: driven.candidateSnapshotDigest, rationale: "forged" }),
      ],
    );
    expect(harness.cp.ceo.currentCeoConfirmation(driven.runId, driven.candidateSnapshotDigest).allowed).toBe(true);
    await runDaemonOnce(harness, "acp-step0a-forged-");
    // Today: the forged row released the GitHub sequence and the run completed.
    expect(github.mergeCount).toBe(1);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(ceoDecisionRows(harness, driven.runId).map((row) => row.sessionId)).toEqual(["nobody"]);
  });
});

// Neither CEO door compares `ceoSessionId` with the authenticated peer. Each re-checks on every call
// that the peer is the current CEO binding, and the gate requires the argument to be that binding
// too, so the two agree only by way of the binding. A door whose authenticator did not pin the CEO
// binding would reopen the question these tests answer.
describe("Step 0 (b): a CEO-door caller naming a different ceoSessionId", () => {
  it("hermes.mcp.sock: the bound CEO naming another session is refused; naming itself confirms and the run completes", async () => {
    const { github, harness, driven } = await readyForCeo();
    const ceo = wireCeo(harness, "wire-ceo");
    const other = readySession(harness, "other-session");
    await harness.cp.continuity.evaluate("authority witness wire");
    const listeners = await startDaemonMcpListeners(harness.cp, tempDir("acp-step0b-sock-"), "witness-mcp-token", {
      finalizeApprovedRun: async () => undefined,
    });
    const socketPath = listeners.socketPaths[0]!;
    try {
      const connection = openMcp(socketPath, ceo);
      expect(await connection.initialized()).not.toBeNull();
      for (const [index, named] of [other.sessionId, driven.ownerSessionId, "sess_does_not_exist"].entries()) {
        const refused = await connection.call(10 + index, confirmArgs(`step0b-other-${index}`, driven, named));
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
      }
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(ceoDecisionRows(harness, driven.runId)).toEqual([]);
      await runDaemonOnce(harness, "acp-step0b-refused-");
      expect(github.mergeCount).toBe(0);

      const confirmed = await connection.call(20, confirmArgs("step0b-self", driven, ceo.sessionId));
      expect(confirmed).toMatchObject({ ok: true, value: { state: RunState.CEO_APPROVED } });
      connection.close();
      await runDaemonOnce(harness, "acp-step0b-confirmed-");
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      expect(github.mergeCount).toBe(1);
      expect(ceoDecisionRows(harness, driven.runId).map((row) => row.sessionId)).toEqual([ceo.sessionId]);
    } finally {
      await listeners.close();
    }
  });

  it("hermes.mcp.sock: a session that does not hold the CEO role naming the CEO's id never gets a tool", async () => {
    const { github, harness, driven } = await readyForCeo();
    const ceo = wireCeo(harness, "wire-ceo");
    const stranger = readySession(harness, "stranger");
    await harness.cp.continuity.evaluate("authority witness stranger");
    const listeners = await startDaemonMcpListeners(harness.cp, tempDir("acp-step0b-stranger-"), "witness-mcp-token", {
      finalizeApprovedRun: async () => undefined,
    });
    try {
      const connection = openMcp(listeners.socketPaths[0]!, stranger);
      const answer = await connection.initialized();
      expect(answer).toBeNull();
      expect(connection.transcript()).toContain(ReasonCode.BINDING_GENERATION_STALE);
      connection.close();
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(ceoDecisionRows(harness, driven.runId)).toEqual([]);
      expect(ceo.sessionId).not.toBe(stranger.sessionId);
      expect(github.mergeCount).toBe(0);
    } finally {
      await listeners.close();
    }
  });

  it("hermes.mcp.sock: a CEO connection the role has since left, naming the new CEO's id, is refused per call", async () => {
    const { harness, driven } = await readyForCeo();
    const first = wireCeo(harness, "first-ceo");
    await harness.cp.continuity.evaluate("authority witness first");
    const listeners = await startDaemonMcpListeners(harness.cp, tempDir("acp-step0b-moved-"), "witness-mcp-token", {
      finalizeApprovedRun: async () => undefined,
    });
    try {
      const connection = openMcp(listeners.socketPaths[0]!, first);
      expect(await connection.initialized()).not.toBeNull();
      const second = wireCeo(harness, "second-ceo");
      await harness.cp.continuity.evaluate("authority witness second");
      const refused = await connection.call(30, confirmArgs("step0b-moved", driven, second.sessionId));
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      connection.close();
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(ceoDecisionRows(harness, driven.runId)).toEqual([]);
    } finally {
      await listeners.close();
    }
  });

  it("adopted CEO door: the admitted Gateway naming another session is refused; naming its own binding confirms", async () => {
    const fixture = adoptedFixture();
    try {
      const driven = await driveToReviewedCandidate(fixture.h);
      await fixture.h.cp.continuity.evaluate("adopted authority witness packet");
      const packet = fixture.h.cp.ceo.buildPacket({
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        approval: {
          runId: driven.runId,
          candidateSnapshotDigest: driven.candidateSnapshotDigest,
          resultSummary: "candidate verified",
          recommendation: "merge",
          residualRisk: [],
          approvedBySessionId: driven.ownerSessionId,
          approvedByGeneration: driven.ownerBindingGeneration,
          approvedAt: fixture.h.clock.nowIso(),
        },
      });
      if (!packet.allowed) throw new Error(packet.message);
      const admission = fixture.admission();
      const admitted = await fixture.admit();
      if (!admitted.allowed) throw new Error(admitted.message);
      // What `startAdoptedCeoToolSocket` builds for an admitted connection.
      const server = createHermesServer(createHermesMcpPort(fixture.h.cp), () => admission.authenticate(admitted.value),
        { provenance: admitted.value.provenance });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "adopted-authority-witness", version: "1" });
      await client.connect(clientTransport);
      try {
        const call = async (key: string, ceoSessionId: string) => (await client.callTool({
          name: "ceo_decision_submit",
          arguments: confirmArgs(key, driven, ceoSessionId),
          _meta: { [HERMES_PROVENANCE_META_KEY]: { session_id: LIVE, lineage_root_digest: DIGEST,
            principal: "owner", cron: false, delegation_depth: 0 } },
        })).structuredContent;
        const ceo = fixture.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
        expect(ceo.sessionId).toBe(fixture.gatewaySessionId);
        expect(await call("adopted-other", driven.ownerSessionId)).toMatchObject({
          ok: false,
          reasonCode: ReasonCode.GATE_AUTHORITY_DENIED,
        });
        expect(fixture.h.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
        expect(ceoDecisionRows(fixture.h, driven.runId)).toEqual([]);
        expect(await call("adopted-self", ceo.sessionId)).toMatchObject({
          ok: true,
          value: { state: RunState.CEO_APPROVED },
        });
      } finally {
        await client.close();
      }
    } finally {
      fixture.h.cp.close();
    }
  });
});
