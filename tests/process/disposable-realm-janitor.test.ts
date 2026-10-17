import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { disposableWorkspaceLocation } from "../../src/core/disposable-workspace-root.ts";

const driver = fileURLToPath(
  new URL("../../src/acceptance/disposable-realm-driver.ts", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const waitForWorkspace = (child: ChildProcessWithoutNullStreams): Promise<string> =>
  new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`child never printed a workspace: ${stdout}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split("\n").find((one) => one.startsWith("READY "));
      if (!line) return;
      clearTimeout(timeout);
      resolve(line.slice("READY ".length));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before reporting its workspace: ${code ?? signal}`));
    });
  });

const waitUntilAbsent = async (path: string): Promise<boolean> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !existsSync(path);
};

describe("the disposable realm crash janitor", () => {
  it("removes the workspace when the process holding its pipe is killed", async () => {
    const source = [
      `import { createJanitorOwnedRealmWorkspace } from ${JSON.stringify(pathToFileURL(driver).href)};`,
      `const { workspace } = await createJanitorOwnedRealmWorkspace();`,
      `process.stdout.write(\`READY \${workspace}\\n\`);`,
      `setInterval(() => undefined, 1_000);`,
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", source],
      { cwd: repositoryRoot, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" } },
    );

    let workspace: string | null = null;
    try {
      workspace = await waitForWorkspace(child);
      expect(dirname(workspace)).toBe(disposableWorkspaceLocation().workspaceRoot);
      expect(existsSync(workspace)).toBe(true);
      child.kill("SIGKILL");

      expect(await waitUntilAbsent(workspace)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not write through inherited TMPDIR before the disposable workspace is established", () => {
    const inheritedRoot = mkdtempSync(
      join(realpathSync("/tmp"), "acp-655-inherited-tmpdir-"),
    );
    writeFileSync(join(inheritedRoot, "live-marker"), "must remain the only entry", {
      mode: 0o600,
    });

    try {
      const before = readdirSync(inheritedRoot).sort();
      // The package's own `acceptance:disposable-realm` command line, run by Node's script runner:
      // `sh -c` with `node_modules/.bin` on PATH, nothing before it. Not through pnpm: pnpm 11
      // (`verify-deps-before-run`, default `install`) runs `pnpm install` before the script, so the
      // launch would write outside the realm before its workspace exists, and the verdict would
      // depend on the host's pnpm — that install refuses a `node_modules` symlinked from outside
      // the checkout (ERR_PNPM_UNSAFE_MODULES_DIR); pnpm 10 skips it. An edit to the script is
      // still an edit to what runs here.
      const result = spawnSync(process.execPath, ["--run", "acceptance:disposable-realm"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: inheritedRoot },
        timeout: 30_000,
      });

      expect(
        result.status,
        `the production disposable-realm launcher failed: ${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain('"allowed": true');
      expect(readdirSync(inheritedRoot).sort()).toEqual(before);
    } finally {
      rmSync(inheritedRoot, { recursive: true, force: true });
    }
  });
});
