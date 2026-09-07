# macOS launchd deployment

Build the release first, then install the per-user job. The installer resolves and writes
absolute paths; the checked-in plist is a template and must never be loaded directly.

```bash
pnpm build
deploy/install-launchd.sh install --app-root "$(pwd)" --node "$(command -v node)"
```

Before installation, put both required, distinct credentials in the logged-in user's Keychain.
`ACP_MCP_TOKEN` authenticates MCP deployment sockets but identifies no peer; `ACP_OPERATOR_TOKEN`
is the separately provisioned credential for `agentctl` and must never be the same value. Both are
fetched only by the owner-only launcher immediately before it starts `agentcpd`; neither is stored
in the plist or inherited by agent sessions.

```bash
security add-generic-password -U -s com.agentcontrolplane.agentcpd -a ACP_MCP_TOKEN -w
security add-generic-password -U -s com.agentcontrolplane.agentcpd -a ACP_OPERATOR_TOKEN -w
```

The daemon binds the operator credential to its configured local CLI peer. Set
`ACP_OPERATOR_ACTOR` in the daemon environment when the host's `USER` is not the actor declared
in `~/.agent-control-plane/owner-identities`; the CLI cannot supply or override this identity in
an operator request.

Optional Buzz configuration uses the same Keychain service and these account names:
`BUZZ_PRIVATE_KEY`, `ACP_BUZZ_INGRESS_SECRET`, `ACP_BUZZ_ALLOWED_ACTORS`, `BUZZ_RELAY_URL`,
`ACP_BUZZ_BINARY`, and `ACP_BUZZ_CHANNEL`. If `BUZZ_PRIVATE_KEY` is installed, the three ACP
Buzz ingress settings must also be installed because the daemon rejects an unauthenticated
actor-binding setup.

Canonical self-claim is an optional, atomic activation group. Provision all eight accounts under
that same Keychain service to enable it:

- `ACP_CANONICAL_SESSION_UUID`
- `ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION`
- `ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH`
- `ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256`
- `ACP_CANONICAL_CTO_BUZZ_ACTOR_ID`
- `ACP_CANONICAL_CTO_WORKDIR`
- `ACP_CANONICAL_CTO_PEER_PROTOCOL`
- `ACP_CANONICAL_CTO_BUZZ_PURPOSE`

With none present, self-claim is disabled. Empty and whitespace-only values count as absent.
Any nonempty proper subset refuses startup before config access, database opening, migration,
or listener creation; diagnostics name missing variables, never their values. With all eight
present, `ACP_BUZZ_CHANNEL` is also required. Channel-only transport configuration remains valid.
The actor, workdir, protocol and purpose have no defaults: the configured values are retained
from daemon entry and passed unchanged to the claim boundary.

The generated launcher clears all eight inherited variables together before its first Keychain
lookup, then reads each through the existing optional-account loop. These values are not written
to the plist. Installation does not create `buzz-nostr-subscriber.json`; that separately provisioned
subscriber config retains its existing authentication contract. Without it, an otherwise configured
daemon can start with full canonical activation while the subscriber opens zero sockets.

The installer resolves the provider CLIs `claude`, `codex` and `grok` from the installing shell's
`PATH` and bakes each absolute path into the launcher as `ACP_RESOLVED_CLAUDE_BINARY`,
`ACP_RESOLVED_CODEX_BINARY` and `ACP_RESOLVED_GROK_BINARY`. The launcher promotes each to
`ACP_CLAUDE_BINARY`, `ACP_CODEX_BINARY` or `ACP_GROK_BINARY` unless that variable is already set,
and the daemon passes it to the matching adapter. An absolute pin is the only channel by which a
CLI outside the launcher's `PATH` is reachable; a configured adapter override takes precedence
over the environment.

Only an absolute, executable path is pinned. A CLI the installer cannot resolve is named on
stderr and left unpinned rather than refused, so a host without an optional CLI can still deploy.
An unpinned provider is searched for on the launcher's `PATH` as any bare name would be, and if it
is not there its capacity probe reports no quota rather than an error — which is why the installer
names it. Installing the CLI and re-running `install` or `upgrade` pins it.

