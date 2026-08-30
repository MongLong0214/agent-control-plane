import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { disposableWorkspaceLocation } from "../../src/core/disposable-workspace-root.ts";

const driver = fileURLToPath(
  new URL("../../src/acceptance/disposable-realm-driver.ts", import.meta.url),
);

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
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)) },
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
});
