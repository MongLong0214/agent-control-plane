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

Canonical self-claim is an optional, atomic activation group. Provision all three accounts under
that same Keychain service to enable it:

- `ACP_CANONICAL_SESSIONS_JSON`
- `ACP_CANONICAL_CTO_PEER_PROTOCOL`
- `ACP_CANONICAL_CTO_BUZZ_PURPOSE`

`ACP_CANONICAL_SESSIONS_JSON` is a JSON array of at most 32 entries, each naming one running
session and the whole of what it is entitled to:

```json
[{"sessionUuid":"<uuid>","projectId":"<project>","buzzActorId":"<actor>"}]
```

A session may be adopted only as `PRIMARY_CTO` of the `projectId` its own entry names, and it
speaks on Buzz as that entry's `buzzActorId`. No two entries may share any of the three values.

An entry may also name its project's CEO room as `buzzAddress`, a lower-case Buzz channel UUID:

```json
[{"sessionUuid":"<uuid>","projectId":"<project>","buzzActorId":"<actor>","buzzAddress":"<channel-uuid>"}]
```

The claim opens that room the way it opens `ACP_BUZZ_CHANNEL` and writes it as the session's
`buzz_address`, which is the room a CEO mention to that CTO must arrive in. An entry without it
gets `ACP_BUZZ_CHANNEL`, as every entry did before the field existed. Entries may share a room. A
`buzzAddress` that is not a lower-case channel UUID refuses startup like any other invalid entry.
A CTO already bound with another room does not have to restart: when its relay next reattaches
(every daemon restart does this), the daemon proves it is the same live holder, opens the room, and
moves that one session row's `buzz_address` to it with one `CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED`
audit row. The binding, its generation and the session are unchanged. Peer messages already queued
for that CTO under the old room are withheld after the move, as for any change of its room.
When `buzz-nostr-subscriber.json` configures an identity for an entry's `buzzActorId`, that
identity's `rooms` must include the entry's room (its `buzzAddress`, else `ACP_BUZZ_CHANNEL`):
startup refuses otherwise, naming the project and both rooms, and the claim and the correction
refuse to write such a room. Set the entry's `buzzAddress`, add the room to that identity's
`rooms`, then restart the daemon. Until startup has made that check, a claim is refused (`CONFLICT`;
claim again once the daemon is up) and a reattach is admitted with its correction held until then.
Every entry's `projectId` must already be registered: an entry naming a project this deployment
holds no record of refuses startup rather than being dropped, so a configured session cannot come
up entitled to a project that does not exist. Registration is all that is required here — whether
a registered project is suspended or unhealthy is a runtime condition, decided while the daemon
runs, and it does not hold startup. The check runs before the daemon starts, so it refuses a
startup that would otherwise park for missing capacity too.
An invalid or empty array refuses startup, and the refusal names the variable, never its contents.
The unregistered-project refusal alone also names the zero-based index of the offending entry and
how many entries there are.

With none present, self-claim is disabled. Empty and whitespace-only values count as absent.
Any nonempty proper subset refuses startup before config access, database opening, migration,
or listener creation; diagnostics name missing variables, never their values. With all three
present, `ACP_BUZZ_CHANNEL` is also required. Channel-only transport configuration remains valid.
The session list, protocol and purpose have no defaults: the configured values are retained from
daemon entry and passed unchanged to the claim boundary.

