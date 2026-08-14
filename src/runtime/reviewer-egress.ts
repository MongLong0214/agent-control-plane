import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { sha256 } from "../core/digest.ts";
import { credentialBearingField } from "../db/audit.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import {
  REVIEWER_PROVIDER_ENDPOINTS,
  type ReviewerEgressConfig,
  type ReviewerEgressRecord,
} from "./provider.ts";

/** Detailed setup failures remain nested under ISOLATION_LOST at the review boundary. */
export type ReviewerEgressFailureCode =
  | "REVIEWER_EGRESS_CONFIG_MISSING"
  | "REVIEWER_EGRESS_PROFILE_MISSING"
  | "REVIEWER_EGRESS_PROFILE_UNREADABLE"
  | "REVIEWER_EGRESS_PROFILE_INVALID"
  | "REVIEWER_EGRESS_PROXY_MISSING"
  | "REVIEWER_EGRESS_PROXY_UNREADABLE"
  | "REVIEWER_EGRESS_RUNTIME_DIR_UNAVAILABLE"
  | "REVIEWER_EGRESS_PROVIDER_ENDPOINTS_MISSING"
  | "REVIEWER_EGRESS_PROVIDER_ENDPOINTS_INVALID"
  | "REVIEWER_EGRESS_PROXY_UNREACHABLE"
  | "REVIEWER_EGRESS_PROXY_DIED"
  | "REVIEWER_EGRESS_ALLOWLIST_UNBOUND"
  | "REVIEWER_EGRESS_LOG_INVALID"
  | "REVIEWER_EGRESS_LOG_CREDENTIAL_BEARING";

export class ReviewerEgressError extends Error {
  constructor(
    readonly failureCode: ReviewerEgressFailureCode,
    message: string,
  ) {
    super(`${failureCode}: ${message}`);
    this.name = "ReviewerEgressError";
  }
}

type EgressProbes = ReviewerEgressRecord["probes"];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const safeJson = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

const fail = (failureCode: ReviewerEgressFailureCode, message: string): never => {
  throw new ReviewerEgressError(failureCode, message);
};

