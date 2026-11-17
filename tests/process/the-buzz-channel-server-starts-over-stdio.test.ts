import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The real entry, started the way Claude Code starts it: as a child over stdio. What a live session
 * depends on before any message exists is that this process comes up, declares the channel capability
 * and its one tool, and refuses to run when it was started with something it must not sign as.
 */
const ENTRY = fileURLToPath(new URL("../../src/cli/buzz-channel.ts", import.meta.url));
const ROOM = "11111111-1111-4111-8111-111111111111";

const files = () => {
  const dir = tempDir("acp-channel-proc-");
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  const secret = generateSecretKey();
  const keyFile = join(dir, "cto.priv");
  writeFileSync(keyFile, `${Buffer.from(secret).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return { state, keyFile, pubkey: getPublicKey(secret), secret };
};
// From source, the module graph uses TypeScript parameter properties, which type stripping alone refuses;
// the shipped entry is the compiled `dist/cli/buzz-channel.js`.
const SOURCE_NODE = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
const args = (f: ReturnType<typeof files>, extra: string[] = []) => [
  ...SOURCE_NODE, ENTRY, "--project-id", "demo", "--key-file", f.keyFile, "--room", ROOM, "--state-dir", f.state,
  // Nothing listens here: the server must come up and answer MCP regardless, and keep retrying.
  "--relay-url", "wss://127.0.0.1:1", ...extra,
];

describe("the channel server over stdio", () => {
  it("answers initialize with the channel capability and lists the reply tool", async () => {
    const f = files();
    const client = new Client({ name: "claude-code-stand-in", version: "0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: args(f, ["--ceo-pubkey", getPublicKey(generateSecretKey())]),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["reply"]);
      const refused = await client.callTool({ name: "reply", arguments: { room: ROOM, event_id: "ab".repeat(32), text: "x" } });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses to start with a key that is also the CEO's, and says only a closed reason", () => {
    const f = files();
    const run = spawnSync(process.execPath, args(f, ["--ceo-pubkey", f.pubkey]), { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(3);
    expect(run.stderr).toMatch(/not this CTO's own/u);
    expect(run.stderr).not.toContain(Buffer.from(f.secret).toString("hex"));
  });

  it("refuses a missing room, a relative key path, and a key readable by others", () => {
    const f = files();
    const noRoom = spawnSync(process.execPath, [...SOURCE_NODE, ENTRY, "--project-id", "demo", "--key-file", f.keyFile, "--state-dir", f.state], { encoding: "utf8", timeout: 20_000 });
    expect(noRoom.status).toBe(2);
    const relative = spawnSync(process.execPath, [...SOURCE_NODE, ENTRY, "--project-id", "demo", "--key-file", "cto.priv", "--room", ROOM, "--state-dir", f.state], { encoding: "utf8", timeout: 20_000 });
    expect(relative.status).toBe(2);
    chmodSync(f.keyFile, 0o644);
    const open = spawnSync(process.execPath, args(f, ["--ceo-pubkey", getPublicKey(generateSecretKey())]), { encoding: "utf8", timeout: 20_000 });
    expect(open.status).toBe(3);
    expect(open.stderr).toMatch(/readable beyond its owner/u);
  });
});