The launcher's `PATH` is the deployment's own runtime interpreter directory followed by
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/bin`. A provider's own directory is never
added: it holds executables unrelated to the CLI, and any directory on this `PATH` makes every
name in it resolvable to the daemon. The interpreter directory comes first so that a CLI whose
shebang resolves its interpreter by name receives the one this generation carries.

Every executable path is recorded as its canonical target: the `--node` answer and each provider
CLI are resolved through their symlinks and directory components before being copied, pinned or
persisted, and must end at an absolute regular executable. Repointing a symlink after an install
therefore does not change which binary the daemon runs.

`install`, `upgrade` and `rollback` canonicalise `--app-root` and then refuse two shapes, before
any file is written, any service is stopped and the runtime interpreter is copied — so a refused
run leaves nothing behind. A canonical path containing `:` is refused because the launcher exports
the app root's runtime interpreter directory as a POSIX `PATH` entry, where `:` separates entries.
The canonical filesystem root is refused because every derived path would carry a leading `//`,
which the sealed rollback binding canonicalises differently. Both are judged after canonicalisation
rather than on the supplied string, since a path with neither property can resolve onto one, and
neither refusal repeats the path back.

The job uses `~/.agent-control-plane` because that is the daemon's configured state root. The
installer and runtime both require this directory, its database, worktree root, secrets root,
and backups to be current-user owned, non-symlinked, and mode `0700`/`0600` as appropriate.

```bash
deploy/install-launchd.sh status
deploy/install-launchd.sh restart
deploy/install-launchd.sh stop
deploy/install-launchd.sh start
```

`upgrade` saves the rendered plist and launcher under
`~/.agent-control-plane/deploy-backups/`, stops the running job, renders the new release, and
starts it. On the next open, the database takes a consistent pre-migration backup before any
ordered schema step runs.

```bash
deploy/install-launchd.sh upgrade --app-root /absolute/release --node /absolute/node
```

Database snapshots are available through the dedicated maintenance executable. A backup is
online; restore requires the job to be stopped and an explicit confirmation. Restore validates
the backup's private mode, manifest checksum, SQLite integrity, and load-bearing triggers before
atomically installing it, preserving the replaced file under `backups/`.

```bash
agentcpd-state backup
agentcpd-state restore /absolute/backup.sqlite --confirm-restore
```

A start that would migrate the database refuses instead (#738), because this app root is also a
git checkout and a `pnpm build` run in it for any reason changes which `SCHEMA_VERSION` the next
restart declares. The refusal exits 0, so `KeepAlive { SuccessfulExit = false }` leaves the job
stopped rather than retrying every `ThrottleInterval`; it leaves `migration-refusal.json` in the
state directory and `agentctl daemon status` reports it with no daemon running. `migration-plan`
reads the database read-only and prints what a start would do; `approve-migration` refuses a live
lock, takes a validated recovery point, and writes an approval naming that exact chain and the
database it is for, which is spent when the chain runs. An approval is a capability over one
file — canonical path, device and inode — so it cannot be spent by a different database beside
it, and its recovery point must be an image of that same file (#747). The migration holds the
deployment's state lock while it runs, so it cannot rewrite the schema under a live daemon.

```bash
agentcpd-state migration-plan
agentcpd-state approve-migration --approved-by "$USER" --confirm-migration
```

To roll back, restore one **sealed rollback pair**: a UUID-named directory under
`~/.agent-control-plane/rollback-pairs/` holding a WAL-complete database backup, the runtime
closure that reads it, and the launchd generation and config that starts it, together with an
exact inventory and a self-excluding `SHA256SUMS`. The database, runtime and launchd members are
taken **only** from that one validated pair — the operator does not name them separately and the
script discovers nothing. There is no `latest`, no newest-by-name, and no separately chosen
pre-migration backup: two independently selected halves are not a pair, and an older binary must
not guess at a newer schema.

```bash
deploy/install-launchd.sh rollback \
  --pair-id <uuid> --expected-index-digest sha256:<hex>
```

`--expected-index-digest` is the `SHA256(SHA256SUMS)` retained **outside** the pair, because a
pair that vouches for its own index vouches for a forgery of itself just as readily. Before
anything is stopped or replaced, the rollback validates the pair id, that digest, the exact
inventory and every file digest, the declared schema, runtime and service identity, that every
member is a regular non-symlink file, and that every member is still inside the pair root after
its path is resolved.

Seal a pair with `node dist/deploy/rollback-pair.js seal …` — run
`node dist/deploy/rollback-pair.js --help` for its flags. It states every identity on the command
line rather than reading any of it from the host, so the same command seals the generation being
left and, later, the one being moved to; it prints the pair id and the index digest to retain.
`docs/ops/owner-actions.md` carries the full procedure.

`uninstall` removes only the LaunchAgent plist and launcher. It intentionally leaves the
database and backups intact.
