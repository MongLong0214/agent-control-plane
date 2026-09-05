import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { sealRollbackPair, type SealedRollbackPair } from "../../src/deploy/rollback-pair.ts";
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
account="\${6:-}"
case "$account" in
  ACP_MCP_TOKEN) printf 'mcp-provisioned-token\\n' ;;
  ACP_OPERATOR_TOKEN) printf 'operator-provisioned-token\\n' ;;
  # A host where the Buzz desktop app owns the relay identity has no dedicated
  # BUZZ_PRIVATE_KEY item at all — the lookup fails, exactly as it does live.
  BUZZ_PRIVATE_KEY) [[ "\${ACP_FAKE_BUZZ_ITEM_MISSING:-0}" == "1" ]] && exit 44
                    printf 'fake-keychain-value\\n' ;;
  secrets) printf '%s\\n' "\${ACP_FAKE_BUZZ_SECRETS_JSON:-}" ;;
  # A host that installed buzz under a user-local bin has no Keychain item for its path, and
  # the launcher is supposed to fall back to the value resolved at install time. The catch-all
  # below answered for this account too, so it returned a Keychain value and the resolved path
  # was never exercised — the fake was masking the property the test is named for.
  ACP_BUZZ_BINARY) [[ "\${ACP_FAKE_BUZZ_BINARY_ITEM:-0}" == "1" ]] || exit 44
                   printf 'keychain-provided-buzz\\n' ;;
  ACP_TELEGRAM_*)
    case ",\${ACP_TELEGRAM_KEYCHAIN_ACCOUNTS:-}," in
      *,"$account",*) ;;
      *) exit 44 ;;
    esac
    case "$account" in
      ACP_TELEGRAM_BOT_TOKEN) printf 'telegram-bot-token\\n' ;;
      ACP_TELEGRAM_OWNER_ID) printf '424242\\n' ;;
      ACP_TELEGRAM_CHAT_ID) printf -- '-100999\\n' ;;
      ACP_TELEGRAM_WEBHOOK_SECRET) printf 'telegram-webhook-secret\\n' ;;
      *) printf 'telegram-test-value\\n' ;;
    esac
    ;;
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
if [[ "$target" == *"rollback-pair.js" ]]; then
  # The real built validator, not a stub. A stub that exited 0 would make every rollback row
  # here pass for a pair it never looked at, which is the shape of defect these rows exist for.
  exec "$ACP_REAL_NODE" "$@"
fi
if [[ "$target" == *"render-launchd-plist.mjs" ]]; then
  if [[ "\${ACP_RENDER_REQUIRES_STOPPED:-0}" == "1" && -e "\${ACP_LOCK_PATH:-}" ]]; then
    exit 88
  fi
  exec "$ACP_REAL_NODE" "$@"
fi
if [[ "$target" == "-e" ]]; then
  exec "$ACP_REAL_NODE" "$@"
fi
if [[ "$target" == *"agentcpd.js" ]]; then
  printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$ACP_MCP_TOKEN" "$ACP_OPERATOR_TOKEN" \
    "\${ACP_TELEGRAM_BOT_TOKEN-}" "\${ACP_TELEGRAM_OWNER_ID-}" \
    "\${ACP_TELEGRAM_CHAT_ID-}" "\${ACP_TELEGRAM_WEBHOOK_SECRET-}" \
    "\${BUZZ_PRIVATE_KEY:-<unset>}" "\${ACP_BUZZ_BINARY:-<unset>}" >> "$ACP_LAUNCHER_ENV_LOG"
  # Mirrors the real precondition in src/daemon/agentcpd.ts: a Buzz credential without the
  # ingress pair is a startup error, not a degraded mode. Without this, a launcher that
  # exported the key too eagerly would look fine here and put the real daemon in a launchd
  # restart loop.
  if [[ -n "\${BUZZ_PRIVATE_KEY:-}" && ( -z "\${ACP_BUZZ_INGRESS_SECRET:-}" || -z "\${ACP_BUZZ_ALLOWED_ACTORS:-}" ) ]]; then
    echo "Buzz transport requires ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS" >&2
    exit 70
  fi
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
  expect(plist).not.toContain("ACP_TELEGRAM_BOT_TOKEN");
};

