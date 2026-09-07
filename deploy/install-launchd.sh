#!/bin/bash
# Render and manage the per-user launchd job for agentcpd on macOS.
set -euo pipefail

readonly LABEL="com.agentcontrolplane.agentcpd"
readonly SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_APP_ROOT="$(cd -P -- "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  deploy/install-launchd.sh install [--app-root PATH] [--node PATH] [--keychain-service NAME] [--no-start]
  deploy/install-launchd.sh start | stop | restart | status | uninstall
  deploy/install-launchd.sh upgrade --app-root PATH [--node PATH] [--keychain-service NAME]
  deploy/install-launchd.sh rollback --pair-id UUID --expected-index-digest sha256:HEX \
    --expect-schema-version N --expect-service-generation NAME --expect-node-version vX.Y.Z

rollback restores one sealed pair, named by its UUID under
$HOME/.agent-control-plane/rollback-pairs/. It selects nothing implicitly: the pair holds the
WAL-complete database backup, the runtime closure and the launchd generation together, and
--expected-index-digest is the SHA256(SHA256SUMS) retained outside the pair, without which a
pair can vouch for a forgery of itself. Prevalidation runs before anything is stopped.

The job always uses $HOME/.agent-control-plane because that is agentcpd's configured
state root. Secrets never go in the plist: store ACP_MCP_TOKEN and ACP_OPERATOR_TOKEN (both required),
optional Buzz variables, and optional Telegram variables as generic-password Keychain items under the
selected service. Telegram is disabled when none of its variables are present and refuses a partial set.

BUZZ_PRIVATE_KEY has a second source. When no such item exists under the selected service,
the launcher falls back to the Buzz desktop app's own store, whose layout is a JSON object
keyed by identity rather than one item per variable. Point it elsewhere with
ACP_BUZZ_KEYCHAIN_SERVICE, ACP_BUZZ_KEYCHAIN_ACCOUNT, and ACP_BUZZ_KEYCHAIN_IDENTITY.
EOF
}

fail() {
  printf 'agentcpd launchd installer: %s\n' "$*" >&2
  exit 1
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage; exit 2; }
shift || true

app_root="$DEFAULT_APP_ROOT"
node_path="${ACP_NODE_PATH:-}"
keychain_service="com.agentcontrolplane.agentcpd"
# Where the Buzz desktop app keeps relay identities when the operator has not exported a
# dedicated BUZZ_PRIVATE_KEY item. Overridable because it is that app's layout, not ours.
buzz_keychain_service="${ACP_BUZZ_KEYCHAIN_SERVICE:-buzz-desktop}"
buzz_keychain_account="${ACP_BUZZ_KEYCHAIN_ACCOUNT:-secrets}"
buzz_keychain_identity="${ACP_BUZZ_KEYCHAIN_IDENTITY:-identity}"
pair_id=""
expected_index_digest=""
expect_schema_version=""
expect_service_generation=""
expect_node_version=""
no_start=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root)
      app_root="${2:-}"; shift 2 ;;
    --node)
      node_path="${2:-}"; shift 2 ;;
    --keychain-service)
      keychain_service="${2:-}"; shift 2 ;;
    --pair-id)
      pair_id="${2:-}"; shift 2 ;;
    --expected-index-digest)
      expected_index_digest="${2:-}"; shift 2 ;;
    --expect-schema-version)
      expect_schema_version="${2:-}"; shift 2 ;;
    --expect-service-generation)
      expect_service_generation="${2:-}"; shift 2 ;;
    --expect-node-version)
      expect_node_version="${2:-}"; shift 2 ;;
    --no-start)
      no_start=1; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      fail "unknown option: $1" ;;
  esac
done

[[ "$command_name" =~ ^(install|start|stop|restart|status|uninstall|upgrade|rollback)$ ]] || {
  usage
  exit 2
}

[[ "$(uname -s)" == "Darwin" ]] || fail "launchd deployment is supported only on macOS"

home_dir="${HOME:?HOME must be set for a per-user LaunchAgent}"
state_dir="$home_dir/.agent-control-plane"
launch_agents_dir="$home_dir/Library/LaunchAgents"
plist_path="$launch_agents_dir/$LABEL.plist"
launcher_path="$state_dir/agentcpd-launch.sh"
deploy_backups_dir="$state_dir/deploy-backups"
rollback_pairs_dir="$state_dir/rollback-pairs"
domain="gui/$(id -u)"
job="$domain/$LABEL"

