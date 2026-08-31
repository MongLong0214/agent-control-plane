import { describe, expect, it, vi } from "vitest";

import type { ReceiptLookupQuery } from "../../src/conversation/turn-coordinator.ts";
import { HermesReceiptPort } from "../../src/runtime/hermes-receipt-port.ts";
import type { HermesAcpInput, HermesAcpResult } from "../../src/runtime/hermes-acp-client.ts";

const query: ReceiptLookupQuery = {
  turnRequestId: "turn-query",
  targetActorId: "actor:query",
  promptDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  bindingGeneration: 7,
  targetBindingId: "binding-query",
  targetAttestationId: "attestation-query",
  executorSessionId: "executor-query",
  executorSessionIncarnation: "incarnation-query",
};

const targetBindReceipt = {
  domain: "hermes.target-bind" as const,
  version: 1 as const,
  actor_id: query.targetActorId,
  binding_generation: query.bindingGeneration,
  executor_runtime_identity: "runtime-query",
  requested_session_id: "hermes-conversation-query",
  lineage_root_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  receipt_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
};

const terminalIdentity = {
  schema: "hermes.acp-terminal-receipt-identity" as const,
  version: 1 as const,
  turnRequestId: "turn-terminal",
  targetActorId: "actor:terminal",
  promptDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  bindingGeneration: 9,
  targetBindingId: "binding-terminal",
  targetAttestationId: "attestation-terminal",
  executorSessionId: "executor-terminal",
  executorSessionIncarnation: "incarnation-terminal",
};

const portOptions = (execute: (input: HermesAcpInput) => Promise<HermesAcpResult>) => ({
  executable: "/trusted/hermes",
  cwd: "/trusted/cwd",
  home: "/trusted/home",
  hermesHome: "/trusted/hermes-home",
  hermesProfile: "owner",
  timeoutMs: 1_000,
  maxStdoutBytes: 8_192,
  maxStderrBytes: 8_192,
  maxLineBytes: 4_096,
  execute,
});

describe("Hermes receipt port", () => {
  it("queries only the persisted historical receipt and maps terminal metadata rather than its query", async () => {
    const historicalHermesTargetBindReceipt = vi.fn(() => targetBindReceipt);
    const execute = vi.fn<(input: HermesAcpInput) => Promise<HermesAcpResult>>(async (_input) => ({
      status: "ABORTED" as const,
      receiptIdentity: terminalIdentity,
      receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evidenceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reasonCode: "HERMES_AGENT_RUN_EXCEPTION",
    }));
    const port = new HermesReceiptPort({ historicalHermesTargetBindReceipt }, portOptions(execute));

    await expect(port.lookup(query, new AbortController().signal)).resolves.toEqual({
      found: true,
      outcome: "ABORTED",
      receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evidenceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reasonCode: "HERMES_AGENT_RUN_EXCEPTION",
      ...terminalIdentity,
    });
    expect(historicalHermesTargetBindReceipt).toHaveBeenCalledWith({
      targetActorId: query.targetActorId,
      bindingGeneration: query.bindingGeneration,
      targetBindingId: query.targetBindingId,
      targetAttestationId: query.targetAttestationId,
      executorSessionId: query.executorSessionId,
      executorSessionIncarnation: query.executorSessionIncarnation,
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "status",
      receiptIdentity: { schema: "hermes.acp-terminal-receipt-identity", version: 1, ...query },
      targetBindReceipt,
      signal: expect.any(AbortSignal),
    }));
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("text");
  });

  it("maps a terminal completed receipt without echoing the query identity", async () => {
    const execute = vi.fn<(input: HermesAcpInput) => Promise<HermesAcpResult>>(async (_input) => ({
      status: "COMPLETED",
      receiptIdentity: terminalIdentity,
      receiptId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      evidenceDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      content: "terminal-only-content",
    }));
    const port = new HermesReceiptPort(
      { historicalHermesTargetBindReceipt: () => targetBindReceipt },
      portOptions(execute),
    );

    await expect(port.lookup(query, new AbortController().signal)).resolves.toEqual({
      found: true,
      outcome: "COMPLETED",
      receiptId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      evidenceDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      reasonCode: "OK",
      ...terminalIdentity,
    });
  });

  it("keeps never-found, incomplete, transport ambiguity, and missing durable evidence in doubt", async () => {
    const historicalHermesTargetBindReceipt = vi.fn(() => targetBindReceipt);
    const execute = vi
      .fn<(input: HermesAcpInput) => Promise<HermesAcpResult>>()
      .mockResolvedValueOnce({ status: "NEVER_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_COMPLETED", terminalStatus: "CLAIMED" })
      .mockResolvedValueOnce({ status: "FAILED", reason: "TIMEOUT" });
    const port = new HermesReceiptPort({ historicalHermesTargetBindReceipt }, portOptions(execute));

    await expect(port.lookup(query, new AbortController().signal)).resolves.toEqual({ found: false });
    await expect(port.lookup(query, new AbortController().signal)).resolves.toEqual({ found: false });
    await expect(port.lookup(query, new AbortController().signal)).resolves.toEqual({ found: false });

    const absent = new HermesReceiptPort(
      { historicalHermesTargetBindReceipt: () => null },
      portOptions(execute),
    );
    await expect(absent.lookup(query, new AbortController().signal)).resolves.toEqual({ found: false });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
