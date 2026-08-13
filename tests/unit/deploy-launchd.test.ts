import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const deploy = join(root, "deploy");
const installer = join(deploy, "install-launchd.sh");
const template = join(deploy, "com.agentcontrolplane.agentcpd.plist.template");
const label = "com.agentcontrolplane.agentcpd";

interface InstallerHarness {
  home: string;
  bin: string;
  launchLog: string;
  securityLog: string;
  launcherEnvLog: string;
  stateAdminLog: string;
  loaded: string;
  lock: string;
  node: string;
  env: NodeJS.ProcessEnv;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const writeExecutable = (path: string, content: string): void => {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
};

const makeHarness = (): InstallerHarness => {
  const home = tempDir("acp-launchd-home-");
  const bin = join(home, "fake-bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  chmodSync(bin, 0o700);

  const launchLog = join(home, "launchctl.log");
  const securityLog = join(home, "security.log");
  const launcherEnvLog = join(home, "launcher-env.log");
  const stateAdminLog = join(home, "state-admin.log");
  const loaded = join(home, "launchd.loaded");
  const lock = join(home, ".agent-control-plane", "agentcpd.lock");
  const launchctl = join(bin, "launchctl");
  const security = join(bin, "security");
  const node = join(bin, "node-wrapper");

  writeExecutable(
    launchctl,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ACP_LAUNCHCTL_LOG"
case "\${1:-}" in
  print)
    [[ -e "$ACP_LAUNCHD_LOADED" ]]
    ;;
  bootstrap)
    touch "$ACP_LAUNCHD_LOADED"
    ;;
  bootout)
    rm -f "$ACP_LAUNCHD_LOADED"
  if [[ -n "\${ACP_STOP_DELAY:-}" && -n "\${ACP_LOCK_PATH:-}" ]]; then
      (sleep "$ACP_STOP_DELAY"; rm -f "$ACP_LOCK_PATH") >/dev/null 2>&1 &
    fi
    ;;
  kickstart)
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  writeExecutable(
    security,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ACP_SECURITY_LOG"
[[ "\${1:-}" == "find-generic-password" ]] || exit 64
case "$*" in
  *" -a ACP_MCP_TOKEN") printf 'mcp-provisioned-token\\n' ;;
  *" -a ACP_OPERATOR_TOKEN") printf 'operator-provisioned-token\\n' ;;
  *) printf 'fake-keychain-value\\n' ;;
esac
`,
  );
  writeExecutable(
    node,
    `#!/bin/bash
set -euo pipefail
target="\${1:-}"
if [[ "$target" == *"state-admin.js" ]]; then
  [[ ! -e "\${ACP_LOCK_PATH:-}" ]] || exit 89
  printf '%s\\n' "$*" >> "$ACP_STATE_ADMIN_LOG"
  exit 0
fi
if [[ "$target" == *"render-launchd-plist.mjs" ]]; then
  if [[ "\${ACP_RENDER_REQUIRES_STOPPED:-0}" == "1" && -e "\${ACP_LOCK_PATH:-}" ]]; then
    exit 88
  fi
  exec "$ACP_REAL_NODE" "$@"
fi
if [[ "$target" == *"agentcpd.js" ]]; then
  printf '%s|%s\\n' "$ACP_MCP_TOKEN" "$ACP_OPERATOR_TOKEN" >> "$ACP_LAUNCHER_ENV_LOG"
  exit 0
