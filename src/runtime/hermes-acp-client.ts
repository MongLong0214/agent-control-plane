import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

/** The exact eight-field wire proof accepted by `hermes acp`; it has no schema field. */
export type HermesTargetBindWireReceipt = {
  domain: "hermes.target-bind";
  version: 1;
  actor_id: string;
  binding_generation: number;
  executor_runtime_identity: string;
  requested_session_id: string;
  lineage_root_digest: string;
  receipt_digest: string;
};

/**
 * The closed receipt identity Hermes currently verifies. Its first three public fields are the
 * coordinator permit's turn/actor/prompt identity; the remaining fields fence its exact target.
 */
export type HermesAcpReceiptIdentity = {
  schema: "hermes.acp-terminal-receipt-identity";
  version: 1;
  turnRequestId: string;
  targetActorId: string;
  promptDigest: string;
  bindingGeneration: number;
  targetBindingId: string;
  targetAttestationId: string;
  executorSessionId: string;
  executorSessionIncarnation: string;
};

export type HermesAcpInput = {
  operation: "execute" | "status";
  executable: string;
  cwd: string;
  home: string;
  hermesHome: string;
  hermesProfile: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxLineBytes: number;
  receiptIdentity: HermesAcpReceiptIdentity;
  targetBindReceipt: HermesTargetBindWireReceipt;
  /** Required for execute and forbidden for status, whose ACP prompt is empty. */
  text?: string;
  signal?: AbortSignal;
};

export type HermesAcpResult =
  | { status: "COMPLETED"; receiptId: string; evidenceDigest: string; content: string }
  | { status: "NEVER_FOUND" }
  | { status: "NOT_COMPLETED"; terminalStatus: "PREPARED" | "CLAIMED" | "NEVER_FOUND" | "REFUSED" }
  | { status: "FAILED"; reason: HermesAcpFailureReason };

export type HermesAcpFailureReason =
  | "ABORTED"
  | "DUPLICATE_RESPONSE"
  | "INVALID_INPUT"
  | "JSON_RPC_ERROR"
  | "LINE_LIMIT"
  | "MALFORMED_FRAME"
  | "MALFORMED_TERMINAL_RECEIPT"
  | "NONZERO_EXIT"
  | "PARTIAL_LINE"
  | "SERVER_REQUEST"
  | "SPAWN_ERROR"
  | "STDERR_LIMIT"
  | "STDOUT_EOF"
  | "STDOUT_LIMIT"
  | "TERMINAL_RECEIPT_MISMATCH"
  | "TIMEOUT"
  | "UNEXPECTED_EXIT";

type JsonRecord = Record<string, unknown>;
type AcpReadable = EventEmitter;
type AcpWritable = { write(value: string): boolean; end(): void };
type AcpChild = EventEmitter & {
  stdin: AcpWritable;
  stdout: AcpReadable;
  stderr: AcpReadable;
  kill(signal?: NodeJS.Signals): boolean;
};

export type HermesAcpSpawn = (command: string, args: readonly string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
}) => AcpChild;

export type HermesAcpDependencies = { spawn?: HermesAcpSpawn };

const IDENTITY_KEYS = [
  "bindingGeneration",
  "executorSessionId",
  "executorSessionIncarnation",
  "promptDigest",
  "schema",
  "targetActorId",
  "targetAttestationId",
  "targetBindingId",
  "turnRequestId",
  "version",
] as const;

