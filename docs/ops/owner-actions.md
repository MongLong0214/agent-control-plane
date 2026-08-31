# Owner actions — prepared up to the line

Four items need the owner. Each is prepared as far as it can be without them; what remains is
stated as commands rather than description. Ordered by what they unblock.

Every path and variable below was read out of the code, not inferred. Where I am recommending
rather than reporting a requirement, it says so.

---

## 1. Reviewer credential scope — blocks the first lifecycle and #241

### Why it is needed

A blind reviewer runs under `tools: "none"`, which is `(deny process-exec*)` with an allowlist
of the provider binary, node and `/usr/bin/env`. The Claude CLI reads its OAuth credential by
spawning `/usr/bin/security` against the login Keychain, so a confined reviewer dies:

    EPERM: operation not permitted, posix_spawn 'security'

The run then fails `EVIDENCE_MISSING`. The credential has to live somewhere the reviewer is
allowed to *read*, rather than somewhere it must *spawn* to reach.

### Command

    CLAUDE_CONFIG_DIR="$HOME/.agent-control-plane/reviewer/claude" claude
    # then: /login    (and /exit once it reports authenticated)

### What it creates

`~/.agent-control-plane/reviewer/claude/` containing `.credentials.json` and `.claude.json`.
Those three paths are exactly what `claudeCredentialPaths()` hands the seatbelt profile as the
reviewer's readable credential scope (`src/runtime/cli-adapters.ts:1088-1095`).

### Which identity

**A separate directory is required. A separate account is not.**

Nothing in the code checks the account. What the code requires is that the reviewer never reads
the ordinary provider config tree, because that tree can hold producer conversations — the
`~/.codex` comment at `cli-adapters.ts:604-607` states the reasoning and the Claude path follows
it. A fresh directory satisfies that whichever account authenticates into it.

**Recommendation, not a requirement:** use a separate account if one is available. Same-account
means the reviewer and the producers share a rate-limit pool, so reviewer starvation and
producer starvation become the same event. That is an availability argument, not an isolation
one — CP-HI-04 is about role separation within a run, which the directory already gives.

### Where it applies

**Precondition: this machine has no daemon installed.** No launcher, no `acp` plist, no
`agentcpd` process — checked, not assumed. Installing it is a separate step owned by the CTO,
and authenticating does not depend on it. Do the login; the daemon comes after.

Once a daemon exists, nothing further is needed — as of `9e970f2` the launcher derives it:

    export ACP_CLAUDE_REVIEWER_CONFIG_DIR="${ACP_CLAUDE_REVIEWER_CONFIG_DIR:-$ACP_STATE_DIR/reviewer/claude}"

So authenticating into the path above is sufficient; the daemon already looks there. An
explicit `ACP_CLAUDE_REVIEWER_CONFIG_DIR` in the launchd environment still wins if the scope
must live elsewhere.

Before `9e970f2` the launcher exported neither variable, so setting it in a shell had no
effect. If the daemon is running from an older launcher, reinstall it first:

    bash deploy/install-launchd.sh install --app-root "$PWD" --node "$(command -v node)"

### Verification — exits 0 when done

The owner's half, which is all that is being asked for here:

    test -s "$HOME/.agent-control-plane/reviewer/claude/.credentials.json" \
      && echo "reviewer credential present"

**Do not include the launcher in this check.** An earlier version of this document did, and on
a machine with no daemon that fails whatever the owner does — reporting "cannot determine" in
the shape of "did not work". That fold is the subject of #444, and this document produced it.

The launcher condition belongs to the daemon install and is checked there:

    grep -q 'ACP_CLAUDE_REVIEWER_CONFIG_DIR' "$HOME/.agent-control-plane/agentcpd-launch.sh"

The real proof is a lifecycle that gets past the reviewer:

    ACP_COMPONENT_INTEGRATION=1 pnpm test:e2e

It currently stops at `EVIDENCE_MISSING`; success is any stage beyond it. Note this runs
without a daemon and against a temporary state root, so it demonstrates the pipeline and
cannot itself accumulate the observation window — see below.

---

## 2. Telegram bot token — #392

### Why