private_directory() {
  local target="$1"
  if [[ -L "$target" ]]; then fail "refusing symlinked directory: $target"; fi
  if [[ ! -e "$target" ]]; then
    mkdir -p "$target"
    chmod 700 "$target"
  fi
  [[ -d "$target" && ! -L "$target" ]] || fail "not a direct directory: $target"
  local metadata owner mode
  metadata="$(stat -f '%u %Lp' "$target")"
  owner="${metadata%% *}"
  mode="${metadata##* }"
  [[ "$owner" == "$(id -u)" ]] || fail "directory is not owned by this user: $target"
  [[ "$mode" == "700" ]] || fail "directory mode must be 0700, found $mode: $target"
}

# Read-only. `private_directory` creates and chmods, which is a mutation: running it during
# rollback prevalidation means a refused rollback has already changed the filesystem, and the
# directory it silently created is one nobody chose to have. Setup mutation belongs to
# install/upgrade; validation only ever asks.
assert_existing_private_directory() {
  local target="$1"
  [[ ! -L "$target" ]] || fail "refusing symlinked directory: $target"
  [[ -d "$target" ]] || fail "required directory does not exist: $target"
  local metadata owner mode
  metadata="$(stat -f '%u %Lp' "$target")"
  owner="${metadata%% *}"
  mode="${metadata##* }"
  [[ "$owner" == "$(id -u)" ]] || fail "directory is not owned by this user: $target"
  [[ "$mode" == "700" ]] || fail "directory mode must be 0700, found $mode: $target"
}

private_file() {
  local target="$1"
  [[ -f "$target" && ! -L "$target" ]] || fail "not a regular file: $target"
  local metadata owner mode
  metadata="$(stat -f '%u %Lp' "$target")"
  owner="${metadata%% *}"
  mode="${metadata##* }"
  [[ "$owner" == "$(id -u)" ]] || fail "file is not owned by this user: $target"
  [[ "$mode" == "600" ]] || fail "file mode must be 0600, found $mode: $target"
}

