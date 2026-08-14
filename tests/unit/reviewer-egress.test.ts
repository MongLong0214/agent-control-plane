import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ClaudeCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import type { ReviewerEgressConfig } from "../../src/runtime/provider.ts";
import { acquireReviewerEgress } from "../../src/runtime/reviewer-egress.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

const liveIt = seatbeltCanApply() ? it : it.skip;

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("could not allocate a loopback port"));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const proxyStatus = async (port: number, host: string): Promise<number> => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  let settled = false;
  const finish = (value: number): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(3_000, () => {
    socket.destroy();
    if (!settled) reject(new Error("CONNECT probe timed out"));
  });
  socket.once("connect", () => {
    socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  });
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString("latin1");
    const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(response);
    if (match) finish(Number(match[1]));
  });
  socket.once("error", reject);
});

const reviewerProfile = (port: number): string => [
  "(version 1)",
  "(allow default)",
  "(deny network-outbound (remote tcp))",
  "(deny network-outbound (remote udp))",
  `(allow network-outbound (remote tcp \"localhost:${port}\"))`,
  "(allow network-outbound (remote unix-socket))",
].join("\n");

const fakeProxy = String.raw`#!/usr/bin/env python3
import json
import hashlib
import os
import signal
import socket
import sys
import threading
import time

PORT = int(sys.argv[1])
ALLOW = sys.argv[2]
LOG = sys.argv[3]
PERMIT_NONALLOWLISTED = __PERMIT_NONALLOWLISTED__
DENY_INVALID = __DENY_INVALID__
START_DIGEST_MODE = "__START_DIGEST_MODE__"
EMIT_UNEXPECTED_ALLOW = __EMIT_UNEXPECTED_ALLOW__

def allowed_hosts():
    with open(ALLOW, encoding="utf-8") as source:
        return {line.strip().lower() for line in source if line.strip()}

def log(event):
    with open(LOG, "a", encoding="utf-8") as sink:
        sink.write(json.dumps(event) + "\n")
        sink.flush()

def handle(connection):
    try:
        connection.settimeout(3)
        request = b""
        while b"\r\n\r\n" not in request:
            part = connection.recv(4096)
            if not part:
                return
            request += part
        line = request.split(b"\r\n", 1)[0].decode("latin1")
        fields = line.split()
        target = fields[1] if len(fields) > 1 else ""
        host, _, port = target.rpartition(":")
        permitted = (PERMIT_NONALLOWLISTED or host.lower() in allowed_hosts()) and not (DENY_INVALID and host.lower().endswith(".invalid"))
        if len(fields) >= 2 and fields[0] == "CONNECT" and permitted and port == "443":
            log({"t": time.time(), "verdict": "ALLOW", "host": host, "port": port})
            connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        else:
            log({"t": time.time(), "verdict": "DENY", "host": host, "port": port})
            connection.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
    finally:
        try:
            connection.close()
        except OSError:
            pass

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", PORT))
server.listen(32)

def stop(_signal, _frame):
    server.close()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
allowlist_digest = "sha256:" + hashlib.sha256(open(ALLOW, "rb").read()).hexdigest()
if START_DIGEST_MODE == "wrong":
    allowlist_digest = "sha256:" + ("0" * 64)
log({"t": time.time(), "verdict": "START", "port": PORT, "pid": os.getpid(), "allowlistDigest": allowlist_digest})
if EMIT_UNEXPECTED_ALLOW:
    log({"t": time.time(), "verdict": "ALLOW", "host": "unexpected.example.com", "port": "443"})
while True:
    try:
        connection, _ = server.accept()
    except OSError:
        break
    threading.Thread(target=handle, args=(connection,), daemon=True).start()
`;

interface EgressFixture {
  packetRoot: string;
  credentialDir: string;
  transcript: string;
  binary: string;
  port: number;
  config: ReviewerEgressConfig;
}

