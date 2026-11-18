import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { launchFolderTrust } from "../../src/runtime/cto-channel-launch.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The launcher presses one key, on a screen it read a moment before, and tmux cannot make reading and pressing one step.
 * What can be on the other side of that gap is removed before Claude Code starts: the folder it will start in must already
 * be trusted in Claude Code's own store, the file `~/.claude/scripts/claude-trust-dir.sh` writes, key and flag as it
 * writes them. Never trusted for the launch, only read.
 */
const world = () => {
  const root = realpathSync(tempDir("acp-trust-"));
  const home = join(root, "home");
  const folder = join(root, "projects", "clone");
  mkdirSync(home, { recursive: true });
  mkdirSync(folder, { recursive: true });
  const store = (projects: Record<string, unknown>, file = join(home, ".claude.json")) => writeFileSync(file, JSON.stringify({ numStartups: 3, projects }));
  return { root, home, folder, store };
};

describe("launchFolderTrust: the folder Claude Code will start in is trusted in its store, or the launch does not start", () => {
  it("is trusted when the store holds this folder's own record with the flag set", () => {
    const w = world();
    w.store({ [w.folder]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(w.folder, { home: w.home, env: {} })).toEqual({ trusted: true, folder: w.folder });
  });

  it.each([
    ["no record for the folder", {}],
    ["a record without the flag", { mcpServers: {} }],
    ["the flag false", { hasTrustDialogAccepted: false }],
    ["the flag as text", { hasTrustDialogAccepted: "true" }],
    ["the flag as a number", { hasTrustDialogAccepted: 1 }],
  ])("is not trusted with %s", (_name, record) => {
    const w = world();
    w.store(Object.keys(record).length === 0 ? {} : { [w.folder]: record });
    expect(launchFolderTrust(w.folder, { home: w.home, env: {} })).toEqual({ trusted: false, folder: w.folder, reason: "no-record" });
  });

  it("does not take a folder above it as trust: the record is the folder's own", () => {
    const w = world();
    w.store({ [join(w.root, "projects")]: { hasTrustDialogAccepted: true }, [w.root]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(w.folder, { home: w.home, env: {} })).toMatchObject({ trusted: false, reason: "no-record" });
  });

  it("reads the folder by its real path, as the trust script writes it, not by a link to it", () => {
    const w = world();
    const link = join(w.root, "link-to-clone");
    symlinkSync(w.folder, link);
    w.store({ [w.folder]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(link, { home: w.home, env: {} })).toEqual({ trusted: true, folder: w.folder });
    w.store({ [link]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(link, { home: w.home, env: {} })).toEqual({ trusted: false, folder: w.folder, reason: "no-record" });
  });

  it("is never trusted for the home folder: Claude Code keeps its answer for one session only", () => {
    const w = world();
    w.store({ [w.home]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(w.home, { home: w.home, env: {} })).toEqual({ trusted: false, folder: w.home, reason: "home-folder" });
  });

  it.each([
    ["is missing", "store-unreadable", (file: string) => { void file; }],
    ["is not JSON", "store-unreadable", (file: string) => writeFileSync(file, "{ not json")],
    ["is not an object", "store-unreadable", (file: string) => writeFileSync(file, "[]")],
    ["has no projects", "no-record", (file: string) => writeFileSync(file, JSON.stringify({ numStartups: 1 }))],
  ])("is not trusted when the store %s", (_name, reason, make) => {
    const w = world();
    make(join(w.home, ".claude.json"));
    expect(launchFolderTrust(w.folder, { home: w.home, env: {} })).toEqual({ trusted: false, folder: w.folder, reason });
  });

  it("is not trusted when the folder cannot be resolved", () => {
    const w = world();
    w.store({ [join(w.root, "gone")]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(join(w.root, "gone"), { home: w.home, env: {} })).toEqual({ trusted: false, folder: null, reason: "folder-unresolvable" });
  });

  it("reads the store Claude Code reads: CLAUDE_CONFIG_DIR's when it is set, the home's when it is not", () => {
    const w = world();
    const config = join(w.root, "config");
    mkdirSync(config);
    w.store({ [w.folder]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(w.folder, { home: w.home, env: { CLAUDE_CONFIG_DIR: config } })).toMatchObject({ trusted: false, reason: "store-unreadable" });
    w.store({ [w.folder]: { hasTrustDialogAccepted: true } }, join(config, ".claude.json"));
    expect(launchFolderTrust(w.folder, { home: w.home, env: { CLAUDE_CONFIG_DIR: config } })).toEqual({ trusted: true, folder: w.folder });
  });

  it("is not trusted where Claude Code is told to ignore its persisted trust", () => {
    const w = world();
    w.store({ [w.folder]: { hasTrustDialogAccepted: true } });
    expect(launchFolderTrust(w.folder, { home: w.home, env: { CLAUDE_CODE_IGNORE_PERSISTED_TRUST: "1" } }))
      .toEqual({ trusted: false, folder: w.folder, reason: "persisted-trust-ignored" });
  });

  it("only reads: the store is byte for byte what it was", () => {
    const w = world();
    w.store({ [w.folder]: { mcpServers: {} } });
    const file = join(w.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    launchFolderTrust(w.folder, { home: w.home, env: {} });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
