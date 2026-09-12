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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { parseLauncherBinding, sealRollbackPair, type SealedRollbackPair } from "../../src/deploy/rollback-pair.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const deploy = join(root, "deploy");
const installer = join(deploy, "install-launchd.sh");
const template = join(deploy, "com.agentcontrolplane.agentcpd.plist.template");
const label = "com.agentcontrolplane.agentcpd";
const CANONICAL_ACTIVATION_VARIABLES = [
  "ACP_CANONICAL_SESSION_UUID",
  "ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256",
  "ACP_CANONICAL_CTO_BUZZ_ACTOR_ID",
  "ACP_CANONICAL_CTO_WORKDIR",
  "ACP_CANONICAL_CTO_PEER_PROTOCOL",
  "ACP_CANONICAL_CTO_BUZZ_PURPOSE",
] as const;

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
  ACP_CANONICAL_*)
    case ",\${ACP_CANONICAL_KEYCHAIN_ACCOUNTS:-}," in
      *,"$account",*) ;;
      *) exit 44 ;;
    esac
    printf 'keychain-%s\\n' "$account"
    ;;
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
if [[ "$target" == *"/acp-provider-cli"* ]]; then
  # A provider CLI fixture whose shebang resolves its interpreter through the environment arrives
  # here: env finds this stub on the launcher's PATH and hands it the script. It is executed for
  # real, because a stub that answered without executing would report a CLI as started on a
  # launcher whose PATH could not reach an interpreter at all.
  #
  # This stub is the copy the installer places in the runtime closure, so the witness below is
  # only set when the shebang resolved to *that* interpreter. Without it the row is satisfied by
  # any interpreter the fixed directories happen to hold, and asserts nothing about the closure.
  export ACP_INTERPRETER_WITNESS=acp-runtime-node
  exec "$ACP_REAL_NODE" "$@"
