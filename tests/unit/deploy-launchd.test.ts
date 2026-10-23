import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { commitlorePin } from "../../src/bootstrap/commitlore-pin.ts";
import { Db } from "../../src/db/database.ts";
import { parseLauncherBinding, sealRollbackPair, type SealedRollbackPair } from "../../src/deploy/rollback-pair.ts";
import { boundedExecFileSync, boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { stableFixtureBinDir, stableFixtureExecutable, stableFixtureLink } from "../helpers/stable-fixture-executable.ts";

afterAll(cleanupTempDirs);

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const deploy = join(root, "deploy");
const installer = join(deploy, "install-launchd.sh");
const template = join(deploy, "com.agentcontrolplane.agentcpd.plist.template");
const label = "com.agentcontrolplane.agentcpd";
/**
 * What `install-launchd.sh` provisions and the generated launcher forwards and then unsets — the
 * installer's list, which this suite pins field by field. It is still six. The daemon's own
 * activation group is three (`agentcpd.ts` `CANONICAL_ACTIVATION_VARS`): the three executor-image
 * variables here reach the daemon and are read by nothing, which `daemon-startup.test.ts` asserts.
 */
const CANONICAL_ACTIVATION_VARIABLES = [
  "ACP_CANONICAL_SESSIONS_JSON",
  "ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256",
  "ACP_CANONICAL_CTO_PEER_PROTOCOL",
  "ACP_CANONICAL_CTO_BUZZ_PURPOSE",
] as const;
/**
 * No head variable: `ACP_HERMES_EXPECTED_LIVE_SESSION_ID` and `ACP_HERMES_TARGET_SESSION_ID` are read
 * by nothing since the head follows the Gateway inside the lineage, so the launcher no longer looks
 * them up (2026-10-03).
 */
const HERMES_RETIRED_HEAD_VARIABLES = ["ACP_HERMES_EXPECTED_LIVE_SESSION_ID", "ACP_HERMES_TARGET_SESSION_ID"] as const;
const HERMES_ADOPTION_VARIABLES = [
  "ACP_HERMES_LINEAGE_ROOT_DIGEST", "ACP_HERMES_EXECUTABLE", "ACP_HERMES_PROFILE",
  "ACP_HERMES_HOME", "ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY", "ACP_HERMES_GATEWAY_API_KEY",
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

/**
 * Overrides one PATH-resolved name for a single test by prepending a stable, content-hashed
 * shim directory ahead of the harness's own (also stable, shared-across-tests) `bin`. `bin`
 * itself must never be written into after `makeHarness` creates it — it is shared by every test
 * that calls `makeHarness`, so two tests wanting different content for the same name (e.g. a
 * `sleep` that exits immediately instead of the default short delay) need their own directory,
 * not a rewrite of the shared one.
 */
const overridePath = (harness: InstallerHarness, name: string, script: string): void => {
  const shimDirectory = dirname(stableFixtureExecutable(name, script));
  harness.env["PATH"] = `${shimDirectory}:${harness.env["PATH"]}`;
};

const makeHarness = (): InstallerHarness => {
  const home = tempDir("acp-launchd-home-");
  // `bin` is a stable, content-hashed directory shared across every call to `makeHarness`, not a
  // fresh `fake-bin` subdirectory of `home`: the scripts below are constant text (every per-run
  // value they need travels through an env var the harness sets, never through the script
  // itself), so writing a fresh copy into a fresh tempDir on every test only minted a new
  // executable inode per test for syspolicyd's provenance table, which cannot be pruned. See
  // tests/helpers/stable-fixture-executable.ts.
  const launchctlScript = `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ACP_LAUNCHCTL_LOG"
case "\${1:-}" in
  print)
    if [[ -e "$ACP_LAUNCHD_BOOTOUT_PENDING" ]]; then
      remaining="$(cat "$ACP_LAUNCHD_BOOTOUT_PENDING")"
      if [[ "$remaining" -eq 0 ]]; then
        rm -f "$ACP_LAUNCHD_BOOTOUT_PENDING" "$ACP_LAUNCHD_LOADED"
      else
        printf '%s\\n' "$((remaining - 1))" > "$ACP_LAUNCHD_BOOTOUT_PENDING"
      fi
    fi
    [[ -e "$ACP_LAUNCHD_LOADED" ]] || exit 1
    if [[ -n "\${ACP_FAKE_START_AFTER_PRINTS:-}" && -e "$ACP_FAKE_START_PRINTS" ]]; then
      prints="$(cat "$ACP_FAKE_START_PRINTS")"
      prints="$((prints + 1))"
      printf '%s\\n' "$prints" > "$ACP_FAKE_START_PRINTS"
      if [[ "$prints" -eq "$ACP_FAKE_START_AFTER_PRINTS" ]]; then
        mkdir -p "$(dirname "$ACP_FAKE_STDOUT_LOG")"
        printf '  "started": {\\n' >> "$ACP_FAKE_STDOUT_LOG"
      fi
    fi
    if [[ "\${ACP_FAKE_PID_MODE:-running}" == "running" ]]; then
      printf '    pid = 4242\\n'
    elif [[ "\${ACP_FAKE_PID_MODE:-running}" == "none" ]]; then
      printf '    last exit code = 0\\n'
    elif [[ "\${ACP_FAKE_PID_MODE:-running}" == "recovers" ]]; then
      prints="$(cat "$ACP_FAKE_RECOVERY_PRINTS")"
      prints="$((prints + 1))"
      printf '%s\\n' "$prints" > "$ACP_FAKE_RECOVERY_PRINTS"
      if [[ "$prints" -ge 60 ]]; then printf '    pid = 4242\\n'; fi
    elif [[ "\${ACP_FAKE_PID_MODE:-running}" == "disappears" ]]; then
      remaining="$(cat "$ACP_FAKE_PID_PRINTS_REMAINING")"
      if [[ "$remaining" -gt 0 ]]; then
        printf '    pid = 4242\\n'
        printf '%s\\n' "$((remaining - 1))" > "$ACP_FAKE_PID_PRINTS_REMAINING"
      fi
    fi
    ;;
  bootstrap)
    touch "$ACP_LAUNCHD_LOADED"
    ;;
  bootout)
    if [[ -n "\${ACP_BOOTOUT_PRINT_LAG:-}" ]]; then
      printf '%s\\n' "$ACP_BOOTOUT_PRINT_LAG" > "$ACP_LAUNCHD_BOOTOUT_PENDING"
    else
      rm -f "$ACP_LAUNCHD_LOADED"
    fi
  if [[ -n "\${ACP_STOP_DELAY:-}" && -n "\${ACP_LOCK_PATH:-}" ]]; then
      (/bin/sleep "$ACP_STOP_DELAY"; rm -f "$ACP_LOCK_PATH") >/dev/null 2>&1 &
    fi
    ;;
  kickstart)
    if [[ "\${ACP_KICKSTART_UNLOAD:-0}" == "1" ]]; then rm -f "$ACP_LAUNCHD_LOADED"; fi
    if [[ "\${ACP_FAKE_PID_MODE:-running}" == "disappears" ]]; then
      printf '3\\n' > "$ACP_FAKE_PID_PRINTS_REMAINING"
    elif [[ "\${ACP_FAKE_PID_MODE:-running}" == "recovers" ]]; then
      printf '0\\n' > "$ACP_FAKE_RECOVERY_PRINTS"
    fi
    if [[ "\${ACP_FAKE_START_MARKER:-1}" == "1" ]]; then
      mkdir -p "$(dirname "$ACP_FAKE_STDOUT_LOG")"
      printf '  "started": {\\n' >> "$ACP_FAKE_STDOUT_LOG"
    fi
    if [[ -n "\${ACP_FAKE_START_AFTER_PRINTS:-}" ]]; then
      printf '0\\n' > "$ACP_FAKE_START_PRINTS"
    fi
    ;;
  *)
    exit 64
    ;;
esac
`;
  // Shorten start_job's one-second polls while leaving the two-second stop-lock fake observable.
  const sleepScript = "#!/bin/bash\n/bin/sleep 0.1\n";
  const securityScript = `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ACP_SECURITY_LOG"
# What the real \`security find-generic-password -w\` prints, as the CTO observed it with /usr/bin/security
# against a throwaway keychain (PR #1152 round 3): a stored value that contains a newline comes back as
# its lowercase hex ("/usr/bin/true\\n" as 2f7573722f62696e2f747275650a), any other value as itself, and
# either one is followed by a single newline security appends. Only that observed rule is reproduced.
answer() {
  local value="$1"
  if [[ "$value" == *$'\\n'* ]]; then
    printf '%s' "$value" | od -An -v -tx1 | tr -d ' \\n'
    printf '\\n'
  else
    printf '%s\\n' "$value"
  fi
}
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
  # The packet reviewer's private Codex home override is optional: no item unless a row stores one.
  ACP_REVIEWER_CODEX_HOME) [[ -n "\${ACP_FAKE_REVIEWER_CODEX_HOME:-}" ]] || exit 44
                           printf '%s\\n' "$ACP_FAKE_REVIEWER_CODEX_HOME" ;;
  # CommitLore's pin (#246 B3) is optional: no item unless a row stores one, so the catch-all cannot
  # answer for it, and a row can make the lookup itself fail with a status other than 44.
  ACP_COMMITLORE_BINARY)
    [[ -z "\${ACP_FAKE_COMMITLORE_LOOKUP_STATUS:-}" ]] || exit "$ACP_FAKE_COMMITLORE_LOOKUP_STATUS"
    # An item that exists and holds nothing: the lookup succeeds and answers an empty line, which is
    # not the "no item" of exit 44.
    [[ "\${ACP_FAKE_COMMITLORE_EMPTY_ITEM:-0}" != "1" ]] || { printf '\\n'; exit 0; }
    [[ -n "\${ACP_FAKE_COMMITLORE_BINARY_ITEM:-}" ]] || exit 44
    answer "$ACP_FAKE_COMMITLORE_BINARY_ITEM" ;;
  # The resident host provisioner's override and its Buzz admission argv (v52) are optional: no item
  # unless a row stores one, so the catch-all cannot answer for either.
  ACP_HOST_PROJECT_PROVISIONER) [[ -n "\${ACP_FAKE_HOST_PROJECT_PROVISIONER_ITEM:-}" ]] || exit 44
                                answer "$ACP_FAKE_HOST_PROJECT_PROVISIONER_ITEM" ;;
  ACP_BUZZ_ADMISSION_COMMAND) [[ -n "\${ACP_FAKE_BUZZ_ADMISSION_COMMAND_ITEM:-}" ]] || exit 44
                              answer "$ACP_FAKE_BUZZ_ADMISSION_COMMAND_ITEM" ;;
  ACP_CANONICAL_*)
    case ",\${ACP_CANONICAL_KEYCHAIN_ACCOUNTS:-}," in
      *,"$account",*) ;;
      *) exit 44 ;;
    esac
    printf 'keychain-%s\\n' "$account"
    ;;
  ACP_HERMES_*)
    case ",\${ACP_HERMES_KEYCHAIN_ACCOUNTS:-}," in
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
`;
  const nodeWrapperScript = `#!/bin/bash
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
  # readers. The order is: the eight leading observations (0-7), what the daemon was handed, what
  # its own PATH can find, whether the handed path runs, which interpreter its PATH resolves,
  # whether an unrelated executable sitting beside a provider CLI is reachable, then the atomic
  # canonical activation group, then where the bare name lsof resolves and what a real scan through
  # it reports, then the optional Hermes adoption group, then the reviewer's Codex home override, then
  # the resident host provisioner and its Buzz admission argv (v52).
  # These are separate observations and a launcher can satisfy any of them without the others. The
  # CommitLore pin is recorded below, in a file of its own.
  #
  # The positions of the last three are deliberately NOT written here. They are derived in
  # launcherObservations from the activation groups own lengths, and the numbers this comment used
  # to carry had already gone stale twice: it said the canonical group ran 17-24 when it runs 17-22,
  # put lsof at 25-26 when it is 23-24, and gave Hermes an overlapping 26-33. A comment restating a
  # derived position is the second authority the derivation was introduced to remove.
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$ACP_MCP_TOKEN" "$ACP_OPERATOR_TOKEN" \\
    "\${ACP_TELEGRAM_BOT_TOKEN-}" "\${ACP_TELEGRAM_OWNER_ID-}" \\
    "\${ACP_TELEGRAM_CHAT_ID-}" "\${ACP_TELEGRAM_WEBHOOK_SECRET-}" \\
    "\${BUZZ_PRIVATE_KEY:-<unset>}" "\${ACP_BUZZ_BINARY:-<unset>}" \\
    "\${ACP_CLAUDE_BINARY:-<unset>}" "\${ACP_CODEX_BINARY:-<unset>}" "\${ACP_GROK_BINARY:-<unset>}" \\
    "$(command -v claude || printf '<unresolvable>')" \\
    "$(command -v codex || printf '<unresolvable>')" \\
    "$(command -v grok || printf '<unresolvable>')" \\
    "$(started_of "\${ACP_CLAUDE_BINARY:-}"),$(started_of "\${ACP_CODEX_BINARY:-}"),$(started_of "\${ACP_GROK_BINARY:-}")" \\
    "$(command -v node || printf '<unresolvable>')" \\
    "$(command -v acp-sibling-probe || printf '<unresolvable>')" \\
    "\${ACP_CANONICAL_SESSIONS_JSON-}" "\${ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION-}" \\
    "\${ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH-}" "\${ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256-}" \\
    "\${ACP_CANONICAL_CTO_PEER_PROTOCOL-}" "\${ACP_CANONICAL_CTO_BUZZ_PURPOSE-}" \\
    "$(command -v lsof || printf '<unresolvable>')" "$(lsof_scan)" \\
    "\${ACP_HERMES_LINEAGE_ROOT_DIGEST-}" "\${ACP_HERMES_EXECUTABLE-}" \\
    "\${ACP_HERMES_PROFILE-}" "\${ACP_HERMES_HOME-}" \\
    "\${ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY-}" "\${ACP_HERMES_GATEWAY_API_KEY-}" \\
    "\${ACP_REVIEWER_CODEX_HOME:-<unset>}" \\
    "\${ACP_HOST_PROJECT_PROVISIONER:-<unset>}" "\${ACP_BUZZ_ADMISSION_COMMAND:-<unset>}" >> "$ACP_LAUNCHER_ENV_LOG"
  # The CommitLore pin (#246 B3), byte for byte. Its reader trims and splits the line above, which would
  # erase the difference between the newline security appends and a newline in the stored value. No
  # file means the variable was not exported.
  if [[ -n "\${ACP_COMMITLORE_BINARY+set}" ]]; then
    printf '%s' "$ACP_COMMITLORE_BINARY" > "$ACP_LAUNCHER_COMMITLORE_RAW"
  else
    rm -f "$ACP_LAUNCHER_COMMITLORE_RAW"
  fi
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
`;
  const bin = stableFixtureBinDir({
    launchctl: launchctlScript,
    security: securityScript,
    "node-wrapper": nodeWrapperScript,
    sleep: sleepScript,
  });
  const node = join(bin, "node-wrapper");

  const launchLog = join(home, "launchctl.log");
  const securityLog = join(home, "security.log");
  const launcherEnvLog = join(home, "launcher-env.log");
  const stateAdminLog = join(home, "state-admin.log");
  const loaded = join(home, "launchd.loaded");
  const stdoutLog = join(home, ".agent-control-plane", "agentcpd.out.log");
  const lock = join(home, ".agent-control-plane", "agentcpd.lock");

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
      ACP_LAUNCHER_COMMITLORE_RAW: join(home, "launcher-commitlore.raw"),
      ACP_STATE_ADMIN_LOG: stateAdminLog,
      ACP_LAUNCHD_LOADED: loaded,
      ACP_LAUNCHD_BOOTOUT_PENDING: join(home, "launchd.bootout-pending"),
      ACP_FAKE_PID_PRINTS_REMAINING: join(home, "launchd.pid-prints-remaining"),
      ACP_FAKE_RECOVERY_PRINTS: join(home, "launchd.recovery-prints"),
      ACP_FAKE_START_PRINTS: join(home, "launchd.start-prints"),
      ACP_FAKE_STDOUT_LOG: stdoutLog,
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
  // `detached: true` so a timeout group-kills this subtree instead of leaving it behind: orphaned
  // `install-launchd.sh install` and `fake-bin/security` processes with PPID 1 were observed
  // outliving a timed-out test here by more than an hour. `boundedSpawnSync` does this only when
  // asked; its `terminateGroup` docstring says why this site stays synchronous.
  const result = boundedSpawnSync("bash", [command, ...args], {
    encoding: "utf8",
    env: harness.env,
    detached: true,
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

/** The stable address external consumers (Hermes' mcp_servers, etc.) resolve the CLI through. */
const currentLinkPath = (harness: InstallerHarness): string =>
  join(harness.home, ".agent-control-plane", "current");

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
      boundedSpawnSync("bash", ["-c", `command -v ${name}`], { env: harness.env }).status,
      `${name} resolves from the installer's PATH, so this row would measure the host and not the pin`,
    ).not.toBe(0);
  }
};

/**
 * An executable at exactly `path`, as a hard link to a cached entry rather than bytes written for
 * this run: these are executed (through `started_of`, by a launcher run, by the installer), and a
 * fresh file per run is a fresh executable inode per run for syspolicyd. The link keeps what the
 * rows measure — a regular file at that path with that realpath — and is measured itself by "the
 * suite's executable fixture writers" at the end of this file.
 */
const writeProviderCli = (path: string, body: string): string =>
  // The path as written, because that is what the installer pins: it records the answer the
  // installing shell gave, which is the PATH entry plus the name and carries whatever spelling
  // that entry had. Returning the canonical path instead would disagree with a correct pin on
  // every host whose temporary directory is itself a link — which macOS's is.
  stableFixtureLink(path, body);

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
  const launched = boundedSpawnSync("bash", [launcherPath(harness)], {
    encoding: "utf8",
    env: { ...harness.env, BASH_ENV: launcherSecurity },
  });
  return { status: launched.status, stdout: launched.stdout, stderr: launched.stderr };
};

/**
 * Field positions after the canonical activation group are derived from its length rather than
 * written down. They were literals — `lsof: f[24]`, `lsofScan: f[25]`, hermes at `f[26 + index]` —
 * and every change to the group's size silently moved all three onto their neighbours while the
 * group's own fields, being derived, stayed right. That has already happened once (an eight-variable
 * group becoming seven shifted lsof and lsofScan from 25/26 to 24/25) and the record of it warned
 * about exactly these two indices while the hermes base, added later, was the third instance of the
 * same mistake. Deriving them is what stops the next change from being the fourth.
 */
const CANONICAL_BASE_FIELD = 17;
const LSOF_FIELD = CANONICAL_BASE_FIELD + CANONICAL_ACTIVATION_VARIABLES.length;
const HERMES_BASE_FIELD = LSOF_FIELD + 2;

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
    lsof: f[LSOF_FIELD],
    lsofScan: f[LSOF_FIELD + 1],
    canonical: Object.fromEntries(
      CANONICAL_ACTIVATION_VARIABLES.map((name, index) => [name, f[CANONICAL_BASE_FIELD + index] ?? ""]),
    ) as Record<(typeof CANONICAL_ACTIVATION_VARIABLES)[number], string>,
    hermes: Object.fromEntries(
      HERMES_ADOPTION_VARIABLES.map((name, index) => [name, f[HERMES_BASE_FIELD + index] ?? ""]),
    ) as Record<(typeof HERMES_ADOPTION_VARIABLES)[number], string>,
    /** The packet reviewer's optional private Codex home override, appended after the Hermes group. */
    reviewerCodexHome: f[HERMES_BASE_FIELD + HERMES_ADOPTION_VARIABLES.length],
    /** The resident host provisioner the daemon was handed (v52), appended after the reviewer override. */
    hostProvisioner: f[HERMES_BASE_FIELD + HERMES_ADOPTION_VARIABLES.length + 1],
    /** The provisioner's Buzz admission argv the daemon was handed (v52), appended after it. */
    buzzAdmissionCommand: f[HERMES_BASE_FIELD + HERMES_ADOPTION_VARIABLES.length + 2],
    /** The `ACP_BUZZ_BINARY` the daemon was handed (field 7). */
    buzz: f[7],
    /**
     * The `ACP_COMMITLORE_BINARY` the daemon was handed (#246 B3), exactly as handed: read raw, never
     * trimmed, and `undefined` when the variable was not exported.
     */
    commitlore: existsSync(harness.env["ACP_LAUNCHER_COMMITLORE_RAW"] as string)
      ? readFileSync(harness.env["ACP_LAUNCHER_COMMITLORE_RAW"] as string, "utf8")
      : undefined,
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

/**
 * The sealed closure's own interpreter: a shim handing everything to the real one, linked from the
 * cache like `writeProviderCli`'s. Sealing refuses a symlinked member, which a hard link is not.
 * The copied `dist` can already hold a `bin/node` an earlier install put there; it is removed first,
 * because a link cannot land on an existing name and writing through that fresh copy is what
 * minted an executable inode per run.
 */
const writeSealedPairNode = (runtimeRoot: string): string => {
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  const node = join(runtimeRoot, "bin", "node");
  rmSync(node, { force: true });
  return stableFixtureLink(node, `#!/bin/bash\nexec ${process.execPath} "$@"\n`);
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
  /** Shapes the sealed runtime closure before it is sealed, as a different generation's would be. */
  prepareRuntime?: (runtimeRoot: string) => void,
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
  prepareRuntime?.(runtimeRoot);
  // The interpreter travels inside the closure, so the rollback runs the sealed one rather than
  // whatever `node` this machine happens to have.
  writeSealedPairNode(runtimeRoot);

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

const rollbackArgs = (fixture: PairFixture): string[] => [
  "--pair-id",
  fixture.pair.pairId,
  "--expected-index-digest",
  fixture.pair.indexDigest,
  ...structuralFlags(fixture),
];

/**
 * Turns a copy of this build's runtime closure into one whose rollback coordinator predates the
 * database high-water check (ACP1058-R1): the check returns at once, and the coordinator no longer
 * declares it. Everything else is this build's, so it validates and applies the same pair format,
 * which is what a deployment built before the check does with a pair that records a mark — it
 * reads past the mark and restores the image. (Also measured outside the suite with an app root
 * holding a real 115916ce build: the 5e6c1764 installer exited 0 and discarded the write made after
 * the seal; this installer refused with ROLLBACK_PAIR_STALE_DATABASE and stopped nothing.)
 *
 * Anchored on the compiled text, and the anchor is required: a compiled shape this no longer
 * matches fails here rather than quietly leaving the check in and letting every row below pass.
 */
const predateHighWaterCheck = (runtimeRoot: string): void => {
  const coordinator = join(runtimeRoot, "deploy", "rollback-pair.js");
  const source = readFileSync(coordinator, "utf8");
  const anchor = "const assertLiveDatabaseAtSeal = (manifest, root) => {";
  expect(source.split(anchor).length - 1, "the compiled high-water check moved; update this anchor").toBe(1);
  writeFileSync(
    coordinator,
    source
      .replace(anchor, `${anchor}\n    return;`)
      .replaceAll("ACP_ROLLBACK_DATABASE_HIGH_WATER", "ACP_ROLLBACK_PREDATES_THE_CHECK"),
  );
};

/** What `rollback-pair.js guards` says the coordinator under `appRoot` enforces. */
const declaredGuards = (appRoot: string): string =>
  boundedSpawnSync(process.execPath, [join(appRoot, "dist", "deploy", "rollback-pair.js"), "guards"], {
    encoding: "utf8",
  }).stdout;

/** One committed write after a seal, the kind the daemon makes every minute it runs. */
const writeAfterTheSeal = (databasePath: string): number => {
  const raw = new Database(databasePath);
  try {
    raw
      .prepare("INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), "written-after-the-seal", "{}");
    return raw.prepare("SELECT max(event_id) FROM audit_events").pluck().get() as number;
  } finally {
    raw.close();
  }
};

/**
 * Read-write on purpose: a read-only open of a WAL database with no sidecars creates `-wal` and
 * `-shm` beside it and leaves them, which the snapshot below would report as the refusal's doing.
 */
const maxAuditEventId = (databasePath: string): number | null => {
  const raw = new Database(databasePath);
  try {
    return raw.prepare("SELECT max(event_id) FROM audit_events").pluck().get() as number | null;
  } finally {
    raw.close();
  }
};

/** Every byte a refused rollback could have replaced, as one comparable value. */
const deploymentSnapshot = (harness: InstallerHarness, appRoot: string, databasePath: string): string => {
  const state = join(harness.home, ".agent-control-plane");
  const digest = (path: string): string =>
    existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "<absent>";
  return JSON.stringify({
    database: digest(databasePath),
    sidecars: readdirSync(state).filter((name) => name.startsWith("state.sqlite")).sort(),
    generation: digest(join(appRoot, "dist", GENERATION_MARKER)),
    coordinator: digest(join(appRoot, "dist", "deploy", "rollback-pair.js")),
    plist: digest(plistPath(harness)),
    launcher: digest(launcherPath(harness)),
    stage: existsSync(join(state, "rollback-stage")) ? readdirSync(join(state, "rollback-stage")) : "<absent>",
  });
};

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
  boundedExecFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => join(root, entry));

describe("launchd deployment artifact", () => {
  it("restart waits for a delayed bootout before reporting a loaded job", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "1";
    writeFileSync(harness.launchLog, "");

    const restarted = runInstaller(installer, ["restart"], harness);
    const observed = boundedSpawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], {
      encoding: "utf8",
      env: harness.env,
    });

    expect(restarted.status, restarted.stderr).toBe(0);
    expect(observed.status, `restart exited ${restarted.status}; launchctl print found no job`).toBe(0);
    expect(observed.stdout).toContain("pid = 4242");
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("refuses success when kickstart leaves the job unloaded", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_KICKSTART_UNLOAD"] = "1";

    const restarted = runInstaller(installer, ["restart"], harness);

    expect(restarted.status).not.toBe(0);
    expect(restarted.stderr).toContain(`launchd job ${label} is not loaded after start`);
    expect(existsSync(harness.loaded)).toBe(false);
  });

  it("refuses a restart when the job stays registered without a running pid", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_FAKE_PID_MODE"] = "none";
    const printsBefore = subcommands(harness.launchLog).filter((command) => command === "print").length;

    const restarted = runInstaller(installer, ["restart"], harness);
    const printsAfter = subcommands(harness.launchLog).filter((command) => command === "print").length;

    expect(restarted.status, restarted.stderr).not.toBe(0);
    expect(restarted.stderr).toContain(`launchd job ${label} is not running after start`);
    expect(restarted.stderr).toContain("agentctl daemon status");
    expect(printsAfter - printsBefore).toBeLessThan(20);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("accepts a completed start after more than 30 polls with the same pid", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_FAKE_START_MARKER"] = "0";
    harness.env["ACP_FAKE_START_AFTER_PRINTS"] = "36";

    const restarted = runInstaller(installer, ["restart"], harness);

    expect(Number(readFileSync(harness.env["ACP_FAKE_START_PRINTS"]!, "utf8").trim())).toBeGreaterThan(30);
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("allows a throttled relaunch after 30 consecutive polls without a pid", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_FAKE_PID_MODE"] = "recovers";

    const restarted = runInstaller(installer, ["restart"], harness);

    expect(Number(readFileSync(harness.env["ACP_FAKE_RECOVERY_PRINTS"]!, "utf8").trim())).toBeGreaterThan(60);
    expect(restarted.status, restarted.stderr).toBe(0);
  });

  it("refuses a restart when its reported pid disappears during settling", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_FAKE_PID_MODE"] = "disappears";
    const printsBefore = subcommands(harness.launchLog).filter((command) => command === "print").length;

    const restarted = runInstaller(installer, ["restart"], harness);
    const printsAfter = subcommands(harness.launchLog).filter((command) => command === "print").length;

    expect(restarted.status, restarted.stderr).not.toBe(0);
    expect(restarted.stderr).toContain(`launchd job ${label} is not running after start`);
    expect(restarted.stderr).toContain("agentctl daemon status");
    expect(printsAfter - printsBefore).toBeLessThan(100);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("refuses a pid that appears before the daemon reports completed startup", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    harness.env["ACP_FAKE_START_MARKER"] = "0";

    const restarted = runInstaller(installer, ["restart"], harness);

    expect(restarted.status, restarted.stderr).not.toBe(0);
    expect(restarted.stderr).toContain(`launchd job ${label} is not running after start`);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it.each(["restart", "install", "upgrade"])("recovers a late bootout during %s without completing the requested operation", (command) => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    const stateAdminBefore = existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "";
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "31";
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, command === "restart"
      ? [command]
      : [command, "--app-root", root, "--node", harness.node], harness);
    const actions = subcommands(harness.launchLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bootout timed out");
    expect(result.stderr).toContain("original service recovered");
    expect(actions.filter((action) => action === "bootout")).toHaveLength(1);
    expect(actions.filter((action) => action === "bootstrap")).toHaveLength(1);
    expect(actions.filter((action) => action === "kickstart")).toHaveLength(1);
    expect(existsSync(harness.loaded)).toBe(true);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "").toBe(stateAdminBefore);
  });

  it.each(["install", "upgrade"])("preserves a same-root runtime and source Node when %s bootout times out", (command) => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const runtimeNode = join(appRoot, "dist", "bin", "node");
    const originalRuntime = readFileSync(runtimeNode);
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    const nextNode = stableFixtureExecutable(
      "node-new",
      `${readFileSync(harness.node, "utf8")}\n# changed interpreter generation\n`,
    );
    const nextNodeBefore = readFileSync(nextNode);
    const stateAdminBefore = existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "";
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "31";
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, [command, "--app-root", appRoot, "--node", nextNode], harness);
    const actions = subcommands(harness.launchLog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("original service recovered");
    expect(actions.filter((action) => action === "bootstrap")).toHaveLength(1);
    expect(actions.filter((action) => action === "kickstart")).toHaveLength(1);
    expect(existsSync(harness.loaded)).toBe(true);
    expect(readFileSync(runtimeNode)).toEqual(originalRuntime);
    expect(readdirSync(join(appRoot, "dist", "bin")).filter((name) => name.startsWith(".node."))).toEqual([]);
    expect(readFileSync(nextNode)).toEqual(nextNodeBefore);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "").toBe(stateAdminBefore);
  });

  it("keeps the loaded old generation when staging a replacement Node fails", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const runtimeDir = join(appRoot, "dist", "bin");
    const originalNode = readFileSync(join(runtimeDir, "node"));
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    const nextNode = stableFixtureExecutable("node-new", `${readFileSync(harness.node, "utf8")}\n# new generation\n`);
    overridePath(
      harness,
      "cp",
      `#!/bin/bash
if [[ "\${@: -1}" == *"/.node."* ]]; then
  printf 'partial' > "\${@: -1}"
  exit 1
fi
exec /bin/cp "$@"
`,
    );
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, ["upgrade", "--app-root", appRoot, "--node", nextNode], harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed to stage the Node interpreter");
    expect(subcommands(harness.launchLog)).not.toContain("bootout");
    expect(existsSync(harness.loaded)).toBe(true);
    expect(readFileSync(join(runtimeDir, "node"))).toEqual(originalNode);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith(".node."))).toEqual([]);
  });

  it("tightens a writable runtime bin before staging even when the copy fails", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const runtimeDir = join(appRoot, "dist", "bin");
    const originalNode = readFileSync(join(runtimeDir, "node"));
    const nextNode = stableFixtureExecutable("node-new", `${readFileSync(harness.node, "utf8")}\n# new generation\n`);
    const modeLog = join(harness.home, "stage-mode.log");
    // `modeLog` is a fresh per-run log path; it travels through an env var so the shim script
    // text stays constant rather than being interpolated into it per run.
    harness.env["ACP_CP_SHIM_MODE_LOG"] = modeLog;
    overridePath(
      harness,
      "cp",
      `#!/bin/bash
if [[ "\${@: -1}" == *"/.node."* ]]; then
  stat -f '%Lp' "$(dirname -- "\${@: -1}")" >> "$ACP_CP_SHIM_MODE_LOG"
  printf 'partial' > "\${@: -1}"
  exit 1
fi
exec /bin/cp "$@"
`,
    );
    chmodSync(runtimeDir, 0o777);
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, ["upgrade", "--app-root", appRoot, "--node", nextNode], harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed to stage the Node interpreter");
    expect(readFileSync(modeLog, "utf8").trim().split("\n")).toEqual(["755", "755"]);
    expect(statSync(runtimeDir).mode & 0o777).toBe(0o755);
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith(".node."))).toEqual([]);
    expect(readFileSync(join(runtimeDir, "node"))).toEqual(originalNode);
    expect(subcommands(harness.launchLog)).not.toContain("bootout");
  });

  it("promotes a staged replacement Node after successful upgrade", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const runtimeDir = join(appRoot, "dist", "bin");
    const previousNode = readFileSync(join(runtimeDir, "node"));
    const nextNode = stableFixtureExecutable("node-new", `${readFileSync(harness.node, "utf8")}\n# new generation\n`);
    const upgraded = runInstaller(installer, ["upgrade", "--app-root", appRoot, "--node", nextNode], harness);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(readFileSync(join(runtimeDir, "node"))).not.toEqual(previousNode);
    expect(readFileSync(join(runtimeDir, "node"))).toEqual(readFileSync(nextNode));
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith(".node."))).toEqual([]);
    expect(parseLauncherBinding(readFileSync(launcherPath(harness), "utf8"), "upgrade-node").nodePath).toBe(join(runtimeDir, "node"));
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("recovers the original loaded service when rollback bootout unregisters after its timeout", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    const originalRuntime = readFileSync(join(appRoot, "dist", "bin", "node"));
    const stateAdminBefore = existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "";
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "31";
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, ["rollback", "--app-root", appRoot, "--node", harness.node,
      "--pair-id", fixture.pair.pairId, "--expected-index-digest", fixture.pair.indexDigest,
      ...structuralFlags(fixture)], harness);
    const actions = subcommands(harness.launchLog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bootout timed out");
    expect(result.stderr).toContain("original service recovered");
    expect(actions.filter((action) => action === "bootout")).toHaveLength(1);
    expect(actions.filter((action) => action === "bootstrap")).toHaveLength(1);
    expect(actions.filter((action) => action === "kickstart")).toHaveLength(1);
    expect(existsSync(harness.loaded)).toBe(true);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(readFileSync(join(appRoot, "dist", "bin", "node"))).toEqual(originalRuntime);
    expect(existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "").toBe(stateAdminBefore);
    expect(existsSync(join(harness.home, ".agent-control-plane", "rollback-stage"))).toBe(false);
  });

  it("recovers a maintenance bootout that unregisters beyond the initial recovery observations", () => {
    const harness = makeHarness();
    expect(runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness).status).toBe(0);
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "36";
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, ["restart"], harness);
    const actions = subcommands(harness.launchLog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("original service recovered");
    expect(actions.filter((action) => action === "bootstrap")).toHaveLength(1);
    expect(actions.filter((action) => action === "kickstart")).toHaveLength(1);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it("waits for maintenance bootout to unregister before recovering the original service", () => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "1000";
    writeFileSync(harness.launchLog, "");

    const restarted = runInstaller(installer, ["restart"], harness);
    const actions = subcommands(harness.launchLog);

    expect(restarted.status).not.toBe(0);
    expect(restarted.stderr).toContain("original service recovered");
    expect(actions.filter((action) => action === "print").length).toBeGreaterThan(1000);
    expect(actions.filter((action) => action === "bootstrap")).toHaveLength(1);
    expect(actions.filter((action) => action === "kickstart")).toHaveLength(1);
    expect(existsSync(harness.loaded)).toBe(true);
  });

  it.each(["stop", "uninstall"])("does not recover a late bootout during intentional %s", (command) => {
    const harness = makeHarness();
    const installed = runInstaller(installer, ["install", "--app-root", root, "--node", harness.node], harness);
    expect(installed.status, installed.stderr).toBe(0);
    overridePath(harness, "sleep", "#!/bin/bash\nexit 0\n");
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "31";
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(installer, [command], harness);
    const actions = subcommands(harness.launchLog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd job remains loaded after bootout");
    expect(actions).not.toContain("bootstrap");
    expect(actions).not.toContain("kickstart");
    // The fake subsequently unregisters, demonstrating that this was a delayed bootout.
    const observed = boundedSpawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], {
      encoding: "utf8", env: harness.env,
    });
    expect(observed.status).not.toBe(0);
    expect(existsSync(harness.loaded)).toBe(false);
    expect(existsSync(plistPath(harness))).toBe(true);
  });

  it("renders a loadable plist with absolute paths and no secret or unresolved placeholder", () => {
    const output = join(tempDir("acp-launchd-render-"), "agentcpd.plist");
    boundedExecFileSync(process.execPath, [
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
    expect(subcommands(harness.launchLog)).toEqual([
      "print", "print", "bootstrap", "kickstart", "print", "print", "print", "print",
    ]);
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
    const installed = boundedSpawnSync(
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
    const launched = boundedSpawnSync("bash", [launcherPath(harness)], {
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
    const launched = boundedSpawnSync("bash", [launcherPath(harness)], {
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

  it("passes the complete Hermes adoption group from Keychain, never from inherited values", () => {
    const harness = makeHarness();
    for (const name of HERMES_ADOPTION_VARIABLES) harness.env[name] = `inherited-${name}`;
    harness.env["ACP_HERMES_KEYCHAIN_ACCOUNTS"] = HERMES_ADOPTION_VARIABLES.join(",");
    expect(installWithPins(harness).status).toBe(0);

    let launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).hermes).toEqual(Object.fromEntries(
      HERMES_ADOPTION_VARIABLES.map((name) => [name, `keychain-${name}`]),
    ));
    const lookups = readFileSync(harness.securityLog, "utf8");
    for (const name of HERMES_ADOPTION_VARIABLES) {
      expect(lookups).toContain(`find-generic-password -w -s test-service -a ${name}`);
    }
    for (const name of HERMES_RETIRED_HEAD_VARIABLES) {
      expect(lookups).not.toContain(`-a ${name}`);
    }

    // An absent account cannot be filled from the inherited shell; daemon validation owns
    // rejection of the partial group (tested in operator-socket.test.ts).
    const missing = HERMES_ADOPTION_VARIABLES[HERMES_ADOPTION_VARIABLES.length - 1]!;
    harness.env["ACP_HERMES_KEYCHAIN_ACCOUNTS"] = HERMES_ADOPTION_VARIABLES.slice(0, -1).join(",");
    rmSync(harness.launcherEnvLog);
    launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const partial = launcherObservations(harness).hermes;
    expect(partial[missing]).toBe("");
    for (const name of HERMES_ADOPTION_VARIABLES.slice(0, -1)) {
      expect(partial[name]).toBe(`keychain-${name}`);
    }
  });

  it("passes the packet reviewer's optional Codex home override from the Keychain, never from the inherited shell", () => {
    const harness = makeHarness();
    harness.env["ACP_REVIEWER_CODEX_HOME"] = "/inherited/shell/override";
    expect(installWithPins(harness).status).toBe(0);

    // No item: the daemon gets no override and its reviewer reuses the user's own Codex home.
    let launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).reviewerCodexHome).toBe("<unset>");
    expect(readFileSync(harness.securityLog, "utf8")).toContain("find-generic-password -w -s test-service -a ACP_REVIEWER_CODEX_HOME");

    harness.env["ACP_FAKE_REVIEWER_CODEX_HOME"] = "/keychain/reviewer-codex-homes/capsule/home";
    rmSync(harness.launcherEnvLog);
    launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    expect(launcherObservations(harness).reviewerCodexHome).toBe("/keychain/reviewer-codex-homes/capsule/home");
  });

  /**
   * v52: the daemon enables resident project provisioning only when ACP_HOST_PROJECT_PROVISIONER names a
   * script (src/app/control-plane.ts), and without one it refuses every bootstrap
   * BOOTSTRAP_ACTIVATION_INCOMPLETE. The plist is re-rendered on every install and upgrade, so the
   * launcher is the only place a value can live. These rows run the rendered launcher and read what the
   * daemon was handed; the file holding a line is not the daemon receiving it.
   */
  const ownProvisioner = (appRoot: string): string => join(appRoot, "dist", "host", "host-project-provisioner.mjs");

  const deployGeneration = (harness: InstallerHarness, command: "install" | "upgrade", appRoot: string): void => {
    const deployed = runInstaller(
      installer,
      [command, "--app-root", appRoot, "--node", harness.node, "--keychain-service", "test-service"],
      harness,
    );
    expect(deployed.status, deployed.stderr).toBe(0);
  };

  /** One launch: its exit, its stderr, and what the daemon was handed — or null when it was never reached. */
  const launchOnce = (harness: InstallerHarness) => {
    rmSync(harness.launcherEnvLog, { force: true });
    const launched = runGeneratedLauncher(harness);
    return {
      status: launched.status,
      stderr: launched.stderr,
      seen: existsSync(harness.launcherEnvLog) ? launcherObservations(harness) : null,
    };
  };

  /** A plain, non-executable file standing in for a provisioner script: node runs it, nothing execs it. */
  const writeProvisionerFile = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// a resident host provisioner stand-in\n", { mode: 0o600 });
    return path;
  };

  it("v52 hands the daemon this generation's own resident host provisioner by default, never an inherited one", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(statSync(ownProvisioner(appRoot)).isFile(), "the build carries no provisioner to default to").toBe(true);
    // Values inherited from launchd (`launchctl setenv`): a real regular file and a well-formed argv,
    // neither of which an install wrote or an operator stored.
    harness.env["ACP_HOST_PROJECT_PROVISIONER"] = writeProvisionerFile(join(harness.home, "inherited", "provisioner.mjs"));
    harness.env["ACP_BUZZ_ADMISSION_COMMAND"] = JSON.stringify(["/inherited/admission"]);
    deployGeneration(harness, "install", appRoot);

    rmSync(harness.securityLog, { force: true });
    const launch = launchOnce(harness);
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.seen?.hostProvisioner, "the daemon was not handed this generation's own provisioner").toBe(
      ownProvisioner(appRoot),
    );
    // No admission item: nothing is handed, so the provisioner keeps the default in its own script.
    expect(launch.seen?.buzzAdmissionCommand, "an inherited admission argv reached the daemon").toBe("<unset>");
    // The default applied because the Keychain was asked and had no item, not because it was never asked.
    const lookups = readFileSync(harness.securityLog, "utf8").split("\n");
    expect(lookups.filter((line) => line.endsWith("-s test-service -a ACP_HOST_PROJECT_PROVISIONER"))).toHaveLength(1);
    expect(lookups.filter((line) => line.endsWith("-s test-service -a ACP_BUZZ_ADMISSION_COMMAND"))).toHaveLength(1);
  });

  it("v52 lets a Keychain ACP_HOST_PROJECT_PROVISIONER win over the generation's own, and takes the admission argv from the Keychain", () => {
    const harness = makeHarness();
    expect(installWithPins(harness).status).toBe(0);
    const override = writeProvisionerFile(join(harness.home, "operator-provisioner", "host-project-provisioner.mjs"));
    const admission = JSON.stringify(["/opt/operator/bin/admit", "add-member"]);
    harness.env["ACP_FAKE_HOST_PROJECT_PROVISIONER_ITEM"] = override;
    harness.env["ACP_FAKE_BUZZ_ADMISSION_COMMAND_ITEM"] = admission;

    const launch = launchOnce(harness);
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.seen?.hostProvisioner, "the Keychain override did not win").toBe(override);
    expect(launch.seen?.hostProvisioner).not.toBe(ownProvisioner(root));
    expect(launch.seen?.buzzAdmissionCommand, "the Keychain admission argv was not handed through unchanged").toBe(admission);
  });

  it("v52 refuses to start when the resident host provisioner is missing or not a regular file, and never names the path", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    deployGeneration(harness, "install", appRoot);
    const own = ownProvisioner(appRoot);
    const ownHost = dirname(own);

    const refusedBy = (reason: string, kind: string, named: string) => {
      const launch = launchOnce(harness);
      expect(launch.status, `${kind}: ${launch.stderr}`).toBe(78);
      expect(launch.seen, `${kind}: the daemon was started`).toBeNull();
      expect(launch.stderr, kind).toContain(reason);
      expect(launch.stderr, `${kind}: the refusal named the path`).not.toContain(named);
    };

    // The generation's own copy: absent, a directory, a symlink to a regular file elsewhere, and a
    // dist/host that is itself a symlink to a directory outside the generation holding a regular file.
    const ownRefusal = "this generation has no resident host provisioner";
    const ownBytes = readFileSync(own);
    rmSync(own);
    refusedBy(ownRefusal, "absent", appRoot);
    mkdirSync(own);
    refusedBy(ownRefusal, "a directory", appRoot);
    rmSync(own, { recursive: true });
    const elsewhere = writeProvisionerFile(join(harness.home, "elsewhere", "host-project-provisioner.mjs"));
    symlinkSync(elsewhere, own);
    refusedBy(ownRefusal, "a symlink to a regular file outside the generation", appRoot);
    rmSync(own);
    renameSync(ownHost, `${ownHost}.moved`);
    symlinkSync(dirname(elsewhere), ownHost);
    refusedBy(ownRefusal, "a dist/host that leads outside the generation", appRoot);
    rmSync(ownHost);
    renameSync(`${ownHost}.moved`, ownHost);
    writeFileSync(own, ownBytes, { mode: 0o600 });
    // The control: the same generation with its own file back starts and hands it over.
    const restored = launchOnce(harness);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.seen?.hostProvisioner).toBe(own);

    // A Keychain override: absent, relative, a directory, and a symlink to a regular file.
    const overrideRefusal = "the Keychain item ACP_HOST_PROJECT_PROVISIONER does not name an absolute regular file";
    const directory = join(harness.home, "operator-provisioner-directory");
    mkdirSync(directory, { recursive: true });
    const link = join(harness.home, "operator-provisioner-link.mjs");
    symlinkSync(elsewhere, link);
    for (const [kind, value] of Object.entries({
      "a missing absolute path": join(harness.home, "operator-named-nothing", "provisioner.mjs"),
      "a bare name": "operator-provisioner.mjs",
      "a directory": directory,
      "a symlink to a regular file": link,
    })) {
      harness.env["ACP_FAKE_HOST_PROJECT_PROVISIONER_ITEM"] = value;
      refusedBy(overrideRefusal, kind, value);
    }
  });

  it("v52 keeps the provisioner across re-rendering: the default follows the generation and a Keychain value survives", () => {
    const harness = makeHarness();
    const first = makeDisposableAppRoot();
    const second = makeDisposableAppRoot();

    deployGeneration(harness, "install", first);
    let launch = launchOnce(harness);
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.seen?.hostProvisioner).toBe(ownProvisioner(first));

    // An upgrade re-renders the launcher for a new generation, and the default moves with it.
    deployGeneration(harness, "upgrade", second);
    launch = launchOnce(harness);
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.seen?.hostProvisioner, "the re-rendered launcher kept the previous generation's provisioner").toBe(
      ownProvisioner(second),
    );

    // The operator's values live in the Keychain, never in the rendered file, so another re-render of
    // the same generation cannot drop them; every launch after it reads them again.
    const override = writeProvisionerFile(join(harness.home, "operator-provisioner", "host-project-provisioner.mjs"));
    const admission = JSON.stringify(["/opt/operator/bin/admit", "add-member"]);
    harness.env["ACP_FAKE_HOST_PROJECT_PROVISIONER_ITEM"] = override;
    harness.env["ACP_FAKE_BUZZ_ADMISSION_COMMAND_ITEM"] = admission;
    deployGeneration(harness, "upgrade", second);
    const rendered = readFileSync(launcherPath(harness), "utf8");
    expect(rendered, "the override was baked into the launcher").not.toContain(override);
    expect(rendered, "the admission argv was baked into the launcher").not.toContain(admission);
    for (const run of [1, 2]) {
      launch = launchOnce(harness);
      expect(launch.status, `launch ${run}: ${launch.stderr}`).toBe(0);
      expect(launch.seen?.hostProvisioner, `launch ${run}`).toBe(override);
      expect(launch.seen?.buzzAdmissionCommand, `launch ${run}`).toBe(admission);
    }
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

    expect(boundedSpawnSync("bash", [launcherPath(harness)], { encoding: "utf8", env: launcherEnv }).status)
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
    const buzzPath = writeProviderCli(join(userLocalBin, "buzz"), SELF_CONTAINED_CLI);
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
    const launched = boundedSpawnSync("bash", [launcherPath(harness)], {
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
    // On Darwin a canonical self-claim reads the claiming process's working directory, and
    // observes its executing image, by running `lsof -p <pid> -FfptDin`, spawned under its bare
    // name by `lsofEntries` (src/registry/canonical-self-claim.ts). That call consults no
    // environment, so an absolute path baked into a variable has no reader and the daemon's PATH
    // is the only channel that reaches it. lsof ships in /usr/sbin; a PATH without that directory
    // makes every scan fail to run (`SCAN_FAILED`, `ENOENT`), the working directory cannot be read,
    // and a genuine claim is refused `PROBE_FAILED`. The image goes unobserved too, which on its
    // own refuses nothing — the claim records it and compares it against no configured value.
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
    // Resolving is not answering. The claim needs a real scan to come back with records, so the row
    // runs one rather than stopping at the lookup; a txt record is the one an executing image
    // leaves.
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

  it("#785 pins a symlinked CLI at the name it answered with and refuses a relative, non-executable or absent one", () => {
    const harness = makeHarness();
    // Four ways the installing shell can answer for a name, and what each is worth to a daemon
    // that runs from a different working directory and cannot search.
    const real = join(harness.home, "acp-provider-cli-real");
    mkdirSync(real, { recursive: true });
    const onPath = join(harness.home, "acp-provider-cli-onpath");
    mkdirSync(onPath, { recursive: true });

    // A symlink is the stable name a provider's updater maintains, and what is pinned is that
    // name rather than the version it currently resolves to (#954).
    const claudeTarget = writeProviderCli(join(real, "claude-1.0"), SELF_CONTAINED_CLI);
    const claudeLink = join(onPath, "claude");
    symlinkSync(claudeTarget, claudeLink);
    // A file that is present but not executable is not a CLI; the shell does not answer for it.
    writeFileSync(join(onPath, "codex"), SELF_CONTAINED_CLI, { mode: 0o644 });
    chmodSync(join(onPath, "codex"), 0o644);
    // A relative answer names nothing a daemon in another working directory can reach. It would
    // reach resolveExecutable's slash branch — which tests for a slash, not for an absolute path —
    // and be anchored to whatever directory the daemon happens to be in rather than searched for.
    // `grok` resolves only through a relative PATH entry.
    const relative = "acp-provider-cli-relative";
    mkdirSync(join(harness.home, relative), { recursive: true });
    writeProviderCli(join(harness.home, relative, "grok"), SELF_CONTAINED_CLI);

    harness.env["PATH"] = `${harness.bin}:${onPath}:${relative}:/usr/bin:/bin`;
    // The premise, asserted rather than assumed: from this working directory the shell really does
    // answer with the relative spelling. Run anywhere else and it answers with nothing, and the
    // row below would be measuring an absent CLI while claiming to measure a relative one.
    const relativeAnswer = boundedSpawnSync("bash", ["-c", "command -v grok"], {
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
    // Pinned as the link the shell answered with, never as the version behind it.
    expect(launcher).toContain(`ACP_RESOLVED_CLAUDE_BINARY=${claudeLink}`);
    expect(launcher, "the launcher pinned the target rather than the link that named it").not.toContain(
      `ACP_RESOLVED_CLAUDE_BINARY=${realpathSync(claudeTarget)}`,
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
    expect(seen.handed["claude"]).toBe(claudeLink);
    expect(seen.started?.split(",")[0]).toBe("started");
    expect(seen.handed["codex"]).toBe("<unset>");
    expect(seen.handed["grok"]).toBe("<unset>");
  });

  it("#954 pins the stable name a provider's updater maintains, not the versioned file behind it", () => {
    const harness = makeHarness();
    // The provider's own updater owns the versioned directory: it writes a new version, repoints
    // the stable name at it, and deletes the one it replaced. A pin taken at the canonical target
    // therefore names a file that stops existing within days of the install, and from then on
    // every capacity probe spawns a path that is not there — reported as no quota, which the
    // daemon reads as a role it cannot staff.
    const versions = join(harness.home, "acp-provider-cli-versions");
    mkdirSync(versions, { recursive: true });
    const onPath = join(harness.home, "acp-provider-cli-onpath");
    mkdirSync(onPath, { recursive: true });
    const accepted = writeProviderCli(join(versions, "1.0.0"), SELF_CONTAINED_CLI);
    const stable = join(onPath, "claude");
    symlinkSync(accepted, stable);
    harness.env["PATH"] = isolatedInstallerPath(harness, onPath);

    expect(installWithPins(harness).status).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    expect(
      launcher,
      "the launcher pinned something other than the stable path the installing shell answered with",
    ).toContain(`ACP_RESOLVED_CLAUDE_BINARY=${stable}`);
    expect(
      launcher,
      "the launcher pinned the versioned file, which the provider's updater deletes",
    ).not.toContain(`ACP_RESOLVED_CLAUDE_BINARY=${realpathSync(accepted)}`);

    // The updater runs: a new version arrives, the stable name moves to it, and the version this
    // install resolved and accepted is removed.
    const replacement = writeProviderCli(join(versions, "2.0.0"), SELF_CONTAINED_CLI);
    rmSync(stable);
    symlinkSync(replacement, stable);
    rmSync(accepted);

    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.handed["claude"]).toBe(stable);
    // The half a text assertion cannot reach: the pinned path is still a CLI that runs. A pin at
    // the deleted version reports `failed` here, which is the live symptom this row is about.
    expect(
      seen.started?.split(",")[0],
      "the pinned path no longer runs once the provider's updater has replaced the version behind it",
    ).toBe("started");
  });

  it("#954 refuses a name that answers for something other than a regular file", () => {
    const harness = makeHarness();
    // `-x` is not enough on its own. A FIFO with the executable bit set satisfies it, and
    // `command -v` answers for it just as it would for a CLI — but a spawn of it blocks on an
    // open that has no writer, so the daemon's first capacity probe would hang rather than fail.
    // `-f` is the clause that keeps it out, and without a row it is the kind of clause a later
    // simplification deletes as redundant.
    const onPath = join(harness.home, "acp-provider-cli-fifo");
    mkdirSync(onPath, { recursive: true });
    const fifo = join(onPath, "claude");
    boundedExecFileSync("mkfifo", [fifo], { timeout: 10_000 });
    chmodSync(fifo, 0o755);
    harness.env["PATH"] = isolatedInstallerPath(harness, onPath);

    // The premise, asserted rather than assumed: the shell does answer with this path. If it did
    // not, the assertion below would pass for the ordinary reason that nothing was found, and
    // would say nothing at all about `-f`. A directory would fail here — `command -v` skips those
    // — which is why this row uses a FIFO.
    const answer = boundedSpawnSync("bash", ["-c", "command -v claude"], {
      encoding: "utf8",
      env: harness.env,
    });
    expect(answer.status, "the installing shell did not answer for the FIFO").toBe(0);
    expect(answer.stdout.trim(), "the shell answered with something other than the FIFO").toBe(fifo);
    expect(statSync(fifo).isFIFO(), "the fixture is not a FIFO").toBe(true);

    const installed = installWithPins(harness);
    expect(installed.status, installed.stderr).toBe(0);

    const launcher = readFileSync(launcherPath(harness), "utf8");
    expect(launcher, "a FIFO was pinned as a provider CLI").not.toContain("ACP_RESOLVED_CLAUDE_BINARY=");
    expect(installed.stderr).toContain("could not resolve the claude CLI");
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
    // suppression of the channel rather than of one particular sentence. `target` travels through
    // an env var rather than being interpolated into the script so the shim stays byte-constant
    // across runs.
    harness.env["ACP_READLINK_SHIM_TARGET"] = target;
    overridePath(
      harness,
      "readlink",
      `#!/bin/bash\nprintf 'readlink: %s: Permission denied (target %s)\\n' "\${2:-}" "$ACP_READLINK_SHIM_TARGET" >&2\nexit 1\n`,
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

  /**
   * #246 B3 runs a bootstrap's CommitLore only from `ACP_COMMITLORE_BINARY`, an explicit absolute path
   * (src/bootstrap/commitlore-pin.ts): no PATH search, no alias, no fallback. A launcher that never sets
   * it makes every bootstrap CommitLore observation refuse, so the installer resolves `commitlore` the
   * way it resolves the provider CLIs. These rows measure the pin's delivery only; whether a bootstrap
   * then succeeds is the daemon's to decide, and nothing here says it does.
   */
  const PINNED_CLIS = [
    ["claude", "ACP_RESOLVED_CLAUDE_BINARY"],
    ["codex", "ACP_RESOLVED_CODEX_BINARY"],
    ["grok", "ACP_RESOLVED_GROK_BINARY"],
    ["commitlore", "ACP_RESOLVED_COMMITLORE_BINARY"],
  ] as const;

  /** Each named CLI in a directory of its own, and a PATH that holds those directories and nothing else. */
  const cliDirectories = (harness: InstallerHarness, ...names: string[]): Record<string, string> => {
    // An inherited value would be the operator's and would win; these rows measure the installer's.
    delete harness.env["ACP_COMMITLORE_BINARY"];
    const cli: Record<string, string> = {};
    const directories = names.map((name) => {
      const directory = join(harness.home, `acp-cli-${name}`);
      mkdirSync(directory, { recursive: true });
      cli[name] = writeProviderCli(join(directory, name), SELF_CONTAINED_CLI);
      return directory;
    });
    harness.env["PATH"] = isolatedInstallerPath(harness, ...directories);
    return cli;
  };

  it("B3-PIN pins the commitlore CLI absolutely beside the provider pins, and the daemon is handed it", () => {
    const harness = makeHarness();
    const cli = cliDirectories(harness, "claude", "codex", "grok", "commitlore");

    const installed = installWithPins(harness);
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stderr, "a CLI that resolved was reported as unresolved").not.toContain("could not resolve");

    // The rendered artifact that carries every one of these pins is the launcher: the plist runs it and
    // carries none of them. Whole lines, so a pin cannot be satisfied by a comment that mentions the path.
    const launcher = readFileSync(launcherPath(harness), "utf8");
    const lines = launcher.split("\n");
    expect(cli["commitlore"]?.startsWith("/"), "the fixture is not an absolute path").toBe(true);
    for (const [name, variable] of PINNED_CLIS) {
      expect(lines, `${variable} does not carry the ${name} CLI the installer resolved`).toContain(
        `${variable}=${cli[name]}`,
      );
    }
    // The pin is the channel; the CLI's directory is not added to the daemon's PATH to reach it.
    expect(launcher).toContain(EXPECTED_LAUNCHER_PATH_LINE);
    expect(launcher, "the commitlore directory reached the daemon's PATH").not.toContain(
      `${dirname(cli["commitlore"] as string)}:`,
    );

    // The file holding a path is not the daemon receiving it: run the launcher and read what it handed.
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.commitlore, "the launcher never exported the resolved commitlore CLI").toBe(cli["commitlore"]);
    // The provider pins are what they were.
    for (const name of ["claude", "codex", "grok"]) expect(seen.handed[name]).toBe(cli[name]);
    expect(seen.started, "a pinned provider CLI did not start").toBe("started,started,started");
  });

  /**
   * The operator's persistent ACP_COMMITLORE_BINARY is the Keychain item: the plist carries no such
   * variable, so a value in an installing shell never reaches a daemon launchd starts. These rows run
   * the rendered launcher twice against the same Keychain stub and report what the daemon was handed
   * each time — that the value is kept across re-execution of the launcher. It is not a launchd
   * restart test: no launchd is involved.
   *
   * What the daemon was handed is reported as a label, never as the value, so neither a pass nor a
   * failure prints what the Keychain held; `keychainValue` is checked against the launcher's stderr the
   * same way.
   */
  const commitloreAcrossReexecution = (
    harness: InstallerHarness,
    candidates: Record<string, string>,
    keychainValue?: string,
  ) => {
    rmSync(harness.securityLog, { force: true });
    const runs = [1, 2].map(() => {
      rmSync(harness.launcherEnvLog, { force: true });
      rmSync(harness.env["ACP_LAUNCHER_COMMITLORE_RAW"] as string, { force: true });
      const launched = runGeneratedLauncher(harness);
      const handed = launched.status === 0 ? launcherObservations(harness).commitlore : null;
      return {
        status: launched.status,
        // Compared byte for byte against each candidate: nothing is trimmed on the way.
        handed:
          handed === null
            ? "nothing: the launcher did not reach the daemon"
            : handed === undefined
              ? "unset"
              : (Object.entries(candidates).find(([, value]) => value === handed)?.[0] ?? "something else"),
        stderrNamesTheKeychainValue: keychainValue !== undefined && launched.stderr.includes(keychainValue),
        reportsAFailedLookup: launched.stderr.includes("the Keychain lookup for ACP_COMMITLORE_BINARY failed"),
        reportsAnEmptyItem: launched.stderr.includes("the Keychain item ACP_COMMITLORE_BINARY is present but empty"),
      };
    });
    // The launcher's lookups only: the log was cleared after the install, which asks for other accounts.
    const lookups = existsSync(harness.securityLog)
      ? readFileSync(harness.securityLog, "utf8")
          .split("\n")
          .filter((line) => line.endsWith(" -a ACP_COMMITLORE_BINARY")).length
      : 0;
    return { runs, lookups };
  };

  /** Installs with `commitlore` resolvable, so that a baked pin exists for an operator value to win over. */
  const installWithCommitlorePin = (harness: InstallerHarness): string => {
    const cli = cliDirectories(harness, "commitlore");
    expect(installWithPins(harness).status).toBe(0);
    expect(readFileSync(launcherPath(harness), "utf8").split("\n")).toContain(
      `ACP_RESOLVED_COMMITLORE_BINARY=${cli["commitlore"]}`,
    );
    return cli["commitlore"] as string;
  };

  it("B3-PIN-R1 keeps a Keychain ACP_COMMITLORE_BINARY that names a CommitLore across re-execution, over the baked pin", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);
    const operatorDirectory = join(harness.home, "operator-cli");
    mkdirSync(operatorDirectory, { recursive: true });
    const operator = writeProviderCli(join(operatorDirectory, "commitlore"), SELF_CONTAINED_CLI);
    harness.env["ACP_FAKE_COMMITLORE_BINARY_ITEM"] = operator;

    const kept = commitloreAcrossReexecution(harness, { "the Keychain value": operator, "the baked pin": resolved }, operator);
    const expected = {
      status: 0,
      handed: "the Keychain value",
      stderrNamesTheKeychainValue: false,
      reportsAFailedLookup: false,
      reportsAnEmptyItem: false,
    };
    expect(kept.runs).toEqual([expected, expected]);
    expect(kept.lookups, "the launcher did not ask the Keychain on every launch").toBe(2);
  });

  it("B3-PIN-R1 keeps a wrong Keychain ACP_COMMITLORE_BINARY unchanged across re-execution and never replaces it with the baked pin", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);
    const notExecutable = join(harness.home, "operator-not-executable", "commitlore");
    mkdirSync(dirname(notExecutable), { recursive: true });
    writeFileSync(notExecutable, SELF_CONTAINED_CLI, { mode: 0o600 });

    // Missing, relative (a bare name) and not executable. The launcher examines none of them; the
    // daemon's own pin checks are what refuse each one.
    const wrong = {
      "a missing absolute path": join(harness.home, "operator-named-nothing", "commitlore"),
      "a bare name": "commitlore",
      "a non-executable file": notExecutable,
    };
    for (const [kind, value] of Object.entries(wrong)) {
      harness.env["ACP_FAKE_COMMITLORE_BINARY_ITEM"] = value;
      const kept = commitloreAcrossReexecution(harness, { "the Keychain value": value, "the baked pin": resolved }, value);
      const expected = {
        status: 0,
        handed: "the Keychain value",
        stderrNamesTheKeychainValue: false,
        reportsAFailedLookup: false,
        reportsAnEmptyItem: false,
      };
      expect(kept.runs, kind).toEqual([expected, expected]);
      expect(kept.lookups, kind).toBe(2);
    }
  });

  it("B3-PIN-R1 hands the daemon the baked pin across re-execution when the Keychain has no ACP_COMMITLORE_BINARY", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);

    const kept = commitloreAcrossReexecution(harness, { "the baked pin": resolved });
    const expected = { status: 0, handed: "the baked pin", stderrNamesTheKeychainValue: false, reportsAFailedLookup: false, reportsAnEmptyItem: false };
    expect(kept.runs).toEqual([expected, expected]);
    // The pin applied because the Keychain was asked and had no item, not because it was never asked.
    expect(kept.lookups, "the launcher did not ask the Keychain on every launch").toBe(2);
  });

  /**
   * ACP1152-R1: ACP_RESOLVED_COMMITLORE_BINARY is the launcher's own internal name, and a value of it
   * inherited from launchd (`launchctl setenv`) is not an install's answer. Both sides start from a fake
   * one in the parent environment, naming a real absolute executable, with no operator value in the
   * parent environment or the Keychain.
   */
  const injectInheritedResolvedPin = (harness: InstallerHarness): string => {
    const injectedDirectory = join(harness.home, "injected-cli");
    mkdirSync(injectedDirectory, { recursive: true });
    const injected = writeProviderCli(join(injectedDirectory, "commitlore"), SELF_CONTAINED_CLI);
    harness.env["ACP_RESOLVED_COMMITLORE_BINARY"] = injected;
    return injected;
  };

  it("ACP1152-R1 replaces an inherited ACP_RESOLVED_COMMITLORE_BINARY with the pin this install resolved, across re-execution", () => {
    const harness = makeHarness();
    const resolved = cliDirectories(harness, "commitlore")["commitlore"] as string;
    const injected = injectInheritedResolvedPin(harness);

    expect(installWithPins(harness).status).toBe(0);
    expect(readFileSync(launcherPath(harness), "utf8").split("\n")).toContain(
      `ACP_RESOLVED_COMMITLORE_BINARY=${resolved}`,
    );

    const kept = commitloreAcrossReexecution(harness, { "the baked pin": resolved, "the inherited internal value": injected });
    const expected = { status: 0, handed: "the baked pin", stderrNamesTheKeychainValue: false, reportsAFailedLookup: false, reportsAnEmptyItem: false };
    expect(kept.runs, "the daemon was not handed the pin this install resolved").toEqual([expected, expected]);
    expect(kept.lookups, "the launcher did not ask the Keychain on every launch").toBe(2);
  });

  it("ACP1152-R1 gives the daemon no CommitLore pin from an inherited ACP_RESOLVED_COMMITLORE_BINARY when commitlore did not resolve", () => {
    const harness = makeHarness();
    // The reproduced case: no commitlore on the installer's PATH, so no baked line to overwrite the
    // inherited value.
    cliDirectories(harness);
    assertProviderUnresolvable(harness, "commitlore");
    const injected = injectInheritedResolvedPin(harness);

    expect(installWithPins(harness).status).toBe(0);
    expect(readFileSync(launcherPath(harness), "utf8"), "the precondition is a launcher with no baked pin").not.toMatch(
      /^ACP_RESOLVED_COMMITLORE_BINARY=/m,
    );

    const kept = commitloreAcrossReexecution(harness, { "the inherited internal value": injected });
    const expected = { status: 0, handed: "unset", stderrNamesTheKeychainValue: false, reportsAFailedLookup: false, reportsAnEmptyItem: false };
    expect(kept.runs, "an inherited internal variable reached the daemon as its CommitLore pin").toEqual([expected, expected]);
    expect(kept.lookups, "the launcher did not ask the Keychain on every launch").toBe(2);
  });

  /**
   * PIN-SIBLINGS: ACP1152-R1's closure, for the provider and Buzz pins. ACP_RESOLVED_<P>_BINARY is the
   * launcher's own internal name for what this install resolved, and a value of it inherited from launchd
   * (`launchctl setenv`) is never an input. Each row starts from a fake one in the parent environment,
   * naming a real absolute executable, with no ACP_<P>_BINARY in the parent environment or the Keychain.
   * How an inherited ACP_<P>_BINARY itself is treated is a separate question these rows do not touch.
   */
  const SIBLING_PINS = ["claude", "codex", "grok", "buzz"] as const;
  type SiblingPin = (typeof SIBLING_PINS)[number];

  /** What the daemon was handed for `name` on each of two launches, as a label. */
  const siblingAcrossReexecution = (
    harness: InstallerHarness,
    name: SiblingPin,
    candidates: Record<string, string>,
  ): string[] =>
    [1, 2].map(() => {
      rmSync(harness.launcherEnvLog, { force: true });
      const launched = runGeneratedLauncher(harness);
      if (launched.status !== 0) return `nothing: the launcher exited ${launched.status}`;
      const seen = launcherObservations(harness);
      const handed = name === "buzz" ? seen.buzz : seen.handed[name];
      if (handed === "<unset>") return "unset";
      return Object.entries(candidates).find(([, value]) => value === handed)?.[0] ?? "something else";
    });

  /** A fake ACP_RESOLVED_<P>_BINARY in the parent environment, and no ACP_<P>_BINARY there. */
  const inheritSiblingInternal = (harness: InstallerHarness, name: SiblingPin): string => {
    delete harness.env[`ACP_${name.toUpperCase()}_BINARY`];
    const directory = join(harness.home, "inherited-cli");
    mkdirSync(directory, { recursive: true });
    const fake = writeProviderCli(join(directory, name), SELF_CONTAINED_CLI);
    harness.env[`ACP_RESOLVED_${name.toUpperCase()}_BINARY`] = fake;
    return fake;
  };

  for (const name of SIBLING_PINS) {
    const internal = `ACP_RESOLVED_${name.toUpperCase()}_BINARY`;

    it(`PIN-SIBLINGS replaces an inherited ${internal} with the ${name} pin this install resolved, across re-execution`, () => {
      const harness = makeHarness();
      const generated = cliDirectories(harness, name)[name] as string;
      const fake = inheritSiblingInternal(harness, name);

      expect(installWithPins(harness).status).toBe(0);
      expect(readFileSync(launcherPath(harness), "utf8").split("\n")).toContain(`${internal}=${generated}`);
      expect(
        siblingAcrossReexecution(harness, name, { "the generated pin": generated, "the inherited fake": fake }),
        `the daemon was not handed the ${name} pin this install resolved`,
      ).toEqual(["the generated pin", "the generated pin"]);
    });

    it(`PIN-SIBLINGS gives the daemon no ${name} pin from an inherited ${internal} when ${name} did not resolve`, () => {
      const harness = makeHarness();
      cliDirectories(harness);
      assertProviderUnresolvable(harness, name);
      const fake = inheritSiblingInternal(harness, name);

      expect(installWithPins(harness).status).toBe(0);
      expect(readFileSync(launcherPath(harness), "utf8"), "the precondition is a launcher with no baked pin").not.toMatch(
        new RegExp(`^${internal}=`, "m"),
      );
      expect(
        siblingAcrossReexecution(harness, name, { "the inherited fake": fake }),
        `an inherited ${internal} reached the daemon as its ${name} pin`,
      ).toEqual(["unset", "unset"]);
    });
  }

  it("ACP1152-R2 withholds the baked pin across re-execution when the Keychain item is present but empty, and says so", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);

    // The lookup succeeds (exit 0) and answers nothing. Only exit 44, no item, may fall back; an empty
    // item is one the operator stored, so the baked pin must not stand in for it.
    harness.env["ACP_FAKE_COMMITLORE_EMPTY_ITEM"] = "1";
    const kept = commitloreAcrossReexecution(harness, { "the baked pin": resolved });
    const expected = {
      status: 0,
      handed: "unset",
      stderrNamesTheKeychainValue: false,
      reportsAFailedLookup: false,
      reportsAnEmptyItem: true,
    };
    expect(kept.runs, "a present but empty item fell back to the baked pin").toEqual([expected, expected]);
    expect(kept.lookups, "the launcher did not ask the Keychain on every launch").toBe(2);
  });

  /** The daemon's own pin reader on a delivered value, as its verdict only: "accepted" or the refusal condition. */
  const daemonPinCheck = (delivered: string | undefined): string => {
    const decision = commitlorePin(delivered);
    return decision.allowed ? "accepted" : String(decision.evidence["condition"]);
  };

  it("ACP1152-R3 delivers a Keychain value exactly as security prints it, across re-execution", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);
    const operatorDirectory = join(harness.home, "operator-cli");
    mkdirSync(operatorDirectory, { recursive: true });
    const operator = writeProviderCli(join(operatorDirectory, "commitlore"), SELF_CONTAINED_CLI);

    // A normal absolute path: security appends one newline, the launcher's command substitution takes
    // exactly that one off, and the daemon is handed the stored bytes, which its pin reader accepts.
    harness.env["ACP_FAKE_COMMITLORE_BINARY_ITEM"] = operator;
    const plain = commitloreAcrossReexecution(
      harness,
      {
        "the stored value": operator,
        "the stored value plus the newline security appends": `${operator}\n`,
        "the baked pin": resolved,
      },
      operator,
    );
    const plainExpected = {
      status: 0,
      handed: "the stored value",
      stderrNamesTheKeychainValue: false,
      reportsAFailedLookup: false,
      reportsAnEmptyItem: false,
    };
    expect(plain.runs, "a plain stored path").toEqual([plainExpected, plainExpected]);
    expect(daemonPinCheck(launcherObservations(harness).commitlore), "a plain stored path").toBe("accepted");

    // The same path stored with a newline of its own. security prints such a value as its hex, so the
    // daemon is handed the hex unchanged — not the bare path the stub used to deliver, not the stored
    // bytes, and not the baked pin — and its pin reader refuses it. The refusal is the daemon's; the
    // launcher does not fall back to the resolved pin because of it.
    const stored = `${operator}\n`;
    const hex = Buffer.from(stored, "utf8").toString("hex");
    harness.env["ACP_FAKE_COMMITLORE_BINARY_ITEM"] = stored;
    const withNewline = commitloreAcrossReexecution(
      harness,
      {
        "the hex security prints": hex,
        "the bare path": operator,
        "the stored value, newline included": stored,
        "the baked pin": resolved,
      },
      operator,
    );
    const newlineExpected = { ...plainExpected, handed: "the hex security prints" };
    expect(withNewline.runs, "a stored path with a trailing newline").toEqual([newlineExpected, newlineExpected]);
    expect(withNewline.lookups).toBe(2);
    expect(daemonPinCheck(launcherObservations(harness).commitlore), "the delivered hex").toBe("NOT_ABSOLUTE");
  });

  it("B3-PIN-R1 withholds the baked pin across re-execution when the Keychain lookup fails, and says so", () => {
    const harness = makeHarness();
    const resolved = installWithCommitlorePin(harness);

    // 44 is the stub's (and `security`'s) "no such item". Anything else is a lookup that did not
    // answer, which may be hiding a value the operator chose, so the resolved pin must not stand in.
    for (const status of ["36", "1"]) {
      harness.env["ACP_FAKE_COMMITLORE_LOOKUP_STATUS"] = status;
      const kept = commitloreAcrossReexecution(harness, { "the baked pin": resolved });
      const expected = { status: 0, handed: "unset", stderrNamesTheKeychainValue: false, reportsAFailedLookup: true, reportsAnEmptyItem: false };
      expect(kept.runs, `security exit ${status}`).toEqual([expected, expected]);
      expect(kept.lookups, `security exit ${status}`).toBe(2);
    }
  });

  it("B3-PIN names an unresolvable commitlore CLI on stderr, pins nothing for it and installs anyway", () => {
    const harness = makeHarness();
    // The providers resolve, so the row also shows commitlore's absence costs them nothing.
    const cli = cliDirectories(harness, "claude", "codex", "grok");
    assertProviderUnresolvable(harness, "commitlore");

    const installed = installWithPins(harness);
    expect(installed.status, installed.stderr).toBe(0);
    const notice = installed.stderr.split("\n").filter((line) => line.includes("could not resolve"));
    expect(notice, "the installer said nothing, or something else, about commitlore").toHaveLength(1);
    expect(notice[0]).toContain("could not resolve the commitlore CLI");
    // It names the variable an operator sets, and does not borrow the providers' consequence: CommitLore
    // has no quota, and an absent pin refuses rather than reporting one.
    expect(notice[0]).toContain("ACP_COMMITLORE_BINARY");
    expect(notice[0]).not.toContain("quota");

    const launcher = readFileSync(launcherPath(harness), "utf8");
    expect(launcher, "a pin was baked for a CLI that was never found").not.toMatch(/^ACP_RESOLVED_COMMITLORE_BINARY=/m);
    const lines = launcher.split("\n");
    for (const [name, variable] of PINNED_CLIS.slice(0, 3)) {
      expect(lines, `the ${name} pin changed`).toContain(`${variable}=${cli[name]}`);
    }

    // The daemon still starts, with no value: its own pin rule then refuses each bootstrap observation.
    const launched = runGeneratedLauncher(harness);
    expect(launched.status, launched.stderr).toBe(0);
    const seen = launcherObservations(harness);
    expect(seen.commitlore, "the daemon was handed a CommitLore pin").toBeUndefined();
    for (const name of ["claude", "codex", "grok"]) expect(seen.handed[name]).toBe(cli[name]);
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
    const launched = boundedSpawnSync("bash", [launcherPath(harness)], {
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
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "1";
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
      "print",
      "print",
      "print",
      "print",
      "bootout",
      "print",
      "print",
      "print",
      "bootstrap",
      "kickstart",
      "print",
      "print",
      "print",
      "print",
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
    harness.env["ACP_BOOTOUT_PRINT_LAG"] = "1";
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
      "print",
      "print",
      "bootstrap",
      "kickstart",
      "print",
      "print",
      "print",
      "print",
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

  it("ACP1058-R1: refuses a stale pair even when the app root's own coordinator predates the check", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    // A deployment built before the check. Its coordinator validates and applies the pair below
    // without asking whether the live database has moved since the seal.
    predateHighWaterCheck(join(appRoot, "dist"));
    expect(declaredGuards(appRoot)).not.toContain("ACP_ROLLBACK_DATABASE_HIGH_WATER");
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    writeFileSync(join(appRoot, "dist", GENERATION_MARKER), "generation-b\n", { mode: 0o600 });
    const written = writeAfterTheSeal(fixture.databasePath);
    const untouched = deploymentSnapshot(harness, appRoot, fixture.databasePath);
    writeFileSync(harness.launchLog, "");

    const result = runInstaller(
      installer,
      ["rollback", "--app-root", appRoot, "--node", harness.node, ...rollbackArgs(fixture)],
      harness,
    );

    expect(result.status, "the rollback ran through the app root's own coordinator and rewound the database").not.toBe(0);
    expect(result.stderr).toContain("ROLLBACK_PAIR_STALE_DATABASE");
    expect(maxAuditEventId(fixture.databasePath), "the write made after the seal was discarded").toBe(written);
    expect(deploymentSnapshot(harness, appRoot, fixture.databasePath), "a refused rollback changed something").toBe(
      untouched,
    );
    expect(subcommands(harness.launchLog), "a refused rollback stopped the service").not.toContain("bootout");
  });

  it("ACP1058-R1: still refuses a stale pair on the next rollback, after one installed a closure that predates the check", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    const deploymentInstaller = join(appRoot, "deploy", "install-launchd.sh");
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(0);

    // The documented invocation — the installer inside the deployment, no --app-root — returning to
    // a generation built before the check. The database has not moved since that pair was sealed.
    const older = await sealPairFor(harness, appRoot, "generation-before-the-check", predateHighWaterCheck);
    const first = runInstaller(deploymentInstaller, ["rollback", "--node", harness.node, ...rollbackArgs(older)], harness);
    expect(first.status, first.stderr).toBe(0);
    // The rollback replaced the runtime, its coordinator included: what is installed now is older.
    expect(readFileSync(join(appRoot, "dist", GENERATION_MARKER), "utf8").trim()).toBe("generation-before-the-check");
    expect(declaredGuards(appRoot)).not.toContain("ACP_ROLLBACK_DATABASE_HIGH_WATER");

    // A pair sealed now, and then a write the next rollback must not discard.
    const next = await sealPairFor(harness, appRoot, "generation-next");
    const written = writeAfterTheSeal(next.databasePath);
    const untouched = deploymentSnapshot(harness, appRoot, next.databasePath);

    // From this checkout, naming the deployment: the check runs in this checkout's coordinator,
    // not in the older one the deployment now carries.
    writeFileSync(harness.launchLog, "");
    const fromCheckout = runInstaller(
      installer,
      ["rollback", "--app-root", appRoot, "--node", harness.node, ...rollbackArgs(next)],
      harness,
    );
    expect(fromCheckout.status, "the second rollback rewound the database through the older coordinator").not.toBe(0);
    expect(fromCheckout.stderr).toContain("ROLLBACK_PAIR_STALE_DATABASE");
    expect(maxAuditEventId(next.databasePath)).toBe(written);
    expect(deploymentSnapshot(harness, appRoot, next.databasePath)).toBe(untouched);
    expect(subcommands(harness.launchLog)).not.toContain("bootout");

    // From the installer inside the deployment, whose own coordinator is now the older one: it
    // cannot run the check, so the installer refuses to use it, before anything is stopped.
    writeFileSync(harness.launchLog, "");
    const fromDeployment = runInstaller(
      deploymentInstaller,
      ["rollback", "--node", harness.node, ...rollbackArgs(next)],
      harness,
    );
    expect(fromDeployment.status, "the second rollback rewound the database through the older coordinator").not.toBe(0);
    expect(fromDeployment.stderr).toMatch(/does not declare the database high-water check/);
    expect(maxAuditEventId(next.databasePath)).toBe(written);
    expect(deploymentSnapshot(harness, appRoot, next.databasePath)).toBe(untouched);
    expect(subcommands(harness.launchLog)).not.toContain("bootout");

    // The remedy both refusals name works over the older deployment: a pair sealed from the database
    // as it is now, applied through this checkout, keeps the write.
    const fresh = await sealPairFor(harness, appRoot, "generation-fresh");
    const remedied = runInstaller(
      installer,
      ["rollback", "--app-root", appRoot, "--node", harness.node, ...rollbackArgs(fresh)],
      harness,
    );
    expect(remedied.status, remedied.stderr).toBe(0);
    expect(readFileSync(join(appRoot, "dist", GENERATION_MARKER), "utf8").trim()).toBe("generation-fresh");
    expect(maxAuditEventId(fresh.databasePath)).toBe(written);
  });

  it("rejects a substring-only installer stub", () => {
    const stubText = `#!/bin/bash
# Usage: install start restart upgrade rollback --pair-id --expected-index-digest
# find-generic-password render-launchd-plist.mjs
exit 0
`;
    const stub = stableFixtureExecutable("install-launchd.sh", stubText);
    boundedExecFileSync("bash", ["-n", stub]);
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

  it("points current at the installed app root, then at a new one after upgrade", () => {
    const harness = makeHarness();
    const firstRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", firstRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const link = currentLinkPath(harness);
    expect(lstatSync(link).isSymbolicLink(), "current is not a symlink after install").toBe(true);
    expect(readlinkSync(link)).toBe(firstRoot);

    // A real deploy's upgrade names a new generation directory, not the one just installed.
    const secondRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["upgrade", "--app-root", secondRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    expect(readlinkSync(link), "current was not repointed after upgrade").toBe(secondRoot);
  });

  it("does not repoint current when upgrade fails before completing, including failure during startup", () => {
    // ACP1052-R2: the attempted upgrade must name a root distinct from the one already installed.
    // Reusing the installed root would still satisfy "current still names appRoot" even if a
    // regression repointed current at that same root before resolve_node or start_job ran — this
    // is exactly the gap the earlier, single-root version of this test could not see.
    const harness = makeHarness();
    const firstRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", firstRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const link = currentLinkPath(harness);
    expect(readlinkSync(link)).toBe(firstRoot);

    // A Node path that cannot resolve fails resolve_node before anything else runs.
    const secondRoot = makeDisposableAppRoot();
    const failed = runInstaller(
      installer,
      ["upgrade", "--app-root", secondRoot, "--node", join(harness.home, "no-such-node")],
      harness,
    );
    expect(failed.status).not.toBe(0);
    expect(readlinkSync(link), "current moved on a failed upgrade").toBe(firstRoot);

    // Every mutation (runtime, plist, launcher) succeeds but the service never reports a
    // completed start; publish must not run over that failure either.
    const thirdRoot = makeDisposableAppRoot();
    harness.env["ACP_FAKE_PID_MODE"] = "none";
    const failedStart = runInstaller(installer, ["upgrade", "--app-root", thirdRoot, "--node", harness.node], harness);
    expect(failedStart.status).not.toBe(0);
    expect(readlinkSync(link), "current moved on a startup failure").toBe(firstRoot);
  });

  it("points current at the generation a rollback restores", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status).toBe(
      0,
    );
    const fixture = await sealPairFor(harness, appRoot);
    const link = currentLinkPath(harness);
    expect(readlinkSync(link)).toBe(appRoot);

    // Simulate a later generation having moved current elsewhere, so the assertion below is about
    // the rollback switching it back rather than it having never moved.
    const decoyRoot = makeDisposableAppRoot();
    rmSync(link);
    symlinkSync(decoyRoot, link);
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
    expect(readlinkSync(link), "rollback did not repoint current at the restored app root").toBe(appRoot);
  });

  it("refuses to replace an unsafe existing current rather than overwrite it, before touching anything", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    const state = join(harness.home, ".agent-control-plane");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    const link = currentLinkPath(harness);
    // A plain directory at this name, not a symlink this installer ever wrote. The ownership
    // check this guards is unreachable from this sandbox (no root to own a decoy as a different
    // uid), but a non-symlinked directory exercises the same refusal: never overwrite a `current`
    // this run did not create.
    mkdirSync(link, { mode: 0o700 });
    writeFileSync(join(link, "marker.txt"), "not an installer artifact\n", { mode: 0o600 });
    // makeDisposableAppRoot copies this repository's own dist/, which an earlier row in this same
    // suite run may already have cloned a (fake) interpreter into via --app-root root; snapshot
    // what the fixture actually starts with rather than assuming absence.
    const runtimeNodePath = join(appRoot, "dist", "bin", "node");
    const beforeRuntimeNode = existsSync(runtimeNodePath) ? readFileSync(runtimeNodePath) : null;

    const result = runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness);

    expect(result.status, "install succeeded despite an unsafe existing current").not.toBe(0);
    expect(result.stderr).toContain("refusing to replace a non-symlink");
    expect(lstatSync(link).isSymbolicLink(), "the unsafe directory was replaced with a symlink").toBe(false);
    expect(existsSync(join(link, "marker.txt")), "the pre-existing directory's contents were lost").toBe(true);
    // ACP1052-R1: the preflight runs before any deployment mutation, so nothing below ran either.
    if (beforeRuntimeNode === null) {
      expect(existsSync(runtimeNodePath), "the preflight refusal still installed the runtime").toBe(false);
    } else {
      expect(readFileSync(runtimeNodePath), "the preflight refusal still replaced the runtime").toEqual(
        beforeRuntimeNode,
      );
    }
    expect(existsSync(harness.launchLog), "the preflight refusal still called launchctl").toBe(false);
  });

  it("ACP1052-R1: preserves deployment bytes and service state when current is unsafe before an upgrade", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const link = currentLinkPath(harness);
    // An unsafe current arrives after the install that set it correctly, e.g. something else
    // having written over it.
    rmSync(link, { force: true });
    mkdirSync(link, { mode: 0o700 });
    writeFileSync(join(link, "marker.txt"), "untouched\n", { mode: 0o600 });

    const runtimeNode = join(appRoot, "dist", "bin", "node");
    const originalRuntime = readFileSync(runtimeNode);
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    writeFileSync(harness.launchLog, "");
    const nextNode = stableFixtureExecutable("node-new", `${readFileSync(harness.node, "utf8")}\n# new generation\n`);

    const result = runInstaller(installer, ["upgrade", "--app-root", appRoot, "--node", nextNode], harness);

    expect(result.status, "upgrade proceeded despite an unsafe current").not.toBe(0);
    expect(result.stderr).toContain("refusing to replace a non-symlink");
    // The point of ACP1052-R1: no launchd call at all, not even a refused one reached mid-way.
    expect(subcommands(harness.launchLog), "a preflight refusal still touched launchd").toEqual([]);
    expect(readFileSync(runtimeNode)).toEqual(originalRuntime);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(existsSync(join(link, "marker.txt")), "the pre-existing directory's contents were lost").toBe(true);
  });

  it("ACP1052-R1: preserves deployment bytes and service state when current is unsafe before a rollback", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    const link = currentLinkPath(harness);
    rmSync(link, { force: true });
    mkdirSync(link, { mode: 0o700 });
    writeFileSync(join(link, "marker.txt"), "untouched\n", { mode: 0o600 });

    const originalRuntime = readFileSync(join(appRoot, "dist", "bin", "node"));
    const originalPlist = readFileSync(plistPath(harness), "utf8");
    const originalLauncher = readFileSync(launcherPath(harness), "utf8");
    const stateAdminBefore = existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "";
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
        fixture.pair.pairId,
        "--expected-index-digest",
        fixture.pair.indexDigest,
        ...structuralFlags(fixture),
      ],
      harness,
    );

    expect(result.status, "rollback proceeded despite an unsafe current").not.toBe(0);
    expect(result.stderr).toContain("refusing to replace a non-symlink");
    // The prevalidation invariant rollback already keeps for every other check: a refusal here
    // leaves the filesystem exactly as it found it, with not even a bootout attempted.
    expect(subcommands(harness.launchLog), "a preflight refusal still touched launchd").toEqual([]);
    expect(readFileSync(join(appRoot, "dist", "bin", "node"))).toEqual(originalRuntime);
    expect(readFileSync(plistPath(harness), "utf8")).toBe(originalPlist);
    expect(readFileSync(launcherPath(harness), "utf8")).toBe(originalLauncher);
    expect(existsSync(harness.stateAdminLog) ? readFileSync(harness.stateAdminLog, "utf8") : "").toBe(
      stateAdminBefore,
    );
    expect(existsSync(join(harness.home, ".agent-control-plane", "rollback-stage"))).toBe(false);
    expect(existsSync(join(link, "marker.txt")), "the pre-existing directory's contents were lost").toBe(true);
  });

  it("ACP1052-R1: does not fail an otherwise successful install when the current link cannot be published", () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    // Nothing else in this script calls `ln`; failing it unconditionally isolates publish's own
    // rename step without disturbing any other step the installer takes.
    overridePath(harness, "ln", "#!/bin/bash\nexit 1\n");

    const result = runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("current was not updated");
    expect(existsSync(currentLinkPath(harness)), "a failed publish left a link behind").toBe(false);
    expect(existsSync(plistPath(harness)), "an unrelated publish failure blocked the rest of install").toBe(true);
  });

  it("ACP1052-R1: does not fail an otherwise successful rollback when the current link cannot be published", async () => {
    const harness = makeHarness();
    const appRoot = makeDisposableAppRoot();
    expect(
      runInstaller(installer, ["install", "--app-root", appRoot, "--node", harness.node], harness).status,
    ).toBe(0);
    const fixture = await sealPairFor(harness, appRoot);
    writeFileSync(harness.launchLog, "");
    overridePath(harness, "ln", "#!/bin/bash\nexit 1\n");

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
        fixture.pair.indexDigest,
        ...structuralFlags(fixture),
      ],
      harness,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("current was not updated");
    expect(readFileSync(join(appRoot, "dist", GENERATION_MARKER), "utf8").trim()).toBe("sealed-generation");
  });

  it("keeps the template as the only plist artifact in the tree", () => {
    const tree = treeFiles();
    expect(tree.filter((path) => path.endsWith(".plist"))).toEqual([]);
    expect(readFileSync(template, "utf8")).toContain("__ACP_");
    expect(tree.filter((path) => path.endsWith(".plist.template"))).toEqual([template]);
  });
});

