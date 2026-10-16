import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { acpScratchDir } from "../../src/core/scratch-root.ts";
import { CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { ProviderSessionProvisionError } from "../../src/runtime/provider.ts";
import {
  PacketReviewerScopeUnconfigured,
  packetReviewerScope,
  provisionReviewerCodexHome,
} from "../../src/runtime/reviewer-codex-home.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { TestProductionAdapter, testReviewerEgressEvidence } from "../helpers/production-adapter.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * The packet reviewer's Codex home (owner directive and CEO 1792123922, 2026-10-16).
 *
 * With no `ACP_REVIEWER_CODEX_HOME` override, the Codex packet reviewer reuses this user's own,
 * already-authenticated Codex home: no claim, no login per review, and the home's existing files are
 * left as they were. An override keeps the capsule rules and refuses on any fault. `UNCONFIGURED` —
 * no override and no `auth.json` in the default home — is decided by one exported predicate that the
 * doctor and the reviewer both run, and it is the only state the gate may route around. Every fixture
 * home here is a temporary directory; the real `~/.codex` is never named.
 */

afterAll(cleanupTempDirs);
afterEach(() => __testing.setRunCli(null));

const ORIGINAL = { home: process.env["HOME"], override: process.env["ACP_REVIEWER_CODEX_HOME"] };
const restoreEnvironment = (): void => {
  if (ORIGINAL.home === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL.home;
  if (ORIGINAL.override === undefined) delete process.env["ACP_REVIEWER_CODEX_HOME"];
  else process.env["ACP_REVIEWER_CODEX_HOME"] = ORIGINAL.override;
};
beforeEach(() => { delete process.env["ACP_REVIEWER_CODEX_HOME"]; });
afterEach(restoreEnvironment);

const capsules: string[] = [];
afterAll(() => { for (const root of capsules) rmSync(dirname(root), { recursive: true, force: true }); });
const capsule = (parts: { claimed?: boolean; auth?: boolean; mode?: number } = {}): string => {
  const root = provisionReviewerCodexHome();
  capsules.push(root);
  if (parts.claimed) mkdirSync(join(dirname(root), "claimed"), { mode: 0o700 });
  if (parts.auth) writeFileSync(join(root, "auth.json"), "{}", { mode: 0o600 });
  if (parts.mode !== undefined) chmodSync(root, parts.mode);
  return root;
};

/** A fixture user whose `~/.codex` is shaped as `codex login` leaves one, or as asked. */
const fixtureUser = (shape: "authenticated" | "missing" | "no-auth" | "auth-not-a-file", parent = tempDir("acp-prs-user-")) => {
  const home = join(parent, ".codex");
  if (shape !== "missing") mkdirSync(home, { mode: 0o700 });
  if (shape === "authenticated") {
    writeFileSync(join(home, "auth.json"), '{"synthetic":"credential"}', { mode: 0o600 });
    writeFileSync(join(home, "config.toml"), 'model = "the user\'s own choice"\n');
    writeFileSync(join(home, "history.jsonl"), '{"text":"the user\'s own history"}\n');
  }
  if (shape === "auth-not-a-file") mkdirSync(join(home, "auth.json"));
  return { user: parent, home };
};

/** Every file the home held before a review, by relative path and content; new thread files are not in it. */
const filesOf = (root: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(root, { recursive: true }) as string[])
      .filter((path) => !path.startsWith("sessions") && statSync(join(root, path)).isFile())
      .map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );

const isolationFor = (packetRoot: string, denyReadPaths: string[] = []) => ({
  packetRoot,
  denyReadPaths,
  emptyEnvironment: true as const,
  network: "provider-only" as const,
  tools: "none" as const,
});

type RunCliCall = { args: string[]; codexHome: string | undefined; shared: string | undefined; privateRoot: string | undefined };

/** runCli stubbed at the boundary: every call is recorded, and the reply is a well-formed Codex thread. */
const stubCodex = (reply: { exitCode?: number; stderr?: string; timedOut?: boolean } = {}): RunCliCall[] => {
  const calls: RunCliCall[] = [];
  let threads = 0;
  __testing.setRunCli(async (_file, args, options) => {
    const resume = args.includes("resume");
    const thread = resume ? String(args.at(-2)) : `shared-home-thread-${++threads}`;
    calls.push({
      args: [...args],
      codexHome: options.reviewerEnvironment?.CODEX_HOME,
      shared: (options as { reviewerSharedHome?: string }).reviewerSharedHome,
      privateRoot: (options as { reviewerPrivateHome?: { root: string } }).reviewerPrivateHome?.root,
    });
    return {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: thread }),
        JSON.stringify({ item: { type: "agent_message", text: resume ? '{"verdict":"PASS"}' : "READY" } }),
      ].join("\n"),
      stderr: reply.stderr ?? "",
      exitCode: reply.exitCode ?? 0,
      timedOut: reply.timedOut ?? false,
      isolationEnforced: true,
      egressEvidence: testReviewerEgressEvidence("gpt"),
    };
  });
  return calls;
};

