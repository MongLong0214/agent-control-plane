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

To roll back a binary, use the pre-migration backup produced by the upgrade and restore it in
the same operation. The script refuses a binary-only rollback because an older binary must not
guess at a newer schema.

```bash
deploy/install-launchd.sh rollback \
  --database-backup ~/.agent-control-plane/backups/state.sqlite-pre-migration-v11-....sqlite
```

`uninstall` removes only the LaunchAgent plist and launcher. It intentionally leaves the
database and backups intact.
