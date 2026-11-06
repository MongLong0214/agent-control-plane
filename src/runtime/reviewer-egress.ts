import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { sha256 } from "../core/digest.ts";
import { readProcessArgv, readProcessStartToken } from "../core/process-argv.ts";
import { credentialBearingField } from "../db/audit.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import {
  REVIEWER_PROVIDER_ENDPOINTS,
  reviewerEgressProbeIndeterminate,
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

/** A lease's record: a private directory under the runtime directory, removed when the lease ends. */
const LEASE_PREFIX = "reviewer-egress-";
const leaseFiles = (leaseDirectory: string): { allowlistPath: string; logPath: string } => ({
  allowlistPath: join(leaseDirectory, "allowlist.txt"),
  logPath: join(leaseDirectory, "egress.jsonl"),
});
/** The proxy's arguments after its interpreter: the script, the port and the lease's own two files. */
const proxyArguments = (proxyPath: string, port: number, leaseDirectory: string): string[] => {
  const { allowlistPath, logPath } = leaseFiles(leaseDirectory);
  return [proxyPath, String(port), allowlistPath, logPath];
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
      probes.directSocket.some((probe) => probe.blocked !== true || probe.connected === true) ||
      [probes.allowedEndpoint, probes.deniedEndpoint, ...probes.directSocket].some(reviewerEgressProbeIndeterminate)
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
    leaseDirectory = mkdtempSync(join(effectiveConfig.runtimeDir, LEASE_PREFIX));
    const { allowlistPath, logPath } = leaseFiles(leaseDirectory);
    writeFileSync(allowlistPath, `${endpoints.join("\n")}\n`, { mode: 0o600 });
    // The proxy must include this exact digest in its START record after reading the path
    // it was launched with. That binds its observed policy to this invocation's generated
    // bytes rather than merely proving that some proxy answered on the fixed port.
    const allowlistDigest = sha256(readFileSync(allowlistPath));
    // Pre-create private so the proxy only appends; the immutable copy is made after it
    // has stopped, never by following an owner-controlled log path.
    writeFileSync(logPath, "", { mode: 0o600 });
    try {
      // #1344 D — this argv is the process signature `reapOrphanedReviewerEgress` identifies a leftover proxy by.
      proxy = spawn(effectiveConfig.pythonBinary ?? "/usr/bin/python3", proxyArguments(effectiveConfig.proxyPath, port, leaseDirectory), {
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

/**
 * #1344 D — what a daemon's start found of reviewer egress proxies an earlier instance launched and left running.
 * `leases`: the lease directories left behind (their names). `discovery`: COMPLETE when every live process of this user
 * was listed and its argv read; otherwise FAILED, with why (`discoveryError`), and no lease is removed. `stopped`: the
 * proxies matched to a lease and stopped. `survived`: matched proxies that did not stop. `kept`: the leases not removed,
 * because their proxy survived or because discovery could not prove it gone. `portFree`: whether the reviewer port takes
 * a listener now. False means a holder not proven to be one of these proxies, which is left alone: a review start fails
 * as it did before, and this record is the evidence of why.
 */
export interface ReviewerEgressReap {
  port: number;
  leases: string[];
  discovery: "COMPLETE" | "FAILED";
  discoveryError?: string;
  stopped: Array<{ pid: number; lease: string }>;
  survived: Array<{ pid: number; lease: string }>;
  kept: string[];
  portFree: boolean;
}

/** A live process of this user, as `ps` lists it: its pid, and whether it is a zombie (exited, holding no socket). */
interface ListedProcess { pid: number; zombie: boolean }

/**
 * Every process of this user but this one, from `ps`'s pid, uid and state columns. An error answers why the listing is
 * not complete: `ps` failed or timed out, a line it printed is not those three columns, or it did not list this process.
 */
const ownProcesses = (): { processes: ListedProcess[] } | { error: string } => {
  const uid = process.getuid?.();
  if (uid === undefined) return { error: "this platform has no process user id" };
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid=,uid=,stat="], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return { error: `ps failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const processes: ListedProcess[] = [];
  let listedSelf = false;
  for (const line of listing.split("\n")) {
    if (line.trim() === "") continue;
    // A uid is printed signed: nobody is -2.
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return { error: "ps printed a line that is not pid, uid and state" };
    const pid = Number(match[1]);
    if (pid === process.pid) listedSelf = true;
    if (pid !== process.pid && Number(match[2]) === uid) processes.push({ pid, zombie: match[3]!.startsWith("Z") });
  }
  return listedSelf ? { processes } : { error: "ps did not list this process" };
};

/** Whether no process has this pid any more: only ESRCH proves it; a permission error or a live process does not. */
const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** Signals the exact process while it is still the one identified (same pid and OS start), then waits for it to go. */
const stopExact = async (pid: number, startToken: string): Promise<boolean> => {
  const same = (): boolean => readProcessStartToken(pid) === startToken;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!same()) return true;
    try {
      process.kill(pid, signal);
    } catch {
      return !same();
    }
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (!same()) return true;
      await delay(25);
    }
  }
  return !same();
};

const portTakesListener = (port: number): Promise<boolean> => new Promise((resolve) => {
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

/**
 * #1344 D — at a daemon's start, before any review can start: stops the reviewer egress proxies an earlier instance
 * of this daemon launched and left running, which hold the fixed port so that every later review fails ISOLATION_LOST.
 *
 * A proxy is identified the way the launcher records it: a lease directory left under this daemon's runtime directory
 * (a lease that ended removed its own), and a process of this user whose kernel argv ends with exactly the arguments
 * that lease was launched with: this daemon's proxy script, its port and that directory's two files. Only those exact
 * pids are signalled, each while its OS start token is still the one read; never a process found by name, and never
 * what merely holds the port. A lease is removed only when its proxy is proven gone: it was matched and stopped, or
 * discovery was complete and no process matched it. A discovery that failed (`ps` failed, timed out or printed what
 * cannot be read, or a live process's argv could not be read) keeps every lease it did not stop, for the next start to
 * reap. Runs under the lease lock, so no lease of this process is live meanwhile. Null when no lease was left behind.
 */
export const reapOrphanedReviewerEgress = async (config: ReviewerEgressConfig | undefined): Promise<ReviewerEgressReap | null> => {
  if (!config) return null;
  const port = config.port ?? 18_443;
  let names: string[];
  try {
    names = readdirSync(config.runtimeDir);
  } catch {
    return null;
  }
  const leases = names.filter((name) => {
    if (!name.startsWith(LEASE_PREFIX)) return false;
    try {
      return lstatSync(join(config.runtimeDir, name)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
  if (leases.length === 0) return null;

  const releaseLock = await acquireLeaseLock();
  try {
    const signatures = leases.map((lease) => ({ lease, tail: proxyArguments(config.proxyPath, port, join(config.runtimeDir, lease)) }));
    const listed = ownProcesses();
    let discoveryError = "error" in listed ? listed.error : null;
    const matched: Array<{ pid: number; startToken: string; lease: string }> = [];
    /** Matches one process; false when it is live and its argv cannot be read now. */
    const inspect = (pid: number): boolean => {
      const startToken = readProcessStartToken(pid);
      const argv = startToken === null ? null : readProcessArgv(pid);
      // Gone since the listing proves nothing is there; a live process whose argv cannot be read could be a proxy.
      if (startToken === null || argv === null) return processGone(pid);
      const signature = signatures.find(({ tail }) =>
        argv.length > tail.length && tail.every((value, index) => argv[argv.length - tail.length + index] === value));
      if (signature && readProcessStartToken(pid) === startToken) matched.push({ pid, startToken, lease: signature.lease });
      return true;
    };
    let unread = ("error" in listed ? [] : listed.processes).filter(({ zombie }) => !zombie).map(({ pid }) => pid)
      .filter((pid) => !inspect(pid));
    // A process caught exiting or between exec steps is unreadable for a moment: asked again, briefly, before it is
    // taken to leave the discovery incomplete.
    for (let round = 0; unread.length > 0 && round < 3; round += 1) {
      await delay(100);
      unread = unread.filter((pid) => !inspect(pid));
    }
    if (unread.length > 0) discoveryError ??= `the argv of live process ${unread[0]} could not be read`;
    const stopped: ReviewerEgressReap["stopped"] = [];
    const survived: ReviewerEgressReap["survived"] = [];
    for (const proxy of matched) {
      (await stopExact(proxy.pid, proxy.startToken) ? stopped : survived).push({ pid: proxy.pid, lease: proxy.lease });
    }
    const provenGone = (lease: string): boolean =>
      !survived.some((proxy) => proxy.lease === lease) &&
      (stopped.some((proxy) => proxy.lease === lease) || discoveryError === null);
    const kept: string[] = [];
    for (const lease of leases) {
      if (provenGone(lease)) rmSync(join(config.runtimeDir, lease), { recursive: true, force: true });
      else kept.push(lease);
    }
    let portFree = await portTakesListener(port);
    // A stopped proxy's listening socket closes with its process; give the kernel a moment to show it.
    const deadline = Date.now() + 1_000;
    while (!portFree && stopped.length > 0 && Date.now() < deadline) {
      await delay(25);
      portFree = await portTakesListener(port);
    }
    return {
      port,
      leases,
      discovery: discoveryError === null ? "COMPLETE" : "FAILED",
      ...(discoveryError === null ? {} : { discoveryError }),
      stopped,
      survived,
      kept,
      portFree,
    };
  } finally {
    releaseLock();
  }
};

export type { EgressProbes };