launch_agents_directory() {
  local target="$1"
  [[ ! -L "$target" ]] || fail "refusing symlinked LaunchAgents directory: $target"
  mkdir -p "$target"
  [[ -d "$target" && ! -L "$target" ]] || fail "not a direct LaunchAgents directory: $target"
  local owner mode
  owner="$(stat -f '%u' "$target")"
  mode="$(stat -f '%Lp' "$target")"
  [[ "$owner" == "$(id -u)" ]] || fail "LaunchAgents directory is not owned by this user: $target"
  # launchd needs to traverse this standard user directory; only write bits are dangerous.
  [[ $((8#$mode & 8#22)) -eq 0 ]] || fail "LaunchAgents directory is group/world writable: $target"
}

resolve_app_root() {
  [[ -d "$app_root" ]] || fail "app root does not exist: $app_root"
  app_root="$(cd -P -- "$app_root" && pwd)"
  # Both checks run on the canonical path, and before anything is installed, stopped or written.
  # Canonical is the operative word: an input with neither property can resolve to a path with
  # one, so a check on what the caller typed would pass while the deployment still breaks.
  #
  # Neither message repeats the path back. A refusal is written to an operator's terminal, a log
  # and often an issue, and the app root is the caller's private filesystem layout; the condition
  # is what the reader needs, and they already know what they supplied.
  #
  # ':' — the launcher exports this app root's runtime interpreter directory as a POSIX PATH
  # entry, and ':' is the entry separator: such a path splits into two entries that name nothing,
  # the interpreter becomes unreachable, and a provider CLI whose shebang resolves its interpreter
  # by name then finds an ambient one or none. A PATH entry cannot represent the path at all.
  [[ "$app_root" != *:* ]] || fail "app root path cannot contain ':' after canonicalisation, because the launcher exports its runtime interpreter directory as a POSIX PATH entry and ':' separates entries; install from a path without ':'"
  # '/' — every path this installer derives is "$app_root/..." , which at the filesystem root
  # yields a leading '//', whose meaning POSIX leaves to the implementation. The sealed rollback
  # binding canonicalises the same location to a single leading '/', so the two disagree about one
  # install. Refusing is the narrow answer: making every derived path root-safe would mean
  # changing how the binding builds paths too, which is a different module and a wider change than
  # the deployment shape it would buy.
  [[ "$app_root" != "/" ]] || fail "app root cannot be the filesystem root after canonicalisation, because every path derived from it would carry a leading '//' that the sealed rollback binding canonicalises differently; install into a directory"
  [[ -f "$app_root/dist/daemon/agentcpd.js" ]] || fail "build missing: $app_root/dist/daemon/agentcpd.js"
  [[ -f "$app_root/dist/db/state-admin.js" ]] || fail "state maintenance build missing: $app_root/dist/db/state-admin.js"
  [[ -f "$app_root/deploy/render-launchd-plist.mjs" ]] || fail "plist renderer missing from app root"
}

# Resolve a path to the real file it finally names: every symlink followed, every directory
# component canonical. What is pinned has to be the target itself, not a name for it — a pin that
# records a symlink keeps looking correct after the link is repointed, and the daemon then runs a
# different provider binary than the one this install accepted. macOS has no `readlink -f`, so the
# chain is walked here, bounded, and the answer is required to be an absolute regular executable.
canonical_executable() {
  local candidate="$1" hops=0 target directory base
  [[ -n "$candidate" ]] || return 1
  while [[ -L "$candidate" ]]; do
    hops=$((hops + 1))
    [[ "$hops" -le 40 ]] || return 1
    # A link can stop being readable between the predicate above and this call, and the utility
    # reports that by printing the path it was given. That line would cross the installer boundary
    # on its own, ahead of the generic refusal below, which cannot retract it — and a refusal
    # reaches a terminal, a log and often an issue. The failure is taken silently instead: the
    # caller learns the path did not resolve, not what the path was.
    target="$(readlink -- "$candidate" 2>/dev/null)" || return 1
    if [[ "$target" == /* ]]; then
      candidate="$target"
    else
      candidate="$(dirname -- "$candidate")/$target"
    fi
  done
  directory="$(cd -P -- "$(dirname -- "$candidate")" 2>/dev/null && pwd)" || return 1
  base="$(basename -- "$candidate")"
  candidate="${directory%/}/$base"
  [[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || return 1
  printf '%s' "$candidate"
}

resolve_node() {
  if [[ -z "$node_path" ]]; then node_path="$(command -v node || true)"; fi
  [[ "$node_path" = /* && -x "$node_path" ]] || fail "provide an executable absolute Node path with --node"
  # Canonical before it is copied into the runtime closure, so the generation carries the
  # interpreter itself rather than whatever a link happens to point at when the copy is taken.
  node_path="$(canonical_executable "$node_path")" ||
    fail "the Node path does not resolve to an absolute regular executable"
}

# A sealed pair's own guarantee is that its bytes plus the interpreter it names is the whole
# runtime — nothing the machine acquires or loses after sealing changes what a restored generation
# executes. `resolve_node` above answers "what does this host currently call node", which is
# outside the app root on every host that manages its own interpreter (a version manager, a
# user-local install) — and a launcher bound to that path is a launcher `sealRollbackPair` refuses
# to seal at all: it names an interpreter the closure does not carry, converting "this exact
# generation" into "these bytes under whatever node is around later", which is the defect
# `assertGenerationBindings` (src/deploy/rollback-pair.ts) exists to end. So the interpreter is
# cloned into the runtime root itself, once per install/upgrade, and every later step — the
# launcher this script writes and the closure a seal later copies — is bound to that in-tree copy
# rather than the host's own PATH resolution.
install_node_into_runtime() {
  local dest_dir="$app_root/dist/bin"
  local dest="$dest_dir/node"
  mkdir -p "$dest_dir"
  chmod 755 "$dest_dir"
  # Idempotent against re-running install/upgrade after this step has already bound `node_path` to
  # `dest` on a previous run: `cp` onto its own source is undefined at best, so identity is checked
  # by resolved path rather than assumed from where the flag pointed.
  if [[ -e "$dest" ]]; then
    local resolved_src resolved_dest
    resolved_src="$(cd -P -- "$(dirname -- "$node_path")" && pwd)/$(basename -- "$node_path")"
    resolved_dest="$(cd -P -- "$(dirname -- "$dest")" && pwd)/$(basename -- "$dest")"
    if [[ "$resolved_src" == "$resolved_dest" ]]; then
      node_path="$dest"
      return 0
    fi
  fi
  rm -f "$dest"
  # `-c` asks APFS for a clone (near-zero cost for a multi-hundred-megabyte interpreter); a
  # filesystem that cannot clone still gets a real copy rather than a failure.
  cp -c "$node_path" "$dest" 2>/dev/null || cp "$node_path" "$dest"
  chmod 755 "$dest"
  [[ -x "$dest" ]] || fail "failed to install the Node interpreter into the runtime closure: $dest"
  node_path="$dest"
}

keychain_required() {
  local account="$1"
  security find-generic-password -w -s "$keychain_service" -a "$account" >/dev/null 2>&1 ||
    fail "missing Keychain item service=$keychain_service account=$account"
}

snapshot_current_deployment() {
  [[ -f "$plist_path" && -f "$launcher_path" ]] || return 0
  private_file "$plist_path"
  [[ -f "$launcher_path" && ! -L "$launcher_path" ]] || fail "existing launcher is not a regular file"
  private_directory "$deploy_backups_dir"
  local snapshot="$deploy_backups_dir/$(date -u +%Y%m%dT%H%M%SZ)-$(/usr/bin/uuidgen)"
  mkdir "$snapshot"
  chmod 700 "$snapshot"
  cp "$plist_path" "$snapshot/$LABEL.plist"
  cp "$launcher_path" "$snapshot/agentcpd-launch.sh"
  chmod 600 "$snapshot/$LABEL.plist"
  chmod 700 "$snapshot/agentcpd-launch.sh"
}

# The launcher runs under launchd with a fixed PATH that does not include a user-local bin
# directory, so a `buzz` installed at ~/.local/bin is invisible to the daemon even though it
# is on the installing shell's PATH. Resolve it here, while that PATH is still available, and
# bake in the absolute path — otherwise the transport reports unavailable in production for a
# reason nothing in the daemon's own logs can explain.
resolve_buzz_binary() {
  local found=""
  found="$(command -v buzz 2>/dev/null || true)"
  [[ -n "$found" && -x "$found" ]] || return 0
  printf '%s' "$found"
}

# `resolveExecutable` (src/runtime/cli-adapters.ts) searches the daemon's PATH for the bare names
# `claude`, `codex` and `grok`. The launcher pins that PATH to a fixed set of directories, so a
# CLI installed anywhere else is unreachable to the daemon while remaining reachable from the
# shell that installs it. An unresolvable CLI returns as a bare name, nothing spawns, and the
# capacity parser has no representation for "the CLI was not there" — it reports the empty stream
# as no quota. Resolving here, while the installing shell's PATH is visible, is what makes the
# path available to a daemon that cannot search for it.
#
# Only an absolute answer is baked. The daemon runs from a working directory the installing shell
# does not share, and `resolveExecutable` returns an absolute-looking path unchanged rather than
# searching, so a relative pin turns a PATH miss into a failure to stat one layer further in.
resolve_cli_binary() {
  local name="$1" found=""
  found="$(command -v "$name" 2>/dev/null || true)"
  [[ -n "$found" && "$found" == /* ]] || return 0
  # The canonical target, not the name the shell answered with. A pin that records a symlink still
  # reads as correct after the link is repointed, and the daemon then runs a different binary than
  # the one this install resolved and accepted.
  found="$(canonical_executable "$found")" || return 0
  printf '%s' "$found"
}

write_launcher() {
  local temporary="$state_dir/.agentcpd-launch.$$.tmp"
  umask 077
  # Resolved before the launcher is opened for writing, because stdout inside the block below is
  # the launcher file and an unresolvable CLI has to reach the operator's terminal instead.
  #
  # A CLI that cannot be resolved does not fail the install: `grok` is optional, and a host
  # without it must still be able to deploy. It is named on stderr instead, because a provider
  # whose CLI is absent reports no quota rather than an error, which is indistinguishable from a
  # provider that is simply out of quota unless the install says so.
  local spec cli pin_variable resolved_cli
  local cli_pins=()
  for spec in claude:ACP_RESOLVED_CLAUDE_BINARY codex:ACP_RESOLVED_CODEX_BINARY grok:ACP_RESOLVED_GROK_BINARY; do
    cli="${spec%%:*}"
    pin_variable="${spec##*:}"
    resolved_cli="$(resolve_cli_binary "$cli")"
    if [[ -z "$resolved_cli" ]]; then
      printf 'agentcpd installer: could not resolve the %s CLI from this PATH. Nothing is pinned for it, and the %s capacity probe will report no quota rather than an error.\n' \
        "$cli" "$cli" >&2
      continue
    fi
    cli_pins[${#cli_pins[@]}]="$pin_variable=$resolved_cli"
  done
  {
    printf '#!/bin/bash\nset -euo pipefail\n'
    printf 'ACP_NODE_PATH=%q\n' "$node_path"
    printf 'ACP_APP_ROOT=%q\n' "$app_root"
    printf 'ACP_STATE_DIR=%q\n' "$state_dir"
    printf 'ACP_KEYCHAIN_SERVICE=%q\n' "$keychain_service"
    printf 'ACP_BUZZ_KEYCHAIN_SERVICE=%q\n' "$buzz_keychain_service"
    printf 'ACP_BUZZ_KEYCHAIN_ACCOUNT=%q\n' "$buzz_keychain_account"
    printf 'ACP_BUZZ_KEYCHAIN_IDENTITY=%q\n' "$buzz_keychain_identity"
    local resolved_buzz=""
    resolved_buzz="$(resolve_buzz_binary)"
    if [[ -n "$resolved_buzz" ]]; then
      printf 'ACP_RESOLVED_BUZZ_BINARY=%q\n' "$resolved_buzz"
    fi
    local pin
    if [[ ${#cli_pins[@]} -gt 0 ]]; then
      for pin in "${cli_pins[@]}"; do
        printf '%s=%q\n' "${pin%%=*}" "${pin#*=}"
      done
    fi
    printf 'ACP_HOME=%q\n' "$home_dir"
    cat <<'EOF'
export HOME="$ACP_HOME"
# The daemon's PATH is this deployment's own runtime interpreter directory followed by the fixed
# system directories, and nothing else. A provider CLI is reached by the absolute pin below, never
# by placing its directory here: a provider's directory holds unrelated executables, and putting
# it on the daemon's PATH would make every one of them resolvable to a control plane that grants
# authority by name.
#
# The interpreter directory comes first so that a CLI whose shebang resolves its interpreter
# through the environment receives the interpreter this generation carries, rather than whichever
# one a system directory happens to hold.
#
# `/usr/sbin` is last, and is here for `lsof`, which ships only from there. A canonical self-claim
# resolves the claiming process's executing image by spawning `lsof` under its bare name and
# consulting no environment, so this PATH is the only channel that reaches that call: without the
# directory the scan comes back empty, the image resolves to null, and a genuine claim is refused
# with evidence that names neither the missing tool nor the cause. It is a system directory of the
# same standing as `/usr/bin` and `/bin` above — root-owned, mode 755, SIP `restricted`, not
# user-writable, listed in `/etc/paths` as part of the platform's own default PATH, and holding
# none of the names this control plane grants authority by. That is what separates it from a
# provider directory, which is user-writable and drags unrelated siblings into reach.
export PATH="${ACP_NODE_PATH%/*}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"

required_keychain_value() {
  local account="$1" value=""
  value="$(security find-generic-password -w -s "$ACP_KEYCHAIN_SERVICE" -a "$account" 2>/dev/null)" || {
    printf 'agentcpd launcher: missing Keychain item service=%s account=%s\n' "$ACP_KEYCHAIN_SERVICE" "$account" >&2
    exit 78
  }
  printf '%s' "$value"
}

optional_keychain_value() {
  local account="$1" value=""
  unset "$account"
  value="$(security find-generic-password -w -s "$ACP_KEYCHAIN_SERVICE" -a "$account" 2>/dev/null)" || return 0
  [[ -n "$value" ]] || return 0
  printf -v "$account" '%s' "$value"
  export "$account"
}

# The Buzz relay credential is not stored as its own Keychain item on a host where the Buzz
# desktop app owns it: that app keeps every identity's secret inside one `buzz-desktop` /
# `secrets` JSON object, keyed by identity name. Read it from there when no dedicated
# `BUZZ_PRIVATE_KEY` account exists, so the daemon does not start with a silently absent
# credential — `BuzzCliTransport.available()` returns false without it and the doctor then
# reports CTO_BUZZ_NOT_CONNECTED with nothing to point at.
buzz_key_from_desktop_secrets() {
  [[ -n "${BUZZ_PRIVATE_KEY:-}" ]] && return 0
  # agentcpd refuses to start when BUZZ_PRIVATE_KEY is present without its ingress pair,
  # because a transport that can receive but cannot authenticate an actor is worse than no
  # transport. Supplying the key here without them would turn a daemon that runs DEGRADED
  # into one that exits on every launchd restart, so this fallback stays out of the way
  # until the deployment has the whole set.
  if [[ -z "${ACP_BUZZ_INGRESS_SECRET:-}" || -z "${ACP_BUZZ_ALLOWED_ACTORS:-}" ]]; then
    printf 'agentcpd launcher: skipping the Buzz desktop credential — ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS are not both configured\n' >&2
    return 0
  fi
  local blob=""
  blob="$(security find-generic-password -w -s "$ACP_BUZZ_KEYCHAIN_SERVICE" -a "$ACP_BUZZ_KEYCHAIN_ACCOUNT" 2>/dev/null)" || return 0
  local extracted=""
  # The identity key travels in the environment, not in argv. `node -e` argv indexing is a
  # runtime detail — the launcher runs whatever binary --node was pointed at — and picking
  # the wrong index here would silently select a *different* identity's secret rather than
  # fail, which is the one outcome worse than having no credential.
  extracted="$(
    printf '%s' "$blob" | ACP_BUZZ_IDENTITY_KEY="$ACP_BUZZ_KEYCHAIN_IDENTITY" "$ACP_NODE_PATH" -e '
      let raw = "";
      process.stdin.on("data", (c) => { raw += c; });
      process.stdin.on("end", () => {
        try {
          const value = JSON.parse(raw)[process.env.ACP_BUZZ_IDENTITY_KEY];
          if (typeof value === "string" && value.length > 0) process.stdout.write(value);
        } catch { /* not the JSON shape we expect: leave the credential unset */ }
      });
    ' 2>/dev/null
  )" || return 0
  [[ -n "$extracted" ]] || return 0
  export BUZZ_PRIVATE_KEY="$extracted"
}

# Clear the entire activation group before any credential lookup can inherit a partial group.
unset ACP_CANONICAL_SESSION_UUID ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256 ACP_CANONICAL_CTO_BUZZ_ACTOR_ID ACP_CANONICAL_CTO_WORKDIR ACP_CANONICAL_CTO_PEER_PROTOCOL ACP_CANONICAL_CTO_BUZZ_PURPOSE

export ACP_MCP_TOKEN="$(required_keychain_value ACP_MCP_TOKEN)"
export ACP_OPERATOR_TOKEN="$(required_keychain_value ACP_OPERATOR_TOKEN)"
for optional in ACP_OPERATOR_ACTOR BUZZ_PRIVATE_KEY ACP_BUZZ_INGRESS_SECRET ACP_BUZZ_ALLOWED_ACTORS BUZZ_RELAY_URL ACP_BUZZ_BINARY ACP_BUZZ_CHANNEL \
  ACP_TELEGRAM_BOT_TOKEN ACP_TELEGRAM_OWNER_ID ACP_TELEGRAM_ALLOWED_OWNER_IDS \
  ACP_TELEGRAM_CHAT_ID ACP_TELEGRAM_ALLOWED_CHAT_IDS ACP_TELEGRAM_WEBHOOK_SECRET \
  ACP_TELEGRAM_POLL_TIMEOUT_SECONDS ACP_TELEGRAM_RETRY_DELAY_MS \
  ACP_TELEGRAM_DEFAULT_PROJECT_ID ACP_TELEGRAM_API_BASE_URL ACP_TELEGRAM_TRANSPORT_RETENTION_MS \
  ACP_CANONICAL_SESSION_UUID ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION \
  ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256 \
  ACP_CANONICAL_CTO_BUZZ_ACTOR_ID ACP_CANONICAL_CTO_WORKDIR \
  ACP_CANONICAL_CTO_PEER_PROTOCOL ACP_CANONICAL_CTO_BUZZ_PURPOSE; do
  optional_keychain_value "$optional"
done
buzz_key_from_desktop_secrets

# Reviewer credential scopes are paths, not secrets, so they are derived rather than fetched
# from the Keychain. A blind reviewer must not read the ordinary provider config tree — it can
# hold producer conversations — and under `tools: "none"` it cannot spawn `security` to reach
# the Keychain at all, so the credential has to live in a directory it is allowed to read.
# Deriving the default means the operator authenticates into a known path instead of also
# having to publish where it is; an explicit value still wins.
# Outside $ACP_STATE_DIR on purpose. The reviewer seatbelt denies the daemon state tree, so a
# credential placed inside it is unreadable by the process that needs it — measured as
# `failed to read CODEX_HOME ...: Operation not permitted`. The deny is correct; the location
# was wrong. Widening the profile to reach into daemon state would trade the boundary for the
# convenience of one path.
export ACP_REVIEWER_ROOT="${ACP_REVIEWER_ROOT:-$ACP_HOME/.acp-reviewer}"
export ACP_CLAUDE_REVIEWER_CONFIG_DIR="${ACP_CLAUDE_REVIEWER_CONFIG_DIR:-$ACP_REVIEWER_ROOT/claude}"
export ACP_CODEX_REVIEWER_HOME="${ACP_CODEX_REVIEWER_HOME:-$ACP_REVIEWER_ROOT/codex}"

# A Keychain-provided ACP_BUZZ_BINARY wins; otherwise the path resolved at install time.
#
# This runs after the optional loop, not before. optional_keychain_value unsets each account
# before looking it up — deliberately, so a token inherited from the invoking shell cannot pass
# for a Keychain value — which also destroyed a resolved path exported earlier. The daemon then
# fell back to bare `buzz`, unreachable from its pinned PATH: the #423 failure the absolute path
# exists to prevent, reintroduced by a later line.
if [[ -z "${ACP_BUZZ_BINARY:-}" && -n "${ACP_RESOLVED_BUZZ_BINARY:-}" ]]; then
  export ACP_BUZZ_BINARY="$ACP_RESOLVED_BUZZ_BINARY"
fi

# The provider CLIs resolved at install time, for the reason recorded above the Buzz block. An
# operator-supplied value wins; otherwise the daemon is given the path the installer found, which
# is the only channel by which a CLI outside the fixed PATH is reachable at all.
if [[ -z "${ACP_CLAUDE_BINARY:-}" && -n "${ACP_RESOLVED_CLAUDE_BINARY:-}" ]]; then
  export ACP_CLAUDE_BINARY="$ACP_RESOLVED_CLAUDE_BINARY"
fi
if [[ -z "${ACP_CODEX_BINARY:-}" && -n "${ACP_RESOLVED_CODEX_BINARY:-}" ]]; then
  export ACP_CODEX_BINARY="$ACP_RESOLVED_CODEX_BINARY"
fi
if [[ -z "${ACP_GROK_BINARY:-}" && -n "${ACP_RESOLVED_GROK_BINARY:-}" ]]; then
  export ACP_GROK_BINARY="$ACP_RESOLVED_GROK_BINARY"
fi

exec "$ACP_NODE_PATH" "$ACP_APP_ROOT/dist/daemon/agentcpd.js"
EOF
  } > "$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$launcher_path"
}