/**
 * syspolicyd records one provenance row per new executable inode exec'd, and that table cannot be
 * pruned (tests/helpers/stable-fixture-executable.ts). The rows above execute provider CLIs, the
 * Buzz CLI, an updater's versioned files and a sealed closure's interpreter, and each run writes
 * them into that run's own fresh home, because the rows need them at those paths.
 *
 * What is measured here is the writers themselves, run twice the way those rows call them: once to
 * warm the cache and once more as the repeated run. A cache directory that stays the same size says
 * nothing about this — a writer that bypasses it never touches it. So the measurement reads the
 * executables each run actually left at the paths its rows use, and the repeated run must have
 * minted none: every executable it left shares an inode with one the warm run left, which two fresh
 * homes can only do through the cache.
 */
describe("the suite's executable fixture writers", () => {
  const writeEveryExecutableFixture = (): string => {
    const home = tempDir("acp-launchd-writers-");
    // The names the rows use: provider CLIs (#785, #954), the CommitLore CLI (#246 B3), the Buzz CLI
    // (#423), an updater's versions (#954), and the link target the leak row reads its sentinel from.
    for (const name of [
      "claude",
      "codex",
      "grok",
      "commitlore",
      "acp-sibling-probe",
      "claude-1.0",
      "buzz",
      "1.0.0",
      "2.0.0",
      "node-ACPCANONICALSENTINEL",
    ]) {
      writeProviderCli(join(home, name), SELF_CONTAINED_CLI);
    }
    mkdirSync(join(home, "scripted"));
    writeProviderCli(join(home, "scripted", "codex"), ENV_INTERPRETER_CLI);
    writeSealedPairNode(join(home, "runtime"));
    return home;
  };

  const executables = (root: string): { path: string; inode: string }[] => {
    const found: { path: string; inode: string }[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        const stat = lstatSync(path);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          found.push({ path: relative(root, path), inode: `${stat.dev}:${stat.ino}` });
        }
      }
    };
    walk(root);
    return found;
  };

  it("mint no executable inode on a repeated run beyond the warm cache", () => {
    const warm = new Set(executables(writeEveryExecutableFixture()).map(({ inode }) => inode));
    const repeated = executables(writeEveryExecutableFixture());

    expect(repeated.length, "the writers left no executables, so this measured nothing").toBe(12);
    expect(
      repeated.filter(({ inode }) => !warm.has(inode)).map(({ path }) => path),
      "a repeated run wrote these as new executable inodes",
    ).toEqual([]);
  });
});
