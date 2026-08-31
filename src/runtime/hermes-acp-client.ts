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
  | "STDIN_ERROR"
  | "STDOUT_EOF"
  | "STDOUT_LIMIT"
  | "STREAM_ERROR"
  | "TERMINAL_RECEIPT_MISMATCH"
  | "TIMEOUT"
  | "UNEXPECTED_EXIT";

type JsonRecord = Record<string, unknown>;
type AcpReadable = EventEmitter;
type AcpWritable = EventEmitter & { write(value: string): boolean; end(): void };
type AcpChild = EventEmitter & {
  stdin: AcpWritable;
  stdout: AcpReadable;
  stderr: AcpReadable;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
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

const RECEIPT_EVIDENCE_KEYS = [
  "receiptIdentity",
  "receiptIdentityDigest",
  "targetBindReceipt",
  "targetBindReceiptDigest",
] as const;

const RECEIPT_PUBLIC_KEYS = [
  "claimedAt",
  "completedAt",
  "createdAt",
  "responseDigest",
  "sessionId",
  "status",
  "terminalMessageId",
  "turnRequestId",
  ...RECEIPT_EVIDENCE_KEYS,
] as const;

const PREPARED_KEYS = RECEIPT_PUBLIC_KEYS;
const CLAIMED_KEYS = RECEIPT_PUBLIC_KEYS;
const COMPLETED_KEYS = [...RECEIPT_PUBLIC_KEYS, "assistantContent"] as const;
const SHUTDOWN_GRACE_MS = 25;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const safeNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(",")}}`;
};

const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

const rawUtf8Digest = (value: string): string =>
  `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;

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
  if (value.receipt_digest !== canonicalDigest(publicFields)) return null;
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
  return typeof input.text === "string" && identity.promptDigest === canonicalDigest(input.text);
};

const terminalTargetBind = (value: unknown): HermesTargetBindWireReceipt | null => {
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, TARGET_BIND_KEYS)) return asTargetBindWire(value);
  const expected = ["schema", ...TARGET_BIND_KEYS];
  if (value.schema !== "hermes.target-bind-receipt" || !hasExactKeys(value, expected)) return null;
  const { schema: _schema, ...wire } = value;
  return asTargetBindWire(wire);
};

const terminalTargetBindHasClosedShape = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const wire = hasExactKeys(value, TARGET_BIND_KEYS)
    ? value
    : value.schema === "hermes.target-bind-receipt" && hasExactKeys(value, ["schema", ...TARGET_BIND_KEYS])
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "schema"))
      : null;
  return wire !== null &&
    wire.domain === "hermes.target-bind" && wire.version === 1 &&
    nonEmpty(wire.actor_id) && safeNonnegativeInteger(wire.binding_generation) &&
    nonEmpty(wire.executor_runtime_identity) && nonEmpty(wire.requested_session_id) &&
    isDigest(wire.lineage_root_digest) && isDigest(wire.receipt_digest);
};

const receiptEvidenceIsWellTyped = (terminal: JsonRecord): boolean =>
  asReceiptIdentity(terminal.receiptIdentity) !== null &&
  isDigest(terminal.receiptIdentityDigest) &&
  terminalTargetBindHasClosedShape(terminal.targetBindReceipt) &&
  isDigest(terminal.targetBindReceiptDigest);