render_plist() {
  launch_agents_directory "$launch_agents_dir"
  local temporary="$launch_agents_dir/.$LABEL.$$.plist.tmp"
  "$node_path" "$app_root/deploy/render-launchd-plist.mjs" \
    "$app_root/deploy/com.agentcontrolplane.agentcpd.plist.template" \
    "$temporary" "$launcher_path" "$app_root" \
    "$state_dir/agentcpd.out.log" "$state_dir/agentcpd.err.log" "$home_dir" \
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  chmod 600 "$temporary"
  /usr/bin/plutil -lint "$temporary" >/dev/null || fail "rendered plist is invalid"
  mv -f "$temporary" "$plist_path"
  private_file "$plist_path"
}

job_loaded() {
  launchctl print "$job" >/dev/null 2>&1
}

stop_job() {
  if job_loaded; then launchctl bootout "$job"; fi
}

start_job() {
  private_file "$plist_path"
  if ! job_loaded; then launchctl bootstrap "$domain" "$plist_path"; fi
  launchctl kickstart -k "$job"
}

wait_for_stop() {
  local attempt
  for attempt in $(seq 1 30); do
    [[ ! -e "$state_dir/agentcpd.lock" ]] && return 0
    sleep 1
  done
  fail "agentcpd lock remains after launchctl stop; refusing database restore"
}