const makeFixture = async (
  {
    permitNonAllowlisted = false,
    denyInvalid = false,
    startDigestMode = "correct",
    emitUnexpectedAllow = false,
  }: {
    permitNonAllowlisted?: boolean;
    /** Models the reported open proxy: every real name is allowed, only .invalid is denied. */
    denyInvalid?: boolean;
    /** Lets the START record model a proxy launched with someone else's allowlist. */
    startDigestMode?: "correct" | "wrong";
    /** Ensures runtime evidence validation rejects a proxy's unrelated successful CONNECT. */
    emitUnexpectedAllow?: boolean;
  } = {},
): Promise<EgressFixture> => {
  const root = tempDir("acp-reviewer-egress-");
  const packetRoot = join(root, "packet");
  const runtimeDir = join(root, "runtime");
  const credentialDir = join(root, "reviewer-credentials");
  const transcript = join(root, "producer-transcript.jsonl");
  const port = await freePort();
  const profilePath = join(root, "reviewer.sb");
  const proxyPath = join(root, "allowlist-proxy.py");
  const binary = join(packetRoot, "claude-reviewer-stub.mjs");
  mkdirSync(packetRoot, { recursive: true });
  mkdirSync(credentialDir, { recursive: true });
  writeFileSync(transcript, "producer-private-history");
  writeFileSync(profilePath, reviewerProfile(port));
  writeFileSync(proxyPath, fakeProxy
    .replace("__PERMIT_NONALLOWLISTED__", permitNonAllowlisted ? "True" : "False")
    .replace("__DENY_INVALID__", denyInvalid ? "True" : "False")
    .replace("__START_DIGEST_MODE__", startDigestMode)
    .replace("__EMIT_UNEXPECTED_ALLOW__", emitUnexpectedAllow ? "True" : "False"), { mode: 0o700 });
  chmodSync(proxyPath, 0o700);
  writeFileSync(
    binary,
    `#!${process.execPath}
import net from "node:net";
const proxy = new URL(process.env.HTTPS_PROXY ?? "");
const sessionAt = process.argv.indexOf("--session-id");
const sessionId = sessionAt >= 0 ? process.argv[sessionAt + 1] : null;
const fail = (message) => { process.stderr.write(message); process.exit(9); };
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !proxy.port) fail("missing loopback HTTPS_PROXY");
const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
let reply = "";
socket.setTimeout(3000, () => fail("provider CONNECT timed out"));
socket.once("connect", () => socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n"));
socket.on("data", (chunk) => {
  reply += chunk.toString("latin1");
  if (!reply.includes("\\r\\n\\r\\n")) return;
  socket.destroy();
  if (!/^HTTP\\/1\\.[01] 200/.test(reply)) fail("provider CONNECT was not allowed");
  process.stdout.write(JSON.stringify({ result: JSON.stringify({ verdict: "PASS", coveredFiles: [], omittedItems: [], findings: [] }), session_id: sessionId }));
});
socket.once("error", (error) => fail(error.code ?? "provider CONNECT failed"));
`,
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);
  return {
    packetRoot,
    credentialDir,
    transcript,
    binary,
    port,
    config: {
      profilePath,
      proxyPath,
      runtimeDir,
      port,
      providerEndpoints: {
        claude: ["api.anthropic.com"],
        gpt: ["api.openai.com"],
      },
    },
  };
};

const invokeReviewer = async (fixture: EgressFixture, config = fixture.config) => {
  const adapter = new ClaudeCliAdapter({
    clock: new ManualClock("2026-08-14T00:00:00.000Z"),
    capacityFile: join(fixture.packetRoot, "claude-capacity.json"),
    binary: fixture.binary,
    providerCredentialDir: fixture.credentialDir,
    reviewerEgress: config,
  });
  return adapter.invoke({
    prompt: "Return the packet verdict.",
    workdir: fixture.packetRoot,
    timeoutMs: 10_000,
    model: "opus",
    readOnly: true,
    correlationId: "reviewer-egress-test",
    externalSessionId: "provider-reviewer-session",
    isolation: {
      packetRoot: fixture.packetRoot,
      denyReadPaths: [fixture.transcript],
      emptyEnvironment: true,
      network: "provider-only",
      tools: "none",
    },
  });
};

