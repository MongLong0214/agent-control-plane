import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../src/git/git.ts";
import type { HostObservation, HostOperation, ProjectAllocation } from "../../src/runtime/host-project-provisioner.ts";
import { tempDir } from "./fixtures.ts";

/**
 * The resident host provisioner (`scripts/host-project-provisioner.mjs`, run from source) against a real
 * Git clone in a temp HOME. Only GitHub's identity lookup, Claude, tmux, ps and lsof are doubles; the
 * double's resident is "launched" until `killResident()`.
 */
export const hostScript = fileURLToPath(new URL("../../scripts/host-project-provisioner.mjs", import.meta.url));
export const commit = async (repo: string, file: string, message: string): Promise<string> => {
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

/** A temp HOME holding a real Git clone at the approved genesis head, and the host script run against it. */
export async function residentGitHost() {
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
  const invoke = (operation: HostOperation, allocation: ProjectAllocation = a) =>
    new Promise<HostObservation>((resolve, reject) => {
      const child = execFile(process.execPath, [hostScript], {
        env: { ...process.env, HOME: home, ACP_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, TEST_CLAUDE_PID: String(process.pid) },
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (x) => (stdout += String(x)));
      child.stderr!.on("data", (x) => (stderr += String(x)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout) as HostObservation) : reject(new Error(`${operation}: ${stderr}`))));
      child.stdin!.end(JSON.stringify({ version: 1, operation, allocation, packet: { bytes: "approved" } }));
    });
  const head = async () => (await git(clone, ["rev-parse", "HEAD"])).stdout.trim();
  /** The resident process is gone, as after the CTO died; its pane and RC record stay. */
  const killResident = () => {
    const stateFile = join(home, "fake.json");
    writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), launched: false }));
  };
  const env = { ...process.env, HOME: home, ACP_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}`, TEST_CLAUDE_PID: String(process.pid) };
  return { home, state, bin, env, clone, a, autoInit, genesis, invoke, head, killResident };
}
