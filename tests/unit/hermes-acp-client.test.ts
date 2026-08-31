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

class FakeInput extends EventEmitter {
  readonly writes: string[] = [];
  endCalls = 0;
  returnsFalse = false;
  throwOnWrite = false;
  onWrite: ((value: string) => void) | undefined;

  write(value: string): boolean {
    if (this.throwOnWrite) throw new Error("write failed");
    this.writes.push(value);
    this.onWrite?.(value);
    return !this.returnsFalse;
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
  closeCalls = 0;
  autoCloseOnKill = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    this.killCalls += 1;
    if (this.autoCloseOnKill) queueMicrotask(() => this.close(0));
    return this.exitCode === null && this.signalCode === null;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closeCalls > 0) return;
    this.closeCalls += 1;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

const rawUtf8Digest = (value: string): string =>
  `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;

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
  receipt_digest: canonicalDigest(targetBindPublic),
} as const;

const receiptIdentity = {
  schema: "hermes.acp-terminal-receipt-identity",
  version: 1,
  turnRequestId: "turn-1",
  targetActorId: "actor:ceo",
  promptDigest: canonicalDigest("exact prompt bytes"),
  bindingGeneration: 7,
  targetBindingId: "binding-1",
  targetAttestationId: "attestation-1",
  executorSessionId: "executor-session-1",
  executorSessionIncarnation: "incarnation-1",
} as const;

const receiptEvidence = {
  receiptIdentity,
  receiptIdentityDigest: canonicalDigest(receiptIdentity),
  targetBindReceipt: { schema: "hermes.target-bind-receipt", ...targetBindReceipt },
  targetBindReceiptDigest: targetBindReceipt.receipt_digest,
} as const;

const frame = (id: number, result: unknown): string => `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
const initialized = (): string => frame(1, { protocolVersion: 1, agentInfo: { name: "hermes-agent", version: "test" }, agentCapabilities: {}, authMethods: [] });
const terminalResult = (receipt: Record<string, unknown>): Record<string, unknown> => ({
  stopReason: receipt.status === "REFUSED" ? "refusal" : "end_turn",
  _meta: { hermes: { acpTerminalReceipt: receipt } },
});

const completed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "COMPLETED",
  turnRequestId: receiptIdentity.turnRequestId,
  sessionId: targetBindReceipt.requested_session_id,
  terminalMessageId: 42,
  responseDigest: rawUtf8Digest("exact Hermes bytes"),
  createdAt: 1,
  claimedAt: 2,
  completedAt: 3,
  ...receiptEvidence,
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
  ...receiptEvidence,
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

const cleanClose = (child: FakeChild, code = 0, signal: NodeJS.Signals | null = null): void => {
  child.stdout.finish();
  child.stderr.finish();
  child.close(code, signal);
};

const connect = (child: FakeChild, onPrompt: () => void): void => {
  child.stdin.onWrite = (written) => {
    const message = JSON.parse(written) as { id: number };
    if (message.id === 1) child.stdout.emitText(initialized());
    if (message.id === 2) onPrompt();
  };
};

const expectNoResidue = (child: FakeChild): void => {
  expect(child.stdout.listenerCount("data")).toBe(0);
  expect(child.stdout.listenerCount("end")).toBe(0);
  expect(child.stdout.listenerCount("error")).toBe(0);
  expect(child.stderr.listenerCount("data")).toBe(0);
  expect(child.stderr.listenerCount("end")).toBe(0);
  expect(child.stderr.listenerCount("error")).toBe(0);
  expect(child.stdin.listenerCount("drain")).toBe(0);
  expect(child.stdin.listenerCount("error")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
};

const expectFailureShutdown = (child: FakeChild): void => {
  expect(child.stdin.endCalls).toBe(1);
  expect(child.killCalls).toBe(1);
  expectNoResidue(child);
};

describe("bounded Hermes ACP client", () => {
  it("launches only with the explicit dark ACP environment", async () => {
    const child = new FakeChild();
    let spawnOptions: unknown;
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult(completed())));
      cleanClose(child);
    });

    await expect(runHermesAcp(request(), {
      spawn: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      },
    })).resolves.toEqual({
      status: "COMPLETED",
      receiptId: canonicalDigest(receiptIdentity),
      evidenceDigest: rawUtf8Digest("exact Hermes bytes"),
      content: "exact Hermes bytes",
    });
    expect(spawnOptions).toEqual({
      cwd: "/trusted/cwd",
      env: {
        HOME: "/trusted/home",
        HERMES_HOME: "/trusted/hermes-home",
        HERMES_PROFILE: "owner",
        HERMES_ACP_SKIP_ENV_LOAD: "1",
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toBe(0);
    expectNoResidue(child);
  });

  it("does not spawn when its signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn(() => new FakeChild());

    await expect(runHermesAcp(request({ signal: controller.signal }), { spawn })).resolves.toEqual({ status: "FAILED", reason: "ABORTED" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reconciles an exit that happened synchronously during spawn", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.exitCode = 7;
      child.autoCloseOnKill = false;
      const pending = runHermesAcp(request(), { spawn: () => child });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ status: "FAILED", reason: "NONZERO_EXIT" });
      expect(child.stdin.writes).toEqual([]);
      expectFailureShutdown(child);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits to commit a terminal candidate until stdout EOF and a clean close", async () => {
    const child = new FakeChild();
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult(completed())));
      child.stdout.finish();
    });
    let settled = false;
    const pending = runHermesAcp(request(), { spawn: () => child }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toBe(0);
    child.close(0);
    await expect(pending).resolves.toMatchObject({ status: "COMPLETED" });
    expectNoResidue(child);
  });

  it.each([
    ["nonzero", 7, null, "NONZERO_EXIT"],
    ["signal", 0, "SIGTERM", "UNEXPECTED_EXIT"],
  ] as const)("rejects a terminal candidate followed by a %s close", async (_name, code, signal, reason) => {
    const child = new FakeChild();
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult(completed())));
      child.stdout.finish();
      child.close(code, signal);
    });

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason });
    expectFailureShutdown(child);
  });

  it.each([
    ["a duplicate response", (child: FakeChild) => child.stdout.emitText(frame(2, terminalResult(completed())) + frame(2, terminalResult(completed()))), "DUPLICATE_RESPONSE"],
    ["a server request", (child: FakeChild) => child.stdout.emitText(frame(2, terminalResult(completed())) + JSON.stringify({ jsonrpc: "2.0", id: 9, method: "client/request", params: {} }) + "\n"), "SERVER_REQUEST"],
    ["a malformed frame", (child: FakeChild) => child.stdout.emitText(frame(2, terminalResult(completed())) + "not-json\n"), "MALFORMED_FRAME"],
    ["a partial line", (child: FakeChild) => { child.stdout.emitText(frame(2, terminalResult(completed())) + "partial"); child.stdout.finish(); }, "PARTIAL_LINE"],
  ] as const)("rejects post-terminal %s", async (_name, emit, reason) => {
    const child = new FakeChild();
    connect(child, () => {
      emit(child);
      cleanClose(child);
    });

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason });
    expectFailureShutdown(child);
  });

  it("settles a failed shutdown even if kill emits no close", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.autoCloseOnKill = false;
      connect(child, () => child.stdout.emitText("not-json\n"));
      const pending = runHermesAcp(request(), { spawn: () => child });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ status: "FAILED", reason: "MALFORMED_FRAME" });
      expectFailureShutdown(child);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["throws from stdin.write", (child: FakeChild) => { child.stdin.throwOnWrite = true; }, "STDIN_ERROR"],
    ["emits a stdout stream error", (child: FakeChild) => { child.stdout.emit("error", new Error("stdout failed")); }, "STREAM_ERROR"],
    ["emits a stderr stream error", (child: FakeChild) => { child.stderr.emit("error", new Error("stderr failed")); }, "STREAM_ERROR"],
  ] as const)("fails closed when it %s", async (_name, trigger, reason) => {
    const child = new FakeChild();
    if (reason === "STDIN_ERROR") trigger(child);
    else connect(child, () => trigger(child));

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason });
    expectFailureShutdown(child);
  });

  it("waits for drain before writing after stdin backpressure", async () => {
    const child = new FakeChild();
    child.stdin.returnsFalse = true;
    connect(child, () => {
      if (child.stdin.writes.length === 2) {
        child.stdout.emitText(frame(2, terminalResult(completed())));
        cleanClose(child);
      }
    });
    const pending = runHermesAcp(request(), { spawn: () => child });

    expect(child.stdin.writes).toHaveLength(1);
    child.stdin.returnsFalse = false;
    child.stdin.emit("drain");
    await expect(pending).resolves.toMatchObject({ status: "COMPLETED" });
    expect(child.stdin.writes).toHaveLength(2);
    expectNoResidue(child);
  });

  it.each([
    ["receipt identity digest", completed({ receiptIdentityDigest: rawUtf8Digest("wrong identity") })],
    ["target bind digest", completed({ targetBindReceiptDigest: rawUtf8Digest("wrong target") })],
    ["target bind receipt", completed({ targetBindReceipt: { schema: "hermes.target-bind-receipt", ...targetBindReceipt, receipt_digest: rawUtf8Digest("wrong target") } })],
    ["raw assistant content digest", completed({ responseDigest: canonicalDigest("exact Hermes bytes") })],
  ])("rejects a mutated completed %s", async (_name, receipt) => {
    const child = new FakeChild();
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult(receipt)));
      cleanClose(child);
    });

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason: "TERMINAL_RECEIPT_MISMATCH" });
    expectFailureShutdown(child);
  });

  it.each([
    ["NEVER_FOUND", { status: "NEVER_FOUND", turnRequestId: receiptIdentity.turnRequestId }, "turnRequestId", 7],
    ["REFUSED", { status: "REFUSED" }, "status", 7],
    ["PREPARED", inFlight("PREPARED"), "createdAt", "1"],
    ["CLAIMED", inFlight("CLAIMED"), "claimedAt", null],
    ["COMPLETED", completed(), "terminalMessageId", "42"],
  ] as const)("closes the exact %s schema for extra, missing, and wrong-type fields", async (_status, receipt, wrongKey, wrongValue) => {
    const missing = { ...receipt };
    delete missing[wrongKey];
    const variants = [
      { ...receipt, unexpected: true },
      missing,
      { ...receipt, [wrongKey]: wrongValue },
    ];

    for (const variant of variants) {
      const child = new FakeChild();
      connect(child, () => {
        child.stdout.emitText(frame(2, terminalResult(variant)));
        cleanClose(child);
      });
      await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" });
      expectFailureShutdown(child);
    }
  });

  it("documents that ABORTED has no proven Hermes producer schema and stays fail closed", async () => {
    const child = new FakeChild();
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult({ status: "ABORTED" })));
      cleanClose(child);
    });

    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual({ status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" });
    expectFailureShutdown(child);
  });

  it.each([
    ["PREPARED", inFlight("PREPARED")],
    ["CLAIMED", inFlight("CLAIMED")],
    ["REFUSED", { status: "REFUSED" }],
    ["NEVER_FOUND", { status: "NEVER_FOUND", turnRequestId: receiptIdentity.turnRequestId }],
  ] as const)("does not map valid %s outcomes to completed", async (terminalStatus, receipt) => {
    const child = new FakeChild();
    connect(child, () => {
      child.stdout.emitText(frame(2, terminalResult(receipt)));
      cleanClose(child);
    });

    const expected = terminalStatus === "NEVER_FOUND"
      ? { status: "NOT_COMPLETED", terminalStatus }
      : { status: "NOT_COMPLETED", terminalStatus };
    await expect(runHermesAcp(request(), { spawn: () => child })).resolves.toEqual(expected);
    expect(child.killCalls).toBe(0);
    expectNoResidue(child);
  });
});