The production ingress server exists as of `8461d82` — long-poll owner channel, allowlist,
replay defence, prompt-bound receipts. What #392 requires and does not have is a real Telegram
message creating a run and leaving Buzz dispatch evidence. Every path that touches
`getUpdates`/`sendMessage` currently injects a test transport.

### Command

    security add-generic-password -U -s acp -a ACP_TELEGRAM_BOT_TOKEN -w '<token from @BotFather>'
    security add-generic-password -U -s acp -a ACP_TELEGRAM_OWNER_ID   -w '<numeric telegram user id>'
    security add-generic-password -U -s acp -a ACP_TELEGRAM_CHAT_ID    -w '<numeric chat id, may be negative>'
    security add-generic-password -U -s acp -a ACP_TELEGRAM_WEBHOOK_SECRET -w "$(openssl rand -hex 32)"

`-s acp` must match the `--keychain-service` the launcher was installed with.

### What it creates

Four Keychain items the launcher reads at start
(`deploy/install-launchd.sh:254-259`). Telegram stays disabled when none are present and
**refuses a partial set**, so all four are needed together.

### Which identity

The owner's own Telegram account. `ACP_TELEGRAM_OWNER_ID` must also appear in
`~/.agent-control-plane/owner-identities` as a `telegram:` line, or the gate cannot be cleared —
`readOwnerIdentities` is the authority, not the token.

### Where it applies

The Keychain, under the launcher's service name. Restart the daemon afterwards.

### Verification — exits 0 when done

    security find-generic-password -s acp -a ACP_TELEGRAM_BOT_TOKEN -w >/dev/null \
      && grep -q '^telegram:' "$HOME/.agent-control-plane/owner-identities" \
      && echo "telegram ingress configured"

---

## 3. v1.0.0 tag and release — after the observation window

### Why it is last

Not blocked on effort. `docs/PROGRESS-20260814.md` records the condition: the window's five
counts must be recorded in `docs/ACCEPTANCE.md` first, and the window cannot start until item 1
above is done.

### Command

Deliberately not written here. A tag is irreversible external publication, and the command
should be produced against the actual release commit with the acceptance numbers in hand rather
than copied from a document written before them.

### Verification

`docs/ACCEPTANCE.md` carries the window start, duration, three project names and five zero
counts with the telemetry queries that produced them.

---

## 4. Reconcile the deployed daemon with candidate main — blocks #512

The first dogfood run cannot mean anything until the daemon that ran it is a known quantity.
This is not "reconcile a drifted database" — the running process and its database agree with
each other. What is broken is that the checked-out source at the deployment path has moved past
what was ever built and restarted there, and nothing running today would tell you that on its
own.

### Why it is needed

Four numbers describe one deployment, and only two of them agree:

    running dist + live DB     25   these two agree with each other
    checked-out source         30   at the same path, but not what is loaded
    candidate / main           34   b683176, as observed while drafting (re-pin before executing)

