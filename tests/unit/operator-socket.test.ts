import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS, createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { OPERATOR_METHOD } from "../../src/daemon/daemon.ts";
import { DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS, startOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { allow } from "../../src/core/errors.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import {
  makeStartedOperator,
  TEST_OWNER,
  TEST_MCP_TOKEN,
  TEST_OPERATOR_TOKEN,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

const execFile = promisify(execFileCallback);
const OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
const MCP_TOKEN = TEST_MCP_TOKEN;

const CONTRACT: TaskContract = {
  goal: "operator socket regression",
  why: "prove the CLI is not a second runtime authority",
  scope: [],
  nonGoals: [],
  acceptance: ["operator requests are daemon-owned"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const operatorRequest = (
  socketPath: string,
  token: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("operator socket test timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ token, ...request })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve(JSON.parse(received.trim()) as Record<string, unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const createQueuedRun = async (harness: Harness): Promise<string> => {
  const registered = await registerFixtureProject(harness);
  const created = harness.cp.runs.create({
    projectId: registered.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  return created.value.runId;
};

/**
 * A socket whose only method sleeps. The two budgets are passed explicitly and small so the test
 * measures which deadline governs which phase, not how long a real doctor pass takes.
 */
const startSleepingOperator = async (budgets: {
  answerAfterMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
}) => {
  const stateDir = tempDir("acp-operator-deadlines-");
  return startOperatorSocket(
    {
      lock: { held: () => true } as never,
      handleOperatorRequest: async () => {
        await new Promise((resolve) => setTimeout(resolve, budgets.answerAfterMs));
        return allow(ReasonCode.OK, { answered: true });
      },
    } as never,
    stateDir,
    { token: OPERATOR_TOKEN, peerId: `cli:${TEST_OWNER.actor}`, actor: TEST_OWNER.actor },
    {
      mcpToken: MCP_TOKEN,
      handshakeTimeoutMs: budgets.handshakeTimeoutMs,
      requestTimeoutMs: budgets.requestTimeoutMs,
    },
  );
};

describe("operator deadlines name the phase they govern (#609)", () => {
  it("answers a method that outlives the handshake budget instead of calling it unauthenticated", async () => {
    // The defect this pins: the handshake timer stayed armed after the peer authenticated, so a
    // method slower than five seconds answered OPERATOR_UNAUTHENTICATED to an operator whose
    // token was correct. Measured against the live daemon, `doctor.run` came back at 5002ms with
    // exactly that code while `daemon.status` answered in 2ms on the same socket and token.
    const listener = await startSleepingOperator({
      answerAfterMs: 400,
      handshakeTimeoutMs: 120,
      requestTimeoutMs: 4_000,
    });
    try {
      const response = await operatorRequest(listener.socketPath, OPERATOR_TOKEN, {
        requestId: "req-slow-but-fine",
        method: "doctor.run",
        params: { scope: "system", target: null },
      });
      expect(response["allowed"]).toBe(true);
      expect(response["reasonCode"]).toBe(ReasonCode.OK);
    } finally {
      await listener.close();
    }
  });

  it("refuses a method that outlives its own budget as a timeout, naming the method", async () => {
    const listener = await startSleepingOperator({
      answerAfterMs: 4_000,
      handshakeTimeoutMs: 120,
      requestTimeoutMs: 250,
    });
    try {
      const response = await operatorRequest(listener.socketPath, OPERATOR_TOKEN, {
        requestId: "req-too-slow",
        method: "doctor.run",
        params: {},
      });
      expect(response["allowed"]).toBe(false);
      expect(response["reasonCode"]).toBe(ReasonCode.OPERATOR_REQUEST_TIMEOUT);
      expect((response["evidence"] as { method?: string }).method).toBe("doctor.run");
    } finally {
      await listener.close();
    }
  });

  it("still closes a connection that authenticates nothing, and still calls that unauthenticated", async () => {
    const listener = await startSleepingOperator({
      answerAfterMs: 0,
      handshakeTimeoutMs: 120,
      requestTimeoutMs: 4_000,
    });
    try {
      const silent = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(listener.socketPath);
        let received = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          received += chunk;
          if (!received.includes("\n")) return;
          socket.end();
          resolve(JSON.parse(received.trim()) as Record<string, unknown>);
        });
        socket.once("error", reject);
      });
      expect(silent["allowed"]).toBe(false);
      expect(silent["reasonCode"]).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
      expect(silent["message"]).toBe("operator handshake timed out");
    } finally {
      await listener.close();
    }
  });

  it("gives the client a strictly larger budget than the daemon, so the daemon's answer wins", () => {
    // Equal budgets are a coin flip, and the live daemon lost it both ways: three attempts
    // produced OPERATOR_UNAUTHENTICATED once and DAEMON_LOCK_LOST twice, from one healthy daemon.
    expect(DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS);
  });
});

describe("authenticated operator socket (#393/#405)", () => {
  it("removes capacity set instead of retaining a command that only writes an ignored file", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await dispatch(
        createOperatorClient({ socketPath: join(tempDir("acp-capacity-set-removed-"), "operator.sock") }),
        "capacity",
        ["set", "scripted", "{}"],
        false,
      );
      // Reinstating either the CLI branch or daemon method makes this return a socket result
      // rather than the usage error, and reintroduces the ignored-file false-success path.
      expect(code).toBe(2);
      expect(Object.values(OPERATOR_METHOD)).not.toContain("capacity.set");
    } finally {
      stderr.mockRestore();
    }
  });

  it("maps actor register, list, and unregister commands onto the daemon operator methods", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn(async () => ({
      allowed: true as const,
      reasonCode: ReasonCode.OK,
      evidence: {},
      value: {},
    }));
    const client = { request };
    try {
      expect(await dispatch(client, "actor", ["register", "actor:cli-cto", "5", "0"], false)).toBe(0);
      expect(await dispatch(client, "actor", ["list"], false)).toBe(0);
      expect(await dispatch(
        client,
        "actor",
        ["unregister", "actor:cli-cto", "5", "1", "owner", "rotation"],
        false,
      )).toBe(0);

      expect(request.mock.calls).toEqual([
        ["actor.register", {
          actorId: "actor:cli-cto",
          actorGeneration: 5,
          expectedRegistrySetGeneration: 0,
        }, undefined],
        ["actor.list", {}, undefined],
        ["actor.unregister", {
          actorId: "actor:cli-cto",
          actorGeneration: 5,
          expectedRegistrySetGeneration: 1,
          reason: "owner rotation",
        }, undefined],
      ]);
    } finally {
      stdout.mockRestore();
    }
  });

  it("routes a CLI-shaped mutation through the lock-held daemon and opens a 0600 socket", async () => {
    const running = await makeStartedOperator();
    try {
      const runId = await createQueuedRun(running.harness);
      const client = createOperatorClient({ socketPath: running.socketPath, token: OPERATOR_TOKEN });
      const code = await dispatch(client, "run", ["cancel", runId, "operator", "test"], false);

      expect(code).toBe(0);
      expect(running.harness.cp.runs.get(runId)?.state).toBe("CANCELLED");
      expect(statSync(running.socketPath).mode & 0o777).toBe(0o600);
    } finally {
      await running.close();
    }
  });

  it("registers, queries, and unregisters an actor through the authenticated daemon surface", async () => {
    const running = await makeStartedOperator();
    const actorId = "actor:operator-cto";
    try {
      running.harness.cp.db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at)
         VALUES (?, 'PRIMARY_CTO', ?)`,
        [actorId, running.harness.clock.nowIso()],
      );

      const registered = await running.daemon.handleOperatorRequest({
        requestId: "actor-register",
        method: "actor.register",
        params: { actorId, actorGeneration: 7, expectedRegistrySetGeneration: 0 },
        idempotencyKey: "actor-register-once",
      }, running.peer);
      const listed = await running.daemon.handleOperatorRequest({
        requestId: "actor-list",
        method: "actor.list",
        params: {},
      }, running.peer);
      const unregistered = await running.daemon.handleOperatorRequest({
        requestId: "actor-unregister",
        method: "actor.unregister",
        params: {
          actorId,
          actorGeneration: 7,
          expectedRegistrySetGeneration: 1,
          reason: "operator rotation",
        },
        idempotencyKey: "actor-unregister-once",
      }, running.peer);

      expect(registered).toMatchObject({ allowed: true, value: { registrySetGeneration: 1 } });
      expect(listed).toMatchObject({
        allowed: true,
        value: { registrySetGeneration: 1, actors: [{ actorId, actorGeneration: 7 }] },
      });
      expect(unregistered).toMatchObject({ allowed: true, value: { registrySetGeneration: 2 } });
    } finally {
      await running.close();
    }
  });

  it("runs the real CLI process without creating its default state directory", async () => {
    const running = await makeStartedOperator();
    const isolatedHome = tempDir("acp-operator-cli-home-");
    try {
      const runId = await createQueuedRun(running.harness);
      const cli = await execFile(
        process.execPath,
        [
          join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
          join(process.cwd(), "src/cli/agentctl.ts"),
          "run",
          "cancel",
          runId,
          "child",
          "process",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: isolatedHome,
            ACP_OPERATOR_SOCKET: running.socketPath,
            ACP_OPERATOR_TOKEN: OPERATOR_TOKEN,
          },
          maxBuffer: 2 * 1024 * 1024,
        },
      );

      expect(cli.stderr).toBe("");
      expect(JSON.parse(cli.stdout) as { state?: unknown }).toMatchObject({ state: "CANCELLED" });
      expect(running.harness.cp.runs.get(runId)?.state).toBe("CANCELLED");
      expect(existsSync(join(isolatedHome, ".agent-control-plane"))).toBe(false);
    } finally {
      await running.close();
    }
  });

  it("fails closed when the daemon is down rather than opening the database directly", async () => {
    const socketPath = join(tempDir("acp-operator-down-"), "missing.operator.sock");
    const client = createOperatorClient({ socketPath, token: "operator-token", timeoutMs: 250 });
    const result = await client.request("run.cancel", { runId: "run_missing", reason: "test" }, "down-mutation");
    const exportResult = await client.request("run.export", { runId: "run_missing" }, "down-export");

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
    if (result.allowed) return;
    expect(result.message).toMatch(/no direct database fallback/);
    expect(exportResult.allowed).toBe(false);
    expect(exportResult.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
    if (exportResult.allowed) return;
    expect(exportResult.message).toMatch(/no direct database fallback/);
  });

  it("refuses an in-process operator request after the daemon lock is released", async () => {
    const running = await makeStartedOperator();
    try {
      await running.daemon.stop();
      const result = await running.daemon.handleOperatorRequest({
        requestId: "after-stop",
        method: "run.cancel",
        params: { runId: "run_missing", reason: "must fail closed" },
        idempotencyKey: "after-stop-once",
      }, running.peer);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
    } finally {
      await running.close();
    }
  });

  it("coalesces concurrent requests and replays the same result idempotently", async () => {
    const running = await makeStartedOperator();
    try {
      const runId = await createQueuedRun(running.harness);
      const params = { runId, reason: "same operator request" };
      const [first, second] = await Promise.all([
        createOperatorClient({ socketPath: running.socketPath, token: OPERATOR_TOKEN })
          .request("run.cancel", params),
        createOperatorClient({ socketPath: running.socketPath, token: OPERATOR_TOKEN })
          .request("run.cancel", params),
      ]);

      expect(first).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
      expect(second).toEqual(first);
      expect(running.harness.cp.audit.byKind("RUN_TRANSITION")).toHaveLength(1);
    } finally {
      await running.close();
    }
  });

  it("rejects the MCP credential and a wrong credential for every operator method", async () => {
    const running = await makeStartedOperator();
    try {
      for (const [index, method] of Object.values(OPERATOR_METHOD).entries()) {
        const request = {
          requestId: `bad-credential-${index}`,
          method,
          params: {},
        };
        const mcp = await operatorRequest(running.socketPath, MCP_TOKEN, request);
        const wrong = await operatorRequest(running.socketPath, "wrong-operator-token", {
          ...request,
          requestId: `wrong-credential-${index}`,
        });

        expect(mcp).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED,
        });
        expect(wrong).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED,
        });
      }
    } finally {
      await running.close();
    }
  });

  it("refuses to start when the dedicated operator credential is absent or is the MCP token", async () => {
    const running = await makeStartedOperator();
    try {
      await expect(
        startOperatorSocket(
          running.daemon,
          tempDir("acp-operator-mcp-only-"),
          { token: MCP_TOKEN, peerId: "cli:test-owner", actor: TEST_OWNER.actor },
          { mcpToken: MCP_TOKEN },
        ),
      ).rejects.toThrow(/dedicated credential distinct from ACP_MCP_TOKEN/);
      await expect(
        startOperatorSocket(
          running.daemon,
          tempDir("acp-operator-no-token-"),
          { token: "", peerId: "cli:test-owner", actor: TEST_OWNER.actor },
          { mcpToken: MCP_TOKEN },
        ),
      ).rejects.toThrow(/ACP_OPERATOR_TOKEN is required/);
    } finally {
      await running.close();
    }
  });

  it("denies an authenticated non-owner even when the request claims the allowlisted actor", async () => {
    const running = await makeStartedOperator({ operatorActor: "authenticated-non-owner" });
    try {
      const result = await operatorRequest(running.socketPath, OPERATOR_TOKEN, {
        requestId: "forged-repair",
        method: "repair.execute",
        params: {
          operationId: "prune_orphan_worktrees",
          parameters: {},
          owner: true,
          actor: TEST_OWNER.actor,
        },
        idempotencyKey: "forged-repair-once",
      });

      expect(result).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
      });
      expect(running.harness.cp.audit.byKind("INGRESS_REFUSED")).toHaveLength(1);
      expect(running.harness.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(0);
      expect(running.harness.cp.audit.byKind("REPAIR_EXECUTED")).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it("mints and admits the exact owner receipt in the daemon before executing repair", async () => {
    const running = await makeStartedOperator();
    try {
      await registerFixtureProject(running.harness);
      gitSync(running.harness.repoPath, [
        "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach",
        join(running.harness.root, "worktrees", "operator-owner-orphan"), "HEAD",
      ]);
      const client = createOperatorClient({ socketPath: running.socketPath, token: OPERATOR_TOKEN });
      const code = await dispatch(client, "repair", ["execute", "prune_orphan_worktrees"], true);

      expect(code).toBe(0);
      expect(running.harness.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(1);
      expect(running.harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
    } finally {
      await running.close();
    }
  });

  it("mints and admits the owner receipt through a child-process --owner invocation", async () => {
    const running = await makeStartedOperator();
    const isolatedHome = tempDir("acp-operator-owner-cli-home-");
    try {
      await registerFixtureProject(running.harness);
      gitSync(running.harness.repoPath, [
        "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach",
        join(running.harness.root, "worktrees", "operator-owner-cli-orphan"), "HEAD",
      ]);
      const cli = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
        execFileCallback(
          process.execPath,
          [
            join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
            join(process.cwd(), "src/cli/agentctl.ts"),
            "repair",
            "execute",
            "prune_orphan_worktrees",
            "--owner",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              HOME: isolatedHome,
              ACP_OPERATOR_SOCKET: running.socketPath,
              ACP_OPERATOR_TOKEN: OPERATOR_TOKEN,
            },
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }),
        );
      });

      expect(cli.error).toBeNull();
      expect(cli.stderr).toBe("");
      expect(JSON.parse(cli.stdout) as { operationId?: unknown; authorizedBy?: unknown }).toMatchObject({
        operationId: "prune_orphan_worktrees",
        authorizedBy: "OWNER",
      });
      expect(running.harness.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(1);
      expect(running.harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
      expect(running.harness.cp.audit.byKind("REPAIR_EXECUTED")).toHaveLength(1);
    } finally {
      await running.close();
    }
  });

  it("CP-HI-02: the real CLI opens no state when there is no daemon to answer it", async () => {
    // The neighbouring process test runs with a daemon listening, so it proves the CLI does
    // not open state on the *happy* path. This is the path a direct-database fallback would
    // be written for: nothing is listening, and the tempting thing is to read the database.
    //
    // It is behavioural on purpose. The source-text assertions below are defence in depth and
    // a renamed import or a re-exported factory walks straight past them; a process that
    // creates a state directory cannot hide from this one.
    const isolatedHome = tempDir("acp-operator-nodaemon-home-");
    const socketPath = join(tempDir("acp-operator-nodaemon-"), "absent.operator.sock");

    const cli = await execFile(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        join(process.cwd(), "src/cli/agentctl.ts"),
        "run",
        "cancel",
        "run_does_not_exist",
        "no",
        "daemon",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: isolatedHome,
          ACP_OPERATOR_SOCKET: socketPath,
          ACP_OPERATOR_TOKEN: OPERATOR_TOKEN,
        },
        maxBuffer: 2 * 1024 * 1024,
      },
    ).catch((error: { stdout?: string; stderr?: string; code?: number }) => error);

    const combined = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
    expect(combined).toMatch(/no direct database fallback|DAEMON_LOCK_LOST/);
    // The property that matters: no daemon, and still no state of its own.
    expect(existsSync(join(isolatedHome, ".agent-control-plane"))).toBe(false);
  });

  it("keeps the CLI an explicit socket client with no ControlPlane or capability issuance path", () => {
    const source = readFileSync(new URL("../../src/cli/agentctl.ts", import.meta.url), "utf8");
    const daemonSource = readFileSync(new URL("../../src/daemon/agentcpd.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/new ControlPlane\s*\(/);
    expect(source).not.toMatch(/ControlPlane/);
    expect(source).not.toMatch(/new Db\s*\(|writeFileSync|mkdirSync|IngressGuard/);
    expect(source).not.toMatch(/ACP_MCP_TOKEN|ACP_OWNER_ACTOR/);
    expect(source).toMatch(/createOperatorClient/);
    expect(source).toMatch(/no direct database fallback/);
    // Capability issuance remains a daemon composition concern; the client only serializes
    // plain operator requests and can never obtain the private completion/evidence tokens.
    expect(source).not.toMatch(/issueCompletionAuthorities|issueEvidenceWriters|daemonFinalizationAuthorities/);
    expect(daemonSource).toMatch(/operator = await startOperatorSocket\(/);
    expect(daemonSource).toMatch(/ACP_OPERATOR_TOKEN is required/);
    expect(daemonSource).not.toMatch(/ACP_OPERATOR_TOKEN[^\n]*\|\|\s*mcpToken/);
    expect(daemonSource).toMatch(/await operator\?\.close\(\)/);
  });
});
