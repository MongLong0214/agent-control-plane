import { realpathSync } from "node:fs";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import { ClaudeCliAdapter, __testing, claudeTranscriptDirectory, sessionRelayScript } from "../../src/runtime/cli-adapters.ts";
import type { SessionTurnRequest } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider, dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";
import { HeadlessRuntimeDouble as HeadlessRuntimeDoubleClass, type HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  __testing.setRunCli(null);
  vi.restoreAllMocks();
});

/**
 * Issue #246 PR-C slice C1b — the real headless runtime a provisioned BOOTSTRAP_CTO runs on: the
 * adapter's turn contract (one conversation, opened once and resumed after, the acp-cto relay as its
 * only MCP server, no operator settings, the credential nowhere in argv or the environment) and the
 * driver's (credential custody, take-once delivery per turn, authenticated readiness, one turn at a
 * time, coalesced wakes, refused duplicates).
 */

type RunCli = Parameters<typeof __testing.setRunCli>[0];
interface CapturedSpawn {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

/** A stand-in for the CLI process that records exactly what the adapter would execute. */
const captureRunCli = (answer: (spawn: CapturedSpawn) => Record<string, unknown>) => {
  const spawned: CapturedSpawn[] = [];
  const stub = (async (file: string, args: readonly string[], options: Record<string, unknown>) => {
    const spawn = { file, args: [...args], options };
    spawned.push(spawn);
    return {
      stdout: JSON.stringify(answer(spawn)),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isolationEnforced: false,
    };
  }) as unknown as NonNullable<RunCli>;
  __testing.setRunCli(stub);
  return spawned;
};

const adapter = () => new ClaudeCliAdapter({
  clock: new ManualClock("2026-10-09T00:00:00.000Z"),
  capacityFile: tempDir("acp-c1b-cap-") + "/claude.json",
  binary: "/bin/echo",
});

const turn = (overrides: Partial<SessionTurnRequest> & { workdir: string }): SessionTurnRequest => ({
  handle: {
    externalSessionId: "6f0c1d1e-0000-4000-8000-000000000001",
    provider: "claude",
    model: "opus",
    effort: null,
    pid: null,
    workdir: overrides.workdir,
  },
  conversation: "new",
  prompt: "the prompt",
  timeoutMs: 60_000,
  correlationId: "turn-1",
  relay: { launchSocketPath: "/state/cto.launch.sock", mcpSocketPath: "/state/cto.mcp.sock" },
  ...overrides,
});

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

describe("C1b adapter: a session turn is one conversation, opened once and resumed after", () => {
  it("the first call opens the conversation with --session-id and every later call continues it with --resume, never both", async () => {
    const workdir = tempDir("acp-c1b-turn-");
    const spawned = captureRunCli(() => ({ session_id: "6f0c1d1e-0000-4000-8000-000000000001", result: "ok", is_error: false }));
    const claude = adapter();
    expect((await claude.runSessionTurn(turn({ workdir, conversation: "new" }))).ok).toBe(true);
    expect((await claude.runSessionTurn(turn({ workdir, conversation: "resume" }))).ok).toBe(true);
    expect(flagValue(spawned[0]!.args, "--session-id")).toBe("6f0c1d1e-0000-4000-8000-000000000001");
    expect(spawned[0]!.args).not.toContain("--resume");
    expect(flagValue(spawned[1]!.args, "--resume")).toBe("6f0c1d1e-0000-4000-8000-000000000001");
    expect(spawned[1]!.args).not.toContain("--session-id");
    // Both in the session's own fixed workdir, both writing only its transcript directory.
    for (const call of spawned) {
      expect(call.options["cwd"]).toBe(realpathSync(workdir));
      expect(call.options["writablePaths"]).toEqual([claudeTranscriptDirectory(realpathSync(workdir))]);
      expect(call.options["stdin"]).toBe("the prompt");
    }
  });

  it("the acp-cto relay is the only MCP server: strict config, no operator settings, its tools alone admitted, named by socket paths and the conversation id only", async () => {
    const workdir = tempDir("acp-c1b-turn-");
    const spawned = captureRunCli(() => ({ session_id: "6f0c1d1e-0000-4000-8000-000000000001", result: "ok" }));
    await adapter().runSessionTurn(turn({ workdir }));
    const args = spawned[0]!.args;
    expect(args).toEqual(expect.arrayContaining(["-p", "--restricted", "--strict-mcp-config", "--permission-prompts", "none"]));
    expect(flagValue(args, "--settings")).toBe(__testing.sanctionedSettings());
    expect(flagValue(args, "--allowedTools")).toBe("mcp__acp-cto");
    expect(flagValue(args, "--model")).toBe("opus");
    expect(JSON.parse(flagValue(args, "--mcp-config")!)).toEqual({
      mcpServers: {
        "acp-cto": {
          type: "stdio",
          command: process.execPath,
          args: [
            sessionRelayScript(),
            "--launch", "/state/cto.launch.sock",
            "--mcp", "/state/cto.mcp.sock",
            "--session", "6f0c1d1e-0000-4000-8000-000000000001",
          ],
        },
      },
    });
    // Its script and interpreter are re-opened for reading; nothing else is.
    expect(spawned[0]!.options["readablePaths"]).toEqual({
      subtrees: [realpathSync(workdir)],
      files: [sessionRelayScript(), process.execPath],
    });
  });

  it("a probe turn reaches nothing: strict config with no server at all", async () => {
    const workdir = tempDir("acp-c1b-turn-");
    const spawned = captureRunCli(() => ({ session_id: "6f0c1d1e-0000-4000-8000-000000000001", result: "READY" }));
    await adapter().runSessionTurn(turn({ workdir, conversation: "resume", relay: null }));
    expect(spawned[0]!.args).toContain("--strict-mcp-config");
    expect(spawned[0]!.args).not.toContain("--mcp-config");
    expect(spawned[0]!.args).not.toContain("--allowedTools");
  });

  it("an answer from another conversation is not this session's turn", async () => {
    const workdir = tempDir("acp-c1b-turn-");
    captureRunCli(() => ({ session_id: "00000000-0000-4000-8000-00000000beef", result: "ok" }));
    const result = await adapter().runSessionTurn(turn({ workdir }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("SESSION_TURN_CONVERSATION_MISMATCH") });
  });

  it("invoke is unchanged for its existing callers: no conversation step means --session-id; --resume only when asked", async () => {
    const workdir = tempDir("acp-c1b-invoke-");
    const spawned = captureRunCli(() => ({ session_id: "abc", result: "{}" }));
    const claude = adapter();
    const base = { prompt: "p", workdir, timeoutMs: 1_000, readOnly: true, correlationId: "c", externalSessionId: "abc" };
    await claude.invoke(base);
    await claude.invoke({ ...base, conversation: "resume" });
    expect(flagValue(spawned[0]!.args, "--session-id")).toBe("abc");
    expect(spawned[0]!.args).not.toContain("--resume");
    expect(flagValue(spawned[1]!.args, "--resume")).toBe("abc");
  });
});

/** A bootstrap run dispatched on the in-process headless runtime, with its double. */
const dispatched = async () => {
  const harness = makeHarness();
  const claude = bootstrapCtoProvider(harness.cp, harness.clock);
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["done"],
      priority: "NORMAL", humanGate: [], references: [],
    },
  });
  if (!created.allowed) throw new Error(created.message);
  const run = await dispatchBootstrapRun(harness.cp, harness.clock, created.value.runId);
  return { harness, claude: claude as HeadlessRuntimeDouble, run, roleKey: roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId }) };
};