const assertReadableRegularFile = (
  path: string,
  missing: ReviewerEgressFailureCode,
  unreadable: ReviewerEgressFailureCode,
  label: string,
): void => {
  if (!existsSync(path)) fail(missing, `${label} is missing at ${path}`);
  try {
    if (!lstatSync(path).isFile()) fail(unreadable, `${label} is not a regular file at ${path}`);
    accessSync(path, constants.R_OK);
  } catch (error) {
    if (error instanceof ReviewerEgressError) throw error;
    fail(unreadable, `${label} cannot be read at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * The owner profile is independently verified even though the generated inner reviewer
 * profile repeats these network rules. The duplication is intentional: a typo in either
 * profile fails closed rather than making an allow-default outer sandbox decisive.
 */
const assertProfileContract = (profilePath: string, port: number): string => {
  const profile = (() => {
    try {
      return readFileSync(profilePath, "utf8");
    } catch (error) {
      throw new ReviewerEgressError(
        "REVIEWER_EGRESS_PROFILE_UNREADABLE",
        `could not read reviewer egress profile ${profilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  const required = [
    /\(allow\s+default\)/,
    /\(deny\s+network-outbound\s+\(remote\s+tcp\)\)/,
    /\(deny\s+network-outbound\s+\(remote\s+udp\)\)/,
    new RegExp(`\\(allow\\s+network-outbound\\s+\\(remote\\s+tcp\\s+"localhost:${port}"\\)\\)`),
    /\(allow\s+network-outbound\s+\(remote\s+unix-socket\)\)/,
  ];
  if (required.some((rule) => !rule.test(profile))) {
    fail(
      "REVIEWER_EGRESS_PROFILE_INVALID",
      `reviewer egress profile ${profilePath} does not contain the required remote TCP/UDP denies and localhost:${port} exception`,
    );
  }

  // A broad remote TCP allow would defeat the named deny in a profile whose ordering or
  // specificity was changed. The only allowed remote TCP rule is the loopback proxy.
  const tcpAllows = [...profile.matchAll(/\(allow\s+network-outbound\s+\(remote\s+tcp(?:\s+"([^"]+)")?\)\)/g)];
  if (tcpAllows.some((match) => match[1] !== `localhost:${port}`)) {
    fail(
      "REVIEWER_EGRESS_PROFILE_INVALID",
      `reviewer egress profile ${profilePath} grants a remote TCP destination other than localhost:${port}`,
    );
  }
  return profile;
};

const normalizeEndpoint = (value: string): string | null => {
  const endpoint = value.trim().toLowerCase().replace(/\.$/, "");
  // CONNECT accepts a host, never a URL, wildcard, userinfo, port, or IP literal. A
  // compiled hostname policy keeps malformed configuration from becoming proxy input.
  if (
    endpoint.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(endpoint)
  ) return null;
  return endpoint;
};

const configuredEndpoints = (config: ReviewerEgressConfig, provider: string): string[] => {
  const source = config.providerEndpoints ?? REVIEWER_PROVIDER_ENDPOINTS;
  const raw = source[provider];
  if (!raw || raw.length === 0) {
    fail("REVIEWER_EGRESS_PROVIDER_ENDPOINTS_MISSING", `no reviewer egress endpoints are configured for provider '${provider}'`);
  }
  const rawEndpoints = raw as readonly string[];
  const endpoints = [...new Set(rawEndpoints.map(normalizeEndpoint))];
  if (endpoints.some((endpoint) => endpoint === null) || endpoints.length === 0) {
    fail("REVIEWER_EGRESS_PROVIDER_ENDPOINTS_INVALID", `provider '${provider}' has an invalid reviewer egress hostname`);
  }
  return endpoints as string[];
};

let queuedLease: Promise<void> = Promise.resolve();

/**
 * Port 18443 is named in the seatbelt profile. Serialize leases in this daemon process so
 * one provider's generated allowlist cannot ever be observed by another provider's child.
 * A second daemon is already prevented by the daemon lock; if an outside listener owns the
 * port, startup fails closed as PROXY_UNREACHABLE.
 */
const acquireLeaseLock = async (): Promise<() => void> => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = queuedLease;
  queuedLease = prior.then(() => held, () => held);
  await prior;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
};

export interface ReviewerEgressLease {
  readonly profilePath: string;
  /** Validated owner profile bytes, held to prevent a read/validate/use path race. */
  readonly profileText: string;
  readonly proxyUrl: string;
  readonly port: number;
  readonly provider: string;
  readonly allowedEndpoints: readonly string[];
  died(): boolean;
  onDeath(listener: () => void): () => void;
  finalise(phase: ReviewerEgressRecord["phase"], probes: EgressProbes): Promise<ReviewerEgressRecord>;
  abandon(): Promise<void>;
}

class StartedReviewerEgressLease implements ReviewerEgressLease {
  readonly proxyUrl: string;
  #died = false;
  #stopping = false;
  #released = false;
  #listeners = new Set<() => void>();
  #stderr = "";

  constructor(
    readonly profilePath: string,
    readonly profileText: string,
    readonly port: number,
    readonly provider: string,
    readonly allowedEndpoints: readonly string[],
    private readonly allowlistDigest: string,
    private readonly proxy: ChildProcess,
    private readonly logPath: string,
    private readonly leaseDirectory: string,
    private readonly releaseLock: () => void,
  ) {
    this.proxyUrl = `http://127.0.0.1:${port}`;
    this.proxy.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    this.proxy.once("exit", () => {
      if (this.#stopping) return;
      this.#died = true;
      for (const listener of this.#listeners) listener();
    });
    this.proxy.once("error", () => {
      if (this.#stopping) return;
      this.#died = true;
      for (const listener of this.#listeners) listener();
    });
  }

  died(): boolean {
    return this.#died;
  }

  onDeath(listener: () => void): () => void {
    if (this.#died) listener();
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async waitForStart(): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (this.#died || this.proxy.exitCode !== null) {
        fail(
          "REVIEWER_EGRESS_PROXY_UNREACHABLE",
          `reviewer egress proxy exited before listening on localhost:${this.port}${this.#stderr ? `: ${this.#stderr}` : ""}`,
        );
      }
      let starts: Array<Record<string, unknown> | null> = [];
      try {
        const events = readFileSync(this.logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(safeJson);
        starts = events.filter((event) =>
          event?.["verdict"] === "START" && Number(event["port"]) === this.port,
        );
      } catch {
        // The file is created before the child starts. A transient read while the proxy
        // appends is not proof of anything, so wait for a complete START record.
      }
      if (starts.some((event) => event?.["allowlistDigest"] === this.allowlistDigest)) return;
      if (starts.length > 0) {
        fail(
          "REVIEWER_EGRESS_ALLOWLIST_UNBOUND",
          `reviewer egress proxy did not attest the generated allowlist digest for localhost:${this.port}`,
        );
      }
      await delay(25);
    }
    fail(
      "REVIEWER_EGRESS_PROXY_UNREACHABLE",
      `reviewer egress proxy did not announce localhost:${this.port}${this.#stderr ? `: ${this.#stderr}` : ""}`,
    );
  }

  async finalise(phase: ReviewerEgressRecord["phase"], probes: EgressProbes): Promise<ReviewerEgressRecord> {
    await this.stopProxy();
    try {
      if (this.#died) {
        fail("REVIEWER_EGRESS_PROXY_DIED", "reviewer egress proxy died while the reviewer was running");
      }
      const jsonl = readFileSync(this.logPath, "utf8");
      const credential = credentialBearingField({ egress: jsonl });
      if (credential) {
        fail("REVIEWER_EGRESS_LOG_CREDENTIAL_BEARING", `proxy JSONL contains a credential at ${credential}`);
      }
      this.assertMeasuredJsonl(jsonl, probes);
      return {
        provider: this.provider,
        allowedEndpoints: [...this.allowedEndpoints],
        allowlistDigest: this.allowlistDigest,
        proxyPort: this.port,
        phase,
        jsonl,
        probes,
      };
    } catch (error) {
      if (error instanceof ReviewerEgressError) throw error;
      return fail(
        "REVIEWER_EGRESS_LOG_INVALID",
        `could not capture reviewer egress JSONL: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.cleanup();
    }
  }

  async abandon(): Promise<void> {
    await this.stopProxy();
    this.cleanup();
  }

  private assertMeasuredJsonl(jsonl: string, probes: EgressProbes): void {
    const events = jsonl.split("\n").filter(Boolean).map((line) => safeJson(line));
    if (events.length === 0 || events.some((event) => event === null)) {
      fail("REVIEWER_EGRESS_LOG_INVALID", "proxy log is not complete JSONL");
    }
    const records = events as Record<string, unknown>[];
    const sameHost = (event: Record<string, unknown>, host: string): boolean =>
      typeof event["host"] === "string" && event["host"].toLowerCase() === host.toLowerCase();
    const samePort = (event: Record<string, unknown>): boolean => String(event["port"]) === "443";
    const hasStart = records.some((event) =>
      event["verdict"] === "START" &&
      Number(event["port"]) === this.port &&
      event["allowlistDigest"] === this.allowlistDigest,
    );
    const unexpectedAllow = records.find((event) => {
      if (event["verdict"] !== "ALLOW") return false;
      const host = typeof event["host"] === "string" ? event["host"].toLowerCase() : null;
      return host === null || !this.allowedEndpoints.includes(host);
    });
    if (unexpectedAllow) {
      fail(
        "REVIEWER_EGRESS_LOG_INVALID",
        "proxy JSONL records an ALLOW outside the generated allowlist",
      );
    }
    const hasAllow = records.some((event) =>
      event["verdict"] === "ALLOW" && sameHost(event, probes.allowedEndpoint.host) && samePort(event),
    );
    const hasDeny = records.some((event) =>
      event["verdict"] === "DENY" && sameHost(event, probes.deniedEndpoint.host) && samePort(event),
    );
    const directModes = new Set(probes.directSocket.map((probe) => probe.proxyMode));
    if (
      !hasStart ||
      probes.allowedEndpoint.connected !== true ||
      !hasAllow ||
      probes.deniedEndpoint.denied !== true ||
      probes.deniedEndpoint.statusCode !== 403 ||
      !hasDeny ||
      !directModes.has("unset") ||
      !directModes.has("override") ||
      probes.directSocket.some((probe) => probe.blocked !== true || probe.connected === true)
    ) {
      fail("REVIEWER_EGRESS_LOG_INVALID", "proxy JSONL does not corroborate all provider-only invocation probes and the generated allowlist binding");
    }
  }

  private async stopProxy(): Promise<void> {
    if (this.proxy.exitCode !== null || this.proxy.killed) return;
    this.#stopping = true;
    try {
      if (this.proxy.pid) process.kill(-this.proxy.pid, "SIGTERM");
      else this.proxy.kill("SIGTERM");
    } catch {
      this.proxy.kill("SIGTERM");
    }
    await Promise.race([
      new Promise<void>((resolve) => this.proxy.once("exit", () => resolve())),
      delay(1_000),
    ]);
    // `ChildProcess.killed` means only that SIGTERM was successfully *sent*, not that the
    // proxy exited. A stuck proxy must still receive SIGKILL before its lease can release
    // the fixed port to the next reviewer.
    if (this.proxy.exitCode === null) {
      try {
        if (this.proxy.pid) process.kill(-this.proxy.pid, "SIGKILL");
        else this.proxy.kill("SIGKILL");
      } catch {
        this.proxy.kill("SIGKILL");
      }
    }
  }

  private cleanup(): void {
    if (this.#released) return;
    this.#released = true;
    rmSync(this.leaseDirectory, { recursive: true, force: true });
    this.releaseLock();
  }
}

/**
 * Starts the one egress proxy a reviewer can use. The caller must call `finalise` or
 * `abandon` exactly once; both stop the proxy, remove the generated allowlist, and release
 * the fixed-port lease.
 */
export const acquireReviewerEgress = async (
  config: ReviewerEgressConfig | undefined,
  provider: string,
): Promise<ReviewerEgressLease> => {
  const effectiveConfig = config ?? fail(
    "REVIEWER_EGRESS_CONFIG_MISSING",
    "reviewer egress infrastructure is not configured",
  );
  const port = effectiveConfig.port ?? 18_443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail("REVIEWER_EGRESS_CONFIG_MISSING", `reviewer egress port is invalid: ${String(port)}`);
  }
  assertReadableRegularFile(
    effectiveConfig.profilePath,
    "REVIEWER_EGRESS_PROFILE_MISSING",
    "REVIEWER_EGRESS_PROFILE_UNREADABLE",
    "reviewer egress profile",
  );
  assertReadableRegularFile(
    effectiveConfig.proxyPath,
    "REVIEWER_EGRESS_PROXY_MISSING",
    "REVIEWER_EGRESS_PROXY_UNREADABLE",
    "reviewer egress proxy",
  );
  const profileText = assertProfileContract(effectiveConfig.profilePath, port);
  const endpoints = configuredEndpoints(effectiveConfig, provider);
  try {
    ensurePrivateDirectory(effectiveConfig.runtimeDir);
  } catch (error) {
    fail(
      "REVIEWER_EGRESS_RUNTIME_DIR_UNAVAILABLE",
      `cannot prepare reviewer egress runtime directory ${effectiveConfig.runtimeDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const releaseLock = await acquireLeaseLock();
  let leaseDirectory: string | null = null;
  let proxy: ChildProcess | null = null;
  try {
    leaseDirectory = mkdtempSync(join(effectiveConfig.runtimeDir, "reviewer-egress-"));
    const allowlistPath = join(leaseDirectory, "allowlist.txt");
    const logPath = join(leaseDirectory, "egress.jsonl");
    writeFileSync(allowlistPath, `${endpoints.join("\n")}\n`, { mode: 0o600 });
    // The proxy must include this exact digest in its START record after reading the path
    // it was launched with. That binds its observed policy to this invocation's generated
    // bytes rather than merely proving that some proxy answered on the fixed port.
    const allowlistDigest = sha256(readFileSync(allowlistPath));
    // Pre-create private so the proxy only appends; the immutable copy is made after it
    // has stopped, never by following an owner-controlled log path.
    writeFileSync(logPath, "", { mode: 0o600 });
    try {
      proxy = spawn(effectiveConfig.pythonBinary ?? "/usr/bin/python3", [effectiveConfig.proxyPath, String(port), allowlistPath, logPath], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      fail(
        "REVIEWER_EGRESS_PROXY_UNREACHABLE",
        `could not start reviewer egress proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const startedProxy = proxy ?? fail(
      "REVIEWER_EGRESS_PROXY_UNREACHABLE",
      "reviewer egress proxy did not return a process handle",
    );
    const lease = new StartedReviewerEgressLease(
      effectiveConfig.profilePath,
      profileText,
      port,
      provider,
      endpoints,
      allowlistDigest,
      startedProxy,
      logPath,
      leaseDirectory,
      releaseLock,
    );
    await lease.waitForStart();
    return lease;
  } catch (error) {
    try {
      if (proxy && proxy.exitCode === null) {
        if (proxy.pid) process.kill(-proxy.pid, "SIGKILL");
        else proxy.kill("SIGKILL");
      }
    } catch {
      proxy?.kill("SIGKILL");
    }
    if (leaseDirectory) rmSync(leaseDirectory, { recursive: true, force: true });
    releaseLock();
    throw error;
  }
};

export type { EgressProbes };