const TARGET_BIND_KEYS = [
  "actor_id",
  "binding_generation",
  "domain",
  "executor_runtime_identity",
  "lineage_root_digest",
  "receipt_digest",
  "requested_session_id",
  "version",
] as const;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const safeNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(",")}}`;
};

const digestOf = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const asTargetBindWire = (value: unknown): HermesTargetBindWireReceipt | null => {
  if (!isRecord(value) || !hasExactKeys(value, TARGET_BIND_KEYS)) return null;
  if (
    value.domain !== "hermes.target-bind" || value.version !== 1 ||
    !nonEmpty(value.actor_id) || !safeNonnegativeInteger(value.binding_generation) ||
    !nonEmpty(value.executor_runtime_identity) || !nonEmpty(value.requested_session_id) ||
    !isDigest(value.lineage_root_digest) || !isDigest(value.receipt_digest)
  ) return null;
  const publicFields = {
    domain: value.domain,
    version: value.version,
    actor_id: value.actor_id,
    binding_generation: value.binding_generation,
    executor_runtime_identity: value.executor_runtime_identity,
    requested_session_id: value.requested_session_id,
    lineage_root_digest: value.lineage_root_digest,
  };
  if (value.receipt_digest !== digestOf(publicFields)) return null;
  return value as HermesTargetBindWireReceipt;
};

const asReceiptIdentity = (value: unknown): HermesAcpReceiptIdentity | null => {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) return null;
  if (
    value.schema !== "hermes.acp-terminal-receipt-identity" || value.version !== 1 ||
    !nonEmpty(value.turnRequestId) || !nonEmpty(value.targetActorId) || !isDigest(value.promptDigest) ||
    !safeNonnegativeInteger(value.bindingGeneration) ||
    !nonEmpty(value.targetBindingId) || !nonEmpty(value.targetAttestationId) ||
    !nonEmpty(value.executorSessionId) || !nonEmpty(value.executorSessionIncarnation)
  ) return null;
  return value as HermesAcpReceiptIdentity;
};

const requestIsValid = (input: HermesAcpInput): boolean => {
  if (
    (input.operation !== "execute" && input.operation !== "status") ||
    ![input.executable, input.cwd, input.home, input.hermesHome, input.hermesProfile].every(nonEmpty) ||
    ![input.timeoutMs, input.maxStdoutBytes, input.maxStderrBytes, input.maxLineBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) return false;
  const identity = asReceiptIdentity(input.receiptIdentity);
  const target = asTargetBindWire(input.targetBindReceipt);
  if (!identity || !target || identity.targetActorId !== target.actor_id || identity.bindingGeneration !== target.binding_generation) return false;
  if (input.operation === "status") return input.text === undefined;
  return typeof input.text === "string" && identity.promptDigest === digestOf(input.text);
};

const terminalTargetBind = (value: unknown): HermesTargetBindWireReceipt | null => {
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, TARGET_BIND_KEYS)) return asTargetBindWire(value);
  const expected = ["schema", ...TARGET_BIND_KEYS];
  if (value.schema !== "hermes.target-bind-receipt" || !hasExactKeys(value, expected)) return null;
  const { schema: _schema, ...wire } = value;
  return asTargetBindWire(wire);
};

const terminalMatchesRequest = (terminal: JsonRecord, input: HermesAcpInput): boolean => {
  const returnedIdentity = asReceiptIdentity(terminal.receiptIdentity);
  const returnedTarget = terminalTargetBind(terminal.targetBindReceipt);
  return (
    terminal.turnRequestId === input.receiptIdentity.turnRequestId &&
    terminal.sessionId === input.targetBindReceipt.requested_session_id &&
    returnedIdentity !== null && sameJson(returnedIdentity, input.receiptIdentity) &&
    returnedTarget !== null && sameJson(returnedTarget, input.targetBindReceipt) &&
    terminal.targetBindReceiptDigest === input.targetBindReceipt.receipt_digest
  );
};

const terminalResult = (result: unknown, input: HermesAcpInput): HermesAcpResult => {
  if (!isRecord(result) || !hasExactKeys(result, ["_meta", "stopReason"]) || typeof result.stopReason !== "string") {
    return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  }
  const meta = result._meta;
  if (!isRecord(meta) || !hasExactKeys(meta, ["hermes"]) || !isRecord(meta.hermes) || !hasExactKeys(meta.hermes, ["acpTerminalReceipt"]) || !isRecord(meta.hermes.acpTerminalReceipt)) {
    return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  }
  const terminal = meta.hermes.acpTerminalReceipt;
  const status = terminal.status;
  if (status === "NEVER_FOUND") {
    if (!hasExactKeys(terminal, ["status", "turnRequestId"]) || terminal.turnRequestId !== input.receiptIdentity.turnRequestId) {
      return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
    }
    return input.operation === "status" ? { status: "NEVER_FOUND" } : { status: "NOT_COMPLETED", terminalStatus: "NEVER_FOUND" };
  }
  if (status === "REFUSED") {
    return hasExactKeys(terminal, ["status"])
      ? { status: "NOT_COMPLETED", terminalStatus: "REFUSED" }
      : { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  }
  if (status === "PREPARED" || status === "CLAIMED") {
    return terminalMatchesRequest(terminal, input)
      ? { status: "NOT_COMPLETED", terminalStatus: status }
      : { status: "FAILED", reason: "TERMINAL_RECEIPT_MISMATCH" };
  }
  if (status !== "COMPLETED") return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  if (!terminalMatchesRequest(terminal, input)) return { status: "FAILED", reason: "TERMINAL_RECEIPT_MISMATCH" };
  if (!isDigest(terminal.receiptIdentityDigest) || !isDigest(terminal.responseDigest) || typeof terminal.assistantContent !== "string") {
    return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  }
  return {
    status: "COMPLETED",
    receiptId: terminal.receiptIdentityDigest,
    evidenceDigest: terminal.responseDigest,
    content: terminal.assistantContent,
  };
};

const jsonRpcLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const runHermesAcp = async (
  input: HermesAcpInput,
  dependencies: HermesAcpDependencies = {},
): Promise<HermesAcpResult> => {
  if (!requestIsValid(input)) return { status: "FAILED", reason: "INVALID_INPUT" };

  const spawn = dependencies.spawn ?? ((command, args, options) => spawnChild(command, args, options) as unknown as AcpChild);
  let child: AcpChild;
  try {
    child = spawn(input.executable, ["acp"], {
      cwd: input.cwd,
      env: { HOME: input.home, HERMES_HOME: input.hermesHome, HERMES_PROFILE: input.hermesProfile },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { status: "FAILED", reason: "SPAWN_ERROR" };
  }

  return new Promise<HermesAcpResult>((resolve) => {
    const decoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutRemainder = "";
    let initSeen = false;
    let promptSent = false;
    let exitSeen = false;
    let settled = false;
    let resolved = false;
    let finalResult: HermesAcpResult | undefined;
    let timer: NodeJS.Timeout | undefined;
    const seenResponseIds = new Set<number>();

    const resolveOnce = (): void => {
      if (resolved || !finalResult || !exitSeen) return;
      resolved = true;
      child.off("exit", onExit);
      child.off("error", onChildError);
      resolve(finalResult);
    };

    const removeListeners = (): void => {
      child.stdout.off("data", onStdoutData);
      child.stdout.off("end", onStdoutEnd);
      child.stderr.off("data", onStderrData);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
    };

    const finish = (result: HermesAcpResult): void => {
      if (settled) return;
      settled = true;
      finalResult = result;
      if (timer) clearTimeout(timer);
      removeListeners();
      child.stdin.end();
      child.kill("SIGKILL");
      resolveOnce();
    };

    const fail = (reason: HermesAcpFailureReason): void => finish({ status: "FAILED", reason });

    const sendPrompt = (): void => {
      if (promptSent) return fail("DUPLICATE_RESPONSE");
      promptSent = true;
      child.stdin.write(jsonRpcLine({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: input.targetBindReceipt.requested_session_id,
          prompt: input.operation === "execute" ? [{ type: "text", text: input.text }] : [],
          _meta: { hermes: { acpTerminalReceipt: {
            operation: input.operation,
            receiptIdentity: input.receiptIdentity,
            targetBindReceipt: input.targetBindReceipt,
          } } },
        },
      }));
    };

    const handleFrame = (raw: string): HermesAcpResult | undefined => {
      let frame: unknown;
      try { frame = JSON.parse(raw); } catch { fail("MALFORMED_FRAME"); return undefined; }
      if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
        fail("MALFORMED_FRAME");
        return undefined;
      }
      if (Object.hasOwn(frame, "method")) {
        if (typeof frame.method !== "string") {
          fail("MALFORMED_FRAME");
        } else if (Object.hasOwn(frame, "id")) {
          fail("SERVER_REQUEST");
        } else if (!hasExactKeys(frame, Object.hasOwn(frame, "params") ? ["jsonrpc", "method", "params"] : ["jsonrpc", "method"])) {
          fail("MALFORMED_FRAME");
        }
        return undefined;
      }
      const isResult = Object.hasOwn(frame, "result");
      const isError = Object.hasOwn(frame, "error");
      if (
        (!isResult && !isError) || (isResult && isError) || !Object.hasOwn(frame, "id") ||
        !hasExactKeys(frame, isResult ? ["id", "jsonrpc", "result"] : ["error", "id", "jsonrpc"]) ||
        !Number.isSafeInteger(frame.id)
      ) {
        fail("MALFORMED_FRAME");
        return undefined;
      }
      const id = frame.id as number;
      if (seenResponseIds.has(id)) {
        fail("DUPLICATE_RESPONSE");
        return undefined;
      }
      seenResponseIds.add(id);
      if (id !== 1 && id !== 2) {
        fail("MALFORMED_FRAME");
        return undefined;
      }
      if (isError) {
        fail("JSON_RPC_ERROR");
        return undefined;
      }
      if (id === 1) {
        if (initSeen || !isRecord(frame.result) || frame.result.protocolVersion !== 1) {
          fail("MALFORMED_FRAME");
          return undefined;
        }
        initSeen = true;
        sendPrompt();
        return undefined;
      }
      if (!initSeen || !promptSent) {
        fail("MALFORMED_FRAME");
        return undefined;
      }
      return terminalResult(frame.result, input);
    };

    const consumeStdout = (text: string): void => {
      if (settled) return;
      stdoutRemainder += text;
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      let candidate: HermesAcpResult | undefined;
      for (const raw of lines) {
        if (settled) return;
        if (Buffer.byteLength(raw, "utf8") > input.maxLineBytes) {
          fail("LINE_LIMIT");
          return;
        }
        if (candidate) {
          fail("MALFORMED_FRAME");
          return;
        }
        const result = handleFrame(raw);
        if (settled) return;
        if (result) candidate = result;
      }
      if (Buffer.byteLength(stdoutRemainder, "utf8") > input.maxLineBytes) fail("LINE_LIMIT");
      else if (candidate) finish(candidate);
    };

    const onStdoutData = (chunk: Buffer | string): void => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      stdoutBytes += bytes;
      if (stdoutBytes > input.maxStdoutBytes) return fail("STDOUT_LIMIT");
      consumeStdout(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")));
    };

    const onStdoutEnd = (): void => {
      if (settled) return;
      consumeStdout(decoder.end());
      if (settled) return;
      if (stdoutRemainder.length > 0) fail("PARTIAL_LINE");
      else fail("STDOUT_EOF");
    };

    const onStderrData = (chunk: Buffer | string): void => {
      if (settled) return;
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > input.maxStderrBytes) fail("STDERR_LIMIT");
    };

    const onExit = (code: number | null): void => {
      exitSeen = true;
      if (!settled) fail(code === 0 ? "UNEXPECTED_EXIT" : "NONZERO_EXIT");
      resolveOnce();
    };

    const onChildError = (): void => fail("SPAWN_ERROR");
    const onAbort = (): void => fail("ABORTED");

    child.stdout.on("data", onStdoutData);
    child.stdout.on("end", onStdoutEnd);
    child.stderr.on("data", onStderrData);
    child.once("exit", onExit);
    child.once("error", onChildError);
    if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail("TIMEOUT"), input.timeoutMs);

    if (input.signal?.aborted) {
      fail("ABORTED");
      return;
    }
    child.stdin.write(jsonRpcLine({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-control-plane", version: "1" } },
    }));
  });
};