const adapterFor = (options: { codexHome?: string; reviewerCodexHome?: string } = {}) =>
  new CodexCliAdapter({
    clock: new ManualClock("2026-10-16T00:00:00.000Z"),
    capacityFile: join(tempDir("acp-prs-capacity-"), "gpt.json"),
    binary: process.execPath,
    ...options,
  });

const reviewOnce = async (adapter: CodexCliAdapter, label: string) => {
  const packetRoot = tempDir(`acp-prs-packet-${label}-`);
  const spec = { model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot, purpose: "blind-review", isolation: isolationFor(packetRoot) };
  const handle = await adapter.startSession(spec);
  const result = await adapter.invoke({
    ...spec,
    prompt: "review",
    timeoutMs: 5_000,
    readOnly: true,
    correlationId: `prs-${label}`,
    externalSessionId: handle.externalSessionId,
  });
  await adapter.stopSession(handle);
  return result;
};

const doctorScopeState = async (): Promise<string | null> => {
  const findings = (await makeHarness().cp.doctor.run("system")).findings
    .filter((finding) => finding.code === ReasonCode.PACKET_REVIEWER_SCOPE_UNAVAILABLE);
  return findings.length === 0 ? null : String((findings[0]!.observedEvidence as { state?: unknown }).state);
};

describe("one predicate decides UNCONFIGURED, for the doctor and the reviewer alike", () => {
  it("answers the pinned state for each home, and the doctor and the Codex reviewer agree on every one", async () => {
    const rows: Array<{ name: string; shape: Parameters<typeof fixtureUser>[0]; override?: string; state: string }> = [
      { name: "no Codex home at all", shape: "missing", state: "UNCONFIGURED" },
      { name: "a home that was never logged in", shape: "no-auth", state: "UNCONFIGURED" },
      { name: "an empty override is no override", shape: "missing", override: "", state: "UNCONFIGURED" },
      { name: "the user's authenticated home", shape: "authenticated", state: "DEFAULT" },
      { name: "an auth.json that is not a file", shape: "auth-not-a-file", state: "UNUSABLE" },
      { name: "a set override, even a broken one, over an authenticated home", shape: "authenticated", override: "/nonexistent/acp-override/home", state: "OVERRIDE" },
    ];
    for (const row of rows) {
      const { user, home } = fixtureUser(row.shape);
      // HOME is the fixture user's, so the doctor's and the adapter's default home are both
      // `defaultCodexHome()` read the same way — neither is handed a path the other is not.
      process.env["HOME"] = user;
      if (row.override === undefined) delete process.env["ACP_REVIEWER_CODEX_HOME"];
      else process.env["ACP_REVIEWER_CODEX_HOME"] = row.override;

      expect(packetReviewerScope(row.override, home).state, row.name).toBe(row.state);
      const adapter = adapterFor({ ...(row.override === undefined ? {} : { reviewerCodexHome: row.override }) });
      expect(adapter.packetReviewerScope(), row.name).toEqual({ state: row.state, root: row.override || home });

      const calls = stubCodex();
      const packetRoot = tempDir("acp-prs-agree-");
      const started = await adapter.startSession({
        model: "gpt-6.1-sol", workdir: packetRoot, purpose: "blind-review", isolation: isolationFor(packetRoot),
      }).then(() => null, (error: unknown) => error);
      const reviewerSaysUnconfigured = started instanceof PacketReviewerScopeUnconfigured;
      const doctorState = await doctorScopeState();

      expect(reviewerSaysUnconfigured, row.name).toBe(row.state === "UNCONFIGURED");
      expect(doctorState === "UNCONFIGURED", row.name).toBe(reviewerSaysUnconfigured);
      if (row.state === "DEFAULT") {
        expect(started, row.name).toBeNull();
        expect(doctorState, `${row.name}: READY says nothing`).toBeNull();
      } else {
        expect(started, row.name).toBeInstanceOf(ProviderSessionProvisionError);
        expect(doctorState, row.name).not.toBeNull();
      }
      if (row.state === "UNUSABLE") expect(doctorState).toBe("UNUSABLE_DEFAULT_HOME");
      // Nothing that refuses spawned anything, and an override never ran under the default home.
      if (row.state !== "DEFAULT") expect(calls, row.name).toEqual([]);
      restoreEnvironment();
    }
  });
});

