import { afterAll, expect, it } from "vitest";
import { createConnection } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHermesBootstrapAuthority } from "../../src/bootstrap/hermes-bootstrap.ts";
import { startDaemonOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const request = (path: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const socket = createConnection(path);
  const timer = setTimeout(() => { socket.destroy(); reject(new Error("operator deadline")); }, 10000);
  let data = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(JSON.stringify({ token: "fixture-operator", requestId: "owner-restore", method: "bootstrap.hermes", params }) + "\n"));
  socket.on("error", (e) => { clearTimeout(timer); reject(e); });
  socket.on("data", (part) => { data += part; if (!data.includes("\n")) return; clearTimeout(timer); socket.end(); resolve(JSON.parse(data)); });
});

it.each([
  { name: "non-owner bob", operator: "bob", owners: [{ channel: "cli", actor: "alice" }], restore: true, allowed: false },
  { name: "same actor on wrong owner channel", operator: "alice", owners: [{ channel: "telegram", actor: "alice" }], restore: true, allowed: false },
  { name: "wrong owner actor", operator: "alice", owners: [{ channel: "cli", actor: "bob" }], restore: true, allowed: false },
  { name: "unconfigured owner", operator: "alice", owners: [], restore: true, allowed: false },
  { name: "allowlisted CLI owner", operator: "alice", owners: [{ channel: "cli", actor: "alice" }], restore: true, allowed: true },
  { name: "ordinary first-install operator", operator: "bob", owners: [], restore: false, allowed: true },
])("$name is checked before caller-selected executables run", async ({ operator, owners, restore, allowed }) => {
  const h = makeHarness({ ownerIdentities: owners });
  const dir = tempDir("hb-owner-");
  const marker = join(dir, "spawned");
  const target = join(dir, "target.cjs");
  writeFileSync(target, `#!${process.execPath}\nconst {createHash}=require('node:crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const r=JSON.parse(s);const v={domain:'hermes.target-bind',version:1,actor_id:r.actor_id,binding_generation:r.binding_generation,executor_runtime_identity:r.executor_runtime_identity,requested_session_id:r.session_id,lineage_root_digest:r.expected_lineage_root_digest};const c=JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));process.stdout.write(JSON.stringify({...v,receipt_digest:'sha256:'+createHash('sha256').update(c).digest('hex')}));});`, {mode: 0o700});
  let incumbentActor: unknown;
  if (restore) {
    const old = h.cp.sessions.create({ provider: "hermes", model: "legacy", osPid: 2147483647 });
    h.cp.sessions.transition(old.sessionId, "READY");
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: old.sessionId }).allowed).toBe(true);
    incumbentActor = h.cp.db.get("SELECT actor_id FROM assignments WHERE role_key = 'CEO'");
    h.cp.bindings.revoke("CEO", "fixture dead incumbent");
    h.cp.sessions.transition(old.sessionId, "ERROR");
  }
  const authority = createHermesBootstrapAuthority(h.cp, { stateDir: dir, mcpSocketPath: join(dir, "mcp.sock"), mcpToken: "fixture-mcp", runtimeTimeoutMs: 5000 });
  const listener = await startDaemonOperatorSocket(h.cp, { lock: { held: () => true } as never,
    handleOperatorRequest: async () => deny(ReasonCode.INVALID_ARGUMENT, "unused", {}) }, dir,
    { token: "fixture-operator", peerId: "cli:alice", actor: operator },
    { mcpToken: "fixture-mcp", bootstrapHermes: (params) => authority.bootstrap(params) });
  try {
    const result = await request(listener.socketPath, {
      command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');const net=require('node:net'),c=require('node:crypto'),n='fixture-owner-boundary-nonce';const s=net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET,()=>s.write(JSON.stringify({runtimeNonce:n,runtimeProof:c.createHmac('sha256',process.env.ACP_HERMES_BOOTSTRAP_TOKEN).update(n).digest('hex')})+'\\n'));s.on('data',()=>process.exit(0));`],
      model: "fixture", hermesExecutable: target, hermesProfile: "fixture", hermesHome: dir,
      requestedSessionId: "fixture-session", expectedLineageRootDigest: "sha256:" + "a".repeat(64), executorRuntimeIdentity: "fixture-runtime",
      actor: "alice", channel: "cli", restoreCeo: { actorId: "caller-forgery" },
    });
    expect(result.allowed).toBe(allowed);
    expect(existsSync(marker)).toBe(allowed);
    if (!allowed) {
      expect(result.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
      expect(h.cp.bindings.active("CEO")).toBeNull();
      expect(h.cp.sessions.list()).toHaveLength(1);
      expect(existsSync(join(dir, "hermes.bootstrap.sock"))).toBe(false);
    } else {
      expect(h.cp.bindings.active("CEO")?.bindingGeneration).toBe(restore ? 2 : 1);
      if (restore) expect(h.cp.db.all("SELECT actor_id FROM conversational_actors")).toEqual([incumbentActor]);
    }
  } finally { await listener.close(); await authority.close(); h.cp.close(); }
});