The live migration ledger's last five rows (`bootstrap-v20` through `v25-sources-name-admitted-
messages`) all landed within 85 ms of the daemon's own `startedAt`, and nothing has landed since.
`Db.applySchema` (`src/db/database.ts:328-363`) only calls `migrate()` when the on-disk version
differs from the build's `SCHEMA_VERSION`, walks the chain in one pass to exactly
`SCHEMA_VERSION`, and returns without touching the ledger once `version === SCHEMA_VERSION`
(`:353`). A run that starts at 20 and stops dead at 25 is only possible if the running build's own
`SCHEMA_VERSION` constant is 25 — so **the running bytes declare 25**, matching the live database.
That conclusion is reconstructed from ledger timestamps, not read back from anything self-
reporting; see the health.json gap below.

The checked-out source at the deployment path (`686281a897c44937bd40e1759decd95b76d63f49`, clean)
declares `SCHEMA_VERSION = 30` — introduced by `0da07459e36feafb1123523ba94d366dfca6cd6b`
("fix: a merge commit carries what the branch recorded…", 2026-08-22T15:08:12+09:00). The running
`dist/daemon/agentcpd.js` has an mtime roughly ten hours *earlier* than that commit, so it was
never built from it: **the checkout does not describe what is running**, and rebuilding it in
place — for any reason, by anyone — changes that instantly (see "Do not execute" below). Candidate
main (`b683176`) is a further four versions ahead, at 34.

So "migrate v25 → v34" only names one operation if the code that performs it is pinned to the
candidate SHA at the moment it runs, not to whatever happens to be checked out. Item 3 pins that.

**Limitation this packet cannot close:** `health.json` carries `pid`, `startedAt`, `at`,
`continuityMode`, `mode`, `blockingFindings`, `lockHeld`, `runs`, `lastReconcile` and
`timerHealth` — no build SHA, no `SCHEMA_VERSION`, no binary digest. Nothing the running process
exposes over the operator socket or the state directory attests to its own identity. The 25
above is forensics (ledger-timing correlation), not a readback, and a `shasum` of `dist/` after
the fact only proves what bytes sit on disk *now* — it says nothing about what a given `pid`
loaded at its own start unless nobody has touched the file since. A minimal fix — `agentcpd`
recording `{ schemaVersion, entrySha256 }` in `health.json` once, at the top of its own startup,
before it does anything else — would close both this gap and item 5's below. That is a real
change and does not belong in this document; it is filed here as a limitation, not implemented.

### Command

**1. Pin identity — measurement only, changes nothing.**

    git -C /Users/isaac/projects/agent-control-plane rev-parse HEAD
    git -C /Users/isaac/projects/agent-control-plane status --porcelain
    grep -n "SCHEMA_VERSION = " /Users/isaac/projects/agent-control-plane/src/db/migrations.ts
    stat -f '%Sm' /Users/isaac/projects/agent-control-plane/dist/daemon/agentcpd.js \
      /Users/isaac/projects/agent-control-plane/dist/db/migrations.js
    sqlite3 "$HOME/.agent-control-plane/state.sqlite" \
      "select version, migration_id, applied_at from schema_migrations order by version;"
    cat "$HOME/.agent-control-plane/health.json"

Compare the `applied_at` column against `startedAt` in `health.json`: if the top rows cluster
within about a second of `startedAt` and stop, that run's own `SCHEMA_VERSION` is exactly the
version it stopped at — the same reasoning that produced the 25 above, done fresh, because the
numbers in this document age from the moment they were written.

**2. Back up both halves — database and bytes. Neither backup exists in any tool already here.**

Database, using the existing maintenance CLI, then a readback that proves it is good:

    node /Users/isaac/projects/agent-control-plane/dist/db/state-admin.js backup \
      --database "$HOME/.agent-control-plane/state.sqlite" | tee /tmp/acp-512-backup.json
    BACKUP_PATH="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/acp-512-backup.json","utf8")).backup.path)')"
    shasum -a 256 "$BACKUP_PATH"
    cat "$BACKUP_PATH.manifest.json"
    sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;"

Good means: the `shasum` output matches the manifest's `databaseSha256`, and `integrity_check`
returns `ok`. `backupDatabase` (`src/db/backup.ts`) opens the source readonly and never invokes
`Db`, so this is safe to run against the live daemon exactly as it stands, before anything else
changes.

Bytes — nothing in `deploy/install-launchd.sh` snapshots `dist/`; `snapshot_current_deployment`
only copies the plist and the launcher shell script (`deploy/install-launchd.sh:143-155`), and
that function only runs from the `install`/`upgrade` subcommands, which this procedure does not
use (the app root and node path are not changing — only the tree's contents are). Without this
step, "roll back the bytes" in item 6 would have nothing to restore to, since rebuilding from any
git commit produces new bytes, not the ones that were actually running:

    set -e
    BYTES_BACKUP="$HOME/.agent-control-plane/deploy-backups/dist-pre-512-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$BYTES_BACKUP" && chmod 700 "$BYTES_BACKUP"
    cp -a /Users/isaac/projects/agent-control-plane/dist "$BYTES_BACKUP/dist"
    # Hash the copy, not the source. A hash of the source proves what was on the live tree, which
    # is not the thing item 6 will restore from — a truncated or partial copy would carry a
    # perfectly correct receipt describing bytes that are no longer anywhere.
    shasum -a 256 "$BYTES_BACKUP/dist/daemon/agentcpd.js" | tee "$BYTES_BACKUP/agentcpd.js.sha256"
    shasum -a 256 /Users/isaac/projects/agent-control-plane/dist/daemon/agentcpd.js
    # The two lines above must print the same digest. If they differ, the copy is not the tree.
    cp "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist" "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"
    cp "$HOME/.agent-control-plane/agentcpd-launch.sh" "$BYTES_BACKUP/agentcpd-launch.sh"
    chmod 600 "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"
    chmod 700 "$BYTES_BACKUP/agentcpd-launch.sh"
    test -s "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"
    test -s "$BYTES_BACKUP/agentcpd-launch.sh"
    test -f "$BYTES_BACKUP/dist/daemon/agentcpd.js"
    echo "$BYTES_BACKUP"

The plist and the launcher go into **this execution's** `$BYTES_BACKUP` directory, beside the
`dist` copy, and `set -e` plus the `test` lines make a partial backup abort rather than look
complete.

`$BACKUP_PATH` and `$BYTES_BACKUP` are produced by two independent commands — `state-admin.js`
names the database backup, and the shell names the bytes directory — so **their timestamps are
not the same value and must not be treated as a shared identity**. An earlier revision of this
section claimed they were. Seal the pairing explicitly instead, and let item 6 read it back:

    cat > "$BYTES_BACKUP/rollback-receipt.json" <<JSON
    { "databaseBackup": "$BACKUP_PATH",
      "bytesBackup": "$BYTES_BACKUP",
      "agentcpdSha256": "$(cut -d' ' -f1 "$BYTES_BACKUP/agentcpd.js.sha256")" }
    JSON
    cat "$BYTES_BACKUP/rollback-receipt.json"

The receipt is what makes the two halves one operation. Without it the pairing lives only in a
shell variable that dies with the session, and a later rollback would be picking two backups
that merely look contemporaneous.

That co-location is not tidiness. `install-launchd.sh` does snapshot the plist and launcher —
`snapshot_current_deployment` (`deploy/install-launchd.sh:143-155`) — but it runs from exactly
one call site, inside `install|upgrade` (`:338`), and this procedure calls neither. So no
snapshot is created by this run. And `rollback` selects one with
`find "$deploy_backups_dir" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1` (`:373`) — the
newest directory *by name*, which would be some earlier install's artifacts, or nothing at all
(`fail "no prior deployment snapshot is available"`).

**A rollback that restores a plist from a past install is not a rollback of this operation.**
Both halves of item 6 therefore name `$BYTES_BACKUP` explicitly and never let a tool pick.

**3. Stop the job, then rebuild the candidate, then validate on a throwaway copy — never the
live file.**

`RunAtLoad` is `true` and `KeepAlive` is `{ SuccessfulExit = false }` with a 30 s
`ThrottleInterval` (`deploy/com.agentcontrolplane.agentcpd.plist.template`). Rebuilding `dist/` in
place while the job is still loaded means the *next* crash or reboot — not the next command —
arrives at a build declaring a different `SCHEMA_VERSION` than the live database carries. Since
#738 that start **refuses** rather than migrating: `Db`'s constructor requires an approval on
file naming the exact from-version, to-version and ordered migration ids
(`assertMigrationApproved`, `src/db/database.ts`), and the process exits 0 so
`KeepAlive { SuccessfulExit = false }` stops rather than retrying every 30 s. Stopping the job
first is still the right order — it removes the job from supervision entirely until it is
explicitly started again, so the rebuild is not racing a supervised process for the same bytes:

    set -e
    bash /Users/isaac/projects/agent-control-plane/deploy/install-launchd.sh stop
    for i in $(seq 1 30); do [ -e "$HOME/.agent-control-plane/agentcpd.lock" ] || break; sleep 1; done
    if [ -e "$HOME/.agent-control-plane/agentcpd.lock" ]; then
      echo "agentcpd lock remains after stop; refusing to rebuild" >&2
      exit 1
    fi

The `exit 1` is the whole point of this step, not a formality. `install-launchd.sh`'s own
`wait_for_stop` (`deploy/install-launchd.sh:324-330`) ends the same wait with
`fail "agentcpd lock remains after launchctl stop; refusing database restore"`, and every
command that touches state — `install`, `upgrade`, `rollback` — goes through it. Plain `stop`
does not, so the wait has to be written out here; **writing it out is where the fail-closed
property is easiest to drop, and dropping it is worse than not waiting at all**, because a
warning printed above a rebuild reads as a step that ran. A rebuild that proceeds past a held
lock replaces the bytes of a live process.

With the job stopped, re-pin and rebuild the candidate (see item 8 — this SHA must be re-verified
right before this line, not copied from this document):

    git -C /Users/isaac/projects/agent-control-plane fetch origin
    git -C /Users/isaac/projects/agent-control-plane checkout <RE-PINNED CANDIDATE SHA>
    ( cd /Users/isaac/projects/agent-control-plane && pnpm install && pnpm rebuild better-sqlite3 && pnpm build )
    grep -n "SCHEMA_VERSION = " /Users/isaac/projects/agent-control-plane/src/db/migrations.ts

Then validate the exact code that is about to run, against a disposable copy of the item-2
backup:

    DRY_DIR="$(mktemp -d)"; DRY="$DRY_DIR/dry-run.sqlite"
    cp "$BACKUP_PATH" "$DRY"
    chmod 700 "$DRY_DIR"; chmod 600 "$DRY"
    # #738 — a migration is now a decided act, and the dry run has to decide it too. This
    # approves the throwaway copy only: the approval file lands in $DRY_DIR beside it, names
    # that copy's own from/to versions, and cannot authorise anything for the live database.
    node /Users/isaac/projects/agent-control-plane/dist/db/state-admin.js approve-migration \
      --database "$DRY" --approved-by "$USER" --confirm-migration
    node --input-type=module -e '
      import { openDb, SCHEMA_VERSION } from "/Users/isaac/projects/agent-control-plane/dist/db/database.js";
      const db = openDb(process.argv[1]);
      console.log(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        userVersion: Number(db.raw.pragma("user_version", { simple: true })),
      }));
    ' "$DRY"
    rm -rf "$DRY_DIR"

Expect `{"schemaVersion":34,"userVersion":34}` (or whatever `SCHEMA_VERSION` main declares by
execution day). This drives the real migration code (`Db.applySchema` → `Db.migrate`,
`src/db/database.ts:328-441`), not a re-implementation of it, because it is the same compiled
file the daemon is about to load.

**What a failure looks like — not just the success path.** `migrate()` takes exactly one backup,
before the first step in the chain (`backupOpenDatabaseSync`, `:401-405`), and the `catch` block
restores from that same single backup regardless of which step in the chain threw
(`restoreMigrationBackup(filename, backup)`, `:422`, closing over the one `backup` bound at
`:401`) — so **a failure anywhere in a 25→34 run restores to 25, not to whatever intermediate
version it reached.** The thrown message is exactly `"migration failed; the original database was
restored from its automatic backup"` (`:435-439`), or, if even that restore fails, `"migration
failed and the automatic backup could not be restored"` (`:424-434`). This is not hypothetical:
`tests/unit/database-migration-restore.test.ts:828` ("restores the original v11 database when a
fault is injected after a migration commits") drives exactly this path today and asserts that
message. The ordered chain from 25 to 34 was confirmed contiguous while preparing this packet —
nine steps, `fromVersion`/`toVersion` running 25→26→27→28→29→30→31→32→33→34 with no gap in
`src/db/migrations.ts`, and `tests/unit/database-migration-restore.test.ts:588` already asserts
`MIGRATIONS.map(m => m.fromVersion)` equals `MIGRATIONS.map(m => m.toVersion - 1)` for the whole
registry — so a failure here on execution day would be a genuinely new defect in one of those
nine steps, not a missing link this packet failed to notice.

If the dry run throws either message: stop. Do not proceed to item 4. File which migration step
failed and treat it as a blocker on this packet, not something to retry past.

**4. Approve the migration, then start the job — this is the real migration, under supervision,
not a dry run.**

Since #738 the start refuses unless an approval on file names this exact chain. Read the plan
first — `migration-plan` opens the database read-only and changes nothing — and approve only
after the printed `fromVersion`, `toVersion` and `migrations` are the ones item 3's dry run just
proved out:

    node /Users/isaac/projects/agent-control-plane/dist/db/state-admin.js migration-plan \
      --database "$HOME/.agent-control-plane/state.sqlite"
    node /Users/isaac/projects/agent-control-plane/dist/db/state-admin.js approve-migration \
      --database "$HOME/.agent-control-plane/state.sqlite" --approved-by "$USER" --confirm-migration
    bash /Users/isaac/projects/agent-control-plane/deploy/install-launchd.sh start

`approve-migration` refuses while the lock is held, takes its own validated recovery point at
the current version, and writes `~/.agent-control-plane/migration-approval.json` naming that
backup, the ordered chain, and **which database** it is for — canonical path plus device and
inode (#747). It approves **one** migration of **one** file between two named versions: after
the chain runs, the file is renamed to `migration-approval.applied-v25-v34-<epoch>.json` and
authorises nothing further.

Two consequences worth knowing before item 6:

  - The migration itself holds `agentcpd.lock` for as long as it runs, so it cannot proceed
    under a daemon that is still holding the database. That pre-check in `approve-migration` is
    a snapshot; the lock is the guarantee.
  - If the chain fails, its automatic rollback links the pre-migration image back into place,
    which gives the restored database a **new inode**. The approval no longer names it, so the
    next start refuses instead of retrying. That is deliberate: a chain that failed partway is
    exactly when a supervised restart must not silently try again. Retrying is a fresh
    `approve-migration` after the failing step has been understood — item 6's blocker rule.

The first `Db` the new process opens finds `state.sqlite` at 25, a build declaring 34, and an
approval naming exactly 25→34, and `applySchema` runs the real chain — protected by its own
internal backup exactly as validated in item 3. Watch it for the first 60–90 s
(`ThrottleInterval` is 30 s): if it is not stable by then, treat it as crash-looping and go
straight to item 6 rather than waiting longer.

If the start refuses instead, `~/.agent-control-plane/migration-refusal.json` carries the plan
it declined and `agentctl daemon status` reports it offline — the socket and the doctor are both
unavailable during a refusal, so that file and `agentcpd.err.log` are the observation surface.

**5. Post-restart readback.**

    sqlite3 "$HOME/.agent-control-plane/state.sqlite" "select max(version) from schema_migrations;"
    cat "$HOME/.agent-control-plane/health.json"
    shasum -a 256 /Users/isaac/projects/agent-control-plane/dist/daemon/agentcpd.js

Expect: `max(version)` is 34; `health.json` shows a new `pid` and `startedAt`, `lockHeld: true`,
and no new `blockingFindings`; the `shasum` matches the hash taken right after the build in item
3. That last line carries the same caveat as item 1's identity read: it proves what is on disk
now equals what was built, not that the new `pid` attests to it — nothing here does, per the
limitation above.

**6. Rollback — one joint operation. A byte-only or database-only rollback is unsafe by
construction.**

The command block between the two HTML comment markers below is extracted verbatim, at test
time, by `tests/process/the-rollback-preflight-refuses-a-missing-backup-file.test.ts`, which runs
it against a disposable fixture standing in for `$HOME` and the app root, with a missing backup
file, and asserts that `rm -rf` never runs. Moving the block out from under these markers, or
editing a preflight check inside it, is not a formatting change: that test extracts from these
markers and nowhere else, so it fails to find its anchor rather than silently testing stale text.

<!-- owner-actions:rollback-preflight:start -->

    set -e
    bash /Users/isaac/projects/agent-control-plane/deploy/install-launchd.sh stop
    for i in $(seq 1 30); do [ -e "$HOME/.agent-control-plane/agentcpd.lock" ] || break; sleep 1; done
    if [ -e "$HOME/.agent-control-plane/agentcpd.lock" ]; then
      echo "agentcpd lock remains after stop; refusing to replace deployment bytes" >&2
      exit 1
    fi
    # Everything this rollback will read, checked before anything is destroyed. The list is
    # derived from the commands below, not from what seems likely to be missing: each `cp`
    # source and each file passed to `node` appears here, in the form it is used in.
    test -f "$BYTES_BACKUP/dist/daemon/agentcpd.js"
    test -f "$BYTES_BACKUP/dist/db/state-admin.js"
    test -r "$BYTES_BACKUP/dist/db/state-admin.js"
    test -s "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"
    test -s "$BYTES_BACKUP/agentcpd-launch.sh"
    test -s "$BACKUP_PATH"
    test -s "$BACKUP_PATH.manifest.json"
    sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;" | grep -qx ok
    shasum -a 256 "$BYTES_BACKUP/dist/daemon/agentcpd.js" | \
      cut -d' ' -f1 | grep -qxf <(cut -d' ' -f1 "$BYTES_BACKUP/agentcpd.js.sha256")
    rm -rf /Users/isaac/projects/agent-control-plane/dist
    cp -a "$BYTES_BACKUP/dist" /Users/isaac/projects/agent-control-plane/dist
    cp "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist" "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist"
    cp "$BYTES_BACKUP/agentcpd-launch.sh" "$HOME/.agent-control-plane/agentcpd-launch.sh"
    chmod 600 "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist"
    chmod 700 "$HOME/.agent-control-plane/agentcpd-launch.sh"
    node "$BYTES_BACKUP/dist/db/state-admin.js" restore "$BACKUP_PATH" \
      --database "$HOME/.agent-control-plane/state.sqlite" --confirm-restore
    bash /Users/isaac/projects/agent-control-plane/deploy/install-launchd.sh start

<!-- owner-actions:rollback-preflight:end -->

Those checks run **before** the first destructive command, and the list is complete rather than
representative: every `cp` source and every path handed to `node` below appears above, checked
in the form it is used in — `-r` on `state-admin.js` because `node` reads it, `-s` on the
launcher and plist because they are copied and must not be empty.

An earlier revision checked only three of them and then consumed `agentcpd-launch.sh` and
`dist/db/state-admin.js` without ever having looked at either. If one of those were missing or
truncated, `rm -rf dist` and part of the restore would already have run before the failure —
`set -e` would stop the daemon from starting, but the rollback itself would be stranded
half-applied. **A preflight that names some of what follows is not a preflight**; it is a
sample, and the ones it omits are exactly the ones nobody thought about.

The hash comparison closes the other half: it re-hashes the bytes **in the backup**, not the
source they came from, so a copy that silently truncated is caught here rather than after the
live `dist` is gone.

`install-launchd.sh rollback` is deliberately **not** used here, and the reason is worth
stating because reusing it looks obviously right. That path does stop the job, wait for the
lock fail-closed, restore the database and restore a plist and launcher — but it selects them
with `find … | sort | tail -n 1` (`deploy/install-launchd.sh:373`), the newest directory in
`deploy-backups/` **by name**. This procedure never calls `install`/`upgrade`, which is the
only caller of `snapshot_current_deployment` (`:143-155`, called at `:338`), so it creates no
snapshot of its own. `rollback` would therefore either abort with `no prior deployment
snapshot is available`, or restore the plist and launcher of some earlier install — **a
rollback to an identity that is not the one this operation replaced.**

So the restore names `$BYTES_BACKUP` explicitly at every step and lets nothing pick for it.
`state-admin.js` is invoked from the **backup's** `dist`, not the live tree's, because the live
tree's `dist` is what is being replaced two lines above.

The guard above all of this is not optional: `rm -rf dist` against a still-running daemon
replaces the bytes of a live process, and the database restore is then refused by the lock a
moment later, leaving a **partial rollback** — old bytes, new schema — the one combination
`applySchema` refuses outright and `KeepAlive` then retries forever.

Restoring only the database and leaving 34-declaring bytes in place no longer silently undoes
itself — since #738 a build opening a database *older* than itself refuses unless an approval
names that migration, so the restored file stays restored and the daemon stays stopped rather
than migrating forward again. It is still a half-finished rollback and still has to be completed.
Restoring only the bytes and leaving the database at 34 is worse: `applySchema`
refuses a database newer than the running build outright — `"database schema is newer than this
build"` (`src/db/database.ts:335-341`) — and with `KeepAlive.SuccessfulExit = false` and a 30 s
`ThrottleInterval`, launchd retries that failure forever. Both restores must complete, in either
order, while the job is stopped, before the next `start`.

### What it creates

A database backup and manifest under `~/.agent-control-plane/backups/` (item 2); a `dist/`
snapshot and its hash under `~/.agent-control-plane/deploy-backups/` (item 2); nine new rows in
`schema_migrations`, versions 26 through 34, each with a `sha256:` receipt (item 4, on success);
an updated `~/.agent-control-plane/health.json` with a new `pid` and `startedAt` (item 4).

Nothing is written to `origin`. **The deployment checkout is modified**, and this is not a
side effect to gloss: item 3's `git checkout`, `pnpm install` and `pnpm build` move that
checkout's `HEAD`, index and worktree, and replace `dist/` and `node_modules/`. Item 6 replaces
`dist/` again from the snapshot. That checkout is the launchd job's `WorkingDirectory`, so the
owner should expect its state to differ afterward — an earlier draft of this section claimed
"nothing in this repository is modified", which was false in the one direction that matters.

### Which identity

The owner's own macOS account — the account that already owns `~/Library/LaunchAgents`,
`~/.agent-control-plane`, and the `/Users/isaac/projects/agent-control-plane` checkout. No
separate service account exists or is proposed; `launchctl bootstrap`/`bootout` operate in the
`gui/$(id -u)` domain, which is this account's own login session.

### Where it applies

The live host only: `/Users/isaac/projects/agent-control-plane` (the deployment checkout) and
`~/.agent-control-plane` (the state directory). Nothing here touches this worktree, this branch,
or `origin`.

### Do not execute before Isaac's approval, on the day it is executed

This gate is not satisfied by simply not typing the start command. `RunAtLoad` and
`KeepAlive{SuccessfulExit = false}` mean the daemon restarts itself, unattended, on any crash or
reboot — and `Db`'s migration runs with no confirmation prompt, no flag and no operator token the
moment the on-disk version disagrees with the build. **Rebuilding the candidate in item 3 is
already inside the blast radius this line gates**, because the instant that build lands in
`/Users/isaac/projects/agent-control-plane/dist/`, an unrelated crash or a routine reboot —
someone else's, not this procedure's — performs the migration with nobody having approved it. If
a rebuild happens there for any other reason before Isaac has approved execution, stop the job
immediately (item 3's `install-launchd.sh stop` command) and treat items 3 through 5 as already
armed, not as something to defer casually.

### What makes this packet stale

1. **`dist/daemon/agentcpd.js` or `dist/db/migrations.js` under the deployment checkout has a
   newer mtime than what item 1 recorded.** Someone rebuilt the tree — the more likely trigger,
   because that tree is the launchd job's `WorkingDirectory` and nothing gates a build the way
   this document gates a migration. Re-run item 1 before touching anything else.
2. **`origin/main`'s HEAD is no longer the SHA pinned in item 1/3.** Re-derive it with
   `git -C /Users/isaac/projects/agent-control-plane fetch origin && git -C … rev-parse
   origin/main` immediately before item 3, not from this document — main was observed moving
   during the drafting of this very packet.
3. **`select max(version) from schema_migrations` on the live database is no longer 25.**
   Either this packet already ran, or the standing hazard in item 7 already fired somewhere else.
   Stop and re-derive the whole packet; do not assume which case it is.
4. **`SCHEMA_VERSION` in `src/db/migrations.ts` on main is no longer 34.** A new migration landed;
   the chain-contiguity check and the dry-run target in item 3 must be redone against it.

---

## Why the observation window needs a daemon, and the e2e cannot stand in

`tests/e2e/real-component-integration.test.ts:123` creates its state root with `tempDir()`, so
every run writes a fresh `state.sqlite` and discards it. Running it thirty times produces thirty
databases, not thirty counted lifecycles.

#241 requires thirty lifecycles read back out of `telemetry_metrics`, which means one persistent
deployment. So the order is:

1. Owner: authenticate the reviewer credential (above).
2. CTO: install and start the daemon — not yet done on this machine, and not something to run
   on the owner's behalf without having exercised it first.
3. Then the window can start and its start time recorded in `docs/ACCEPTANCE.md`.

Step 2 is mine and is the current blocker on the window, not the credential.