describe("C1b driver: the spawn's readiness is an authenticated attestation, never a row or a UUID", () => {
  it("the spawn's first turn opens the conversation and its relay presents the challenge with the delivered credential", async () => {
    const { harness, claude, run } = await dispatched();
    expect(claude.turns).toHaveLength(1);
    expect(claude.turns[0]).toMatchObject({ conversation: "new", relay: expect.anything() });
    const session = harness.cp.sessions.require(run.ownerSessionId!);
    expect(claude.credentials.get(session.sessionId)).toMatchObject({ sessionId: session.sessionId });
    const attested = harness.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_ATTESTED' AND session_id = ?`, [session.sessionId],
    )?.n;
    expect(attested).toBe(1);
  });

  it.each([
    ["the relay never takes the credential", (double: HeadlessRuntimeDouble) => { double.takeCredential = false; }],
    ["the model never presents the challenge", (double: HeadlessRuntimeDouble) => { double.presentAttestation = false; }],
  ] as const)("refused when %s: no READY session, no binding, the spawn stopped", async (_name, arrange) => {
    const harness = makeHarness();
    const claude = bootstrapCtoProvider(harness.cp, harness.clock);
    arrange(claude);
    const created = harness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "g", why: "w", scope: [], nonGoals: [], acceptance: ["a"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!created.allowed) throw new Error(created.message);
    const refused = await harness.cp.runs.dispatch(created.value.runId);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY, evidence: { cause: ReasonCode.SESSION_ATTESTATION_FAILED } });
    expect(harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: created.value.runId }))).toEqual([]);
    expect(harness.cp.db.all<{ lifecycle: string }>(`SELECT lifecycle FROM sessions WHERE provider = 'claude'`))
      .toEqual([{ lifecycle: "STOPPED" }]);
  });

  it("a spawn whose runtime has no route to the daemon is refused: nothing can authenticate it", async () => {
    const harness = makeHarness();
    // The headless double is registered, but nothing attached the launch channel or the sockets.
    const claude = new HeadlessRuntimeDoubleClass(harness.clock, "claude");
    harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);
    const created = harness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "g", why: "w", scope: [], nonGoals: [], acceptance: ["a"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!created.allowed) throw new Error(created.message);
    const refused = await harness.cp.runs.dispatch(created.value.runId);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.SESSION_NOT_READY,
      evidence: { cause: ReasonCode.SESSION_RUNTIME_UNAVAILABLE },
    });
    expect(claude.turns).toEqual([]);
    expect(harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: created.value.runId }))).toEqual([]);
  });
});