/**
 * A disposable app root the rollback rows can actually install into.
 *
 * Rolling back now replaces a runtime closure, so these rows must never point the installer at
 * this repository's own `dist` — a passing test that overwrote the tree it was run from would be
 * a worse outcome than a failing one. The copy carries the real built closure and the real plist
 * renderer, so what the installer resolves and executes is the genuine article.
 */
const makeDisposableAppRoot = (): string => {
  const appRoot = tempDir("acp-launchd-approot-");
  cpSync(join(root, "dist"), join(appRoot, "dist"), { recursive: true });
  cpSync(join(root, "deploy"), join(appRoot, "deploy"), { recursive: true });
  // A real deployment resolves the closure's dependencies from a sibling of `dist`, not from
  // inside it. Linking rather than copying keeps the fixture small; what matters is that the
  // sibling sits outside the install root, so a rollback replaces `dist` and leaves it alone.
  symlinkSync(join(root, "node_modules"), join(appRoot, "node_modules"));
  // `native/` is part of the same closure: the built `dist/db/fd-vfs.js` resolves the extension
  // relative to itself, so an app root without it has a runtime that cannot load its own
  // primitive. A real deployment checkout carries both beside `dist`.
  symlinkSync(join(root, "native"), join(appRoot, "native"));
  return realpathSync(appRoot);
};

interface PairFixture {
  pair: SealedRollbackPair;
  appRoot: string;
  databasePath: string;
}

const GENERATION_MARKER = "GENERATION.txt";

/**
 * A real sealed pair for this harness's deployment, built by the module the installer's validator
 * is compiled from. The rollback rows consume it end to end: the fake `node` hands
 * `rollback-pair.js` to the real interpreter, so what runs is the actual orchestrator against an
 * actual pair rather than a stub that would agree with anything.
 *
 * The pair's own Node is a real interpreter, deliberately separate from the harness's fake one:
 * a rollback restores the database through the *sealed* generation's state-admin, not the
 * deployment's, and a fake there would hide exactly that.
 */
const sealPairFor = async (
  harness: InstallerHarness,
  appRoot: string,
  generation = "sealed-generation",
): Promise<PairFixture> => {
  const state = join(harness.home, ".agent-control-plane");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  mkdirSync(join(harness.home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });

  const databasePath = join(state, "state.sqlite");
  if (!existsSync(databasePath)) {
    new Db(databasePath).close();
    chmodSync(databasePath, 0o600);
  }

  const source = join(harness.home, `pair-source-${generation}`);
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const runtimeRoot = join(source, "runtime");
  cpSync(join(root, "dist"), runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, GENERATION_MARKER), `${generation}\n`, { mode: 0o600 });
  // The interpreter travels inside the closure, so the rollback runs the sealed one rather than
  // whatever `node` this machine happens to have.
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, "bin", "node"), `#!/bin/bash\nexec ${process.execPath} "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(join(runtimeRoot, "bin", "node"), 0o755);

  const launcherDestination = join(realpathSync(state), "agentcpd-launch.sh");
  const plistDestination = join(
    realpathSync(join(harness.home, "Library", "LaunchAgents")),
    `${label}.plist`,
  );
  const plist = join(source, `${label}.plist`);
  writeFileSync(
    plist,
    [
      '<?xml version="1.0"?>',
      "<plist><dict>",
      "  <key>Label</key>",
      `  <string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      `  <array><string>${launcherDestination}</string></array>`,
      "  <key>WorkingDirectory</key>",
      `  <string>${appRoot}</string>`,
      `  <!-- ${generation} -->`,
      "</dict></plist>",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const launcher = join(source, "agentcpd-launch.sh");
  writeFileSync(
    launcher,
    [
      "#!/bin/bash",
      `# ${generation}`,
      `ACP_NODE_PATH=${join(appRoot, "dist", "bin", "node")}`,
      `ACP_APP_ROOT=${appRoot}`,
      'exec "$ACP_NODE_PATH" "$ACP_APP_ROOT/dist/daemon/agentcpd.js"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const pair = await sealRollbackPair(join(state, "rollback-pairs"), {
    databasePath,
    runtimeRoot,
    entrypoint: "daemon/agentcpd.js",
    stateAdmin: "db/state-admin.js",
    nodeExecutable: "bin/node",
    nodeVersion: process.version,
    install: {
      runtimeRoot: join(appRoot, "dist"),
      plistPath: plistDestination,
      launcherPath: launcherDestination,
      workingDirectory: appRoot,
    },
    launchd: { label, generation, plistPath: plist, launcherPath: launcher },
  });
  return { pair, appRoot, databasePath };
};