describe("the default home: reused, never claimed, left as it was", () => {
  it("runs two successive reviews under the same home, writes no claim marker, and leaves its files untouched", async () => {
    const { home } = fixtureUser("authenticated");
    const before = filesOf(home);
    const calls = stubCodex();
    const adapter = adapterFor({ codexHome: home });

    const first = await reviewOnce(adapter, "first");
    const second = await reviewOnce(adapter, "second");

    expect(first.ok, first.error ?? undefined).toBe(true);
    expect(second.ok, second.error ?? undefined).toBe(true);
    expect(first.isolationAttested && second.isolationAttested).toBe(true);
    // Two handshakes and two resumes, each under the user's own home and no capsule.
    expect(calls.map((call) => call.args.includes("resume") ? "resume" : "bootstrap"))
      .toEqual(["bootstrap", "resume", "bootstrap", "resume"]);
    for (const call of calls) {
      expect(call.codexHome).toBe(realpathSync(home));
      expect(call.shared).toBe(realpathSync(home));
      expect(call.privateRoot).toBeUndefined();
    }
    expect(existsSync(join(home, "claimed"))).toBe(false);
    expect(existsSync(join(dirname(home), "claimed"))).toBe(false);
    expect(filesOf(home)).toEqual(before);
  });

  it("an override takes precedence over a usable default home, and every override fault refuses without touching it", async () => {
    const { home } = fixtureUser("authenticated");
    const overrides: Array<{ name: string; root: string }> = [
      { name: "a path that is not a capsule", root: join(tempDir("acp-prs-not-a-capsule-"), "home") },
      { name: "a capsule with the wrong mode", root: capsule({ auth: true, mode: 0o755 }) },
      { name: "an already claimed capsule", root: capsule({ auth: true, claimed: true }) },
    ];
    for (const override of overrides) {
      const calls = stubCodex();
      const result = await reviewOnce(adapterFor({ codexHome: home, reviewerCodexHome: override.root }), "override")
        .then(() => null, (error: unknown) => error);
      expect(result, override.name).toBeInstanceOf(ProviderSessionProvisionError);
      expect(result, override.name).not.toBeInstanceOf(PacketReviewerScopeUnconfigured);
      expect(calls, override.name).toEqual([]);
    }

    // A capsule the claim accepts runs under that capsule, never the default home, and is spent.
    const good = capsule({ auth: true });
    const calls = stubCodex();
    const ran = await reviewOnce(adapterFor({ codexHome: home, reviewerCodexHome: good }), "capsule");
    expect(ran.ok, ran.error ?? undefined).toBe(true);
    expect(calls.map((call) => [call.codexHome, call.privateRoot, call.shared]))
      .toEqual([[good, good, undefined], [good, good, undefined]]);
    expect(existsSync(join(dirname(good), "claimed"))).toBe(true);
    // An unauthenticated capsule is claimed and then fails at its handshake: a refusal, not UNCONFIGURED.
    const unauthenticated = capsule({});
    stubCodex({ exitCode: 1, stderr: "Not logged in" });
    const refused = await reviewOnce(adapterFor({ codexHome: home, reviewerCodexHome: unauthenticated }), "unauthenticated")
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderSessionProvisionError);
    expect(refused).not.toBeInstanceOf(PacketReviewerScopeUnconfigured);
  });

  it("an auth failure under the default home is a refusal, never UNCONFIGURED", async () => {
    const { home } = fixtureUser("authenticated");
    for (const reply of [{ exitCode: 1, stderr: "401 Unauthorized: refresh token expired" }, { timedOut: true }]) {
      stubCodex(reply);
      const refused = await reviewOnce(adapterFor({ codexHome: home }), "auth")
        .then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(ProviderSessionProvisionError);
      expect(refused).not.toBeInstanceOf(PacketReviewerScopeUnconfigured);
    }
    expect(packetReviewerScope(undefined, home).state).toBe("DEFAULT");
  });

  it("under the real seatbelt profile, Codex reads and writes its home while the packet, withheld paths and egress hold", async (ctx) => {
    requireSeatbelt(ctx);
    // Outside the per-user temp directory on purpose: the reviewer profile already grants writes
    // there, and a home inside it would pass for reasons that are not the reopening under test.
    const user = acpScratchDir("acp-prs-seatbelt-user-");
    const { home } = fixtureUser("authenticated", user);
    // The no-tools probe aims its escape write at the user's daemon state directory, as on a host.
    mkdirSync(join(user, ".agent-control-plane"), { mode: 0o700 });
    const claude = join(user, ".claude");
    mkdirSync(claude);
    writeFileSync(join(claude, "producer.jsonl"), "producer conversation");
    const checkout = join(user, "candidate-checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "app.js"), "module.exports = 1;\n");
    const before = filesOf(home);
    const fixture = acpScratchDir("acp-prs-seatbelt-lease-");
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("no test port"));
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    const profilePath = join(fixture, "owner.sb");
    const proxyPath = join(fixture, "proxy.py");
    writeFileSync(profilePath, `(version 1)\n(allow default)\n(deny network-outbound (remote tcp))\n(deny network-outbound (remote udp))\n(allow network-outbound (remote tcp "localhost:${port}"))\n(allow network-outbound (remote unix-socket))`);
    // Local protocol fixture only: it never opens an upstream connection or reads credentials.
    writeFileSync(proxyPath, `#!/usr/bin/env python3
import hashlib,json,os,signal,socket,sys,time
port=int(sys.argv[1]); allow=sys.argv[2]; logpath=sys.argv[3]
data=open(allow,'rb').read(); hosts=set(data.decode().splitlines())
def log(row):
 with open(logpath,'a') as out: out.write(json.dumps(dict(t=time.time(),**row))+'\\n')
server=socket.socket(); server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); server.bind(('127.0.0.1',port)); server.listen(32)
def stop(*_):
 server.close(); sys.exit(0)
signal.signal(signal.SIGTERM,stop)
log(dict(verdict='START',port=port,pid=os.getpid(),allowlistDigest='sha256:'+hashlib.sha256(data).hexdigest()))
while True:
 conn,_=server.accept(); conn.settimeout(3)
 try:
  request=b''
  while b'\\r\\n\\r\\n' not in request:
   part=conn.recv(4096)
   if not part: break
   request+=part
  fields=request.split(b'\\r\\n')[0].decode().split()
  if len(fields)<2: continue
  host,_,targetport=fields[1].rpartition(':'); permitted=fields[0]=='CONNECT' and host in hosts and targetport=='443'
  log(dict(verdict='ALLOW' if permitted else 'DENY',host=host,port=targetport))
  conn.sendall(b'HTTP/1.1 200 Connection Established\\r\\n\\r\\n' if permitted else b'HTTP/1.1 403 Forbidden\\r\\n\\r\\n')
 finally: conn.close()
`, { mode: 0o700 });
    // A synthetic Codex: it does what the real CLI does with its home — reads the login and config,
    // writes a thread file, resumes from it — and reports what else it could reach.
    const binary = join(fixture, "codex-fixture.mjs");
    writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const home = process.env.CODEX_HOME;
fs.readFileSync(home + '/auth.json'); fs.readFileSync(home + '/config.toml');
fs.mkdirSync(home + '/sessions', { recursive: true });
const resume = process.argv.includes('resume');
const thread = resume ? process.argv.at(-2) : 'shared-' + randomUUID();
const rollout = home + '/sessions/' + thread + '.jsonl';
if (resume) { if (!fs.existsSync(rollout)) process.exit(9); fs.appendFileSync(rollout, 'resume\\n'); }
else fs.writeFileSync(rollout, 'start\\n');
const denied = (fn) => { try { fn(); return false; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; } };
const reach = {
  producerRead: denied(() => fs.readFileSync(${JSON.stringify(join(claude, "producer.jsonl"))})),
  checkoutRead: denied(() => fs.readFileSync(${JSON.stringify(join(checkout, "app.js"))})),
  checkoutWrite: denied(() => fs.writeFileSync(${JSON.stringify(join(checkout, "app.js"))}, 'WRONG')),
};
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'PASS', reach }) } }));
`, { mode: 0o700 });
    process.env["HOME"] = user;
    try {
      // The production shape: the user's home is also a host transcript root the gate asks to deny.
      const runReview = async (label: string) => {
        const packetRoot = realpathSync(tempDir(`acp-prs-seatbelt-packet-${label}-`));
        const isolation = isolationFor(packetRoot, [realpathSync(home), realpathSync(claude), realpathSync(checkout)]);
        const proxied = new CodexCliAdapter({
          clock: new ManualClock("2026-10-16T00:00:00.000Z"),
          capacityFile: join(fixture, "capacity.json"),
          binary,
          codexHome: home,
          reviewerEgress: { profilePath, proxyPath, runtimeDir: join(fixture, `lease-${label}`), port,
            providerEndpoints: { gpt: ["api.openai.com"] } },
        });
        const handle = await proxied.startSession({ model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot,
          purpose: "blind-review", isolation });
        const result = await proxied.invoke({ model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot,
          externalSessionId: handle.externalSessionId, prompt: "review", timeoutMs: 10_000, readOnly: true,
          correlationId: `prs-seatbelt-${label}`, isolation });
        await proxied.stopSession(handle);
        return result;
      };
      for (const label of ["first", "second"]) {
        const result = await runReview(label);
        expect(result.ok, result.error ?? undefined).toBe(true);
        expect(result.isolationAttested).toBe(true);
        expect(result.egressEvidence?.[0]?.probes.deniedEndpoint.statusCode).toBe(403);
        expect(result.egressEvidence?.[0]?.probes.directSocket.every((entry) => entry.blocked)).toBe(true);
        expect((result.json as { reach?: unknown }).reach).toEqual({ producerRead: true, checkoutRead: true, checkoutWrite: true });
      }
      const rollouts = readdirSync(join(home, "sessions"));
      expect(rollouts).toHaveLength(2);
      for (const rollout of rollouts) expect(readFileSync(join(home, "sessions", rollout), "utf8")).toBe("start\nresume\n");
      expect(filesOf(home)).toEqual(before);
      expect(readFileSync(join(checkout, "app.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(existsSync(join(dirname(home), "claimed"))).toBe(false);
    } finally {
      restoreEnvironment();
      rmSync(user, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the GPT sol pins are gpt-6.1-sol", () => {
  it("names gpt-6.1-sol for the Codex reviewer, CEO and CTO defaults and the control plane's preferred reviewer", () => {
    expect(adapterFor().defaultModels).toEqual({
      reviewer: "gpt-6.1-sol",
      ceo: "gpt-6.1-sol",
      worker: "gpt-5.6-luna-max",
      cto: "gpt-6.1-sol",
    });
    const root = tempDir("acp-prs-defaults-");
    const clock = new ManualClock("2026-10-16T00:00:00.000Z");
    const cp = new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock,
      adapters: [new TestProductionAdapter(clock)],
      allowNonProductionAdapters: true,
    });
    try {
      expect(cp.review["preferences"]).toEqual({
        preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" },
        fallbacks: [{ provider: "claude", model: "opus", effort: null }],
      });
    } finally {
      cp.close();
    }
  });
});