fi
if [[ "$target" == *"agentcpd.js" ]]; then
  started_of() {
    local candidate="\${1:-}"
    [[ -n "$candidate" ]] || { printf 'unpinned'; return 0; }
    "$candidate" --version >/dev/null 2>&1 && printf 'started' || printf 'failed'
  }
  # Whether the daemon's own PATH reaches the tool a canonical self-claim resolves an executing
  # image with. lsofEntries (src/registry/canonical-self-claim.ts) spawns the bare name lsof and
  # consults no environment, so PATH is the only channel by which that call is reachable. The
  # report is the parsed scan rather than an exit status: an lsof that runs and reports no txt
  # record resolves no image either, and the claim is refused just the same.
  lsof_scan() {
    local out=""
    out="$(lsof -p $$ -FfptDin 2>/dev/null)" || { printf 'unrunnable'; return 0; }
    printf '%s' "$out" | grep -q '^ftxt$' && printf 'txt-reported' || printf 'no-txt'
  }
  # Fields are appended, never inserted: field position is the contract between this stub and its
  # readers, and every reader written before these destructures from the front (indices 0-7).
  # 8-10 are what the daemon was handed, 11-13 what its own PATH can find, 14 whether the handed
  # path runs, 15 which interpreter its PATH resolves, 16 whether an unrelated executable sitting
  # beside a provider CLI is reachable, 17-24 the atomic canonical activation group, and 25-26
  # where the bare name lsof resolves and what a real scan through it reports. They are
  # separate observations and a launcher can satisfy any of them without the others.
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$ACP_MCP_TOKEN" "$ACP_OPERATOR_TOKEN" \
    "\${ACP_TELEGRAM_BOT_TOKEN-}" "\${ACP_TELEGRAM_OWNER_ID-}" \
    "\${ACP_TELEGRAM_CHAT_ID-}" "\${ACP_TELEGRAM_WEBHOOK_SECRET-}" \
    "\${BUZZ_PRIVATE_KEY:-<unset>}" "\${ACP_BUZZ_BINARY:-<unset>}" \
    "\${ACP_CLAUDE_BINARY:-<unset>}" "\${ACP_CODEX_BINARY:-<unset>}" "\${ACP_GROK_BINARY:-<unset>}" \
    "$(command -v claude || printf '<unresolvable>')" \
    "$(command -v codex || printf '<unresolvable>')" \
    "$(command -v grok || printf '<unresolvable>')" \
    "$(started_of "\${ACP_CLAUDE_BINARY:-}"),$(started_of "\${ACP_CODEX_BINARY:-}"),$(started_of "\${ACP_GROK_BINARY:-}")" \
    "$(command -v node || printf '<unresolvable>')" \
    "$(command -v acp-sibling-probe || printf '<unresolvable>')" \
    "\${ACP_CANONICAL_SESSION_UUID-}" "\${ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION-}" \
    "\${ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH-}" "\${ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256-}" \
    "\${ACP_CANONICAL_CTO_BUZZ_ACTOR_ID-}" "\${ACP_CANONICAL_CTO_WORKDIR-}" \
    "\${ACP_CANONICAL_CTO_PEER_PROTOCOL-}" "\${ACP_CANONICAL_CTO_BUZZ_PURPOSE-}" \
    "$(command -v lsof || printf '<unresolvable>')" "$(lsof_scan)" >> "$ACP_LAUNCHER_ENV_LOG"
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
  // A relative PATH entry only means anything relative to a working directory. Rows that measure
  // what the installer does with a relative answer have to run it from the directory that answer
  // is relative to, or the shell resolves nothing and the row measures absence instead.
  cwd?: string,
): CommandResult => {
  const result = spawnSync("bash", [command, ...args], {
    encoding: "utf8",
    env: harness.env,
    ...(cwd ? { cwd } : {}),
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

/**
 * The launcher's PATH, as a single literal.
 *
 * Asserted whole rather than searched: a provider directory added anywhere in it would satisfy
 * every "the CLI resolves" assertion in this file while making every unrelated executable beside
 * that CLI resolvable to the daemon too.
 */
const EXPECTED_LAUNCHER_PATH_LINE =
  'export PATH="${ACP_NODE_PATH%/*}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"';

/** A PATH holding nothing a provider could be found in, so a row measures the pin and not the host. */
const isolatedInstallerPath = (harness: InstallerHarness, ...extra: string[]): string =>
  [harness.bin, ...extra, "/usr/bin", "/bin"].join(":");

/** Refuse to measure a pin on a host that already answers for the bare name some other way. */
const assertProviderUnresolvable = (harness: InstallerHarness, ...names: string[]): void => {
  for (const name of names) {
    expect(
      spawnSync("bash", ["-c", `command -v ${name}`], { env: harness.env }).status,
      `${name} resolves from the installer's PATH, so this row would measure the host and not the pin`,
    ).not.toBe(0);
  }
};

const writeProviderCli = (path: string, body: string): string => {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  // The canonical path, because that is what the installer pins: it resolves every answer to the
  // real file before recording it, so a fixture compared by the name it was created under would
  // disagree with a correct pin on any host whose temporary directory is itself a link.
  return realpathSync(path);
};

/** A provider CLI that carries its own interpreter, as a compiled one does. */
const SELF_CONTAINED_CLI = "#!/bin/sh\nexit 0\n";
/** A provider CLI that reaches its interpreter through the environment, as a packaged script does. */
const ENV_INTERPRETER_CLI =
  "#!/usr/bin/env node\n" +
  'process.exit(process.env.ACP_INTERPRETER_WITNESS === "acp-runtime-node" ? 0 : 1);\n';

const installWithPins = (harness: InstallerHarness): CommandResult =>
  runInstaller(
    installer,
    ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
    harness,
  );

/** Execute the generated launcher with `security` stubbed, as launchd would start it. */
const runGeneratedLauncher = (harness: InstallerHarness): CommandResult => {
  const launcherSecurity = join(harness.home, "launcher-security.bash");
  writeFileSync(launcherSecurity, `security() { "${join(harness.bin, "security")}" "$@"; }\n`, {
    mode: 0o600,
  });
  const launched = spawnSync("bash", [launcherPath(harness)], {
    encoding: "utf8",
    env: { ...harness.env, BASH_ENV: launcherSecurity },
  });
  return { status: launched.status, stdout: launched.stdout, stderr: launched.stderr };
};

/** What the daemon saw, by field. Positions are the contract; see the stub in `makeHarness`. */
const launcherObservations = (harness: InstallerHarness) => {
  const f = readFileSync(harness.launcherEnvLog, "utf8").trim().split("|");
  const byProvider = (a: number, b: number, c: number) =>
    ({ claude: f[a], codex: f[b], grok: f[c] }) as Record<string, string | undefined>;
  return {
    handed: byProvider(8, 9, 10),
    onPath: byProvider(11, 12, 13),
    started: f[14],
    node: f[15],
    sibling: f[16],
    /** Where the daemon's PATH resolves the bare name `lsof`, and what a scan through it reports. */
    lsof: f[25],
    lsofScan: f[26],
    canonical: Object.fromEntries(
      CANONICAL_ACTIVATION_VARIABLES.map((name, index) => [name, f[17 + index] ?? ""]),
    ) as Record<(typeof CANONICAL_ACTIVATION_VARIABLES)[number], string>,
  };
};

/** The interpreter the installer copies into the runtime closure, which the launcher binds to. */
const installedInterpreter = (): string => join(root, "dist", "bin", "node");

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
  for (const name of CANONICAL_ACTIVATION_VARIABLES) expect(plist).not.toContain(name);
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
  // No `native/` symlink: `dist/db/fd-vfs.js` now resolves the extension inside `dist` itself
  // (`dist/native/fd-vfs/build/Release/...`), which the `dist` copy above already carries because
  // `pnpm build` puts it there (`scripts/copy-native-fd-vfs-into-dist.mjs`). A symlink beside
  // `dist` would rebuild the exact escape hatch B2 closed — this fixture must pass because the
  // closure is complete, not because the test recreated the sibling path a rollback never restores.
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

/**
 * The repository tree as git sees it: tracked files plus untracked ones that are not ignored.
 *
 * `filesUnder(root)` walks the filesystem and skips only `.git`, so it also reads everything under
 * `evidence/local/` — which `.gitignore` covers and which the harnesses fill with scratch. A
 * 17 MB `evidence/local/mutation-verdict/gates-checkout/` left behind on 2026-09-09 holds its own
 * copy of `deploy/com.agentcontrolplane.agentcpd.plist.template`, and the "only plist artifact in
 * the tree" assertion failed on it — locally only, because a fresh CI checkout has no
 * `evidence/local/` at all. A test that passes on the runner and fails on every machine carrying
 * ordinary scratch is a test nobody can use to decide anything.
 *
 * Asking git is not a workaround for that; it is what the assertion already meant. "In the tree"
 * is a statement about what this repository contains, and `.gitignore` is where this repository
 * says what it does not.
 *
 * The filesystem walk this replaced is deleted rather than left beside it. An unused helper that
 * enumerates the tree the wrong way is an invitation to the same failure, and the next person
 * reaching for "list the files" would have had two choices with nothing marking which is right.
 */
const treeFiles = (): string[] =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => join(root, entry));

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

  it("B1: seals the launcher install-launchd.sh actually writes, not a hand-built fixture", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    // `sealRollbackPair` canonicalizes every `install.*` destination it is given (`canonical()`,
    // src/deploy/rollback-pair.ts) — resolving symlinks even for a path that may not exist yet — so
    // that its recorded identity is stable regardless of which route a caller named a destination
    // by. On a real deployment `$HOME` is `/Users/<name>`, with no symlink component, so this is a
    // no-op there. `os.tmpdir()` on macOS sits under `/var`, a symlink to `/private/var`, so a test
    // `$HOME` needs the same resolution *before* the installer writes anything, or the plist it
    // writes (raw, unresolved `$HOME`) and the identity the seal records for the same path (always
    // resolved) name the same file in two different spellings — a fixture artifact, not something
    // B1 is responsible for.
    const resolvedHome = realpathSync(harness.home);
    const installEnv: NodeJS.ProcessEnv = { ...harness.env, HOME: resolvedHome };
    const installed = spawnSync(
      "bash",
      [
        installer,
        "install",
        "--app-root",
        appRoot,
        "--node",
        harness.node,
        "--keychain-service",
        "test-service",
        "--no-start",
      ],
      { encoding: "utf8", env: installEnv },
    );
    expect(installed.status, installed.stderr ?? "").toBe(0);

    // The installer's own claim: the interpreter is cloned in-tree, not left pointing at whatever
    // `--node`/`command -v node` named.
    const installedNodePath = join(appRoot, "dist", "bin", "node");
    expect(existsSync(installedNodePath), "install-launchd.sh did not clone the interpreter into dist/bin").toBe(
      true,
    );
    expect(statSync(installedNodePath).mode & 0o111, "the cloned interpreter lost its execute bit").not.toBe(0);
    const launcherTextPath = join(resolvedHome, ".agent-control-plane", "agentcpd-launch.sh");
    const plistTextPath = join(resolvedHome, "Library", "LaunchAgents", `${label}.plist`);
    const launcherText = readFileSync(launcherTextPath, "utf8");
    expect(launcherText).toContain(`ACP_NODE_PATH=${installedNodePath}`);

    // The acceptance test itself: the runbook seals with `--install-runtime-root "$APP_ROOT/dist"
    // --node-executable bin/node` (docs/ops/owner-actions.md) against exactly the plist and
    // launcher `install-launchd.sh` wrote — not a fixture that already had the right answer baked
    // in. Before B1 this threw "the sealed launcher is not bound to the Node executable this pair
    // installs"; a hand-written launcher fixture never exercised that path at all.
    const state = join(resolvedHome, ".agent-control-plane");
    const databasePath = join(state, "b1-acceptance.sqlite");
    new Db(databasePath).close();
    chmodSync(databasePath, 0o600);
    const sealed = await sealRollbackPair(join(state, "rollback-pairs"), {
      databasePath,
      runtimeRoot: join(appRoot, "dist"),
      entrypoint: "daemon/agentcpd.js",
      stateAdmin: "db/state-admin.js",
      nodeExecutable: "bin/node",
      nodeVersion: process.version,
      install: {
        runtimeRoot: join(appRoot, "dist"),
        plistPath: plistTextPath,
        launcherPath: launcherTextPath,
        workingDirectory: appRoot,
      },
      launchd: {
        label,
        generation: "b1-acceptance",
        plistPath: plistTextPath,
        launcherPath: launcherTextPath,
      },
    });
    expect(sealed.pairId).toBeTruthy();
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

  it("clears all inherited canonical activation values together before any Keychain lookup", () => {
    const harness = makeHarness();
    for (const name of CANONICAL_ACTIVATION_VARIABLES) {
      harness.env[name] = `inherited-${name}-must-not-survive`;
    }

    expect(installWithPins(harness).status).toBe(0);
    const launcher = readFileSync(launcherPath(harness), "utf8");
    const clearAt = launcher.indexOf(`unset ${CANONICAL_ACTIVATION_VARIABLES.join(" ")}`);
    const firstLookupAt = launcher.indexOf('export ACP_MCP_TOKEN="$(required_keychain_value ACP_MCP_TOKEN)"');
    expect(clearAt, "the canonical group is not cleared by one explicit unset command").toBeGreaterThanOrEqual(0);
    expect(firstLookupAt, "the required Keychain lookup call is missing").toBeGreaterThan(clearAt);

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).canonical).toEqual(
      Object.fromEntries(CANONICAL_ACTIVATION_VARIABLES.map((name) => [name, ""])),
    );
  });

  it("round-trips the complete canonical group from explicit Keychain accounts only", () => {
    const harness = makeHarness();
    harness.env["ACP_CANONICAL_KEYCHAIN_ACCOUNTS"] = CANONICAL_ACTIVATION_VARIABLES.join(",");

    expect(installWithPins(harness).status).toBe(0);
    expect(existsSync(join(harness.home, ".agent-control-plane", "buzz-nostr-subscriber.json"))).toBe(false);
    assertRenderedPlist(harness);

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).canonical).toEqual(
      Object.fromEntries(
        CANONICAL_ACTIVATION_VARIABLES.map((name) => [name, `keychain-${name}`]),
      ),
    );
    const lookups = readFileSync(harness.securityLog, "utf8");
    for (const name of CANONICAL_ACTIVATION_VARIABLES) {
      expect(lookups).toContain(`find-generic-password -w -s test-service -a ${name}`);
    }
    expect(existsSync(join(harness.home, ".agent-control-plane", "buzz-nostr-subscriber.json"))).toBe(false);
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
    expect(
      ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"].some((d) =>
        buzzPath.startsWith(`${d}/`),
      ),
    ).toBe(false);

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

  it("#785 pins each provider CLI absolutely and puts no provider directory on the daemon's PATH", () => {
    const harness = makeHarness();
    // Three providers in three directories. `resolveExecutable` (src/runtime/cli-adapters.ts)
    // searches the daemon's PATH for the bare names, the launcher pins that PATH to a fixed set,
    // and a CLI installed elsewhere resolves to a bare name that never spawns — reported by the
    // capacity parser as no quota rather than as an error.
    const directories = ["a", "b", "c"].map((suffix) => {
      const directory = join(harness.home, `acp-provider-cli-${suffix}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    });
    const cli: Record<string, string> = {
      claude: writeProviderCli(join(directories[0] as string, "claude"), SELF_CONTAINED_CLI),
      codex: writeProviderCli(join(directories[1] as string, "codex"), SELF_CONTAINED_CLI),
      grok: writeProviderCli(join(directories[2] as string, "grok"), SELF_CONTAINED_CLI),
    };
    harness.env["PATH"] = isolatedInstallerPath(harness, ...directories);

    expect(installWithPins(harness).status).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    for (const [name, path] of Object.entries(cli)) {
      expect(launcher, `${name} was not resolved at install time`).toContain(path);
    }
    // Whole-line, so that no provider directory can be added anywhere in it.
    expect(launcher).toContain(EXPECTED_LAUNCHER_PATH_LINE);
    for (const directory of directories) {
      expect(launcher, "a provider directory reached the daemon's PATH").not.toContain(
        `${directory}:`,
      );
    }
    // Extra assignments must not cost the launcher its seal: the rollback pair reads it as a
    // closed grammar rather than searching it, so this uses the real parser.
    const binding = parseLauncherBinding(launcher, "test:#785");
    expect(binding.entrypoint).toBe("dist/daemon/agentcpd.js");
    expect(binding.appRoot).toBe(realpathSync(root));

    // The file holding a path is not the daemon receiving it: deleting an export while leaving
    // the baked value passes every assertion above and hands the daemon nothing. Run it.
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);

    for (const name of ["claude", "codex", "grok"]) {
      expect(seen.handed[name], `the launcher never exported a resolved ${name}`).toBe(cli[name]);
      // The pin is the only channel. If the directory were on PATH, this would resolve and the
      // row would pass for a reason it does not claim.
      expect(seen.onPath[name], `${name} is reachable through the daemon's PATH`).toBe(
        "<unresolvable>",
      );
    }
    expect(seen.started, "a pinned CLI did not start").toBe("started,started,started");
  });

  it("#785 leaves an executable sitting beside a provider CLI unreachable from the daemon", () => {
    const harness = makeHarness();
    // The reason a provider's directory is not added to PATH. A provider installs its CLI beside
    // whatever else its packaging ships, and this control plane selects executables by name; a
    // directory on the daemon's PATH makes every one of those names selectable.
    const directory = join(harness.home, "acp-provider-cli-shared");
    mkdirSync(directory, { recursive: true });
    const claude = writeProviderCli(join(directory, "claude"), SELF_CONTAINED_CLI);
    const sibling = writeProviderCli(join(directory, "acp-sibling-probe"), SELF_CONTAINED_CLI);
    harness.env["PATH"] = isolatedInstallerPath(harness, directory);

    expect(installWithPins(harness).status).toBe(0);
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);

    // The provider CLI arrives, by pin.
    expect(seen.handed["claude"]).toBe(claude);
    expect(seen.started?.split(",")[0]).toBe("started");
    // Its neighbour does not arrive at all, by any channel.
    expect(seen.sibling, "an unrelated executable beside a provider CLI is resolvable").toBe(
      "<unresolvable>",
    );
    expect(readFileSync(launcherPath(harness), "utf8")).not.toContain(sibling);
  });

  it("#785 resolves the interpreter to this deployment's own copy, not an ambient one", () => {
    const harness = makeHarness();
    harness.env["PATH"] = isolatedInstallerPath(harness);
    expect(installWithPins(harness).status).toBe(0);
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);

    // The launcher is bound to the interpreter the installer cloned into the runtime closure, and
    // its PATH has to name the same one: an ambient interpreter ahead of it on PATH would serve a
    // shebang lookup from outside the generation the sealed pair attests to.
    expect(launcherObservations(harness).node).toBe(installedInterpreter());
  });

  it("reaches lsof from the daemon's PATH, so a canonical self-claim can resolve an executing image", () => {
    const harness = makeHarness();
    // On Darwin a canonical self-claim resolves the claiming process's executing image by running
    // `lsof -p <pid> -FfptDin`, spawned under its bare name by `lsofEntries`
    // (src/registry/canonical-self-claim.ts). That call consults no environment, so an absolute
    // path baked into a variable has no reader and the daemon's PATH is the only channel that
    // reaches it. lsof ships in /usr/sbin; a PATH without that directory turns every scan into an
    // empty list, the executing image resolves to null, and a genuine claim is refused as CONFLICT
    // with evidence that carries a pid and names neither the missing tool nor the cause.
    harness.env["PATH"] = isolatedInstallerPath(harness);
    expect(installWithPins(harness).status).toBe(0);
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);

    // What the daemon's PATH resolves, not what the PATH line reads. A row that searched the
    // launcher text for /usr/sbin would pass on a PATH that still cannot run the tool.
    expect(seen.lsof, "the daemon's PATH does not resolve lsof").not.toBe("<unresolvable>");
    expect(
      seen.lsof?.startsWith("/"),
      "lsof resolved to something that is not an absolute path",
    ).toBe(true);
    // Resolving is not answering. The claim needs a txt record back from a real scan, so the row
    // runs one rather than stopping at the lookup.
    expect(seen.lsofScan, "lsof resolved but reported no executing image").toBe("txt-reported");
  });

  it("#785 starts a provider CLI that finds its interpreter through the environment", () => {
    const harness = makeHarness();
    // A packaged CLI is commonly a script whose shebang resolves its interpreter by name, so an
    // absolute pin alone is not enough — the interpreter has to be on the daemon's PATH as well.
    // It comes from this deployment's runtime closure rather than from the provider's directory,
    // which stays off PATH entirely.
    const directory = join(harness.home, "acp-provider-cli-scripted");
    mkdirSync(directory, { recursive: true });
    const codex = writeProviderCli(join(directory, "codex"), ENV_INTERPRETER_CLI);
    harness.env["PATH"] = isolatedInstallerPath(harness, directory);

    expect(installWithPins(harness).status).toBe(0);
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);

    expect(seen.handed["codex"]).toBe(codex);
    // Its own directory is not reachable, so nothing here comes from the provider's location.
    expect(seen.onPath["codex"]).toBe("<unresolvable>");
    // And it ran under the interpreter this deployment installed. The fixture exits non-zero
    // unless the interpreter that executed it was the runtime copy, so an ambient interpreter in
    // one of the fixed directories cannot satisfy this row in place of the closure's own.
    expect(
      seen.started?.split(",")[1],
      "the env-shebang CLI did not start under this deployment's interpreter",
    ).toBe("started");
  });

  it("#785 supports a provider CLI installed outside any bin directory", () => {
    const harness = makeHarness();
    // A CLI can sit at a path with no directory worth adding to anything — a native build under
    // its own root, or a single file. The pin carries it; nothing about its parent directory is
    // encoded into the daemon's PATH.
    const grok = writeProviderCli(join(harness.home, "grok"), SELF_CONTAINED_CLI);
    harness.env["PATH"] = isolatedInstallerPath(harness, harness.home);

    expect(installWithPins(harness).status).toBe(0);
    const launcher = readFileSync(launcherPath(harness), "utf8");
    expect(launcher).toContain(grok);
    expect(launcher).toContain(EXPECTED_LAUNCHER_PATH_LINE);
    expect(launcher, "the CLI's parent directory was encoded into a PATH").not.toContain(
      `${harness.home}:`,
    );

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.handed["grok"]).toBe(grok);
    expect(seen.onPath["grok"]).toBe("<unresolvable>");
    expect(seen.started?.split(",")[2]).toBe("started");
  });

  it("#785 pins a symlinked CLI at its canonical target and refuses a relative, non-executable or absent one", () => {
    const harness = makeHarness();
    // Four ways the installing shell can answer for a name, and what each is worth to a daemon
    // that runs from a different working directory and cannot search.
    const real = join(harness.home, "acp-provider-cli-real");
    mkdirSync(real, { recursive: true });
    const onPath = join(harness.home, "acp-provider-cli-onpath");
    mkdirSync(onPath, { recursive: true });

    // A symlink is a name for a file, not the file. What is pinned is the target it resolves to.
    const claudeTarget = writeProviderCli(join(real, "claude-1.0"), SELF_CONTAINED_CLI);
    symlinkSync(claudeTarget, join(onPath, "claude"));
    // A file that is present but not executable is not a CLI; the shell does not answer for it.
    writeFileSync(join(onPath, "codex"), SELF_CONTAINED_CLI, { mode: 0o644 });
    chmodSync(join(onPath, "codex"), 0o644);
    // A relative answer names nothing a daemon in another working directory can reach, and would
    // reach resolveExecutable's absolute-path branch, which returns it unchanged rather than
    // searching. `grok` resolves only through a relative PATH entry.
    const relative = "acp-provider-cli-relative";
    mkdirSync(join(harness.home, relative), { recursive: true });
    writeProviderCli(join(harness.home, relative, "grok"), SELF_CONTAINED_CLI);

    harness.env["PATH"] = `${harness.bin}:${onPath}:${relative}:/usr/bin:/bin`;
    // The premise, asserted rather than assumed: from this working directory the shell really does
    // answer with the relative spelling. Run anywhere else and it answers with nothing, and the
    // row below would be measuring an absent CLI while claiming to measure a relative one.
    const relativeAnswer = spawnSync("bash", ["-c", "command -v grok"], {
      encoding: "utf8",
      env: harness.env,
      cwd: harness.home,
    });
    expect(relativeAnswer.stdout.trim(), "the fixture did not produce a relative answer").toBe(
      `${relative}/grok`,
    );

    const installed = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
      harness.home,
    );
    expect(installed.status, installed.stderr).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    // Pinned as the canonical target, never as the link that named it.
    expect(launcher).toContain(`ACP_RESOLVED_CLAUDE_BINARY=${realpathSync(claudeTarget)}`);
    expect(launcher, "the launcher pinned the link rather than its target").not.toContain(
      `ACP_RESOLVED_CLAUDE_BINARY=${join(onPath, "claude")}`,
    );
    // Not pinned: neither the unexecutable file nor anything relative.
    expect(launcher, "a non-executable file was pinned").not.toContain("ACP_RESOLVED_CODEX_BINARY=");
    expect(launcher, "a relative path was pinned").not.toContain("ACP_RESOLVED_GROK_BINARY=");
    expect(launcher).not.toContain(`=${relative}/`);
    for (const name of ["codex", "grok"]) {
      expect(installed.stderr).toContain(`could not resolve the ${name} CLI`);
    }

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.handed["claude"]).toBe(realpathSync(claudeTarget));
    expect(seen.started?.split(",")[0]).toBe("started");
    expect(seen.handed["codex"]).toBe("<unset>");
    expect(seen.handed["grok"]).toBe("<unset>");
  });

  it("#785 keeps running the binary it pinned when the symlink that named it is repointed", () => {
    const harness = makeHarness();
    // The reason a pin is canonical. A pin that recorded the link would still read as correct
    // after the link moved, and the daemon would run a provider binary this install never saw.
    const real = join(harness.home, "acp-provider-cli-real");
    mkdirSync(real, { recursive: true });
    const onPath = join(harness.home, "acp-provider-cli-onpath");
    mkdirSync(onPath, { recursive: true });
    const accepted = writeProviderCli(join(real, "claude-1.0"), SELF_CONTAINED_CLI);
    const substitute = writeProviderCli(join(real, "claude-2.0"), SELF_CONTAINED_CLI);
    const link = join(onPath, "claude");
    symlinkSync(accepted, link);
    harness.env["PATH"] = isolatedInstallerPath(harness, onPath);

    expect(installWithPins(harness).status).toBe(0);

    // The link now names a different binary. Nothing about the installed deployment changed.
    rmSync(link);
    symlinkSync(substitute, link);

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.handed["claude"], "repointing the symlink changed which binary the daemon runs").toBe(
      realpathSync(accepted),
    );
    expect(seen.handed["claude"]).not.toBe(realpathSync(substitute));
  });

  /** A valid app root at `where`: the builds and renderer the installer requires. */
  const buildAppRootAt = (where: string): string => {
    mkdirSync(where, { recursive: true });
    cpSync(join(root, "dist"), join(where, "dist"), { recursive: true });
    cpSync(join(root, "deploy"), join(where, "deploy"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(where, "node_modules"));
    // The source tree may already carry an interpreter another install put there, and the copy
    // brings it along. Removing it is what makes its absence attributable to a refusal.
    rmSync(join(where, "dist", "bin"), { recursive: true, force: true });
    return where;
  };

  /** Nothing an install does to the filesystem or the service may have happened. */
  const expectNothingInstalled = (harness: InstallerHarness, appRoot: string): void => {
    expect(
      existsSync(join(appRoot, "dist", "bin", "node")),
      "the interpreter was installed into a refused app root",
    ).toBe(false);
    // The clone creates this directory before it writes the file, so its absence is the earlier
    // and stricter statement: not even the first step of the first effect ran.
    expect(
      existsSync(join(appRoot, "dist", "bin")),
      "the runtime interpreter directory was created for a refused install",
    ).toBe(false);
    expect(existsSync(launcherPath(harness)), "a launcher was written for a refused app root").toBe(false);
    expect(existsSync(plistPath(harness)), "a plist was rendered for a refused app root").toBe(false);
    expect(
      existsSync(join(harness.home, ".agent-control-plane")),
      "the state directory was created for a refused app root",
    ).toBe(false);
    expect(existsSync(harness.launchLog), "launchctl was called for a refused app root").toBe(false);
  };

  it("#785 refuses an app root that canonicalises onto a path no PATH entry can hold", () => {
    const harness = makeHarness();
    // The launcher exports the app root's runtime interpreter directory as a POSIX PATH entry,
    // where ':' separates entries, so such a path splits into two entries naming nothing.
    //
    // The input given here carries no ':' at all — it is a plain symlink that resolves onto one.
    // A guard placed on what the caller typed accepts this and installs a broken deployment; only
    // a guard on the canonical path refuses it. That ordering is the property under test, and a
    // literal colon argument cannot measure it.
    const parent = tempDir("acp-launchd-colon-approot-");
    const colonRoot = buildAppRootAt(join(parent, "app:root"));
    const colonFreeInput = join(parent, "plain-approot");
    symlinkSync(colonRoot, colonFreeInput);
    expect(colonFreeInput).not.toContain(":");

    const refused = runInstaller(
      installer,
      ["install", "--app-root", colonFreeInput, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );
    expect(refused.status, refused.stdout).not.toBe(0);
    expect(refused.stderr).toContain("cannot contain ':' after canonicalisation");

    // A refusal is written to a terminal, a log and often an issue. The app root is the caller's
    // private filesystem layout and does not belong in any of them.
    const output = `${refused.stdout}${refused.stderr}`;
    expect(output, "the refusal disclosed the canonical app root").not.toContain(colonRoot);
    expect(output, "the refusal disclosed the supplied app root").not.toContain(colonFreeInput);
    expect(output, "the refusal disclosed the caller's directory layout").not.toContain(parent);

    expectNothingInstalled(harness, colonRoot);

    // The same tree at a path without the separator installs. Nothing but the ':' differs, so it
    // is the whole reason for the refusal rather than a property of the fixture.
    const plainRoot = join(parent, "approot");
    renameSync(colonRoot, plainRoot);
    rmSync(colonFreeInput);
    symlinkSync(plainRoot, colonFreeInput);
    const accepted = runInstaller(
      installer,
      ["install", "--app-root", colonFreeInput, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(readFileSync(launcherPath(harness), "utf8")).toContain(EXPECTED_LAUNCHER_PATH_LINE);
    // The positive control for the fails-closed assertions: an accepted install does clone the
    // interpreter, so their absence above is a fact about the refusal rather than an assertion
    // that could never have observed anything.
    expect(existsSync(join(plainRoot, "dist", "bin", "node"))).toBe(true);
  });

  it("#785 refuses the filesystem root as an app root, and binds a real one without a doubled slash", () => {
    const harness = makeHarness();
    // Every path the installer derives is "$app_root/...", which at the filesystem root yields a
    // leading '//' whose meaning POSIX leaves to the implementation — while the sealed rollback
    // binding canonicalises the same location to a single '/'. The two would disagree about one
    // install, so the root is refused before anything is written.
    const refused = runInstaller(
      installer,
      ["install", "--app-root", "/", "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );
    expect(refused.status, refused.stdout).not.toBe(0);
    expect(refused.stderr).toContain("cannot be the filesystem root");
    expect(existsSync(launcherPath(harness)), "a launcher was written for the filesystem root").toBe(false);
    expect(existsSync(plistPath(harness)), "a plist was rendered for the filesystem root").toBe(false);
    expect(
      existsSync(join(harness.home, ".agent-control-plane")),
      "the state directory was created for the filesystem root",
    ).toBe(false);
    expect(existsSync(harness.launchLog), "launchctl was called for the filesystem root").toBe(false);

    // And the binding a real app root does produce carries no doubled separator, in the node path
    // the launcher execs or in the PATH entry derived from it.
    expect(installWithPins(harness).status).toBe(0);
    const launcher = readFileSync(launcherPath(harness), "utf8");
    const binding = parseLauncherBinding(launcher, "test:#785-root");
    expect(binding.nodePath).not.toContain("//");
    expect(binding.appRoot).not.toContain("//");
    expect(launcher).toContain(EXPECTED_LAUNCHER_PATH_LINE);
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).node, "the daemon's interpreter path is not canonical").toBe(
      installedInterpreter(),
    );
  });

  it("#785 refuses a Node path that does not resolve to a regular executable, before any effect", () => {
    const harness = makeHarness();
    // `-x` alone accepts things that are not programs: a directory carries the execute bit, so a
    // link to one passes an executable test and is then copied into the runtime closure as the
    // interpreter the whole generation is bound to. Requiring the canonical target to be a regular
    // file is what rejects it, and it happens before the clone that is the first effect.
    const appRoot = buildAppRootAt(join(tempDir("acp-launchd-node-shape-"), "approot"));
    const directory = join(harness.home, "not-a-program");
    mkdirSync(directory, { recursive: true });
    const link = join(harness.home, "node-link");
    symlinkSync(directory, link);
    expect(statSync(link).isDirectory(), "the fixture must resolve to a directory").toBe(true);

    const refused = runInstaller(
      installer,
      ["install", "--app-root", appRoot, "--node", link, "--keychain-service", "test-service"],
      harness,
    );
    expect(refused.status, refused.stdout).not.toBe(0);
    expect(refused.stderr).toContain("does not resolve to an absolute regular executable");
    expectNothingInstalled(harness, appRoot);
  });

  it("#785 says a path did not resolve without saying what the path was", () => {
    const harness = makeHarness();
    // A link can stop being readable between the predicate that finds it and the call that reads
    // it. The utility reports that by printing the path it was given, and that line crosses the
    // installer boundary on its own — ahead of the generic refusal, which cannot retract it. The
    // branch is forced here by a `readlink` that fails the way the real one does under that race.
    const supplied = "ACPSUPPLIEDSENTINEL";
    const canonical = "ACPCANONICALSENTINEL";
    const target = writeProviderCli(join(harness.home, `node-${canonical}`), SELF_CONTAINED_CLI);
    const link = join(harness.home, `node-${supplied}`);
    symlinkSync(target, link);
    // Emits both paths the way the real utility emits the one it was handed, so the row measures
    // suppression of the channel rather than of one particular sentence.
    writeExecutable(
      join(harness.bin, "readlink"),
      `#!/bin/bash\nprintf 'readlink: %s: Permission denied (target %s)\\n' "\${2:-}" "${target}" >&2\nexit 1\n`,
    );

    const refused = runInstaller(
      installer,
      ["install", "--app-root", root, "--node", link, "--keychain-service", "test-service"],
      harness,
    );
    expect(refused.status, refused.stdout).not.toBe(0);
    // The stable diagnostic is present …
    expect(refused.stderr).toContain("does not resolve to an absolute regular executable");
    // … and asserting only that would pass with the leaked line sitting directly above it.
    const output = `${refused.stdout}${refused.stderr}`;
    expect(output, "the supplied path leaked through the utility's stderr").not.toContain(supplied);
    expect(output, "the canonical path leaked through the utility's stderr").not.toContain(canonical);
    expect(output, "a raw utility diagnostic crossed the installer boundary").not.toContain(
      "Permission denied",
    );
  });

  it("#785 names each provider CLI it could not resolve and installs anyway", () => {
    const harness = makeHarness();
    // grok is optional and a host without it must still be able to deploy, so nothing is pinned
    // and nothing is refused. What it must not be is silent: an absent CLI reports as no quota,
    // which is indistinguishable from a provider that is out of quota unless the install says so.
    harness.env["PATH"] = isolatedInstallerPath(harness);
    assertProviderUnresolvable(harness, "claude", "codex", "grok");

    const installed = installWithPins(harness);
    expect(installed.status, installed.stderr).toBe(0);
    for (const name of ["claude", "codex", "grok"]) {
      expect(installed.stderr, `the installer said nothing about ${name}`).toContain(
        `could not resolve the ${name} CLI`,
      );
    }
    expect(installed.stderr).toContain("will report no quota");

    // Nothing is baked for a CLI that was not found: a bare name would take the absolute-path
    // branch in `resolveExecutable` and then fail to stat, which is worse than searching PATH.
    const launcher = readFileSync(launcherPath(harness), "utf8");
    for (const variable of [
      "ACP_RESOLVED_CLAUDE_BINARY",
      "ACP_RESOLVED_CODEX_BINARY",
      "ACP_RESOLVED_GROK_BINARY",
    ]) {
      expect(launcher, `${variable} was baked for a CLI that was never found`).not.toContain(
        `${variable}=`,
      );
    }

    const launched = runGeneratedLauncher(harness);
    // The daemon still starts. An unresolved provider is a degraded deployment, not a dead one.
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    for (const name of ["claude", "codex", "grok"]) expect(seen.handed[name]).toBe("<unset>");
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
    const tree = treeFiles();
    expect(tree.filter((path) => path.endsWith(".plist"))).toEqual([]);
    expect(readFileSync(template, "utf8")).toContain("__ACP_");
    expect(tree.filter((path) => path.endsWith(".plist.template"))).toEqual([template]);
  });
});
