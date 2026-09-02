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
reviewer's readable credential scope (`claudeCredentialPaths` in `src/runtime/cli-adapters.ts`).

### Which identity

**A separate directory is required. A separate account is not.**

Nothing in the code checks the account. What the code requires is that the reviewer never reads
the ordinary provider config tree, because that tree can hold producer conversations — the
`~/.codex` comment above `codexCredentialPaths` in `src/runtime/cli-adapters.ts` states the
reasoning and the Claude path follows it. A fresh directory satisfies that whichever account
authenticates into it.

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

Four Keychain items the launcher reads at start — the `required_keychain_value` /
`optional_keychain_value` block in `deploy/install-launchd.sh`. Telegram stays disabled when none
are present and **refuses a partial set**, so all four are needed together.

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
`src/db/database.ts` — `applySchema` only calls `migrate()` when the on-disk version
differs from the build's `SCHEMA_VERSION`, walks the chain in one pass to exactly
`SCHEMA_VERSION`, and returns without touching the ledger once `version === SCHEMA_VERSION`.
A run that starts at 20 and stops dead at 25 is only possible if the running build's own
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

Database — using SQLite's own **online backup API** through the `sqlite3` CLI, not the
maintenance CLI's `backup` subcommand. That subcommand loads `better-sqlite3`
(its `better-sqlite3` import in `src/db/database.ts`), and a fresh `node` process run for this
procedure cannot load its
native binding — the daemon loaded it once at its own start, and rebuilding the binding here
(before item 3 stops the job) is exactly the thing the "do not execute" gate below exists to
prevent. Measured on this host: `sqlite3` is **3.51.0**, which has `.backup ?DB? FILE`, and the
live database's `journal_mode` is `delete`. A raw `cp` of a live database can copy a file mid
write; the online backup API is built for exactly this and needs nothing stopped to be safe. So
there is no `cp` here, and no fallback to one.

This block was rewritten after running the previous version against the real host and watching
it fail silently: the `node` step above threw, `BACKUP_PATH` came out empty, and
`sqlite3 "" "PRAGMA integrity_check;"` opened a throwaway temporary database and printed `ok` —
a real command, a real `ok`, and no backup at all. Every step below exists to make that specific
shape unreachable: `sqlite3` is never invoked against a path that has not already been proven
non-empty, absolute, and a real file.