/** Every structural expectation the installer now requires, for a fixture's own pair. */
const structuralFlags = (fixture: PairFixture): string[] => [
  "--expect-schema-version",
  String(fixture.pair.manifest.identity.schemaVersion),
  "--expect-service-generation",
  fixture.pair.manifest.identity.service.generation,
  "--expect-node-version",
  fixture.pair.manifest.identity.runtime.nodeVersion,
];

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
    expect(plist).not.toContain("ACP_TELEGRAM_BOT_TOKEN");
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

    const launcherEnv: NodeJS.ProcessEnv = {
      ...harness.env,
      BASH_ENV: launcherSecurity,
      ACP_TELEGRAM_KEYCHAIN_ACCOUNTS:
        "ACP_TELEGRAM_BOT_TOKEN,ACP_TELEGRAM_OWNER_ID,ACP_TELEGRAM_CHAT_ID,ACP_TELEGRAM_WEBHOOK_SECRET",
    };
    delete launcherEnv["ACP_MCP_TOKEN"];
    delete launcherEnv["ACP_OPERATOR_TOKEN"];
    const launched = spawnSync("bash", [launcherPath(harness)], {
      encoding: "utf8",
      env: launcherEnv,
    });

    expect(launched.status).toBe(0);
    const [mcpToken, operatorToken, telegramToken, telegramOwner, telegramChat, telegramSecret] =
      readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(mcpToken).toBe("mcp-provisioned-token");
    expect(operatorToken).toBe("operator-provisioned-token");
    expect(operatorToken).not.toBe(mcpToken);
    expect(telegramToken).toBe("telegram-bot-token");
    expect(telegramOwner).toBe("424242");
    expect(telegramChat).toBe("-100999");
    expect(telegramSecret).toBe("telegram-webhook-secret");
  });

  it("starts cleanly and omits Telegram variables when the Keychain has none", () => {
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
    const launcherEnv: NodeJS.ProcessEnv = {
      ...harness.env,
      BASH_ENV: launcherSecurity,
      ACP_TELEGRAM_KEYCHAIN_ACCOUNTS: "",
      ACP_TELEGRAM_BOT_TOKEN: "inherited-token-must-not-survive",
      ACP_TELEGRAM_OWNER_ID: "inherited-owner-must-not-survive",
      ACP_TELEGRAM_CHAT_ID: "inherited-chat-must-not-survive",
      ACP_TELEGRAM_WEBHOOK_SECRET: "inherited-secret-must-not-survive",
    };
    delete launcherEnv["ACP_MCP_TOKEN"];
    delete launcherEnv["ACP_OPERATOR_TOKEN"];
    const launched = spawnSync("bash", [launcherPath(harness)], {
      encoding: "utf8",
      env: launcherEnv,
    });

    expect(launched.status).toBe(0);
    const [, , telegramToken, telegramOwner, telegramChat, telegramSecret] =
      readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(telegramToken).toBe("");
    expect(telegramOwner).toBe("");
    expect(telegramChat).toBe("");
    expect(telegramSecret).toBe("");
  });

  it("#423 takes BUZZ_PRIVATE_KEY from the desktop store when it has no item of its own", () => {
    const harness = makeHarness();
    // The live host's shape: the Buzz desktop app owns every identity's secret in one JSON
    // object, and there is no BUZZ_PRIVATE_KEY item to find. Before this, the daemon simply
    // started without the credential and reported a healthy channel it could not open.
    harness.env["ACP_FAKE_BUZZ_ITEM_MISSING"] = "1";
    harness.env["ACP_FAKE_BUZZ_SECRETS_JSON"] = JSON.stringify({
      identity: "relay-credential-from-desktop-store",
      other: "not-this-one",
    });
    // The daemon only accepts a Buzz credential alongside its ingress pair.
    harness.env["ACP_BUZZ_INGRESS_SECRET"] = "ingress-secret";
    harness.env["ACP_BUZZ_ALLOWED_ACTORS"] = "actor-one";

    expect(
      runInstaller(
        installer,
        ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
        harness,
      ).status,
    ).toBe(0);

    const launcherSecurity = join(harness.home, "launcher-security.bash");
    writeFileSync(launcherSecurity, `security() { "${join(harness.bin, "security")}" "$@"; }\n`, {
      mode: 0o600,
    });
    const launcherEnv: NodeJS.ProcessEnv = { ...harness.env, BASH_ENV: launcherSecurity };
    delete launcherEnv["BUZZ_PRIVATE_KEY"];

    expect(spawnSync("bash", [launcherPath(harness)], { encoding: "utf8", env: launcherEnv }).status)
      .toBe(0);

    const [, , , , , , buzzKey] = readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(buzzKey).toBe("relay-credential-from-desktop-store");
  });

  it("derives reviewer credential scopes the daemon can read without the Keychain", () => {
    // Under `tools: "none"` a reviewer cannot spawn `security`, so its credential has to live
    // in a directory it is allowed to read rather than in the login Keychain. These are paths,
    // not secrets, so they are derived rather than fetched — the operator authenticates into a
    // known location instead of also having to publish where it is.
    //
    // The launcher previously exported neither, so a deployment that set
    // ACP_CLAUDE_REVIEWER_CONFIG_DIR in a shell would have seen the daemon ignore it.
    const harness = makeHarness();
    const installed = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );
    expect(installed.status).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    expect(launcher).toContain("ACP_STATE_DIR=");
    expect(launcher).toContain(
      'export ACP_CLAUDE_REVIEWER_CONFIG_DIR="${ACP_CLAUDE_REVIEWER_CONFIG_DIR:-$ACP_REVIEWER_ROOT/claude}"',
    );
    expect(launcher).toContain(
      'export ACP_CODEX_REVIEWER_HOME="${ACP_CODEX_REVIEWER_HOME:-$ACP_REVIEWER_ROOT/codex}"',
    );
  });

  it("#423 gives the daemon an absolute path to the Buzz CLI its own PATH cannot reach", () => {
    const harness = makeHarness();
    // The launcher pins PATH to the system directories. A `buzz` installed under a user-local
    // bin — which is where it is on this host — is then unreachable to the daemon while being
    // perfectly reachable from the shell that installed it, so a live capture run by hand
    // succeeds and production silently has no transport at all.
    const userLocalBin = join(harness.home, "user-local-bin");
    mkdirSync(userLocalBin, { recursive: true });
    const buzzPath = join(userLocalBin, "buzz");
    writeFileSync(buzzPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(buzzPath, 0o755);
    harness.env["PATH"] = `${userLocalBin}:${harness.env["PATH"] ?? ""}`;
    harness.env["ACP_BUZZ_INGRESS_SECRET"] = "ingress-secret";
    harness.env["ACP_BUZZ_ALLOWED_ACTORS"] = "actor-one";
    harness.env["ACP_FAKE_BUZZ_ITEM_MISSING"] = "1";
    harness.env["ACP_FAKE_BUZZ_SECRETS_JSON"] = JSON.stringify({ identity: "relay-credential" });

    expect(
      runInstaller(
        installer,
        ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
        harness,
      ).status,
    ).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    // Baked in at install time, while the installing shell's PATH was still visible.
    expect(launcher).toContain(buzzPath);
    // And it must be an absolute path the launchd PATH does not have to find.
    expect(buzzPath.startsWith("/")).toBe(true);
    expect(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].some((d) => buzzPath.startsWith(`${d}/`)))
      .toBe(false);

    // The file containing the path is not the daemon receiving it. Deleting the export while
    // leaving the baked value made every assertion above still pass — the launcher held the
    // right string and handed the daemon nothing. Running it is what tells them apart.
    const launcherSecurity = join(harness.home, "launcher-security.bash");
    writeFileSync(
      launcherSecurity,
      `security() { "${join(harness.bin, "security")}" "$@"; }\n`,
      { mode: 0o600 },
    );
    const launched = spawnSync("bash", [launcherPath(harness)], {
      encoding: "utf8",
      env: { ...harness.env, BASH_ENV: launcherSecurity },
    });
    expect(launched.status, launched.stderr).toBe(0);

    // What the daemon actually received, rather than what the file contains. The two differ:
    // deleting the ACP_BUZZ_BINARY export leaves every assertion above passing, because the
    // resolved path is still baked in as ACP_RESOLVED_BUZZ_BINARY.
    //
    // This asserts only that the value is not a Keychain answer. Asserting it equals buzzPath
    // fails — the launcher exports nothing here even though ACP_RESOLVED_BUZZ_BINARY is baked,
    // and I could not account for that in three attempts, so it is filed rather than guessed at.
    const [, , , , , , , resolvedBuzz] =
      readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(resolvedBuzz, "the launcher never exported the resolved Buzz binary").toBe(buzzPath);
  });

  it("#423 leaves BUZZ_PRIVATE_KEY unset rather than guessing when neither source has it", () => {
    const harness = makeHarness();
    harness.env["ACP_FAKE_BUZZ_ITEM_MISSING"] = "1";
    // The desktop store exists but holds nothing under the identity key.
    harness.env["ACP_FAKE_BUZZ_SECRETS_JSON"] = JSON.stringify({ other: "not-this-one" });

    expect(
      runInstaller(
        installer,
        ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
        harness,
      ).status,
    ).toBe(0);

    const launcherSecurity = join(harness.home, "launcher-security.bash");
    writeFileSync(launcherSecurity, `security() { "${join(harness.bin, "security")}" "$@"; }\n`, {
      mode: 0o600,
    });
    const launcherEnv: NodeJS.ProcessEnv = { ...harness.env, BASH_ENV: launcherSecurity };
    delete launcherEnv["BUZZ_PRIVATE_KEY"];

    // Absent is the correct outcome: the daemon must start, and `available()` refuses.
    const launched = spawnSync("bash", [launcherPath(harness)], {
      encoding: "utf8",
      env: launcherEnv,
    });
    expect(launched.status).toBe(0);
    const [, , , , , , buzzKey] = readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
    expect(buzzKey).toBe("<unset>");
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

  it("refuses a rollback that names no sealed pair, however many snapshots exist", () => {
    const harness = makeHarness();
    expect(
      runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness).status,
    ).toBe(0);
    // `upgrade` is the only caller of snapshot_current_deployment, so after this there is a
    // deployment snapshot on disk for an implicit selection to find and restore.
    expect(
      runInstaller(
        installer,
        ["upgrade", "--app-root", root, "--node", harness.node, "--no-start"],
        harness,
      ).status,
    ).toBe(0);
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(
      installer,
      ["rollback", "--app-root", root, "--node", harness.node],
      harness,
    );

    expect(result.status, "rollback proceeded without naming the pair it restores").not.toBe(0);
    expect(result.stderr).toContain("rollback requires --pair-id");
    expect(existsSync(harness.stateAdminLog)).toBe(false);
    expect(readFileSync(harness.launchLog, "utf8")).toBe("");
  });

  it("refuses rollback unless the retained index digest is supplied", () => {
    const harness = makeHarness();
    const result = runInstaller(
      installer,
      ["rollback", "--app-root", root, "--node", harness.node, "--pair-id", randomUUID()],
      harness,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rollback requires --expected-index-digest");
    expect(existsSync(harness.launchLog)).toBe(false);
  });

  it("refuses a rollback that does not state the schema, generation and runtime it restores", () => {
    const harness = makeHarness();
    const base = [
      "rollback",
      "--app-root",
      root,
      "--node",
      harness.node,
      "--pair-id",
      randomUUID(),
      "--expected-index-digest",
      `sha256:${"0".repeat(64)}`,
    ];
    const full = [
      ...base,
      "--expect-schema-version",
      "36",
      "--expect-service-generation",
      "generation-under-test",
      "--expect-node-version",
      "v22.18.0",
    ];

    // Each structural expectation is required on its own. An expectation a caller may omit is one
    // that will be omitted, and then a pair for one schema, generation or runtime is applied to a
    // deployment it was never sealed for with nothing objecting.
    for (const [omitted, message] of [
      ["--expect-schema-version", "requires --expect-schema-version"],
      ["--expect-service-generation", "requires --expect-service-generation"],
      ["--expect-node-version", "requires --expect-node-version"],
    ] as const) {
      const at = full.indexOf(omitted);
      const without = [...full.slice(0, at), ...full.slice(at + 2)];
      const result = runInstaller(installer, without, harness);
      expect(result.status, `rollback accepted a request omitting ${omitted}`).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
    expect(existsSync(harness.launchLog)).toBe(false);
  });

  it("refuses `latest` and every other name that is not a pair id", () => {
    const harness = makeHarness();
    for (const pairId of ["latest", "20260901T000000Z-newest", "..", "../elsewhere"]) {
      const result = runInstaller(
        installer,
        [
          "rollback",
          "--app-root",
          root,
          "--node",
          harness.node,
          "--pair-id",
          pairId,
          "--expected-index-digest",
          `sha256:${"0".repeat(64)}`,
        ],
        harness,
      );
      expect(result.status, `rollback accepted the pair id ${pairId}`).not.toBe(0);
      expect(result.stderr).toContain("must be a UUID, never a name like 'latest'");
    }
    expect(existsSync(harness.launchLog)).toBe(false);
  });

  it("refuses a pair whose index digest is not the one retained, before it stops anything", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    writeFileSync(harness.launchLog, "");
    const installedBefore = readFileSync(launcherPath(harness), "utf8");

    const result = runInstaller(
      installer,
      [
        "rollback",
        "--app-root",
        appRoot,
        "--node",
        harness.node,
        "--pair-id",
        fixture.pair.pairId,
        "--expected-index-digest",
        `sha256:${"0".repeat(64)}`,
        ...structuralFlags(fixture),
      ],
      harness,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("index digest does not match the retained digest");
    // Prevalidation means before, not during: nothing was stopped, staged or replaced.
    expect(readFileSync(harness.launchLog, "utf8")).toBe("");
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(installedBefore);
    expect(existsSync(join(harness.home, ".agent-control-plane", "rollback-stage"))).toBe(false);
  });

  it("creates nothing and changes no mode when it refuses a rollback", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const state = join(harness.home, ".agent-control-plane");
    const pairsRoot = join(state, "rollback-pairs");
    rmSync(pairsRoot, { recursive: true, force: true });
    const stateModeBefore = statSync(state).mode;
    const entriesBefore = readdirSync(state).sort();
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(
      installer,
      [
        "rollback",
        "--app-root",
        appRoot,
        "--node",
        harness.node,
        "--pair-id",
        randomUUID(),
        "--expected-index-digest",
        `sha256:${"0".repeat(64)}`,
        "--expect-schema-version",
        "36",
        "--expect-service-generation",
        "generation-under-test",
        "--expect-node-version",
        process.version,
      ],
      harness,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required directory does not exist");
    // The refusal is free: the directory it looked in was not conjured into existence, the state
    // root's mode was not adjusted, and nothing new appeared beside it.
    expect(existsSync(pairsRoot), "a refused rollback created the pairs root").toBe(false);
    expect(readdirSync(state).sort()).toEqual(entriesBefore);
    expect(statSync(state).mode).toBe(stateModeBefore);
    expect(readFileSync(harness.launchLog, "utf8")).toBe("");
  });

  it("waits for the daemon to stop, then installs the named pair's whole generation", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    // A second, later pair the old implicit `sort | tail -n 1` would have preferred. Nothing may
    // select it: this rollback names the first one.
    const newer = await sealPairFor(harness, appRoot, "generation-nobody-approved");
    expect(newer.pair.pairId).not.toBe(fixture.pair.pairId);

    // Generation B is live: a different runtime closure, plist and launcher.
    writeFileSync(join(appRoot, "dist", GENERATION_MARKER), "generation-b\n", { mode: 0o600 });
    writeFileSync(plistPath(harness), "<!-- generation-b -->\n", { mode: 0o600 });
    writeFileSync(launcherPath(harness), "#!/bin/bash\n# generation-b\n", { mode: 0o700 });

    writeFileSync(harness.loaded, "loaded\n", { mode: 0o600 });
    writeFileSync(harness.lock, "old daemon lock\n", { mode: 0o600 });
    writeFileSync(harness.launchLog, "");
    const rolledBack = runInstaller(
      installer,
      [
        "rollback",
        "--app-root",
        appRoot,
        "--node",
        harness.node,
        "--pair-id",
        fixture.pair.pairId,
        "--expected-index-digest",
        fixture.pair.indexDigest,
        ...structuralFlags(fixture),
      ],
      harness,
    );

    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    expect(existsSync(harness.lock)).toBe(false);
    // Two `print`s before the bootout: one asks whether the service was running so the original
    // state can be restored afterwards, one is `stop_job`'s own check.
    expect(subcommands(harness.launchLog)).toEqual([
      "print",
      "print",
      "bootout",
      "print",
      "bootstrap",
      "kickstart",
    ]);

    // The generation moved as one: runtime closure, plist and launcher are all the named pair's,
    // and none of them is the newer pair nobody approved.
    expect(readFileSync(join(appRoot, "dist", GENERATION_MARKER), "utf8").trim()).toBe("sealed-generation");
    expect(readFileSync(plistPath(harness), "utf8")).toContain("sealed-generation");
    expect(readFileSync(launcherPath(harness), "utf8")).toContain("sealed-generation");
    expect(readFileSync(launcherPath(harness), "utf8")).not.toContain("generation-nobody-approved");
    // The runtime installed is a working closure, restored through the pair's own state-admin.
    expect(existsSync(join(appRoot, "dist", "db", "state-admin.js"))).toBe(true);
    // The stage is not left lying around holding a copy of the deployment.
    expect(readdirSync(join(harness.home, ".agent-control-plane", "rollback-stage"))).toEqual([]);
  });

  it("leaves a deliberately stopped service stopped after a rollback", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    // Installed but never started: the operator's chosen state is "stopped".
    expect(
      runInstaller(
        installer,
        ["install", "--app-root", appRoot, "--node", harness.node, "--no-start"],
        harness,
      ).status,
    ).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    writeFileSync(harness.launchLog, "");

    const rolledBack = runInstaller(
      installer,
      [
        "rollback",
        "--app-root",
        appRoot,
        "--node",
        harness.node,
        "--pair-id",
        fixture.pair.pairId,
        "--expected-index-digest",
        fixture.pair.indexDigest,
        ...structuralFlags(fixture),
      ],
      harness,
    );

    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    // The generation was replaced, and the service was not started behind the operator's back.
    expect(readFileSync(join(appRoot, "dist", GENERATION_MARKER), "utf8").trim()).toBe(
      "sealed-generation",
    );
    const launchctl = subcommands(harness.launchLog);
    expect(launchctl, "a stopped service was started by the rollback").not.toContain("bootstrap");
    expect(launchctl).not.toContain("kickstart");
    expect(existsSync(harness.loaded)).toBe(false);
  });

  it("rejects a substring-only installer stub", () => {
    const stub = join(tempDir("acp-launchd-stub-"), "install-launchd.sh");
    const stubText = `#!/bin/bash
# Usage: install start restart upgrade rollback --pair-id --expected-index-digest
# find-generic-password render-launchd-plist.mjs
exit 0
`;
    writeExecutable(stub, stubText);
    execFileSync("bash", ["-n", stub]);
    for (const token of ["rollback", "--pair-id", "find-generic-password", "render-launchd-plist.mjs"]) {
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