describe("C1b driver: one turn at a time; concurrent wakes coalesce; a duplicate is refused", () => {
  it("wakes during a turn coalesce into exactly one follow-up turn; never two turns at once", async () => {
    const { harness, claude, roleKey } = await dispatched();
    let release: () => void = () => undefined;
    let running = 0;
    let most = 0;
    claude.onWorkTurn = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      running -= 1;
    };
    const runtime = harness.cp.sessionRuntime;
    expect(runtime.wake(roleKey, [{ id: "m1", kind: "test" }])).toMatchObject({ allowed: true, value: "STARTED" });
    await vi.waitFor(() => expect(running).toBe(1));
    expect(runtime.wake(roleKey, [{ id: "m2", kind: "test" }])).toMatchObject({ allowed: true, value: "COALESCED" });
    expect(runtime.wake(roleKey, [{ id: "m3", kind: "test" }])).toMatchObject({ allowed: true, value: "COALESCED" });
    // A duplicate of a trigger already queued, and of the one running, is refused.
    expect(runtime.wake(roleKey, [{ id: "m2", kind: "test" }])).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
    expect(runtime.wake(roleKey, [{ id: "m1", kind: "test" }])).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
    release();
    await vi.waitFor(() => expect(claude.turns).toHaveLength(3));
    release();
    await vi.waitFor(() => expect(running).toBe(0));
    // The attestation, the first work turn, and one coalesced follow-up for m2 and m3.
    expect(claude.turns.map((turn) => turn.conversation)).toEqual(["new", "resume", "resume"]);
    expect(claude.turns[2]!.prompt).toContain("test");
    expect(most).toBe(1);
    // Once run, a trigger is never run again.
    expect(runtime.wake(roleKey, [{ id: "m3", kind: "test" }])).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
    expect(claude.turns).toHaveLength(3);
  });

  it("the credential is offered for exactly one turn and withdrawn after it; an untaken one is recorded", async () => {
    const { harness, claude, roleKey, run } = await dispatched();
    claude.takeCredential = false;
    expect(harness.cp.sessionRuntime.wake(roleKey, [{ id: "w1", kind: "test" }]).allowed).toBe(true);
    await vi.waitFor(() => expect(claude.turns).toHaveLength(2));
    await vi.waitFor(() => expect(harness.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_CREDENTIAL_NOT_TAKEN' AND session_id = ?`, [run.ownerSessionId],
    )?.n).toBe(1));
  });

  it("a session the daemon holds no credential for runs no turn", async () => {
    const { harness, claude, roleKey, run } = await dispatched();
    harness.cp.sessionRuntime.release(run.ownerSessionId!);
    expect(harness.cp.sessionRuntime.wake(roleKey, [{ id: "w1", kind: "test" }])).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.SESSION_RUNTIME_UNAVAILABLE,
    });
    expect(claude.turns).toHaveLength(1);
  });

  it("the plaintext credential reaches no argv, stdin or environment of the real adapter's turn", async () => {
    const { harness, run } = await dispatched();
    const session = harness.cp.sessions.require(run.ownerSessionId!);
    const secret = "never-in-argv-" + "x".repeat(32);
    harness.cp.sessionRuntime.adopt(session.sessionId, Role.BOOTSTRAP_CTO, secret, session.credentialEpoch);
    // Route the session through the real Claude adapter, with the CLI replaced by a recorder.
    const workdir = tempDir("acp-c1b-real-");
    const real = adapter();
    vi.spyOn(harness.cp.providers, "requireForRole").mockReturnValue(real);
    vi.spyOn(harness.cp.sessions, "get").mockImplementation((sessionId) => {
      const row = harness.cp.db.get<{ session_id: string }>(`SELECT session_id FROM sessions WHERE session_id = ?`, [sessionId]);
      if (!row) return null;
      return { ...session, workdir };
    });
    const spawned = captureRunCli(() => ({ session_id: session.incarnation.split("#", 1)[0], result: "ok" }));
    // The recorder presents no challenge, so the turn runs and the attestation is refused.
    const attested = await harness.cp.sessionRuntime.attest(session.sessionId, "resume");
    expect(attested).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_ATTESTATION_FAILED });
    expect(spawned).toHaveLength(1);
    const seen = JSON.stringify({ args: spawned[0]!.args, stdin: spawned[0]!.options["stdin"], env: process.env });
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain(session.sessionId + ":");
  });
});