case "$command_name" in
  install|upgrade)
    resolve_app_root
    resolve_node
    install_node_into_runtime
    private_directory "$state_dir"
    private_directory "$deploy_backups_dir"
    keychain_required ACP_MCP_TOKEN
    keychain_required ACP_OPERATOR_TOKEN
    snapshot_current_deployment
    stop_job
    wait_for_stop
    write_launcher
    render_plist
    if [[ "$no_start" == "0" ]]; then start_job; fi
    printf 'installed %s at %s (state: %s)\n' "$LABEL" "$plist_path" "$state_dir"
    ;;
  start)
    start_job
    ;;
  stop)
    stop_job
    ;;
  restart)
    stop_job
    start_job
    ;;
  status)
    launchctl print "$job"
    ;;
  uninstall)
    stop_job
    [[ ! -e "$plist_path" || ! -L "$plist_path" ]] || fail "refusing symlinked plist"
    [[ ! -e "$launcher_path" || ! -L "$launcher_path" ]] || fail "refusing symlinked launcher"
    rm -f "$plist_path" "$launcher_path"
    printf 'removed launchd artifacts only; database and backups remain in %s\n' "$state_dir"
    ;;
  rollback)
    # The pair is named, never discovered. This branch used to take
    # `find "$deploy_backups_dir" -maxdepth 1 -type d | sort | tail -n 1` — the newest directory
    # by name — and separately an operator-supplied database backup. Newest is not approved, and
    # two independently chosen halves are not a pair: the plist could be from one generation and
    # the database from another with nothing noticing. One sealed pair holds both.
    [[ -n "$pair_id" ]] ||
      fail "rollback requires --pair-id <uuid> naming the sealed pair to restore"
    [[ "$pair_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
      fail "rollback pair id must be a UUID, never a name like 'latest': $pair_id"
    [[ -n "$expected_index_digest" ]] ||
      fail "rollback requires --expected-index-digest sha256:<hex>, the digest retained outside the pair"
    [[ "$expected_index_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      fail "expected index digest must be sha256:<64 hex digits>: $expected_index_digest"
    # Structural compatibility is not optional. A rollback that does not state which schema,
    # generation and runtime it is restoring can be applied to a deployment it was never for, and
    # the pair would have no way to object.
    [[ "$expect_schema_version" =~ ^[0-9]+$ ]] ||
      fail "rollback requires --expect-schema-version <integer>, the schema the sealed image is at"
    [[ -n "$expect_service_generation" ]] ||
      fail "rollback requires --expect-service-generation <name>, the generation being restored"
    [[ -n "$expect_node_version" ]] ||
      fail "rollback requires --expect-node-version <version>, the runtime the sealed closure declares"
    resolve_app_root
    resolve_node
    # Read-only from here to the last prevalidation line: a refused rollback must leave the
    # filesystem exactly as it found it, including not having created the directories it looked in.
    assert_existing_private_directory "$state_dir"
    assert_existing_private_directory "$rollback_pairs_dir"
    pair_root="$rollback_pairs_dir/$pair_id"
    [[ -d "$pair_root" && ! -L "$pair_root" ]] || fail "no sealed rollback pair with this id: $pair_root"
    pair_root="$(cd -P -- "$pair_root" && pwd)"
    [[ "${pair_root##*/}" == "$pair_id" ]] ||
      fail "the sealed pair directory resolves to a different id: $pair_root"
    validator="$app_root/dist/deploy/rollback-pair.js"
    [[ -f "$validator" ]] || fail "rollback pair validator build missing: $validator"

    # Prevalidation, before anything is stopped, restored or replaced. The index digest is the one
    # value deliberately kept outside the pair: a pair that vouches for its own index vouches for
    # a forged one, because a forger rewrites the index alongside the member it altered.
    index_shasum="$(/usr/bin/shasum -a 256 "$pair_root/SHA256SUMS")" ||
      fail "sealed pair index is unreadable: $pair_root/SHA256SUMS"
    actual_index_digest="sha256:${index_shasum%% *}"
    [[ "$actual_index_digest" == "$expected_index_digest" ]] ||
      fail "sealed pair index digest does not match the retained digest: expected $expected_index_digest, found $actual_index_digest"

    # One invocation, one authority. The installer never learns a path inside the pair and never
    # hands one back in: validate, private verified copy, install and post-condition all happen
    # inside the command below, so there is no stage directory anyone can name and apply later.
    # It also states what the deployment *is* — database, service label, app root, install root,
    # schema, generation and runtime — so a pair sealed for a different one is refused.
    rollback_flags=(
      --pair-root "$pair_root"
      --pair-id "$pair_id"
      --expected-index-digest "$expected_index_digest"
      --expect-database "$state_dir/state.sqlite"
      --expect-service-label "$LABEL"
      --expect-working-directory "$app_root"
      --expect-runtime-root "$app_root/dist"
      --expect-schema-version "$expect_schema_version"
      --expect-service-generation "$expect_service_generation"
      --expect-node-version "$expect_node_version"
      --stage-parent "$state_dir/rollback-stage"
    )

    # Everything below this line is one generation being replaced. The command installs the sealed
    # runtime closure, plist, launcher and database together — restoring the database through the
    # *sealed* state-admin under the *sealed* Node, because pair A's image installed by generation
    # B's code is the defect this whole mechanism exists to prevent — and puts the previous
    # generation back if any step fails. A failed rollback therefore ends with the old generation
    # whole, so the job is started again rather than left down.
    "$node_path" "$validator" validate "${rollback_flags[@]}" >/dev/null ||
      fail "sealed rollback pair failed validation: $pair_root"

    # The service state before this rollback touched it. Always starting the job afterwards would
    # leave a deployment running that the operator had deliberately stopped — a state change
    # nobody asked for, arrived at through a failure path. So the original state is captured here
    # and restored on both the success and the compensation path.
    if job_loaded; then service_was_loaded=1; else service_was_loaded=0; fi
    stop_job
    wait_for_stop
    if ! rollback_report="$("$node_path" "$validator" rollback "${rollback_flags[@]}")"; then
      if [[ "$service_was_loaded" == "1" ]]; then start_job; fi
      rm -rf "$state_dir/rollback-stage"
      fail "rollback failed; the previous generation and the original service state were restored"
    fi
    if [[ "$service_was_loaded" == "1" ]]; then start_job; fi
    applied_generation=""
    while IFS='=' read -r report_key report_value; do
      case "$report_key" in
        ACP_APPLIED_GENERATION) applied_generation="$report_value" ;;
      esac
    done <<< "$rollback_report"
    printf 'rolled back to sealed pair %s (generation %s)\n' "$pair_id" "$applied_generation"
    ;;
esac