fi
exit 90
`,
  );

  return {
    home,
    bin,
    launchLog,
    securityLog,
    launcherEnvLog,
    stateAdminLog,
    loaded,
    lock,
    node,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      ACP_LAUNCHCTL_LOG: launchLog,
      ACP_SECURITY_LOG: securityLog,
      ACP_LAUNCHER_ENV_LOG: launcherEnvLog,
      ACP_STATE_ADMIN_LOG: stateAdminLog,
      ACP_LAUNCHD_LOADED: loaded,
      ACP_LOCK_PATH: lock,
      ACP_STOP_DELAY: "2",
      ACP_REAL_NODE: process.execPath,
    },
  };
};

const runInstaller = (
  command: string,
  args: readonly string[],
  harness: InstallerHarness,
): CommandResult => {
  const result = spawnSync("bash", [command, ...args], {
    encoding: "utf8",
    env: harness.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const subcommands = (log: string): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);

const plistPath = (harness: InstallerHarness): string =>
  join(harness.home, "Library", "LaunchAgents", `${label}.plist`);

const launcherPath = (harness: InstallerHarness): string =>
  join(harness.home, ".agent-control-plane", "agentcpd-launch.sh");

const assertRenderedPlist = (harness: InstallerHarness): void => {
  const plist = readFileSync(plistPath(harness), "utf8");
  expect(plist).toContain(join(harness.home, ".agent-control-plane", "agentcpd-launch.sh"));
  expect(plist).toContain(root);
  expect(plist).toContain(join(harness.home, ".agent-control-plane", "agentcpd.out.log"));
  expect(plist).toContain(join(harness.home, ".agent-control-plane", "agentcpd.err.log"));
  expect(plist).toContain(`<key>WorkingDirectory</key>`);
  expect(plist).toContain(`<key>HOME</key>`);
  expect(plist).not.toContain("__ACP_");
  expect(plist).not.toContain("ACP_MCP_TOKEN");
};

const filesUnder = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

describe("launchd deployment artifact", () => {
  it("renders a loadable plist with absolute paths and no secret or unresolved placeholder", () => {
    const output = join(tempDir("acp-launchd-render-"), "agentcpd.plist");
    execFileSync(process.execPath, [
      join(deploy, "render-launchd-plist.mjs"),
      template,
      output,
      "/Users/operator/.agent-control-plane/agentcpd-launch.sh",
      "/Users/operator/release & one",
      "/Users/operator/.agent-control-plane/agentcpd.out.log",
      "/Users/operator/.agent-control-plane/agentcpd.err.log",
      "/Users/operator",
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ]);
    const plist = readFileSync(output, "utf8");

    expect(plist).toContain("/Users/operator/.agent-control-plane/agentcpd-launch.sh");
    expect(plist).toContain("/Users/operator/release &amp; one");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).not.toContain("__ACP_");
    expect(plist).not.toContain("REPLACE_WITH_");
    expect(plist).not.toContain("ACP_MCP_TOKEN");
  });

  it("installs through fake launchctl/security and observes the rendered job", () => {
    const harness = makeHarness();
    const result = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );

    expect(result.status).toBe(0);
    expect(existsSync(plistPath(harness))).toBe(true);
    assertRenderedPlist(harness);
    expect(subcommands(harness.launchLog)).toEqual(["print", "print", "bootstrap", "kickstart"]);
    expect(readFileSync(harness.securityLog, "utf8")).toContain(
      "find-generic-password -w -s test-service -a ACP_MCP_TOKEN",
    );
    expect(readFileSync(harness.securityLog, "utf8")).toContain(
      "find-generic-password -w -s test-service -a ACP_OPERATOR_TOKEN",
    );
  });

  it("executes the rendered launcher with distinct MCP and operator credentials", () => {
    const harness = makeHarness();
    const installed = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );

    expect(installed.status).toBe(0);
    const launcherSecurity = join(harness.home, "launcher-security.bash");
    writeFileSync(
      launcherSecurity,
      `security() { "${join(harness.bin, "security")}" "$@"; }\n`,
      { mode: 0o600 },
    );

    const launcherEnv: NodeJS.ProcessEnv = { ...harness.env, BASH_ENV: launcherSecurity };
    delete launcherEnv["ACP_MCP_TOKEN"];
    delete launcherEnv["ACP_OPERATOR_TOKEN"];
    const launched = spawnSync("bash", [launcherPath(harness)], {
      encoding: "utf8",
      env: launcherEnv,
    });

    expect(launched.status).toBe(0);
    const [mcpToken, operatorToken] = readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(mcpToken).toBe("mcp-provisioned-token");
    expect(operatorToken).toBe("operator-provisioned-token");
    expect(operatorToken).not.toBe(mcpToken);
  });

  it("waits for the old daemon lock during upgrade before rendering the replacement", () => {
    const harness = makeHarness();
    const installed = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", harness.node],
      harness,
    );
    expect(installed.status).toBe(0);

    writeFileSync(harness.lock, "old daemon lock\n", { mode: 0o600 });
    harness.env["ACP_RENDER_REQUIRES_STOPPED"] = "1";
    const upgraded = runInstaller(
      installer,
      ["upgrade", "--app-root", root, "--node", harness.node],
      harness,
    );

    expect(upgraded.status).toBe(0);
    expect(existsSync(harness.lock)).toBe(false);
    assertRenderedPlist(harness);
    expect(subcommands(harness.launchLog)).toEqual([
      "print",
      "print",
      "bootstrap",
      "kickstart",
      "print",
      "bootout",
      "print",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("refuses rollback unless an explicit database backup is supplied", () => {
    const harness = makeHarness();
    const result = runInstaller(
      installer,
      ["rollback", "--app-root", root, "--node", harness.node],
      harness,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rollback requires --database-backup");
    expect(existsSync(harness.launchLog)).toBe(false);
  });

  it("waits for the daemon to stop before rollback invokes state restore", () => {
    const harness = makeHarness();
    expect(
      runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness).status,
    ).toBe(0);
    expect(
      runInstaller(
        installer,
        ["upgrade", "--app-root", root, "--node", harness.node, "--no-start"],
        harness,
      ).status,
    ).toBe(0);

    // The fake daemon is loaded again so rollback must take it down. The fake node exits
    // non-zero if state-admin is reached while this lock still exists.
    writeFileSync(harness.loaded, "loaded\n", { mode: 0o600 });
    writeFileSync(harness.lock, "old daemon lock\n", { mode: 0o600 });
    writeFileSync(harness.launchLog, "");
    const backup = join(harness.home, "operator-named-backup.sqlite");
    const rolledBack = runInstaller(
      installer,
      ["rollback", "--app-root", root, "--node", harness.node, "--database-backup", backup],
      harness,
    );

    expect(rolledBack.status).toBe(0);
    expect(existsSync(harness.lock)).toBe(false);
    expect(readFileSync(harness.stateAdminLog, "utf8")).toContain(`restore ${backup}`);
    expect(subcommands(harness.launchLog)).toEqual(["print", "bootout", "print", "bootstrap", "kickstart"]);
  });

  it("rejects a substring-only installer stub", () => {
    const stub = join(tempDir("acp-launchd-stub-"), "install-launchd.sh");
    const stubText = `#!/bin/bash
# Usage: install start restart upgrade rollback --database-backup
# find-generic-password render-launchd-plist.mjs
exit 0
`;
    writeExecutable(stub, stubText);
    execFileSync("bash", ["-n", stub]);
    for (const token of ["rollback", "--database-backup", "find-generic-password", "render-launchd-plist.mjs"]) {
      expect(stubText).toContain(token);
    }

    const harness = makeHarness();
    const result = runInstaller(stub, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(result.status).toBe(0);
    expect(() => {
      expect(existsSync(plistPath(harness))).toBe(true);
      expect(subcommands(harness.launchLog)).toEqual(["print", "print", "bootstrap", "kickstart"]);
    }).toThrow();
  });

  it("keeps the template as the only plist artifact in the tree", () => {
    const loadable = filesUnder(root).filter((path) => path.endsWith(".plist"));
    expect(loadable).toEqual([]);
    expect(readFileSync(template, "utf8")).toContain("__ACP_");
    expect(filesUnder(root).filter((path) => path.endsWith(".plist.template"))).toEqual([template]);
  });
});
