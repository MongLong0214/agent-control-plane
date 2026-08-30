import { spawnSync } from "node:child_process";

import { digestOf, isDigest } from "../core/digest.ts";

export type HermesTargetBindResponse = {
  domain: "hermes.target-bind";
  version: 1;
  actor_id: string;
  binding_generation: number;
  executor_runtime_identity: string;
  requested_session_id: string;
  lineage_root_digest: string;
  receipt_digest: string;
};

type FailureCategory =
  | "PREFLIGHT_INVALID"
  | "PREFLIGHT_CONFLICT"
  | "PREFLIGHT_UNAVAILABLE"
  | "PROTOCOL_INVALID"
  | "PROTOCOL_UNAVAILABLE";

export type HermesTargetBindDecision =
  | { allowed: true; value: HermesTargetBindResponse }
  | { allowed: false; category: FailureCategory };

export type HermesTargetBindOptions = {
  hermesExecutable: string;
  hermesProfile: string;
  hermesHome: string;
  sessionId: string;
  expectedLineageRootDigest: string;
  actorId: string;
  bindingGeneration: number;
  executorRuntimeIdentity: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const protocolInvalid = (): HermesTargetBindDecision => ({ allowed: false, category: "PROTOCOL_INVALID" });
const protocolUnavailable = (): HermesTargetBindDecision => ({ allowed: false, category: "PROTOCOL_UNAVAILABLE" });

export const runHermesTargetBind = (options: HermesTargetBindOptions): HermesTargetBindDecision => {
  if (!Number.isSafeInteger(options.bindingGeneration) || options.bindingGeneration <= 0 || !isDigest(options.expectedLineageRootDigest)) {
    return protocolInvalid();
  }
  const request = {
    domain: "hermes.target-bind",
    version: 1,
    session_id: options.sessionId,
    expected_lineage_root_digest: options.expectedLineageRootDigest,
    actor_id: options.actorId,
    binding_generation: options.bindingGeneration,
    executor_runtime_identity: options.executorRuntimeIdentity,
  };
  const result = spawnSync(options.hermesExecutable, ["target", "bind", "--json"], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: options.maxOutputBytes ?? 65_536,
    env: { HOME: options.hermesHome, HERMES_HOME: options.hermesHome, HERMES_PROFILE: options.hermesProfile },
  });
  if (result.error || result.signal || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > (options.maxOutputBytes ?? 65_536)) {
    return protocolUnavailable();
  }
  if (result.status === 1) {
    if (result.stdout === '{"error":"target_bind_preflight_invalid"}') return { allowed: false, category: "PREFLIGHT_INVALID" };
    if (result.stdout === '{"error":"target_bind_preflight_conflict"}') return { allowed: false, category: "PREFLIGHT_CONFLICT" };
    if (result.stdout === '{"error":"target_bind_preflight_unavailable"}') return { allowed: false, category: "PREFLIGHT_UNAVAILABLE" };
    return protocolInvalid();
  }
  if (result.status !== 0) return protocolUnavailable();
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { return protocolInvalid(); }
  if (response === null || typeof response !== "object" || Array.isArray(response)) return protocolInvalid();
  const record = response as Record<string, unknown>;
  const keys = ["actor_id", "binding_generation", "domain", "executor_runtime_identity", "lineage_root_digest", "receipt_digest", "requested_session_id", "version"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) return protocolInvalid();
  if (
    record.domain !== "hermes.target-bind" || record.version !== 1 || record.actor_id !== options.actorId ||
    record.binding_generation !== options.bindingGeneration || record.executor_runtime_identity !== options.executorRuntimeIdentity ||
    record.requested_session_id !== options.sessionId || record.lineage_root_digest !== options.expectedLineageRootDigest ||
    !isDigest(record.lineage_root_digest) || !isDigest(record.receipt_digest)
  ) return protocolInvalid();
  const publicFields = {
    domain: record.domain,
    version: record.version,
    actor_id: record.actor_id,
    binding_generation: record.binding_generation,
    executor_runtime_identity: record.executor_runtime_identity,
    requested_session_id: record.requested_session_id,
    lineage_root_digest: record.lineage_root_digest,
  };
  if (record.receipt_digest !== digestOf(publicFields)) return protocolInvalid();
  return { allowed: true, value: response as HermesTargetBindResponse };
};
