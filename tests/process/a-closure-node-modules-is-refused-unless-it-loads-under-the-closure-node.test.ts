import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundedExecFileSync, boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A sealed closure's `node_modules` carries better-sqlite3, a native addon bound to one Node ABI,
 * and the seal never starts the closure it seals. An addon built for a different Node than the
 * closure's `bin/node` therefore seals cleanly and fails only at rollback — at the database step,
 * which is the failure the hoisted layout exists to prevent. `deploy/closure-node-modules.sh`
 * installs under the closure's own Node and loads the result with it before it succeeds; these
 * rows hold it to refusing what that Node cannot load.
 *
 * The ABI row needs a second Node with a different `process.versions.modules`; it is skipped
 * where there is none (set `ACP_TEST_ALT_NODE`, or keep another major beside this one, as nvm does). Renaming the
 * addon's registration symbol does not stand in for one: Node registers the addon from a static
 * initializer, so the rename loads fine, and a byte patch that invalidates the code signature is
 * killed by macOS for that reason rather than for the ABI. The row below it, an addon that is not
 * a loadable binary at all, always runs.
 */

const SCRIPT = join(process.cwd(), "deploy", "closure-node-modules.sh");

/** A Node executable whose addon ABI differs from this one's, if the machine has one. */
const otherNode = (): string | null => {
  // HOME is private under test, so look beside this Node instead: nvm keeps every version in a
  // sibling of the one running, `<versions>/<version>/bin/node`.
  const nvm = dirname(dirname(dirname(process.execPath)));
  const candidates = [
    ...(process.env["ACP_TEST_ALT_NODE"] ? [process.env["ACP_TEST_ALT_NODE"]] : []),
    ...(existsSync(nvm) ? readdirSync(nvm).map((version) => join(nvm, version, "bin", "node")) : []),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const modules = boundedSpawnSync(candidate, ["-p", "process.versions.modules"], { encoding: "utf8" });
    if (modules.status === 0 && modules.stdout.trim() !== process.versions.modules) return candidate;
  }
  return null;
};
const ALT_NODE = otherNode();

let root = "";
let closureNode = "";
let built = "";

const verify = (tree: string, node = closureNode) =>
  boundedSpawnSync(SCRIPT, ["--verify", tree, node], { encoding: "utf8" });

const copyOfBuilt = (name: string): string => {
  const copy = join(root, name, "node_modules");
  mkdirSync(join(root, name), { recursive: true });
  cpSync(built, copy, { recursive: true });
  return copy;
};

beforeAll(() => {
  root = tempDir("acp-closure-node-modules-");
  mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 });
  closureNode = join(root, "bin", "node");
  boundedExecFileSync("/bin/cp", ["-c", process.execPath, closureNode]);
  chmodSync(closureNode, 0o755);
  mkdirSync(join(root, "built"), { recursive: true });
  built = join(root, "built", "node_modules");
  boundedExecFileSync(SCRIPT, [process.cwd(), built, closureNode], { timeout: 240_000 });
}, 300_000);

describe("deploy/closure-node-modules.sh", () => {
  it("produces a tree that loads under the closure's Node and holds no symbolic link", () => {
    const loaded = verify(built);
    expect(loaded.status, loaded.stderr).toBe(0);
    const links = boundedExecFileSync("/usr/bin/find", [built, "-type", "l"], { encoding: "utf8" });
    expect(links.trim()).toBe("");
  });

  it.skipIf(ALT_NODE === null)("refuses an addon built for a different Node ABI", () => {
    const refused = verify(built, ALT_NODE!);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not load under");
    expect(refused.stderr).toMatch(/different Node\.js version|NODE_MODULE_VERSION/);
  });

  it("refuses an addon that is not a loadable binary", () => {
    const tree = copyOfBuilt("corrupt-addon");
    writeFileSync(join(tree, "better-sqlite3", "build", "Release", "better_sqlite3.node"), "not a mach-o file\n");

    const refused = verify(tree);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not load under");
    expect(refused.stderr).toContain(closureNode);
  });

  it("refuses a tree that cannot resolve a dependency of nostr-tools", () => {
    const tree = copyOfBuilt("missing-dependency");
    rmSync(join(tree, "@noble", "hashes"), { recursive: true, force: true });

    const refused = verify(tree);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not load under");
  });

  it("refuses a closure Node that is not an executable file named node", () => {
    const wrongName = join(root, "bin", "not-node");
    boundedExecFileSync("/bin/cp", [closureNode, wrongName]);
    const refused = verify(built, wrongName);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("is not an executable file named node");
    expect(existsSync(join(root, "never-created"))).toBe(false);
    const install = boundedSpawnSync(SCRIPT, [process.cwd(), join(root, "never-created", "node_modules"), wrongName], {
      encoding: "utf8",
    });
    expect(install.status).not.toBe(0);
    expect(existsSync(join(root, "never-created"))).toBe(false);
  });
});