describe("#419 daemon-owned reviewer egress", () => {
  it("generates a provider-specific allowlist and wraps the reviewer in the owner profile", async () => {
    const fixture = await makeFixture();
    const lease = await acquireReviewerEgress(fixture.config, "claude");
    try {
      expect(lease.allowedEndpoints).toEqual(["api.anthropic.com"]);
      expect(await proxyStatus(lease.port, "api.openai.com")).toBe(403);
      expect(await proxyStatus(lease.port, "api.anthropic.com")).toBe(200);
      const composedProfilePath = join(fixture.packetRoot, "reviewer-composed.sb");
      expect(__testing.composeReviewerProfile(reviewerProfile(fixture.port), "(version 1)\n(allow default)\n(deny file-write*)"))
        .toContain("(deny file-write*)");
      expect(__testing.reviewerSandboxArgs(
        "(inner profile)",
        fixture.binary,
        ["--settings", "packet-settings"],
        lease,
        composedProfilePath,
      )).toEqual([
        "-f",
        composedProfilePath,
        "/usr/bin/env",
        `HTTPS_PROXY=http://127.0.0.1:${fixture.port}`,
        fixture.binary,
        "--settings",
        "packet-settings",
      ]);
      // Removing generated `allowlist.txt` input or the outer `-f` wrapper makes the
      // cross-provider 403 / exact command assertion fail.
    } finally {
      await lease.abandon();
    }
  });

  liveIt("measures allowed, denied, and direct-bypass probes for the reviewer invocation", async () => {
    const fixture = await makeFixture();
    const result = await invokeReviewer(fixture);

    expect(result).toMatchObject({
      ok: true,
      isolationAttested: true,
      isolationReasonCode: undefined,
      providerSessionId: "provider-reviewer-session",
    });
    const record = result.egressEvidence?.[0];
    expect(record).toBeDefined();
    expect(record?.allowedEndpoints).toEqual(["api.anthropic.com"]);
    expect(record?.allowlistDigest).toBe(sha256("api.anthropic.com\n"));
    expect(record?.probes.allowedEndpoint).toMatchObject({
      host: "api.anthropic.com",
      connected: true,
      statusCode: 200,
    });
    expect(record?.probes.deniedEndpoint).toMatchObject({
      host: "api.openai.com",
      denied: true,
      statusCode: 403,
    });
    expect(record?.probes.directSocket).toEqual(expect.arrayContaining([
      expect.objectContaining({ proxyMode: "unset", blocked: true, connected: false }),
      expect.objectContaining({ proxyMode: "override", blocked: true, connected: false }),
    ]));
    expect(record?.jsonl).toContain('"verdict": "ALLOW"');
    expect(record?.jsonl).toContain('"verdict": "DENY"');
    expect(record?.jsonl).toContain('"host": "api.openai.com"');
    // Deleting either kernel network deny, the proxy refusal check, or the direct-socket
    // check prevents attestation and makes these measured assertions fail.
  });

  liveIt("refuses an invocation when its proxy permits the generated non-allowlisted host", async () => {
    const fixture = await makeFixture({ permitNonAllowlisted: true });
    const result = await invokeReviewer(fixture);

    expect(result).toMatchObject({
      ok: false,
      isolationAttested: false,
      isolationReasonCode: ReasonCode.ISOLATION_LOST,
    });
    expect(result.error).toContain("non-allowlisted endpoint probe was not refused");
    // Deleting the non-allowlisted CONNECT status check changes this refusal into a later
    // log failure (or an attestation), so the exact assertion is load-bearing.
  });

  liveIt("#419 regression: refuses an open proxy that only denies .invalid names", async () => {
    const fixture = await makeFixture({ permitNonAllowlisted: true, denyInvalid: true });
    const result = await invokeReviewer(fixture);

    expect(result).toMatchObject({
      ok: false,
      isolationAttested: false,
      isolationReasonCode: ReasonCode.ISOLATION_LOST,
    });
    expect(result.error).toContain("non-allowlisted endpoint probe was not refused");
    // On the pre-fix implementation this fails: its only deny probe is a .invalid name,
    // which this deliberately permissive proxy refuses while allowing every real host.
  });

  liveIt("rejects a proxy JSONL ALLOW outside the generated allowlist", async () => {
    const fixture = await makeFixture({ emitUnexpectedAllow: true });
    const result = await invokeReviewer(fixture);

    expect(result).toMatchObject({
      ok: false,
      isolationAttested: false,
      isolationReasonCode: ReasonCode.ISOLATION_LOST,
    });
    expect(result.error).toContain("proxy JSONL records an ALLOW outside the generated allowlist");
    // Deleting assertMeasuredJsonl's unexpected-ALLOW rejection turns this into a false
    // attestation even though the proxy admitted an unrelated endpoint.
  });

  it("does not finalize a real-host deny probe unless its recorded response is 403", async () => {
    const fixture = await makeFixture();
    const lease = await acquireReviewerEgress(fixture.config, "claude");
    await expect(async () => {
      await expect(proxyStatus(lease.port, "api.anthropic.com")).resolves.toBe(200);
      await expect(proxyStatus(lease.port, "api.openai.com")).resolves.toBe(403);
      await lease.finalise("reviewer-invocation", {
        allowedEndpoint: { host: "api.anthropic.com", connected: true, statusCode: 200 },
        deniedEndpoint: { host: "api.openai.com", denied: true, statusCode: 200 },
        directSocket: [
          { host: "api.anthropic.com", proxyMode: "unset", connected: false, blocked: true, errorCode: "EPERM" },
          { host: "api.anthropic.com", proxyMode: "override", connected: false, blocked: true, errorCode: "EPERM" },
        ],
      });
    }).rejects.toMatchObject({ failureCode: "REVIEWER_EGRESS_LOG_INVALID" });
    // This unit check exercises finalisation only. The attestation probe itself is covered
    // above and runs through runProfileCommand under the composed profile.
  });

  it("refuses a proxy START record that does not bind the generated allowlist bytes", async () => {
    const fixture = await makeFixture({ startDigestMode: "wrong" });
    let lease: Awaited<ReturnType<typeof acquireReviewerEgress>> | undefined;
    let failure: unknown;
    try {
      lease = await acquireReviewerEgress(fixture.config, "claude");
    } catch (error) {
      failure = error;
    } finally {
      await lease?.abandon();
    }

    expect(failure).toMatchObject({ failureCode: "REVIEWER_EGRESS_ALLOWLIST_UNBOUND" });
    // Deleting waitForStart's digest comparison lets this proxy lease start, so this exact
    // unbound-digest assertion is the binding regression.
  });

  it("fails closed with a distinct reason for missing or unavailable egress infrastructure", async () => {
    const fixture = await makeFixture();
    const deadProxy = join(fixture.packetRoot, "dead-proxy.py");
    writeFileSync(deadProxy, "raise SystemExit(7)\n", { mode: 0o700 });

    for (const [name, config, code] of [
      ["profile", { ...fixture.config, profilePath: join(fixture.packetRoot, "missing-reviewer.sb") }, "REVIEWER_EGRESS_PROFILE_MISSING"],
      ["proxy", { ...fixture.config, proxyPath: join(fixture.packetRoot, "missing-proxy.py") }, "REVIEWER_EGRESS_PROXY_MISSING"],
      ["listener", { ...fixture.config, proxyPath: deadProxy }, "REVIEWER_EGRESS_PROXY_UNREACHABLE"],
    ] as const) {
      const result = await invokeReviewer(fixture, config);
      expect(result, name).toMatchObject({
        ok: false,
        isolationAttested: false,
        isolationReasonCode: ReasonCode.ISOLATION_LOST,
      });
      expect(result.error, name).toContain(code);
    }
    // Replacing the egress setup failures with an allow-default fallback makes each
    // ISOLATION_LOST/code assertion fail.
  });

  it("invalidates a lease as soon as its supervised proxy dies", async () => {
    const fixture = await makeFixture();
    const dyingProxy = join(fixture.packetRoot, "dying-proxy.py");
    writeFileSync(dyingProxy, String.raw`import hashlib, json, os, sys, time
port = int(sys.argv[1])
with open(sys.argv[3], "a", encoding="utf-8") as log:
    digest = "sha256:" + hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
    log.write(json.dumps({"t": time.time(), "verdict": "START", "port": port, "pid": os.getpid(), "allowlistDigest": digest}) + "\n")
    log.flush()
time.sleep(0.05)
`, { mode: 0o700 });
    const lease = await acquireReviewerEgress({ ...fixture.config, proxyPath: dyingProxy }, "claude");
    let deathObserved = false;
    lease.onDeath(() => { deathObserved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    expect(lease.died()).toBe(true);
    expect(deathObserved).toBe(true);
    await expect(lease.finalise("reviewer-invocation", {
      allowedEndpoint: { host: "api.anthropic.com" },
      deniedEndpoint: { host: "denied.provider.test" },
      directSocket: [],
    })).rejects.toMatchObject({ failureCode: "REVIEWER_EGRESS_PROXY_DIED" });
    // Removing the process exit listener leaves the lease apparently healthy and this
    // death/finalisation assertion fails instead of silently reusing a dead boundary.
  });

  it("refuses credential-shaped content before proxy JSONL can become evidence", async () => {
    const fixture = await makeFixture();
    const credentialProxy = join(fixture.packetRoot, "credential-proxy.py");
    writeFileSync(credentialProxy, String.raw`import hashlib, json, os, sys, time
port = int(sys.argv[1])
with open(sys.argv[3], "a", encoding="utf-8") as log:
    digest = "sha256:" + hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
    log.write(json.dumps({"t": time.time(), "verdict": "START", "port": port, "pid": os.getpid(), "allowlistDigest": digest}) + "\n")
    log.write(json.dumps({"t": time.time(), "verdict": "ERROR", "error": "sk-123456789012345678901234"}) + "\n")
    log.flush()
while True:
    time.sleep(1)
`, { mode: 0o700 });
    const lease = await acquireReviewerEgress({ ...fixture.config, proxyPath: credentialProxy }, "claude");
    await expect(lease.finalise("reviewer-invocation", {
      allowedEndpoint: { host: "api.anthropic.com" },
      deniedEndpoint: { host: "denied.provider.test" },
      directSocket: [],
    })).rejects.toMatchObject({ failureCode: "REVIEWER_EGRESS_LOG_CREDENTIAL_BEARING" });
    // Removing the pre-persistence credential scan lets this raw token-shaped JSONL pass
    // into evidence, so this refusal is deliberately before record construction.
  });
});
