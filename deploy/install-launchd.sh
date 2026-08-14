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
  deploy/install-launchd.sh rollback --database-backup PATH

The job always uses $HOME/.agent-control-plane because that is agentcpd's configured
state root. Secrets never go in the plist: store ACP_MCP_TOKEN and ACP_OPERATOR_TOKEN (both required) and optional
Buzz variables as generic-password Keychain items under the selected service.

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
database_backup=""
no_start=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root)
      app_root="${2:-}"; shift 2 ;;
    --node)
      node_path="${2:-}"; shift 2 ;;
    --keychain-service)
      keychain_service="${2:-}"; shift 2 ;;
    --database-backup)
      database_backup="${2:-}"; shift 2 ;;
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
  [[ -f "$app_root/dist/daemon/agentcpd.js" ]] || fail "build missing: $app_root/dist/daemon/agentcpd.js"
  [[ -f "$app_root/dist/db/state-admin.js" ]] || fail "state maintenance build missing: $app_root/dist/db/state-admin.js"
  [[ -f "$app_root/deploy/render-launchd-plist.mjs" ]] || fail "plist renderer missing from app root"
}

resolve_node() {
  if [[ -z "$node_path" ]]; then node_path="$(command -v node || true)"; fi
  [[ "$node_path" = /* && -x "$node_path" ]] || fail "provide an executable absolute Node path with --node"
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

write_launcher() {
  local temporary="$state_dir/.agentcpd-launch.$$.tmp"
  umask 077
  {
    printf '#!/bin/bash\nset -euo pipefail\n'
    printf 'ACP_NODE_PATH=%q\n' "$node_path"
    printf 'ACP_APP_ROOT=%q\n' "$app_root"
    printf 'ACP_KEYCHAIN_SERVICE=%q\n' "$keychain_service"
    printf 'ACP_BUZZ_KEYCHAIN_SERVICE=%q\n' "$buzz_keychain_service"
    printf 'ACP_BUZZ_KEYCHAIN_ACCOUNT=%q\n' "$buzz_keychain_account"
    printf 'ACP_BUZZ_KEYCHAIN_IDENTITY=%q\n' "$buzz_keychain_identity"
    local resolved_buzz=""
    resolved_buzz="$(resolve_buzz_binary)"
    if [[ -n "$resolved_buzz" ]]; then
      printf 'ACP_RESOLVED_BUZZ_BINARY=%q\n' "$resolved_buzz"
    fi
    printf 'ACP_HOME=%q\n' "$home_dir"
    cat <<'EOF'
export HOME="$ACP_HOME"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

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
  value="$(security find-generic-password -w -s "$ACP_KEYCHAIN_SERVICE" -a "$account" 2>/dev/null)" || return 0
  printf -v "$account" '%s' "$value"
  export "$account"
}

# The Buzz relay credential is not stored as its own Keychain item on a host where the Buzz
# desktop app owns it: that app keeps every identity's secret inside one `buzz-desktop` /
# `secrets` JSON object, keyed by identity name. Read it from there when no dedicated
# `BUZZ_PRIVATE_KEY` account exists, so the daemon does not start with a silently absent
# credential — `BuzzCliTransport.available()` returns false without it and the doctor then
# reports CTO_BUZZ_NOT_CONNECTED with nothing to point at.
# A Keychain-provided ACP_BUZZ_BINARY wins; otherwise use the path resolved at install time.
if [[ -z "${ACP_BUZZ_BINARY:-}" && -n "${ACP_RESOLVED_BUZZ_BINARY:-}" ]]; then
  export ACP_BUZZ_BINARY="$ACP_RESOLVED_BUZZ_BINARY"
fi
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

export ACP_MCP_TOKEN="$(required_keychain_value ACP_MCP_TOKEN)"
export ACP_OPERATOR_TOKEN="$(required_keychain_value ACP_OPERATOR_TOKEN)"
for optional in ACP_OPERATOR_ACTOR BUZZ_PRIVATE_KEY ACP_BUZZ_INGRESS_SECRET ACP_BUZZ_ALLOWED_ACTORS BUZZ_RELAY_URL ACP_BUZZ_BINARY ACP_BUZZ_CHANNEL; do
  optional_keychain_value "$optional"
done
buzz_key_from_desktop_secrets

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
    [[ -n "$database_backup" && "$database_backup" = /* ]] ||
      fail "rollback requires --database-backup /absolute/pre-migration-backup.sqlite"
    resolve_app_root
    resolve_node
    private_directory "$state_dir"
    private_directory "$deploy_backups_dir"
    local_snapshot="$(find "$deploy_backups_dir" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)"
    [[ -n "$local_snapshot" ]] || fail "no prior deployment snapshot is available"
    private_file "$local_snapshot/$LABEL.plist"
    [[ -f "$local_snapshot/agentcpd-launch.sh" && ! -L "$local_snapshot/agentcpd-launch.sh" ]] || fail "saved launcher is invalid"
    stop_job
    wait_for_stop
    "$node_path" "$app_root/dist/db/state-admin.js" restore "$database_backup" \
      --database "$state_dir/state.sqlite" --confirm-restore
    cp "$local_snapshot/$LABEL.plist" "$plist_path"
    cp "$local_snapshot/agentcpd-launch.sh" "$launcher_path"
    chmod 600 "$plist_path"
    chmod 700 "$launcher_path"
    start_job
    printf 'rolled back deployment and restored database from %s\n' "$database_backup"
    ;;
esac
