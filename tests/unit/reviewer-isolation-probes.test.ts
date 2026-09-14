import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { claimReviewerCodexHome, provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";

import { ManualClock } from "../../src/core/clock.ts";
import { CodexCliAdapter, __testing, reviewerEnvironment } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

describe("CP-HI-04 reviewer isolation probes", () => {
  it("runs private Codex bootstrap and resume through the real local egress lease", async () => {
    if (!seatbeltCanApply()) return;
    const root = provisionReviewerCodexHome();
    const fixture = realpathSync(tempDir("acp-private-lease-"));
    const packet = join(fixture, "packet");
    mkdirSync(packet);
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
    const binary = join(packet, "codex-fixture.mjs");
    writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
const root=process.env.CODEX_HOME;
const marker=root+'/synthetic-thread';
if(process.argv.includes('resume')) {
 if(fs.readFileSync(marker,'utf8')!=='private-thread') process.exit(9);
} else fs.writeFileSync(marker,'private-thread');
fs.writeFileSync(root+'/auth.json','synthetic-refresh');
console.log(JSON.stringify({type:'thread.started',thread_id:'private-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'READY'}}));
`, { mode: 0o700 });
    const adapter = new CodexCliAdapter({ clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packet, "capacity.json"), binary, reviewerCodexHome: root,
      reviewerEgress: { profilePath, proxyPath, runtimeDir: join(fixture, "lease"), port,
        providerEndpoints: { gpt: ["api.openai.com"] } } });
    // The denial probe needs a path that actually exists, and with an empty deny list the only
    // candidates are the ambient `~/.claude` and `~/.codex`. Those exist on a developer's machine
    // and on no clean host, so this case attested here and refused on a GitHub runner with
    // "reviewer isolation has no existing transcript path to probe" — green locally, red in CI,
    // for a reason that is not about the code under test. The sibling #360 case below already
    // owns its probe target; this one now does too.
    const producerTranscript = join(fixture, "producer-history.jsonl");
    writeFileSync(producerTranscript, "private producer reasoning");
    const isolation = { packetRoot: packet, denyReadPaths: [producerTranscript],
      emptyEnvironment: true as const,
      network: "provider-only" as const, tools: "none" as const };
    try {
      const handle = await adapter.startSession({ model: "gpt-5.6-sol", effort: "xhigh",
        workdir: packet, purpose: "blind-review", isolation });
      const result = await adapter.invoke({ model: "gpt-5.6-sol", effort: "xhigh", workdir: packet,
        externalSessionId: handle.externalSessionId, prompt: "READY", timeoutMs: 10000,
        readOnly: true, correlationId: "private-lease", isolation });
      expect(result.ok, result.error ?? undefined).toBe(true);
      expect(result.isolationAttested).toBe(true);
      expect(result.egressEvidence?.map((entry) => entry.phase)).toContain("reviewer-invocation");
      expect(result.egressEvidence?.[0]?.probes.deniedEndpoint.statusCode).toBe(403);
      expect(result.egressEvidence?.[0]?.probes.directSocket.every((entry) => entry.blocked)).toBe(true);
      expect(readFileSync(join(root, "auth.json"), "utf8")).toBe("synthetic-refresh");
      await adapter.stopSession(handle);
      expect(existsSync(root)).toBe(true);
    } finally {
      // Awaited production runner reaps the synthetic child and closes its own lease.
      rmSync(dirname(root), { recursive: true, force: true });
    }
  }, 30000);
  it("allows only private-home runtime/refresh writes while native negative boundaries bite", () => {
    if (!seatbeltCanApply()) return;
    const root = provisionReviewerCodexHome();
    const sibling = provisionReviewerCodexHome();
    const packet = realpathSync(tempDir("acp-private-native-packet-"));
    const withheld = realpathSync(tempDir("acp-private-native-withheld-"));
    const targets = [join(dirname(root), "parent-sentinel"), join(sibling, "other-session"),
      join(withheld, "owner-home"), join(withheld, "github-store"), join(withheld, "shared-credentials")];
    for (const target of targets) writeFileSync(target, "synthetic-protected");
    const binding = claimReviewerCodexHome(root);
    const profile = __testing.reviewerProfile(packet, [withheld], process.execPath, [root], [], undefined, binding);
    const script = `
      const fs = require('node:fs');
      const net = require('node:net');
      const {spawnSync} = require('node:child_process');
      const targets = ${JSON.stringify(targets)};
      const result = { reads: [], writes: [], shellDenied: false, networkDenied: false, privateWrite: false };
      for (const target of targets) {
        try { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); result.reads.push(false); }
        catch (e) { result.reads.push(e.code === 'EPERM' || e.code === 'EACCES'); }
        try { fs.writeFileSync(target, 'WRONG'); result.writes.push(false); }
        catch (e) { result.writes.push(e.code === 'EPERM' || e.code === 'EACCES'); }
      }
      fs.realpathSync(${JSON.stringify(root)});
      // The exact ancestor metadata allowance must not grant directory data reads.
      try { fs.readdirSync(${JSON.stringify(dirname(root))}); throw new Error('ancestor data readable'); }
      catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }
      fs.writeFileSync(${JSON.stringify(join(root, "auth.json"))}, 'synthetic-refresh');
      fs.writeFileSync(${JSON.stringify(join(root, "installation_id"))}, 'synthetic-runtime');
      result.privateWrite = true;
      result.shellDenied = !!spawnSync('/bin/sh', ['-c', 'exit 0']).error;
      const socket = net.createConnection({host:'127.0.0.1', port:9});
      socket.on('error', e => { result.networkDenied = e.code === 'EPERM' || e.code === 'EACCES'; console.log(JSON.stringify(result)); });
      socket.setTimeout(1000, () => { socket.destroy(); console.log(JSON.stringify(result)); });
    `;
    try {
      const result = spawnSync("/usr/bin/sandbox-exec", ["-p", `${profile}\n(deny network*)`, process.execPath, "-e", script],
        { cwd: packet, env: { PATH: "/usr/bin:/bin", HOME: packet, CODEX_HOME: root, TMPDIR: packet }, encoding: "utf8", timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ reads: [true,true,true,true,true], writes: [true,true,true,true,true],
        shellDenied: true, networkDenied: true, privateWrite: true });
      for (const target of targets) expect(readFileSync(target, "utf8")).toBe("synthetic-protected");
      expect(readFileSync(join(root, "auth.json"), "utf8")).toBe("synthetic-refresh");
    } finally {
      // Synchronous bounded child has returned; no allowed descendant executable was started.
      rmSync(dirname(root), { recursive: true, force: true });
      rmSync(dirname(sibling), { recursive: true, force: true });
    }
  });
  it("P0-07 fixes the Codex reviewer to GPT-5.6 Sol xhigh and uses only its provider thread id", () => {
    const packetRoot = tempDir("acp-codex-reviewer-contract-");
    const adapter = new CodexCliAdapter({
      clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"),
      binary: "codex-not-invoked-by-contract-test",
    });
    expect(adapter.supportsReviewerIsolation).toBe(true);
    expect(adapter.requiresReviewerProviderSessionProof).toBe(true);
    expect(adapter.supportsReviewerEffortAttestation).toBe(true);

    const bootstrap = __testing.codexReviewerArgs("bootstrap", "gpt-5.6-sol", "xhigh");
    expect(bootstrap).toEqual([
      "exec",
      "--json",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "read-only",
      "-",
    ]);
    expect(__testing.reviewerToolContractPresent(bootstrap)).toBe(true);

    const resume = __testing.codexReviewerArgs(
      "resume",
      "gpt-5.6-sol",
      "xhigh",
      "provider-thread-7b1c",
    );
    expect(resume).toContain("provider-thread-7b1c");
    expect(resume).not.toContain("--ephemeral");
    expect(__testing.reviewerToolContractPresent(resume)).toBe(true);
    expect(__testing.reviewerToolContractPresent(
      resume.filter((value) => value !== 'sandbox_mode="read-only"'),
    )).toBe(false);

    const output = [
      '{"type":"thread.started","thread_id":"provider-thread-7b1c"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"verdict\\":\\"PASS\\"}"}}',
    ].join("\n");
    expect(__testing.codexThreadId(output)).toBe("provider-thread-7b1c");
    expect(__testing.codexLastAgentMessage(output)).toBe('{"verdict":"PASS"}');
    expect(__testing.codexThreadId('{"type":"thread.started","session_id":"local-uuid"}')).toBeNull();
    // Removing the strict model/effort args, the read-only control, or the provider-issued
    // thread event makes this regression fail instead of silently accepting a local id.
  });

  it("#360 actively proves the profile denies producer transcript reads", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const transcript = join(tempDir("acp-review-probe-transcript-"), "cto-history.jsonl");
    const credentialScope = tempDir("acp-review-probe-provider-");
    writeFileSync(transcript, "private producer reasoning");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [transcript],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeDeniedTranscriptPaths(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      [transcript],
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // Removing either the profile's file-read deny or the live probe turns this into a
    // false result instead of a static list assertion.
  });

  it("#360 actively proves a reviewer cannot execute a shell or write outside its packet", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const credentialScope = tempDir("acp-review-probe-provider-");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeNoTools(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // If `(deny process-exec*)`, `(deny file-write*)`, or either active probe disappears,
    // one of the attempted shell/write effects succeeds and this assertion fails.
  });

});
