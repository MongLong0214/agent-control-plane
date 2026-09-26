import { request } from "node:http";

import { isDigest } from "../core/digest.ts";

/** A Gateway observation, not an authorization or an ACP session pin. */
export interface HermesGatewayIdentity {
  session_id: string;
  lineage_root_digest: string;
  process_pid: number;
  process_started_at: string;
}

const PATH = "/v1/canonical-surface/identity";
const MAX_BYTES = 4_096;
const TIMEOUT_MS = 1_500;
const failure = (): Error => new Error("Gateway identity unavailable");

const isIdentity = (value: unknown): value is HermesGatewayIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["lineage_root_digest", "process_pid", "process_started_at", "session_id"])) return false;
  return typeof record.session_id === "string" && record.session_id.length > 0 &&
    record.session_id.length <= 512 && !/[\x00-\x1f\x7f]/.test(record.session_id) &&
    isDigest(record.lineage_root_digest) &&
    typeof record.process_pid === "number" && Number.isSafeInteger(record.process_pid) &&
    record.process_pid > 0 && typeof record.process_started_at === "string" &&
    record.process_started_at.length > 0 && record.process_started_at.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(record.process_started_at);
};

const readHermesGatewayIdentity = async (options: {
  apiKey: string;
  port?: number;
}): Promise<HermesGatewayIdentity> => {
  const port = options.port ?? 8642;
  if (typeof options.apiKey !== "string" || !/^[\x21-\x7e]+$/.test(options.apiKey) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) throw failure();

  return new Promise<HermesGatewayIdentity>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", family: 4, port, path: PATH, method: "GET",
      agent: false, headers: { Authorization: `Bearer ${options.apiKey}` } }, (res) => {
      if (res.statusCode !== 200 || (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          Number(res.headers["content-length"] ?? 0) > MAX_BYTES) {
        reject(failure());
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          reject(failure());
          res.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!isIdentity(body)) throw failure();
          resolve(body);
        } catch { reject(failure()); }
      });
      res.on("error", () => reject(failure()));
      res.on("aborted", () => reject(failure()));
    });
    const timer = setTimeout(() => {
      reject(failure());
      req.destroy();
    }, TIMEOUT_MS);
    req.on("error", () => reject(failure()));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
};

/** Compose once with the daemon's separately provisioned key; readers take no caller input. */
export const createHermesGatewayIdentityReader = (options: {
  apiKey: string;
  /** Ephemeral test listener only; production uses Gateway's fixed port 8642. */
  port?: number;
}): (() => Promise<HermesGatewayIdentity>) => {
  const apiKey = options.apiKey;
  const port = options.port;
  return () => readHermesGatewayIdentity({ apiKey, port });
};