Self-claim derives the session UUID from the Claude ancestor's argv selector first, and from the
host session registry beside the transcript root when argv has no selector. The registry is read
through one `O_NOFOLLOW` descriptor (regular, owned by the daemon's uid, size-bounded) and must have
its pid and `procStart` match the ancestor and its kernel start time, a native file birth time no
earlier than the ancestor's native Darwin start token and no later than the wall clock at the
check, that start token unchanged after the read, and `kind` `interactive`. A start token that is
not a native Darwin token, or a birth time that is unavailable or zero, makes the registry
unverifiable and refuses it; ACP deploys only on Darwin (launchd). Only a missing registry file lets an argv selector stand alone: a file that
fails any of those checks, or a valid entry that disagrees with the selector, refuses the claim.
The session is derived again, argv and registry, after the Buzz await and at the commit
checkpoint, and the claim refuses if it changed; the delegated CTO bind's rechecks do the same.
The host session registry is supplementary evidence writable by a same-uid process, not an additional authentication mechanism.
Residual risk: on Darwin, a backward wall-clock step smaller than the gap between a stale registry file's creation and the claim, combined with a reuse of its pid within the same second, by a same-uid process that could already write the registry, can still admit that stale file.

`ACP_CANONICAL_CTO_WORKDIR` used to be the eighth. It pinned the one directory the canonical
CTO's process could run from; nothing compares a working directory any more, so the group no
longer carries a value that had to be kept correct for no reader. A deployment that still
provisions it is not refused — the variable is simply ignored.

`ACP_CANONICAL_SESSION_UUID` and `ACP_CANONICAL_CTO_BUZZ_ACTOR_ID` used to be two of the seven.
They held one session's uuid and one session's Buzz identity, so a second canonical CTO could not
be expressed and the project a claimant asked for was compared against nothing (#1005).
`ACP_CANONICAL_SESSIONS_JSON` replaces both, and a deployment that still provisions either of the
old two is not refused — they are simply ignored.

`ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION`, `ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH` and
`ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256` used to be three of the six. They pinned one CLI build —
its version, its resolved path and the sha256 of its bytes — that every claimant's executing image
had to equal, while each project's session runs whichever build it was started with; a session on
an earlier build was refused, and one whose build the updater had since deleted from disk could
never be admitted at all. The claim now records the executing image and requires nothing of it.
That also withdraws what the realpath and sha256 comparison defended against: a same-user process
exec'd from a binary renamed `claude` is no longer told apart by its bytes, and what bounds a claim
is the kernel peer credential on the claim socket, the session UUID derived from the claimant's
ancestor, and the project that UUID's entry names. A deployment that still provisions any of the three is not
refused — they are simply ignored.

The generated launcher clears all six inherited variables together before its first Keychain
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
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` and `/usr/sbin`. A provider's own
directory is never added: it holds executables unrelated to the CLI, and any directory on this
`PATH` makes every name in it resolvable to the daemon. The interpreter directory comes first so
that a CLI whose shebang resolves its interpreter by name receives the one this generation
carries.

`/usr/sbin` is last, and is required for `lsof`, which ships only from there. A canonical
self-claim reads the claiming process's working directory, and observes its executing image, by
spawning `lsof` under its bare name and consulting no environment, so this `PATH` is the only
channel that reaches the call: an absolute path baked into a variable has no reader. Without the
directory the scan cannot run, the working directory cannot be read, and a genuine claim is
refused as `PROBE_FAILED`. The executing image goes unobserved in the same case, which on its own
refuses nothing: it is recorded, not required. The directory is admitted on the same
footing as `/usr/bin` and `/bin`: a root-owned, mode `755`, SIP-`restricted`, non-user-writable
system directory listed in `/etc/paths`, holding none of the names this control plane grants
authority by. A provider directory is user-writable and carries unrelated siblings, which is why
one is still never added.

The two kinds of executable path this installer records are not recorded the same way, because
they have different owners.

The `--node` answer is resolved through its symlinks and directory components and must end at an
absolute regular executable, and that canonical file is then copied into the runtime closure. A
sealed generation's guarantee is that its own bytes plus the interpreter it names are the whole
runtime, so the interpreter it carries has to be the file itself rather than a name for one.

Each provider CLI is pinned at the name the installing shell answered with — the stable name the
provider's own updater maintains — and is required to be absolute, a regular file and executable,
but is not canonicalised. The versioned file behind that name belongs to the updater, which writes
a new version, repoints the name and prunes the version it replaced; a pin recorded at the
canonical target therefore stops naming anything within days of every install, and a probe that
spawns a path which is not there reports no quota rather than an error. The daemon follows the name
rather than freezing it: `resolveExecutable` (`src/runtime/cli-adapters.ts`) hands the pinned name
itself to each spawn, so the kernel resolves the symlink at every exec and the CLI that runs is
whichever version the name currently points at. Repointing the name after an install does change
which binary the daemon runs, and that is the accepted outcome; nothing here notices a pinned name
whose target has gone.

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

`start` and `restart` report success only after this start writes its completed-start record and
launchd reports the same running pid across a short settle window. They wait up to 180 seconds
for slow startup, but fail sooner when launchd shows a sustained missing pid: after five polls
for a successful-exit refusal or 35 polls while allowing one throttled relaunch. If the job stays
registered without a running daemon, they exit nonzero; inspect `agentctl daemon status` and
`agentcpd.out.log` for the startup reason.

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
state directory and `agentctl daemon status` reports it with no daemon running. The installer
therefore reports a failed start even though launchd retains the job. `migration-plan`
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

If a registered checkout is gone, stop the daemon and suspend its project offline with
`agentcpd-state suspend-project --project-id <id> --approved-by "$USER" --confirm-suspend`.
The command refuses a live state lock or a schema version different from this build, and records
the owner approval in the `PROJECT_SUSPENDED` audit event. Restore the checkout before resuming
the project through the existing owner path.

Two limits are deliberate. The approver is the OS account running the command, so a deployment
whose `ACP_OPERATOR_ACTOR` differs from that account must also declare `cli:<account>` in
`owner-identities` to use this path. And a project that still has an unfinished run or an active
binding cannot be suspended offline, because nothing offline can checkpoint that work. Its missing
checkout keeps blocking startup until the checkout is restored.

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

The validation and the rollback itself run in the installer's **own checkout's**
`dist/deploy/rollback-pair.js`, not the deployment's: the deployment's is the runtime being
replaced, a deployment built before a check would skip it, and a rollback into an older generation
installs that generation's copy. The installer first asks that build (`rollback-pair.js guards`)
whether it refuses a pair the live database has moved past, and stops there if it does not. Run
from inside a deployment that a rollback took back to such a generation, the installer therefore
refuses; run the next rollback from a checkout built with the check, with
`--app-root <deployment>`.

Seal a pair with `node dist/deploy/rollback-pair.js seal …` — run
`node dist/deploy/rollback-pair.js --help` for its flags. It states every identity on the command
line rather than reading any of it from the host, so the same command seals the generation being
left and, later, the one being moved to; it prints the pair id and the index digest to retain.
`docs/ops/owner-actions.md` carries the full procedure.

`uninstall` removes only the LaunchAgent plist and launcher. It intentionally leaves the
database and backups intact.