<!-- owner-actions:database-backup:start -->

    set -euo pipefail

    SOURCE_DB="$HOME/.agent-control-plane/state.sqlite"

    # 1. Identity of the source, established before anything reads or copies it.
    if [ -z "$SOURCE_DB" ] || [ -L "$SOURCE_DB" ]; then
      echo "refusing: SOURCE_DB is empty or a symlink" >&2; exit 1
    fi
    test -f "$SOURCE_DB"
    test -r "$SOURCE_DB"
    test -s "$SOURCE_DB"
    SOURCE_SIZE="$(stat -f '%z' "$SOURCE_DB")"
    SOURCE_INODE="$(stat -f '%i' "$SOURCE_DB")"
    SOURCE_MTIME="$(stat -f '%Sm' "$SOURCE_DB")"
    # Byte 18 of the SQLite header is the file-format write version: 1 is a rollback journal,
    # 2 is WAL. Every `sqlite3` call below passes `-readonly`, and a read-only connection to a
    # WAL database has to create the `-shm` file it is not allowed to create — it fails
    # `SQLITE_CANTOPEN (14)` with no explanation of why. This is read from the file's own bytes
    # rather than asked of `sqlite3`, because asking is the thing that cannot work here.
    #
    # This is not hypothetical and it is not stable: the live database is `delete` (measured), but
    # `Db`'s constructor sets `journal_mode = WAL` on a database it creates (`src/db/database.ts`
    # around the `PRAGMA journal_mode = WAL` line), so a state file created by this code rather
    # than inherited from an older one is WAL. Until this procedure is re-verified for that case,
    # a WAL source stops here with a sentence that says so, instead of an errno.
    SOURCE_JOURNAL_FORMAT="$(od -An -tu1 -j18 -N1 "$SOURCE_DB" | tr -d ' ')"
    if [ "$SOURCE_JOURNAL_FORMAT" != "1" ]; then
      echo "refusing: $SOURCE_DB has SQLite write-format $SOURCE_JOURNAL_FORMAT, not 1; a read-only connection cannot open a WAL database and this procedure is not verified for one" >&2; exit 1
    fi
    # `.timeout 30000` for the same reason step 3's `.backup` carries one, and it was missing here
    # only from this line. This is a read of the *live* database, and under `journal_mode=delete` a
    # committing writer holds `EXCLUSIVE` for a short window in which a plain read is not queued —
    # it is refused instantly with `SQLITE_BUSY`. An owner running this against a working daemon is
    # reading a database that is being committed to continuously, so that window is not rare.
    #
    # Measured: with the daemon-shaped writer of
    # `tests/process/the-database-backup-step-fails-closed.test.ts` on the source, this line — and
    # only this line — could hand the owner a bare `5`. `sqlite3` prints `Error: stepping, database
    # is locked (5)`, `set -e` carries the substitution's exit status, and the procedure died here,
    # *before* `.backup` ever ran, with nothing on the way out naming the backup, the daemon, or
    # what to do next. The dot command is what queues instead of refusing; the sentence below is
    # what a reader gets if 30 seconds of queueing is still not enough.
    if ! SOURCE_USER_VERSION="$(sqlite3 -readonly "$SOURCE_DB" '.timeout 30000' 'PRAGMA user_version;')"; then
      echo "refusing: could not read user_version from $SOURCE_DB — it stayed locked for the 30s this read waits, which means a concurrent writer (normally the daemon) is committing to it without a gap. No backup was taken and nothing was written. Retry when the daemon is quieter, or stop it first." >&2
      exit 1
    fi
    echo "source: size=$SOURCE_SIZE inode=$SOURCE_INODE mtime=$SOURCE_MTIME user_version=$SOURCE_USER_VERSION"

    # 2. An explicit new destination inside the owner-only backup directory. Refused here, before
    #    the backup runs: empty, already existing, a symlink, or a missing parent all stop below.
    BACKUP_DIR="$HOME/.agent-control-plane/backups"
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    if [ ! -d "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
      echo "refusing: $BACKUP_DIR is missing or not a plain directory" >&2; exit 1
    fi
    BACKUP_NAME="state-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
    BACKUP_TMP="$BACKUP_DIR/.${BACKUP_NAME}.tmp-$$"
    case "$BACKUP_PATH" in
      /*) ;;
      *) echo "refusing: backup path is not absolute" >&2; exit 1 ;;
    esac
    if [ -z "$BACKUP_PATH" ] || [ -e "$BACKUP_PATH" ] || [ -L "$BACKUP_PATH" ]; then
      echo "refusing: $BACKUP_PATH is empty or already exists" >&2; exit 1
    fi
    if [ -z "$BACKUP_TMP" ] || [ -e "$BACKUP_TMP" ] || [ -L "$BACKUP_TMP" ]; then
      echo "refusing: $BACKUP_TMP is empty or already exists" >&2; exit 1
    fi

    # Cleanup is armed here, before the temp file can exist, rather than beside the publish step
    # that needs it. Every refusal between this line and the end is a refusal that has already
    # created something, and an earlier revision armed the trap only at step 7 — so each of those
    # left a `.state-….tmp-<pid>` behind in the backup directory. `$BACKUP_TMP` carries this
    # shell's pid, so it names nothing another run owns.
    #
    # It unlinks only names *this run itself created*, and never `$BACKUP_PATH`, which this run
    # never creates unless it is committing. The manifest link is dropped only while the commit
    # marker is absent: once `$BACKUP_PATH` exists the publication is complete and belongs to
    # whoever made it, and an unconditional `rm -f "$BACKUP_PATH"` here would let a run that
    # merely collided at step 7 delete a stranger's verified backup on its way out. That is not
    # hypothetical — it is what the released-reservation revision did.
    MANIFEST_LINKED=0
    publish_cleanup() {
      if [ "$MANIFEST_LINKED" = "1" ] && [ ! -e "$BACKUP_PATH" ]; then
        rm -f "$BACKUP_PATH.manifest.json"
      fi
      rm -f "$BACKUP_TMP" "${BACKUP_TMP}.manifest.json"
    }
    trap publish_cleanup EXIT

    # 3. The backup itself: one `sqlite3` invocation, the online backup API, against the live
    #    database exactly as it stands. Busy, error, or any nonzero exit stops here — there is no
    #    raw-copy fallback for this command to fall back to.
    #
    #    What `.timeout` covers here, stated exactly, because #753 was filed reading it as covering
    #    more: it queues behind *lock contention*. Measured against a source held under
    #    `BEGIN EXCLUSIVE`, this command waits for the holder and exits `0`; without the dot
    #    command it exits `1` with `Error: database is locked`. It cannot exit `5` — the shell maps
    #    every backup failure to `1` — so a bare `5` out of this block was never this line.
    #
    #    It does not cover *starvation*. `.backup` is the online backup API, which restarts its
    #    copy whenever the source is written mid-pass, and the CLI's copy loop has no iteration cap
    #    and no deadline. A source written without a gap would therefore show up as a run that does
    #    not finish, not as a nonzero exit. That has not been observed here and nothing below
    #    bounds it; if this procedure ever hangs at this line, that is the shape to suspect.
    sqlite3 -readonly "$SOURCE_DB" ".timeout 30000" ".backup '$BACKUP_TMP'"
    # `readManifest` in `src/db/backup.ts` runs `assertPrivatePath` on both the backup and its
    # manifest, and that requires mode exactly 0600. `.backup` writes with the ambient umask, so
    # without this the restore refuses the artifact on permissions alone.
    chmod 600 "$BACKUP_TMP"

    # 4. Verify the artifact before trusting it further. `$SOURCE_DB` above and `$BACKUP_TMP` here
    #    are the only two paths this block ever hands to `sqlite3`, and both are proven non-empty,
    #    absolute, and a real file first — this is what makes `sqlite3 "" ...` unreachable. If any
    #    check below fails, stop: do not call `sqlite3` again against this path.
    if [ -z "$BACKUP_TMP" ]; then
      echo "refusing: backup temp path is empty" >&2; exit 1
    fi
    case "$BACKUP_TMP" in
      /*) ;;
      *) echo "refusing: backup temp path is not absolute" >&2; exit 1 ;;
    esac
    if [ -L "$BACKUP_TMP" ]; then
      echo "refusing: $BACKUP_TMP is a symlink" >&2; exit 1
    fi
    test -f "$BACKUP_TMP"
    test -s "$BACKUP_TMP"

    # 5. Integrity check — stdout must be exactly `ok`, and the command must exit 0. Both, not
    #    either: a corrupt backup can still exit 0 with the wrong text, and a hung/busy one exits
    #    nonzero under `set -e` before stdout is even compared.
    INTEGRITY="$(sqlite3 -readonly "$BACKUP_TMP" 'PRAGMA integrity_check;')"
    if [ "$INTEGRITY" != "ok" ]; then
      echo "refusing: integrity_check on $BACKUP_TMP returned '$INTEGRITY', not ok" >&2; exit 1
    fi

    # 6. Manifest — the backup's own sha256, written and then re-verified from the file on disk,
    #    not trusted from a shell variable alone.
    #
    #    The schema is **not this document's to choose**. `readManifest` in `src/db/backup.ts` is
    #    the only reader that matters, because every restore goes through it, and it accepts
    #    exactly these five fields: `format` equal to the string below, `databaseFile` equal to
    #    the backup's basename, `databaseSha256` matching `^sha256:[a-f0-9]{64}$`, an integer
    #    `schemaVersion`, and a string `createdAt`. An earlier revision invented a second schema
    #    here (`…/online-v1`, `backupSha256`, `backupUserVersion`) and it was never readable:
    #    `state-admin.js restore` rejected every backup this procedure produced, with
    #    `backup manifest has an invalid shape`. The procedure whose only purpose is to make a
    #    rollback possible produced backups the rollback refused.
    #
    #    So: one schema, owned by the code that validates it. If these fields ever need to change,
    #    they change in `src/db/backup.ts` first and here second — never the other way round. The
    #    source identity that used to live in this file is already on stdout from step 1.
    BACKUP_SHA256="sha256:$(shasum -a 256 "$BACKUP_TMP" | cut -d' ' -f1)"
    BACKUP_USER_VERSION="$(sqlite3 -readonly "$BACKUP_TMP" 'PRAGMA user_version;')"
    # `schemaVersion` is JSON-unquoted, so a non-integer here does not produce a manifest that is
    # merely wrong — it produces one that is not JSON, and the failure surfaces at restore time as
    # a parse error rather than here as a refusal.
    case "$BACKUP_USER_VERSION" in
      ''|*[!0-9]*) echo "refusing: user_version of $BACKUP_TMP is '$BACKUP_USER_VERSION', not an integer" >&2; exit 1 ;;
    esac
    cat > "${BACKUP_TMP}.manifest.json" <<JSON
    { "format": "agent-control-plane.sqlite-backup/v1",
      "databaseFile": "$BACKUP_NAME",
      "databaseSha256": "$BACKUP_SHA256",
      "schemaVersion": $BACKUP_USER_VERSION,
      "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
    JSON
    chmod 600 "${BACKUP_TMP}.manifest.json"
    grep -q "\"databaseSha256\": \"$BACKUP_SHA256\"" "${BACKUP_TMP}.manifest.json"
    VERIFY_SHA256="sha256:$(shasum -a 256 "$BACKUP_TMP" | cut -d' ' -f1)"
    if [ "$VERIFY_SHA256" != "$BACKUP_SHA256" ]; then
      echo "refusing: re-hash of $BACKUP_TMP no longer matches the recorded sha256" >&2; exit 1
    fi

    # 7. Publish — every check above has passed. The final names themselves are the claim, and
    #    they are never given back. `ln` creates a hard link atomically and fails `EEXIST` rather
    #    than replacing: it is the file-level analogue of `mkdir` and it never clobbers. `mv -n`
    #    is not a substitute — neither the GNU nor the BSD implementation is race-free, and using
    #    it would reintroduce exactly the check-then-act this replaces.
    #
    #    `ln` requires both names on one filesystem. `$BACKUP_TMP` and `$BACKUP_PATH` are siblings
    #    inside `$BACKUP_DIR`, so this holds — but it is asserted here rather than assumed, and a
    #    run that cannot prove it stops instead of falling back to something that can clobber.
    #    Read into variables first: a `$(stat …)` compared inline fails open, because a `stat`
    #    that errors on both sides makes the comparison "" = "" and the check passes having
    #    measured nothing. Under `set -e` an assignment carries its substitution's exit status,
    #    and the `-z` covers a `stat` that exits 0 and prints nothing.
    BACKUP_TMP_DEVICE="$(stat -f '%d' "$BACKUP_TMP")"
    BACKUP_DIR_DEVICE="$(stat -f '%d' "$BACKUP_DIR")"
    if [ -z "$BACKUP_TMP_DEVICE" ] || [ "$BACKUP_TMP_DEVICE" != "$BACKUP_DIR_DEVICE" ]; then
      echo "refusing: $BACKUP_TMP is not on the same filesystem as $BACKUP_DIR; ln cannot claim the final name atomically" >&2
      exit 1
    fi
    # `publish_cleanup` and its `trap` are armed back in step 2, before the temp file can exist,
    # so a refusal anywhere between there and here leaves nothing behind. `MANIFEST_LINKED` is the
    # only state it reads, and only the next line sets it.
    #
    # The manifest is linked first and the database last, so `$BACKUP_PATH` is the commit marker.
    # This ordering, not the trap, is what survives a death the shell cannot handle: `trap … EXIT`
    # does not run on `SIGKILL`, so a run killed between the two links leaves at most a manifest
    # with no database — never a database that looks verified with no manifest beside it. Item 6
    # checks `$BACKUP_PATH` first and refuses that state.
    #
    # **This covers process death, not power loss.** The kernel applies both `link` operations in
    # order, so any surviving process — including a later run of this block — observes them in
    # order. It says nothing about what reaches stable storage: there is no `fsync` of this
    # directory and no `F_FULLFSYNC` between the two calls, so after a host power loss or an OS
    # crash the second link can be on disk while the first is not, and a database with no manifest
    # is possible. Closing that would need a real durability protocol, and this block does not
    # have one. What does hold after a crash is item 6's preflight: it validates the pair with the
    # real restore validator before it destroys anything.
    #
    # The same line is also the exclusion. Two runs sharing a timestamp both pass every check
    # above independently, and one may have passed the destination check long before the other
    # published; because nothing is ever released, the later one still collides here and refuses
    # before it has touched `$BACKUP_PATH` at all.
    if ! ln "${BACKUP_TMP}.manifest.json" "${BACKUP_PATH}.manifest.json" 2>/dev/null; then
      echo "refusing: another run already owns the final name $BACKUP_PATH" >&2
      exit 1
    fi
    MANIFEST_LINKED=1
    ln "$BACKUP_TMP" "$BACKUP_PATH"
    rm -f "$BACKUP_TMP" "${BACKUP_TMP}.manifest.json"
    test -s "$BACKUP_PATH"
    test -s "$BACKUP_PATH.manifest.json"
    echo "backup verified: $BACKUP_PATH"
    cat "$BACKUP_PATH.manifest.json"

<!-- owner-actions:database-backup:end -->

Good means the last two lines print — a manifest whose `databaseSha256` was independently
recomputed twice and a database at a final name this run claimed with a link that cannot replace
anything. Nothing before that line does, and `$BACKUP_PATH` is the only value the rest of this
document may treat as a verified backup: not a value parsed from a file that might not have been
written, and not a value that might be empty.

**What the ordering guarantees, precisely.** The manifest is linked before the database, and that
ordering is what an untrappable death runs into. Against **process termination** — `SIGKILL`, a
crashed shell — it is a real guarantee: the kernel has already applied both namespace operations
by the time anything else can look, so no surviving process ever sees the database without its
manifest. Against **host power loss or an OS crash** it is not, and this document does not claim
it is. Nothing here `fsync`s the directory, and macOS needs `F_FULLFSYNC` for a write to actually
reach the platter, so the two metadata writes can land out of order and a crash can leave a
database at `$BACKUP_PATH` with no manifest. The `SIGKILL` case is the one this repository's tests
can exercise and do; the power-loss case would need a durability protocol nobody has written here.
What covers it instead is item 6, which validates the backup through the real restore validator
before it destroys anything — so a torn pair fails the rollback's preflight rather than the
rollback itself.

An earlier revision of step 7 reserved the final name with `mkdir` and released the reservation on
success. That is a mutual-exclusion primitive, and its lifetime is the critical section — while
the thing it was protecting, a published backup, outlives that section forever. **A lock released
at the end of a critical section cannot protect an artifact that outlives it.** Two failures
followed directly. A second run that had passed the `[ -e "$BACKUP_PATH" ]` check *before* the
first published could take the freed reservation afterwards and `mv` over the published pair
without ever re-reading the final name; and because the reservation no longer said who owned that
name, the losing run's cleanup deleted a backup it had not made. Both are gone because the final
name is now the claim itself, held permanently, rather than a lock standing in for one.

**One new state this creates, and its recovery.** A run killed between the two links leaves a
manifest at `$BACKUP_PATH.manifest.json` with no database beside it. That name is claimed
permanently, so a later run at the same timestamp refuses rather than resuming — which is correct
and fail-closed, and item 6's preflight already treats it as no usable backup, because
`test -s "$BACKUP_PATH"` is checked there and fails first. It is still a state someone has to
clear rather than puzzle over. To recover, take a fresh backup: this block's name carries a new
UTC timestamp, so it does not collide. To remove the orphan instead, confirm there is no database
at the paired name before unlinking anything:

(After a power loss the reverse pair — a database with no manifest — is possible too, per the
ordering note above. Do not hand-write a manifest for it. Take a fresh backup: a manifest written
by hand is precisely how the document's schema and `src/db/backup.ts`'s drifted apart, and the
resulting file is unverifiable by construction, since its whole purpose is to attest to bytes
nobody watched being produced.)

    ORPHAN="$BACKUP_DIR/state-<TIMESTAMP>.sqlite"
    test ! -e "$ORPHAN"                 # refuse if a database is present — that pair is a real backup
    test -s "$ORPHAN.manifest.json"
    rm "$ORPHAN.manifest.json"

Never remove the manifest without that first `test`: a manifest whose database exists is half of a
verified backup, and deleting it is how the failure this section is about gets recreated by hand.

Bytes — nothing in `deploy/install-launchd.sh` snapshots `dist/`; `snapshot_current_deployment`
only copies the plist and the launcher shell script, and
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
`snapshot_current_deployment` in `deploy/install-launchd.sh` — but it runs from exactly
one call site, inside `install|upgrade`, and this procedure calls neither. So no
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
`wait_for_stop` in `deploy/install-launchd.sh` ends the same wait with
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
    agentcpd-state approve-migration --database "$DRY" --approved-by "$USER" --confirm-migration
    agentcpd-state migrate-approved-copy --database-copy "$DRY" --confirm-migration
    rm -rf "$DRY_DIR"

Expect a report whose `toVersion` is the `SCHEMA_VERSION` the pinned candidate declares, listing
the migration ids that ran with `checksum: true` on each, `approvalRetired: true`, and
`daemonless: true`.

This drives the real migration code — `applySchema` calling `migrate` in `src/db/database.ts` —
not a re-implementation of it, because it is the same compiled file the daemon is about to load.

`agentcpd-state` is the installed command, and it is deliberately not spelled as a path into a
checkout. A runbook step that runs `node <checkout>/dist/db/state-admin.js` makes a private
working tree the authority for what the operator just proved: it is the same failure as the
inline program below, one indirection further out, and it is what an operator reaches for when
the installed interface is the thing they are trying to verify.

**The command is the interface; there is no inline program here any more.** An earlier revision
of this step imported `openDb` from the deployment's `dist` inside `node --input-type=module -e`.
That is a private import spelled out in a runbook: nothing versions it, nothing tests it, and the
operator proving a chain during an incident is running a program written at the keyboard.
`migrate-approved-copy` is the same act with an owner — it takes `--database-copy` and has no
default, refuses a symbolic link, a non-regular file, a file with more than one link and anything
that resolves to the deployment's own database *before* it opens anything, and starts no daemon,
listener or surviving child. It prints no path, so its output can be pasted into a report as it
stands.

**What a failure looks like — not just the success path.** `migrate()` in `src/db/database.ts`
takes exactly one backup before the first step in the chain — `backupOpenDatabaseSync`, named
`pre-migration-v<from>` — and its `catch` block calls `restoreMigrationBackup` with that same
single `backup` binding regardless of which step threw. So **a failure anywhere in the run
restores to the version the chain started at, not to whatever intermediate version it reached.**
The thrown message is exactly `"migration failed; the original database was restored from its
automatic backup"`, or, if even that restore fails, `"migration failed and the automatic backup
could not be restored"`. This is not hypothetical: `restores the original v11 database when a
fault is injected after a migration commits`, in
`tests/unit/database-migration-restore.test.ts`, drives exactly this path today and asserts that
message.

The one recovery point is also visible in the ledger afterwards, which is how to tell a real
chain apart from one that claims more safety than it has: only the receipt for the chain's
**first** step carries `backup_file` and `backup_checksum`, and every later receipt carries
`NULL` for both. `migrates a v11 fixture in order, records its backup receipt, and
re-establishes load-bearing guards` asserts exactly that, and the falsifiability case
`one-recovery-point-for-the-whole-chain` is the mutation that proves the assertion is load-bearing.

**Three of the steps are destructive table rewrites, which is why the single recovery point
matters here rather than being a formality.** `v26-ledger-trigger-bodies`,
`v27-an-observation-carries-its-evidence` and `v28-an-operator-can-settle-a-turn-nobody-observed`
each run with `foreignKeysOffDuringApply: true` and call `rebuildObservationsIfStale` — v28 also
`rebuildCanonicalTurnsIfStale` — and those helpers **drop and recreate** the table, taking its
triggers with it and restoring them from `ledgerTriggerDdl()` afterwards. A failure at, say, the
step after v28 therefore does not leave a database one edit away from correct; it leaves one that
has had `canonical_turns` and `canonical_turn_observations` rewritten, and the pre-chain image is
the only thing that undoes that.

The chain was confirmed contiguous while preparing this packet, and stays confirmed by test
rather than by this sentence: `MIGRATIONS.map(m => m.fromVersion)` equals
`MIGRATIONS.map(m => m.toVersion - 1)` for the whole registry, asserted in
`tests/unit/database-migration-restore.test.ts`. So a failure here on execution day would be a
genuinely new defect in one of those steps, not a missing link this packet failed to notice. **Do
not read a step count out of this document** — derive it on the day from the live
`max(version)` and the `SCHEMA_VERSION` the pinned candidate declares, per staleness rule 4.

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
the chain runs, the file is renamed to `migration-approval.applied-v25-v<to>-<epoch>.json` and
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

The first `Db` the new process opens finds `state.sqlite` at 25, a build declaring the pinned
`SCHEMA_VERSION`, and an approval naming exactly that chain, and `applySchema` runs it — protected by its own
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

Expect: `max(version)` is the pinned `SCHEMA_VERSION` — 36 as measured 2026-09-02, not the 34
item 1 recorded; `health.json` shows a new `pid` and `startedAt`, `lockHeld: true`,
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
    # The restore, run for real against a throwaway database, before anything is destroyed.
    # Every check above this line asks whether a file is *present*; none of them asks whether
    # `restoreDatabase` will accept it, and those are different claims. `readManifest` alone can
    # refuse on the manifest's format, its `databaseFile`, its `databaseSha256` shape, its
    # `schemaVersion`, or either file's permissions — and `validateBackup` then re-hashes the
    # image, re-checks its integrity, and asserts this schema's invariants at its recorded
    # version. A backup that fails any of those was going to fail *after* `rm -rf dist`, in the
    # procedure you reach for when things are already broken. This is the same command as the
    # real restore below, differing only in `--database`, so what it proves is not a proxy.
    ROLLBACK_PREFLIGHT_DIR="$BYTES_BACKUP/rollback-preflight"
    rm -rf "$ROLLBACK_PREFLIGHT_DIR"
    mkdir -p "$ROLLBACK_PREFLIGHT_DIR"
    chmod 700 "$ROLLBACK_PREFLIGHT_DIR"
    node "$BYTES_BACKUP/dist/db/state-admin.js" restore "$BACKUP_PATH" \
      --database "$ROLLBACK_PREFLIGHT_DIR/state.sqlite" --confirm-restore
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

`test -s "$BACKUP_PATH"` also covers the one incomplete state item 4 step 2 can leave behind. A
backup run killed untrappably between its two links leaves a manifest at
`$BACKUP_PATH.manifest.json` with no database — the deliberate direction of that ordering, since
the reverse would leave a database that looks verified. That is **not a usable backup**, and this
line refuses it before `rm -rf` runs, on its own, without needing to reason about the manifest.
Clearing the orphan is written out at the end of item 4 step 2.

`install-launchd.sh rollback` is deliberately **not** used here, and the reason is worth
stating because reusing it looks obviously right. That path does stop the job, wait for the
lock fail-closed, restore the database and restore a plist and launcher — but it selects them
with `find … | sort | tail -n 1` inside `rollback` in `deploy/install-launchd.sh`, the newest
directory in
`deploy-backups/` **by name**. This procedure never calls `install`/`upgrade`, which is the
only caller of `snapshot_current_deployment`, so it creates no
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
build"` (thrown by `applySchema` in `src/db/database.ts`) — and with
`KeepAlive.SuccessfulExit = false` and a 30 s
`ThrottleInterval`, launchd retries that failure forever. Both restores must complete, in either
order, while the job is stopped, before the next `start`.

### What it creates

A database backup and manifest under `~/.agent-control-plane/backups/` (item 2); a `dist/`
snapshot and its hash under `~/.agent-control-plane/deploy-backups/` (item 2); nine new rows in
`schema_migrations`, one row per step from 26 to the pinned `SCHEMA_VERSION`, each with a
`sha256:` receipt (item 4, on success);
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
4. **`SCHEMA_VERSION` in `src/db/migrations.ts` on main is no longer the number item 1 recorded.**
   A new migration landed; the chain-contiguity check and the dry-run target in item 3 must be
   redone against it. **This tripwire has already fired.** Item 1 recorded 34. Measured
   2026-09-02: `origin/main` declares `SCHEMA_VERSION = 36` and the live database is still at 25,
   so the chain this packet would run is 25→36 — two steps longer than the prose it was drafted
   with. Re-derive item 1's pins before executing anything; do not read a target version, a step
   count, or an `applied-v25-v<to>` filename out of this document.

---

## Why the observation window needs a daemon, and the e2e cannot stand in

`tempDir()` in `tests/e2e/real-component-integration.test.ts` creates its state root, so
every run writes a fresh `state.sqlite` and discards it. Running it thirty times produces thirty
databases, not thirty counted lifecycles.

#241 requires thirty lifecycles read back out of `telemetry_metrics`, which means one persistent
deployment. So the order is:

1. Owner: authenticate the reviewer credential (above).
2. CTO: install and start the daemon — not yet done on this machine, and not something to run
   on the owner's behalf without having exercised it first.
3. Then the window can start and its start time recorded in `docs/ACCEPTANCE.md`.

Step 2 is mine and is the current blocker on the window, not the credential.
