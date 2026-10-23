import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ResidentProjectProvisioning } from "../../src/bootstrap/resident-project-provisioning.ts";
import { RunKind } from "../../src/domain/types.ts";
import { git } from "../../src/git/git.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner, ProjectAllocation } from "../../src/runtime/host-project-provisioner.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R1-03 — the host's checkout readback must be Git's own HEAD and branch, not the allocated
 * SHA echoed back after a commit-exists check. Activation requires the clone attached to dev, clean,
 * exactly at the approved genesis head, and never resets it; fleet recovery (`ensure-resident`, long
 * after bootstrap) accepts later development built on that head, and never a dirty or detached one.
 * Real Git; only GitHub's identity lookup, Claude, tmux, ps and lsof are doubles.
 */
const script = fileURLToPath(new URL("../../scripts/host-project-provisioner.mjs", import.meta.url));
const commit = async (repo: string, file: string, message: string): Promise<string> => {
  writeFileSync(join(repo, file), message);
  await git(repo, ["add", file]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
};
const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.HOME, cmd = path.basename(process.argv[1]), args = process.argv.slice(2), stateFile = path.join(root,'fake.json');
const a = JSON.parse(fs.readFileSync(path.join(root,'allocation.json'),'utf8'));
const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : {};
const out = x => process.stdout.write(x);
if (cmd === 'gh') out('R_node');
else if (cmd === 'claude') { if (args[1] === 'add') s.mcp = true; else if (args[1] === 'get') { if (!s.mcp) process.exit(1); out('acp-cto agentctl attach resident-cto --claimed-session-id '+a.sessionUuid+' --project-id test'); } }
else if (cmd === 'tmux') {
  if (args[0] === 'has-session') process.exit(s.launched ? 0 : 1);
  if (args[0] === 'new-session') { s.launched = true; fs.mkdirSync(path.join(root,'.claude','sessions'),{recursive:true}); fs.writeFileSync(path.join(root,'.claude','sessions',process.env.TEST_CLAUDE_PID+'.json'),JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:'bridge'})); }
  else if (args[0] === 'display-message') { if (!s.launched) process.exit(1); out('999999'); }
}
else if (cmd === 'ps') { if (s.launched) { if (args.includes('command=')) out('claude --session-id '+a.sessionUuid); else out(process.env.TEST_CLAUDE_PID+' 999999 Thu Oct 22 01:00:00 2026 claude --session-id '+a.sessionUuid+'\\n999999 1 Thu Oct 22 01:00:00 2026 tmux'); } }
else if (cmd === 'lsof') out('n'+a.clonePath+'\\n');
else process.exit(2);
fs.writeFileSync(stateFile,JSON.stringify(s));
`;

async function host() {
  const home = realpathSync(tempDir("v52-checkout-home-"));
  const state = join(home, "acp");
  const bin = join(home, "bin");
  const clone = join(home, "projects", "fixture");
  mkdirSync(bin);
  mkdirSync(clone, { recursive: true });
  for (const cmd of ["gh", "claude", "tmux", "ps", "lsof"]) writeFileSync(join(bin, cmd), fake, { mode: 0o700 });
  mkdirSync(join(home, ".claude", "scripts"), { recursive: true });
  writeFileSync(join(home, ".claude", "scripts", "claude-trust-dir.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  mkdirSync(join(home, ".hermes", "bridge", "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".hermes", "bridge", "keys", "cto-test.priv"), "11".repeat(32) + "\n", { mode: 0o600 });
  await git(clone, ["init", "-q", "-b", "dev"]);
  const autoInit = await commit(clone, "README.md", "autoInit");
  const genesis = await commit(clone, "test.js", "genesis");
  await git(clone, ["remote", "add", "origin", "https://github.com/acme/fixture.git"]);
  const a: ProjectAllocation = {
    projectId: "test", runId: "run_test", repositoryIdentity: "github:acme/fixture", repositoryNodeId: "R_node", head: genesis,
    sessionUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", clonePath: clone,
    tmuxName: "acp-74657374", socketPath: join(state, "cc-session-test.sock"), fleetName: "acp-test", identityName: "cto-test",
    privateKeyFile: join(home, ".hermes", "bridge", "keys", "cto-test.priv"), bootPacket: join(home, ".claude", "watchers", "fleet", "acp-test.boot.txt"), nonce: "nonce",
  };
  writeFileSync(join(home, "allocation.json"), JSON.stringify(a));
  const invoke = (operation: HostOperation) =>
    new Promise<HostObservation>((resolve, reject) => {
      const child = execFile(process.execPath, [script], {
        env: { ...process.env, HOME: home, ACP_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, TEST_CLAUDE_PID: String(process.pid) },
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (x) => (stdout += String(x)));
      child.stderr!.on("data", (x) => (stderr += String(x)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout) as HostObservation) : reject(new Error(`${operation}: ${stderr}`))));
      child.stdin!.end(JSON.stringify({ version: 1, operation, allocation: a, packet: { bytes: "approved" } }));
    });
  const head = async () => (await git(clone, ["rev-parse", "HEAD"])).stdout.trim();
  return { clone, autoInit, genesis, invoke, head };
}

describe("V52-R1-03 the host reports Git's own HEAD, and activation requires the approved checkout", () => {
  it("a detached dirty checkout fails the readback in every operation, and keeps its edits and HEAD", async () => {
    const h = await host();
    await git(h.clone, ["checkout", "-q", "--detach", h.autoInit]);
    writeFileSync(join(h.clone, "dirty.txt"), "keep edits");
    await expect(h.invoke("ensure-checkout")).rejects.toThrow("detached");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("detached");
    await expect(h.invoke("observe")).rejects.toThrow("detached");
    expect(readFileSync(join(h.clone, "dirty.txt"), "utf8")).toBe("keep edits");
    expect(await h.head()).toBe(h.autoInit);
  });

  it("a clean dev at the earlier autoInit commit fails the readback and is not moved", async () => {
    const h = await host();
    await git(h.clone, ["reset", "-q", "--hard", h.autoInit]);
    await expect(h.invoke("ensure-checkout")).rejects.toThrow("not on dev at the approved genesis head");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    expect(await h.head()).toBe(h.autoInit);
  });

  it("a clean dev at the approved head passes, and the readback is Git's HEAD", async () => {
    const h = await host();
    const observed = await h.invoke("ensure-checkout");
    expect(observed.checkout?.head).toBe(h.genesis);
    expect(observed.checkout?.head).toBe(await h.head());
    const launched = await h.invoke("ensure-resident");
    expect(launched.checkout?.head).toBe(h.genesis);
    expect((await h.invoke("observe")).checkout?.head).toBe(h.genesis);
  });

  it("fleet recovery accepts later development on dev or a feature branch, never a dirty, detached or unrelated one", async () => {
    const h = await host();
    await h.invoke("ensure-checkout");
    const later = await commit(h.clone, "feature.js", "later work on dev");
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(later);
    // The bootstrap requirement stays activation's: a later head is not the approved genesis.
    await expect(h.invoke("observe")).rejects.toThrow("not on dev at the approved genesis head");
    await git(h.clone, ["checkout", "-q", "-b", "feature/next"]);
    const feature = await commit(h.clone, "next.js", "feature work");
    expect((await h.invoke("ensure-resident")).checkout?.head).toBe(feature);
    writeFileSync(join(h.clone, "next.js"), "uncommitted");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("uncommitted changes");
    await git(h.clone, ["checkout", "-q", "--", "next.js"]);
    await git(h.clone, ["checkout", "-q", "--orphan", "unrelated"]);
    await commit(h.clone, "other.js", "unrelated history");
    await expect(h.invoke("ensure-resident")).rejects.toThrow("does not build on the approved genesis head");
    expect(existsSync(join(h.clone, "other.js"))).toBe(true);
  });
});

const contract = { goal: "bootstrap", why: "owner request", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };
describe("V52-R1-03 activation compares the reported HEAD with the approved genesis head", () => {
  it.each(["ensure-checkout", "ensure-resident", "observe"] as const)("refuses activation when %s reports another head", async (step) => {
    const h = makeHarness();
    const host: HostProjectProvisioner = {
      async invoke(op: HostOperation, a: ProjectAllocation): Promise<HostObservation> {
        const checkout = { path: a.clonePath, origin: "https://github.com/acme/fixture.git", head: op === step ? "e".repeat(40) : a.head, repositoryNodeId: a.repositoryNodeId };
        if (op === "ensure-checkout") return { checkout };
        if (op === "ensure-buzz") return { buzz: { pubkey: "a".repeat(64), roomId: a.roomId, rosterVerified: true, nonceEventId: "b".repeat(64), nonceReadable: true } };
        if (op === "ensure-routing") return { routing: { generation: 1, roomId: a.roomId } };
        return { checkout, resident: { pid: 12345, startedAt: "start", cwd: a.clonePath, sessionUuid: a.sessionUuid, tmuxName: a.tmuxName, tmuxAncestry: true, bridgeSessionId: "rc" } };
      },
    };
    const run = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
    if (!run.allowed) throw new Error(run.message);
    h.cp.projects.register({ projectId: "resident", name: "resident" });
    const service = new ResidentProjectProvisioning(h.cp.db, h.clock, host, join(h.root, "home"), h.root);
    service.attachSubscriber(async () => false);
    service.remember({ runId: run.value.runId, candidateSnapshotDigest: "candidate", ceoSessionId: "ceo" }, "resident", {});
    await expect(service.ensure({ runId: run.value.runId, projectId: "resident", repositoryIdentity: "github:acme/fixture", repositoryNodeId: "R_node", head: "f".repeat(40), packet: {} })).rejects.toThrow();
    expect(service.evidence(run.value.runId)).toBeNull();
    h.cp.close();
  });
});
