import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runHermesAcp } from "../../src/runtime/hermes-acp-client.ts";

class FakeOutput extends EventEmitter {
  emitText(value: string): void {
    this.emit("data", Buffer.from(value, "utf8"));
  }

  finish(): void {
    this.emit("end");
  }
}

class FakeInput {
  readonly writes: string[] = [];
  endCalls = 0;
  onWrite: ((value: string) => void) | undefined;

  write(value: string): boolean {
    this.writes.push(value);
    this.onWrite?.(value);
    return true;
  }

  end(): void {
    this.endCalls += 1;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeInput();
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  killCalls = 0;
  exitCalls = 0;
  exitOnKill = true;
  private exited = false;

  kill(): boolean {
    this.killCalls += 1;
    if (this.exitOnKill && !this.exited) queueMicrotask(() => this.exit(0));
    return !this.exited;
  }

  exit(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCalls += 1;
    this.emit("exit", code, signal);
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

const targetBindPublic = {
  domain: "hermes.target-bind",
  version: 1,
  actor_id: "actor:ceo",
  binding_generation: 7,
  executor_runtime_identity: "runtime:ceo",
  requested_session_id: "hermes-session-1",
  lineage_root_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
} as const;

const targetBindReceipt = {
  ...targetBindPublic,
  receipt_digest: digest(targetBindPublic),
} as const;

const receiptIdentity = {
  schema: "hermes.acp-terminal-receipt-identity",
  version: 1,
  turnRequestId: "turn-1",
  targetActorId: "actor:ceo",
  promptDigest: digest("exact prompt bytes"),
  bindingGeneration: 7,
  targetBindingId: "binding-1",
  targetAttestationId: "attestation-1",
  executorSessionId: "executor-session-1",
  executorSessionIncarnation: "incarnation-1",
} as const;

const frame = (id: number, result: unknown): string => `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
const rpcError = (id: number): string => `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "refused" } })}\n`;
const initialized = (): string => frame(1, { protocolVersion: 1, agentInfo: { name: "hermes-agent", version: "test" }, agentCapabilities: {}, authMethods: [] });

const terminalResult = (receipt: Record<string, unknown>, extraMeta: Record<string, unknown> = {}): Record<string, unknown> => ({
  stopReason: receipt.status === "REFUSED" ? "refusal" : "end_turn",
  _meta: { hermes: { acpTerminalReceipt: receipt }, ...extraMeta },
});

const completed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "COMPLETED",
  turnRequestId: receiptIdentity.turnRequestId,
  sessionId: targetBindReceipt.requested_session_id,
  terminalMessageId: "message-1",
  responseDigest: digest("exact Hermes bytes"),
  createdAt: 1,
  claimedAt: 2,
  completedAt: 3,
  receiptIdentity,
  receiptIdentityDigest: digest(receiptIdentity),
  targetBindReceipt: { schema: "hermes.target-bind-receipt", ...targetBindReceipt },
  targetBindReceiptDigest: targetBindReceipt.receipt_digest,
  assistantContent: "exact Hermes bytes",
  ...overrides,
});

const inFlight = (status: "PREPARED" | "CLAIMED"): Record<string, unknown> => ({
  status,
  turnRequestId: receiptIdentity.turnRequestId,
  sessionId: targetBindReceipt.requested_session_id,
  terminalMessageId: null,
  responseDigest: null,
  createdAt: 1,
  claimedAt: status === "CLAIMED" ? 2 : null,
  completedAt: null,
  receiptIdentity,
  receiptIdentityDigest: digest(receiptIdentity),
  targetBindReceipt: { schema: "hermes.target-bind-receipt", ...targetBindReceipt },
  targetBindReceiptDigest: targetBindReceipt.receipt_digest,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  operation: "execute" as const,
  executable: "/trusted/hermes",
  cwd: "/trusted/cwd",
  home: "/trusted/home",
  hermesHome: "/trusted/hermes-home",
  hermesProfile: "owner",
  timeoutMs: 1_000,
  maxStdoutBytes: 8_192,
  maxStderrBytes: 8_192,
  maxLineBytes: 4_096,
  receiptIdentity,
  targetBindReceipt,
  text: "exact prompt bytes",
  ...overrides,
});

const connect = (child: FakeChild, onPrompt: () => void): void => {
  child.stdin.onWrite = (written) => {
    const message = JSON.parse(written) as { id: number };
    if (message.id === 1) child.stdout.emitText(initialized());
    if (message.id === 2) onPrompt();
  };
};

const expectTornDownOnce = (child: FakeChild): void => {
  expect(child.stdin.endCalls).toBe(1);
  expect(child.killCalls).toBe(1);
  expect(child.exitCalls).toBe(1);
  expect(child.stdout.listenerCount("data")).toBe(0);
  expect(child.stdout.listenerCount("end")).toBe(0);
  expect(child.stderr.listenerCount("data")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
};

describe("bounded Hermes ACP client", () => {
  it("executes against the exact existing Hermes target and maps only its completed receipt", async () => {
    const child = new FakeChild();
    let spawnOptions: unknown;
    connect(child, () => child.stdout.emitText(frame(2, terminalResult(completed()))));

    const result = await runHermesAcp(request(), {
      spawn: (
        _executable: string,
        _args: readonly string[],
        options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
      ) => {
        spawnOptions = options;
        return child;
      },
    });

    const frames = child.stdin.writes.map((written) => JSON.parse(written) as Record<string, unknown>);
    expect(frames).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-control-plane", version: "1" } },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: targetBindReceipt.requested_session_id,
          prompt: [{ type: "text", text: "exact prompt bytes" }],
          _meta: { hermes: { acpTerminalReceipt: {
            operation: "execute",
            receiptIdentity,
            targetBindReceipt,
          } } },
        },
      },
    ]);
    expect(frames.map((entry) => entry.method)).not.toContain("session/new");
    expect(frames.map((entry) => entry.method)).not.toContain("session/load");
    expect(frames.map((entry) => entry.method)).not.toContain("session/resume");
    expect(spawnOptions).toEqual({
      cwd: "/trusted/cwd",
      env: { HOME: "/trusted/home", HERMES_HOME: "/trusted/hermes-home", HERMES_PROFILE: "owner" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(result).toEqual({
      status: "COMPLETED",
      receiptId: digest(receiptIdentity),
      evidenceDigest: digest("exact Hermes bytes"),
      content: "exact Hermes bytes",
    });
    expectTornDownOnce(child);
  });

  it("looks up status with an empty prompt and preserves NEVER_FOUND as non-completion", async () => {
    const child = new FakeChild();
    connect(child, () => child.stdout.emitText(frame(2, terminalResult({
      status: "NEVER_FOUND",
      turnRequestId: receiptIdentity.turnRequestId,
    }))));

    const result = await runHermesAcp(request({ operation: "status", text: undefined }), { spawn: () => child });

    expect((JSON.parse(child.stdin.writes[1]!) as { params: { prompt: unknown } }).params.prompt).toEqual([]);
    expect(result).toEqual({ status: "NEVER_FOUND" });
    expectTornDownOnce(child);
  });

  it.each([
    ["identity", completed({ receiptIdentity: { ...receiptIdentity, targetActorId: "actor:wrong" } })],
    ["target", completed({ targetBindReceipt: { schema: "hermes.target-bind-receipt", ...targetBindReceipt, actor_id: "actor:wrong" } })],
  ])("fails closed when a completed receipt has a mismatched %s", async (_name, receipt) => {
    const child = new FakeChild();
    connect(child, () => child.stdout.emitText(frame(2, terminalResult(receipt))));

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({
      status: "FAILED",
      reason: "TERMINAL_RECEIPT_MISMATCH",
    });
    expectTornDownOnce(child);
  });

  it.each([
    ["extra terminal metadata", () => frame(2, terminalResult(completed(), { unexpected: true })), "MALFORMED_TERMINAL_RECEIPT"],
    ["malformed JSON", () => "not-json\n", "MALFORMED_FRAME"],
    ["extra response frame", () => frame(2, terminalResult(completed())) + frame(77, {}), "MALFORMED_FRAME"],
  ])("fails closed on %s", async (_name, makeOutput, reason) => {
    const child = new FakeChild();
    connect(child, () => child.stdout.emitText(makeOutput()));

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({
      status: "FAILED",
      reason,
    });
    expectTornDownOnce(child);
  });

  it("rejects duplicate JSON-RPC response ids and unknown server requests while ignoring bounded notifications", async () => {
    const duplicate = new FakeChild();
    duplicate.stdin.onWrite = (written) => {
      if ((JSON.parse(written) as { id: number }).id === 1) duplicate.stdout.emitText(initialized() + initialized());
    };
    await expect(runHermesAcp(request(), { spawn: () => duplicate })).resolves.toEqual({ status: "FAILED", reason: "DUPLICATE_RESPONSE" });
    expectTornDownOnce(duplicate);

    const serverRequest = new FakeChild();
    serverRequest.stdin.onWrite = (written) => {
      if ((JSON.parse(written) as { id: number }).id === 1) {
        serverRequest.stdout.emitText(initialized() + JSON.stringify({ jsonrpc: "2.0", id: 9, method: "client/request", params: {} }) + "\n");
      }
    };
    await expect(runHermesAcp(request(), { spawn: () => serverRequest })).resolves.toEqual({ status: "FAILED", reason: "SERVER_REQUEST" });
    expectTornDownOnce(serverRequest);

    const notification = new FakeChild();
    notification.stdin.onWrite = (written) => {
      if ((JSON.parse(written) as { id: number }).id === 1) {
        notification.stdout.emitText(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }) + "\n" + initialized());
      }
      if ((JSON.parse(written) as { id: number }).id === 2) notification.stdout.emitText(frame(2, terminalResult(completed())));
    };
    await expect(runHermesAcp(request(), { spawn: () => notification })).resolves.toMatchObject({ status: "COMPLETED" });
    expectTornDownOnce(notification);
  });

  it.each([
    ["PREPARED", inFlight("PREPARED")],
    ["CLAIMED", inFlight("CLAIMED")],
    ["REFUSED", { status: "REFUSED" }],
    ["NEVER_FOUND", { status: "NEVER_FOUND", turnRequestId: receiptIdentity.turnRequestId }],
  ])("never maps execute terminal %s to completed", async (terminalStatus, receipt) => {
    const child = new FakeChild();
    connect(child, () => child.stdout.emitText(frame(2, terminalResult(receipt))));

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "NOT_COMPLETED", terminalStatus });
    expectTornDownOnce(child);
  });

  it("maps a JSON-RPC error to a fail-closed outcome", async () => {
    const child = new FakeChild();
    connect(child, () => child.stdout.emitText(rpcError(2)));

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason: "JSON_RPC_ERROR" });
    expectTornDownOnce(child);
  });

  it("fails closed on timeout and abort without residual timer or listener state", async () => {
    vi.useFakeTimers();
    try {
      const timeout = new FakeChild();
      connect(timeout, () => {});
      const timingOut = runHermesAcp(request({ timeoutMs: 50 }), { spawn: () => timeout });
      await vi.advanceTimersByTimeAsync(50);
      await expect(timingOut).resolves.toEqual({ status: "FAILED", reason: "TIMEOUT" });
      expectTornDownOnce(timeout);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    const controller = new AbortController();
    const aborted = new FakeChild();
    connect(aborted, () => {});
    const pending = runHermesAcp(request({ signal: controller.signal }), { spawn: () => aborted });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "FAILED", reason: "ABORTED" });
    expectTornDownOnce(aborted);
  });

  it.each([
    ["stdout cap", (child: FakeChild) => child.stdout.emitText("12345"), { maxStdoutBytes: 4 }, "STDOUT_LIMIT"],
    ["stderr cap", (child: FakeChild) => child.stderr.emitText("12345"), { maxStderrBytes: 4 }, "STDERR_LIMIT"],
    ["line cap", (child: FakeChild) => child.stdout.emitText("12345\n"), { maxLineBytes: 4 }, "LINE_LIMIT"],
    ["partial stdout line", (child: FakeChild) => { child.stdout.emitText("partial"); child.stdout.finish(); }, {}, "PARTIAL_LINE"],
  ])("fails closed on %s", async (_name, emit, caps, reason) => {
    const child = new FakeChild();
    connect(child, () => emit(child));

    await expect(runHermesAcp(request(caps), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason });
    expectTornDownOnce(child);
  });

  it("fails closed when the child exits nonzero", async () => {
    const child = new FakeChild();
    child.stdin.onWrite = (written) => {
      if ((JSON.parse(written) as { id: number }).id === 1) child.exit(7);
    };

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason: "NONZERO_EXIT" });
    expectTornDownOnce(child);
  });
});
