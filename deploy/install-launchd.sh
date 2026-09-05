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

export ACP_MCP_TOKEN="$(required_keychain_value ACP_MCP_TOKEN)"
export ACP_OPERATOR_TOKEN="$(required_keychain_value ACP_OPERATOR_TOKEN)"
for optional in ACP_OPERATOR_ACTOR BUZZ_PRIVATE_KEY ACP_BUZZ_INGRESS_SECRET ACP_BUZZ_ALLOWED_ACTORS BUZZ_RELAY_URL ACP_BUZZ_BINARY ACP_BUZZ_CHANNEL \
  ACP_TELEGRAM_BOT_TOKEN ACP_TELEGRAM_OWNER_ID ACP_TELEGRAM_ALLOWED_OWNER_IDS \
  ACP_TELEGRAM_CHAT_ID ACP_TELEGRAM_ALLOWED_CHAT_IDS ACP_TELEGRAM_WEBHOOK_SECRET \
  ACP_TELEGRAM_POLL_TIMEOUT_SECONDS ACP_TELEGRAM_RETRY_DELAY_MS \
  ACP_TELEGRAM_DEFAULT_PROJECT_ID ACP_TELEGRAM_API_BASE_URL ACP_TELEGRAM_TRANSPORT_RETENTION_MS; do
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
    stop_job
    wait_for_stop
    if ! rollback_report="$("$node_path" "$validator" rollback "${rollback_flags[@]}")"; then
      start_job
      fail "rollback failed and the previous generation was restored; the service was started again"
    fi
    start_job
    applied_generation=""
    while IFS='=' read -r report_key report_value; do
      case "$report_key" in
        ACP_APPLIED_GENERATION) applied_generation="$report_value" ;;
      esac
    done <<< "$rollback_report"
    printf 'rolled back to sealed pair %s (generation %s)\n' "$pair_id" "$applied_generation"
    ;;
esac
