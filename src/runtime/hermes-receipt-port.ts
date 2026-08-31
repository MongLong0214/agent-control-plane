import { ReasonCode } from "../core/reason-codes.ts";
import type { ReceiptLookupQuery, ReceiptLookupResult, ReceiptPort } from "../conversation/turn-coordinator.ts";
import type { HermesTargetBindReceipt } from "../session/binding-registry.ts";
import {
  runHermesAcp,
  type HermesAcpInput,
  type HermesAcpReceiptIdentity,
  type HermesAcpResult,
} from "./hermes-acp-client.ts";

/** The persisted-attestation resolver; it never derives evidence from a live binding. */
export interface HermesHistoricalReceiptResolver {
  historicalHermesTargetBindReceipt(input: {
    targetActorId: string;
    bindingGeneration: number;
    targetBindingId: string;
    targetAttestationId: string;
    executorSessionId: string;
    executorSessionIncarnation: string;
  }): HermesTargetBindReceipt | null;
}

export type HermesAcpExecute = (input: HermesAcpInput) => Promise<HermesAcpResult>;

/** Explicitly configured process boundary for the dark status-only receipt port. */
export interface HermesReceiptPortOptions {
  executable: string;
  cwd: string;
  home: string;
  hermesHome: string;
  hermesProfile: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxLineBytes: number;
  /** A1's execution seam. C4-A0 only supplies `operation: "status"` to it. */
  execute?: HermesAcpExecute;
}

const identityFor = (query: ReceiptLookupQuery): HermesAcpReceiptIdentity => ({
  schema: "hermes.acp-terminal-receipt-identity",
  version: 1,
  turnRequestId: query.turnRequestId,
  targetActorId: query.targetActorId,
  promptDigest: query.promptDigest,
  bindingGeneration: query.bindingGeneration,
  targetBindingId: query.targetBindingId,
  targetAttestationId: query.targetAttestationId,
  executorSessionId: query.executorSessionId,
  executorSessionIncarnation: query.executorSessionIncarnation,
});

const historicalIdentity = (query: ReceiptLookupQuery) => ({
  targetActorId: query.targetActorId,
  bindingGeneration: query.bindingGeneration,
  targetBindingId: query.targetBindingId,
  targetAttestationId: query.targetAttestationId,
  executorSessionId: query.executorSessionId,
  executorSessionIncarnation: query.executorSessionIncarnation,
});

/**
 * Receipt-only Hermes reconciliation.
 *
 * It asks the bounded ACP client only for a status of the exact immutable receipt identity. A
 * missing historic attestation, a non-terminal answer, a malformed/ambiguous transport result, or
 * an exception all remain `found: false`; none can release an in-doubt turn or create a session.
 */
export class HermesReceiptPort implements ReceiptPort {
  readonly #execute: HermesAcpExecute;

  constructor(
    private readonly receipts: HermesHistoricalReceiptResolver,
    private readonly options: HermesReceiptPortOptions,
  ) {
    this.#execute = options.execute ?? runHermesAcp;
  }

  async lookup(query: ReceiptLookupQuery, signal: AbortSignal): Promise<ReceiptLookupResult> {
    const targetBindReceipt = this.receipts.historicalHermesTargetBindReceipt(historicalIdentity(query));
    if (!targetBindReceipt) return { found: false };

    let result: HermesAcpResult;
    try {
      result = await this.#execute({
        operation: "status",
        executable: this.options.executable,
        cwd: this.options.cwd,
        home: this.options.home,
        hermesHome: this.options.hermesHome,
        hermesProfile: this.options.hermesProfile,
        timeoutMs: this.options.timeoutMs,
        maxStdoutBytes: this.options.maxStdoutBytes,
        maxStderrBytes: this.options.maxStderrBytes,
        maxLineBytes: this.options.maxLineBytes,
        receiptIdentity: identityFor(query),
        targetBindReceipt,
        signal,
      });
    } catch {
      return { found: false };
    }

    if (result.status === "COMPLETED") {
      return {
        found: true,
        outcome: "COMPLETED",
        receiptId: result.receiptId,
        evidenceDigest: result.evidenceDigest,
        reasonCode: ReasonCode.OK,
        ...result.receiptIdentity,
      };
    }
    if (result.status === "ABORTED") {
      return {
        found: true,
        outcome: "ABORTED",
        receiptId: result.receiptId,
        evidenceDigest: result.evidenceDigest,
        reasonCode: result.reasonCode,
        ...result.receiptIdentity,
      };
    }
    return { found: false };
  }
}