const terminalMatchesRequest = (terminal: JsonRecord, input: HermesAcpInput): boolean => {
  const returnedIdentity = asReceiptIdentity(terminal.receiptIdentity);
  const returnedTarget = terminalTargetBind(terminal.targetBindReceipt);
  return (
    terminal.turnRequestId === input.receiptIdentity.turnRequestId &&
    terminal.sessionId === input.targetBindReceipt.requested_session_id &&
    returnedIdentity !== null &&
    terminal.receiptIdentityDigest === canonicalDigest(returnedIdentity) &&
    sameJson(returnedIdentity, input.receiptIdentity) &&
    returnedTarget !== null &&
    terminal.targetBindReceiptDigest === returnedTarget.receipt_digest &&
    sameJson(returnedTarget, input.targetBindReceipt) &&
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
    const expected = status === "PREPARED" ? PREPARED_KEYS : CLAIMED_KEYS;
    if (
      !hasExactKeys(terminal, expected) ||
      !nonEmpty(terminal.turnRequestId) || !nonEmpty(terminal.sessionId) ||
      terminal.terminalMessageId !== null || terminal.responseDigest !== null ||
      !finiteNumber(terminal.createdAt) ||
      (status === "PREPARED" ? terminal.claimedAt !== null : !finiteNumber(terminal.claimedAt)) ||
      terminal.completedAt !== null || !receiptEvidenceIsWellTyped(terminal)
    ) return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
    return terminalMatchesRequest(terminal, input)
      ? { status: "NOT_COMPLETED", terminalStatus: status }
      : { status: "FAILED", reason: "TERMINAL_RECEIPT_MISMATCH" };
  }
  if (status !== "COMPLETED") return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  if (
    !hasExactKeys(terminal, COMPLETED_KEYS) ||
    !nonEmpty(terminal.turnRequestId) || !nonEmpty(terminal.sessionId) ||
    !safeNonnegativeInteger(terminal.terminalMessageId) || !isDigest(terminal.responseDigest) ||
    !finiteNumber(terminal.createdAt) || !finiteNumber(terminal.claimedAt) || !finiteNumber(terminal.completedAt) ||
    typeof terminal.assistantContent !== "string" || !receiptEvidenceIsWellTyped(terminal)
  ) return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
  if (!terminalMatchesRequest(terminal, input) || terminal.responseDigest !== rawUtf8Digest(terminal.assistantContent)) {
    return { status: "FAILED", reason: "TERMINAL_RECEIPT_MISMATCH" };
  }
  return {
    status: "COMPLETED",
    receiptId: terminal.receiptIdentityDigest as string,
    evidenceDigest: terminal.responseDigest,
    content: terminal.assistantContent,
  };
};

const jsonRpcLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const runHermesAcp = async (
  input: HermesAcpInput,
  dependencies: HermesAcpDependencies = {},
): Promise<HermesAcpResult> => {
  if (input.signal?.aborted) return { status: "FAILED", reason: "ABORTED" };
  if (!requestIsValid(input)) return { status: "FAILED", reason: "INVALID_INPUT" };

  const spawn = dependencies.spawn ?? ((command, args, options) => spawnChild(command, args, options) as unknown as AcpChild);
  let child: AcpChild;
  try {
    child = spawn(input.executable, ["acp"], {
      cwd: input.cwd,
      env: {
        HOME: input.home,
        HERMES_HOME: input.hermesHome,
        HERMES_PROFILE: input.hermesProfile,
        HERMES_ACP_SKIP_ENV_LOAD: "1",
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      },
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
    let promptQueued = false;
    let stdinWriteInProgress = false;
    let stdinBackpressured = false;
    let stdinEnded = false;
    let stdoutEnded = false;
    let closeSeen = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let terminalCandidate: HermesAcpResult | undefined;
    let failure: HermesAcpResult | undefined;
    let resolved = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    const seenResponseIds = new Set<number>();

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      timeoutTimer = undefined;
      shutdownTimer = undefined;
    };

    const removeListeners = (): void => {
      child.stdout.off("data", onStdoutData);
      child.stdout.off("end", onStdoutEnd);
      child.stdout.off("error", onStreamError);
      child.stderr.off("data", onStderrData);
      child.stderr.off("end", onStderrEnd);
      child.stderr.off("error", onStreamError);
      child.stdin.off("drain", onDrain);
      child.stdin.off("error", onStdinError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onChildError);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
    };

    const resolveOnce = (result: HermesAcpResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      removeListeners();
      resolve(result);
    };

    const closeStdin = (): boolean => {
      if (stdinEnded) return true;
      stdinEnded = true;
      try {
        child.stdin.end();
        return true;
      } catch {
        return false;
      }
    };

    const failureResult = (reason: HermesAcpFailureReason): HermesAcpResult => ({ status: "FAILED", reason });

    const beginFailure = (reason: HermesAcpFailureReason): void => {
      if (resolved || failure) return;
      failure = failureResult(reason);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      closeStdin();
      try { child.kill("SIGKILL"); } catch { /* bounded settlement below remains authoritative */ }
      if (closeSeen) {
        resolveOnce(failure);
        return;
      }
      shutdownTimer = setTimeout(() => resolveOnce(failure!), Math.min(SHUTDOWN_GRACE_MS, input.timeoutMs));
    };

    const settleTerminalCandidate = (): void => {
      if (resolved || failure || !terminalCandidate || !stdoutEnded || !closeSeen) return;
      if (closeCode !== 0 || closeSignal !== null) {
        beginFailure(closeCode !== null && closeCode !== 0 ? "NONZERO_EXIT" : "UNEXPECTED_EXIT");
        return;
      }
      resolveOnce(terminalCandidate);
    };

    const sendPrompt = (): void => {
      if (resolved || failure || promptSent) {
        if (!resolved && !failure) beginFailure("DUPLICATE_RESPONSE");
        return;
      }
      if (stdinWriteInProgress || stdinBackpressured) {
        promptQueued = true;
        return;
      }
      promptSent = true;
      writeFrame({
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
      });
    };

    const flushPrompt = (): void => {
      if (!promptQueued || stdinWriteInProgress || stdinBackpressured || resolved || failure) return;
      promptQueued = false;
      sendPrompt();
    };

    const writeFrame = (value: unknown): void => {
      if (resolved || failure) return;
      stdinWriteInProgress = true;
      let accepted: boolean;
      try {
        accepted = child.stdin.write(jsonRpcLine(value));
      } catch {
        stdinWriteInProgress = false;
        beginFailure("STDIN_ERROR");
        return;
      }
      stdinWriteInProgress = false;
      if (!accepted) stdinBackpressured = true;
      flushPrompt();
    };

    const acceptTerminal = (candidate: HermesAcpResult): void => {
      if (candidate.status === "FAILED") {
        beginFailure(candidate.reason);
        return;
      }
      if (terminalCandidate) {
        beginFailure("DUPLICATE_RESPONSE");
        return;
      }
      terminalCandidate = candidate;
      if (!closeStdin()) {
        beginFailure("STDIN_ERROR");
        return;
      }
      settleTerminalCandidate();
    };

    const handleFrame = (raw: string): void => {
      let frame: unknown;
      try { frame = JSON.parse(raw); } catch { beginFailure("MALFORMED_FRAME"); return; }
      if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
        beginFailure("MALFORMED_FRAME");
        return;
      }
      if (Object.hasOwn(frame, "method")) {
        if (typeof frame.method !== "string") beginFailure("MALFORMED_FRAME");
        else if (Object.hasOwn(frame, "id")) beginFailure("SERVER_REQUEST");
        else if (terminalCandidate) beginFailure("MALFORMED_FRAME");
        else if (!hasExactKeys(frame, Object.hasOwn(frame, "params") ? ["jsonrpc", "method", "params"] : ["jsonrpc", "method"])) beginFailure("MALFORMED_FRAME");
        return;
      }
      const isResult = Object.hasOwn(frame, "result");
      const isError = Object.hasOwn(frame, "error");
      if (
        (!isResult && !isError) || (isResult && isError) || !Object.hasOwn(frame, "id") ||
        !hasExactKeys(frame, isResult ? ["id", "jsonrpc", "result"] : ["error", "id", "jsonrpc"]) ||
        !Number.isSafeInteger(frame.id)
      ) {
        beginFailure("MALFORMED_FRAME");
        return;
      }
      const id = frame.id as number;
      if (seenResponseIds.has(id)) {
        beginFailure("DUPLICATE_RESPONSE");
        return;
      }
      seenResponseIds.add(id);
      if (id !== 1 && id !== 2) {
        beginFailure("MALFORMED_FRAME");
        return;
      }
      if (isError) {
        beginFailure("JSON_RPC_ERROR");
        return;
      }
      if (id === 1) {
        if (terminalCandidate || initSeen || !isRecord(frame.result) || frame.result.protocolVersion !== 1) {
          beginFailure("MALFORMED_FRAME");
          return;
        }
        initSeen = true;
        sendPrompt();
        return;
      }
      if (terminalCandidate || !initSeen || !promptSent) {
        beginFailure(terminalCandidate ? "DUPLICATE_RESPONSE" : "MALFORMED_FRAME");
        return;
      }
      acceptTerminal(terminalResult(frame.result, input));
    };

    const consumeStdout = (text: string): void => {
      if (resolved || failure) return;
      stdoutRemainder += text;
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const raw of lines) {
        if (resolved || failure) return;
        if (Buffer.byteLength(raw, "utf8") > input.maxLineBytes) {
          beginFailure("LINE_LIMIT");
          return;
        }
        handleFrame(raw);
      }
      if (!failure && Buffer.byteLength(stdoutRemainder, "utf8") > input.maxLineBytes) beginFailure("LINE_LIMIT");
    };

    const onStdoutData = (chunk: Buffer | string): void => {
      if (resolved || failure) return;
      if (stdoutEnded) {
        beginFailure("MALFORMED_FRAME");
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      stdoutBytes += bytes;
      if (stdoutBytes > input.maxStdoutBytes) {
        beginFailure("STDOUT_LIMIT");
        return;
      }
      consumeStdout(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")));
    };

    const onStdoutEnd = (): void => {
      if (resolved || failure || stdoutEnded) return;
      consumeStdout(decoder.end());
      if (failure) return;
      stdoutEnded = true;
      if (stdoutRemainder.length > 0) {
        beginFailure("PARTIAL_LINE");
        return;
      }
      if (!terminalCandidate) {
        beginFailure("STDOUT_EOF");
        return;
      }
      settleTerminalCandidate();
    };

    const onStderrData = (chunk: Buffer | string): void => {
      if (resolved || failure) return;
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > input.maxStderrBytes) beginFailure("STDERR_LIMIT");
    };

    const onStderrEnd = (): void => { /* retain the listener through process close for stream errors */ };

    const onStreamError = (): void => beginFailure("STREAM_ERROR");
    const onStdinError = (): void => beginFailure("STDIN_ERROR");

    const onExit = (code: number | null, signal: NodeJS.Signals | null = null, reconciled = false): void => {
      if (resolved || failure) return;
      if (code !== 0 || signal !== null) {
        beginFailure(code !== null && code !== 0 ? "NONZERO_EXIT" : "UNEXPECTED_EXIT");
        return;
      }
      if (reconciled && !terminalCandidate) beginFailure("UNEXPECTED_EXIT");
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null = null): void => {
      if (resolved) return;
      closeSeen = true;
      closeCode = code;
      closeSignal = signal;
      if (failure) {
        resolveOnce(failure);
        return;
      }
      if (!terminalCandidate) {
        beginFailure(code !== null && code !== 0 ? "NONZERO_EXIT" : "UNEXPECTED_EXIT");
        return;
      }
      settleTerminalCandidate();
    };

    const onChildError = (): void => beginFailure("SPAWN_ERROR");
    const onAbort = (): void => beginFailure("ABORTED");
    const onDrain = (): void => {
      stdinBackpressured = false;
      flushPrompt();
    };

    child.stdout.on("data", onStdoutData);
    child.stdout.on("end", onStdoutEnd);
    child.stdout.on("error", onStreamError);
    child.stderr.on("data", onStderrData);
    child.stderr.on("end", onStderrEnd);
    child.stderr.on("error", onStreamError);
    child.stdin.on("drain", onDrain);
    child.stdin.on("error", onStdinError);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onChildError);
    if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });

    if (input.signal?.aborted) {
      beginFailure("ABORTED");
      return;
    }
    if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined) {
      onExit(child.exitCode ?? null, child.signalCode ?? null, true);
      return;
    }
    timeoutTimer = setTimeout(() => beginFailure("TIMEOUT"), input.timeoutMs);
    writeFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-control-plane", version: "1" } },
    });
  });
};
