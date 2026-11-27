# Owner actions — prepared up to the line

Three items need the owner (§2–§4); §1 is a recovery step needed only if the reviewer's sign-in stops working. Each is prepared as far as it can be without them; what remains is
stated as commands rather than description. Ordered by what they unblock.

Every path and variable below was read out of the code, not inferred. Where I am recommending
rather than reporting a requirement, it says so.

---

## 1. Reviewer credential scope — in place; the owner is needed only if its sign-in stops working

The reviewer's credential scope exists, and blind reviews have run under it since 2026-11-01.
Nothing waits on this item. It stays here as the recovery step for the one case that needs the
owner: a blind review refused because the reviewer's own sign-in is no longer accepted.

### Why the reviewer has its own scope

A blind reviewer runs under `tools: "none"`, which is `(deny process-exec*)` with an allowlist
of the provider binary, node and `/usr/bin/env`. The Claude CLI reads its OAuth credential by
spawning `/usr/bin/security` against the login Keychain, so a confined reviewer reading the
ordinary credential dies:

    EPERM: operation not permitted, posix_spawn 'security'

The run then fails `EVIDENCE_MISSING`. The credential has to live somewhere the reviewer is
allowed to *read*, rather than somewhere it must *spawn* to reach.

### Where it lives

In the reviewer's own Claude config directory, `ACP_CLAUDE_REVIEWER_CONFIG_DIR`. The installed
launcher derives it from `ACP_REVIEWER_ROOT` when it is not set, outside the daemon state tree
that the reviewer seatbelt denies; an explicit value in the launchd environment still wins. The
comment above that export in `deploy/install-launchd.sh` gives the reasoning, and
`claudeCredentialPaths` in `src/runtime/cli-adapters.ts` is what hands the directory to the
seatbelt profile as the reviewer's readable credential scope. Read the location there, not here.

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

### If the reviewer's sign-in stops working

Only then: sign in again into the same directory, with `ACP_CLAUDE_REVIEWER_CONFIG_DIR` set to
the value the installed launcher exports.

    CLAUDE_CONFIG_DIR="$ACP_CLAUDE_REVIEWER_CONFIG_DIR" claude
    # then: /login    (and /exit once it reports authenticated)

### How to tell it works

A blind review that completes is the proof. A file in the reviewer's directory is not: its
presence does not show that the sign-in it holds is still accepted, so this item gives no file
check.

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

**Prerequisite for the first seal of an existing deployment.** `sealRollbackPair` refuses to seal a
launcher bound to an interpreter outside the runtime it installs (`assertGenerationBindings`,
`src/deploy/rollback-pair.ts`) — a launcher naming `$(command -v node)` from the installing host
promises "restore these bytes and run them under whatever interpreter is around later", exactly the
generation-mixing a sealed pair exists to end. Since #774, `install-launchd.sh install|upgrade`
clones the resolved interpreter into `$APP_ROOT/dist/bin/node` and binds the launcher's
`ACP_NODE_PATH` to that in-tree copy itself, and `pnpm build` places the native `fd-vfs` extension
at `dist/native/fd-vfs/build/Release/...` so `dist` carries it too — but only from the run that
does this onward. A deployment installed before #774 is still running the old, externally-bound
launcher, and **cannot be sealed as it currently runs**: run `install-launchd.sh upgrade --app-root
"$APP_ROOT" --node "$(command -v node)"` (ordinary operation — stops the job, rewrites the launcher,
restarts it) once, and only then take the first seal below. A seal attempted against the old
launcher fails loudly (`assertGenerationBindings`'s own refusal) rather than silently sealing
something that cannot be restored.

Bytes — seal a rollback pair. This replaces the hand-built byte snapshot that used to live here.
That snapshot copied `dist`, the plist and the launcher into a directory the shell named, hashed
one file, and wrote a receipt afterwards claiming the database backup and the bytes belonged
together. They did not: two independently chosen halves are not a pair no matter what a third file
says about them, and the receipt was only as good as the shell session that wrote it. A sealed
pair carries the database image, the runtime closure, the plist and the launcher under one id, and
item 6 restores it as one operation.

    set -e
    APP_ROOT=/absolute/path/to/agent-control-plane
    # The closure is what gets sealed, and it carries its own interpreter, native extension and
    # dependencies. A pair that named an external `node` (or an extension living outside `dist`)
    # would promise "restore these bytes and run them under whatever this machine has later",
    # which is the generation-mixing the pair exists to end. `$APP_ROOT/dist` already carries the
    # interpreter (`dist/bin/node`) and the extension (`dist/native/...`) as of the prerequisite
    # above, so this step only has to fold in `node_modules` — it no longer clones `command -v
    # node` by hand.
    CLOSURE="$HOME/.agent-control-plane/closure-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$CLOSURE" && chmod 700 "$CLOSURE"
    cp -Rc "$APP_ROOT/dist/." "$CLOSURE/"
    # Not `cp -RcL "$APP_ROOT/node_modules"`: that copy dereferences pnpm's symlinks into real
    # directories at the top level, where a package's own dependencies (`@noble/hashes`, which
    # `nostr-tools` needs) are not, so the sealed `state-admin.js` cannot start and the rollback
    # fails at its database step. This installs the same lockfile's production dependencies as a
    # hoisted, symlink-free tree that resolves on its own; it needs `pnpm` on PATH. It installs
    # under the closure's own `bin/node` and loads better-sqlite3 and nostr-tools with it before
    # it succeeds, so an addon built for a different Node is refused here, not at rollback. On a
    # pnpm cache miss that addon is fetched by `prebuild-install` or built by `node-gyp`, and the
    # lockfile's integrity hashes do not cover it.
    chmod 755 "$CLOSURE/bin/node"
    "$APP_ROOT/deploy/closure-node-modules.sh" "$APP_ROOT" "$CLOSURE/node_modules" "$CLOSURE/bin/node"
    node "$APP_ROOT/dist/deploy/rollback-pair.js" seal \
      --pairs-root "$HOME/.agent-control-plane/rollback-pairs" \
      --database "$HOME/.agent-control-plane/state.sqlite" \
      --runtime-root "$CLOSURE" \
      --entrypoint daemon/agentcpd.js --state-admin db/state-admin.js \
      --node-executable bin/node --node-version "$(node --version)" \
      --install-runtime-root "$APP_ROOT/dist" \
      --install-plist "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist" \
      --install-launcher "$HOME/.agent-control-plane/agentcpd-launch.sh" \
      --working-directory "$APP_ROOT" \
      --service-label com.agentcontrolplane.agentcpd \
      --service-generation "$(git -C "$APP_ROOT" rev-parse HEAD)" \
      --plist "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist" \
      --launcher "$HOME/.agent-control-plane/agentcpd-launch.sh"

Record what it prints. `ACP_PAIR_ID` and `ACP_PAIR_INDEX_DIGEST` are the two values item 6 needs,
and the digest is deliberately the one thing kept **outside** the pair — a pair cannot prove its
own index. Everything else the rollback needs is inside the pair.

`install-launchd.sh` does snapshot the plist and launcher — `snapshot_current_deployment` — but
it runs from exactly one call site, inside `install|upgrade`, and this procedure calls neither, so
`deploy-backups/` holds whatever some earlier install left there, or nothing at all. It is not a
rollback source: **a rollback that restores a plist from a past install is not a rollback of this
operation.**

`rollback` used to pick from it — `find … | sort | tail -n 1`, the newest directory *by name*.
That selection is gone. `rollback` now restores the sealed pair named above and discovers nothing,
which is why this procedure seals one rather than assembling a rollback out of parts.

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
    node /Users/isaac/projects/agent-control-plane/dist/db/state-admin.js approve-migration \
      --database "$DRY" --approved-by "$USER" --confirm-migration
    node "$HOME/projects/agent-control-plane/dist/db/state-admin.js" migrate-approved-copy \
      --database-copy "$DRY" --confirm-migration
    rm -rf "$DRY_DIR"

Expect a report whose `toVersion` equals the `schemaVersion` main declares on execution day, with
`approvalRetired: true`, `daemonless: true`, and every step's `checksum` true. This drives the real
migration code — `applySchema` calling `migrate` in `src/db/database.ts` — not a re-implementation
of it, because it is the same compiled file the daemon is about to load.

Until `#765`/`#766` this step was an inline `node --input-type=module -e` that imported `openDb`
from `dist`. That is a private import spelled out in a runbook: nothing versioned it, nothing
tested it, and the operator proving a chain during an incident was running a program they wrote at
the keyboard. `migrate-approved-copy` is the same act with an owner.

It takes `--database-copy` and has no default, because the default would be the one database it
must never touch. It refuses a symbolic link, a non-regular file, a file with more than one link,
a copy with a non-empty `-wal` or `-shm` beside it, and anything that resolves to the deployment's
own database. It starts no daemon, listener or surviving child, and prints no path, so its output
can be pasted into a report as it stands.

**What it means that the copy is migrated in place.** The pathname you name is opened exactly once,
and every decision after that — identity, link count, version, which approval applies — is about
that open file rather than about the name. `lstat` and `open` are two syscalls and a rename between
them is invisible to both, so a command that verified a pathname and then handed the same pathname
to SQLite would have verified one thing and opened another. A native VFS (`native/fd-vfs`) makes
SQLite use the descriptor that was verified, so the migration happens in the approved file itself,
through a handle nothing can redirect. Nothing is staged and nothing is copied back.

One consequence is worth knowing before you read the report: a bound connection has no
shared-memory support, so SQLite declines to enter WAL mode and runs the chain on a rollback
journal instead. It declines silently, by returning the previous mode rather than an error, so the
command asserts the mode it actually got and the report states it under `journalMode`. A copy that
already has a non-empty log beside it is refused rather than opened, because its header version
would not be the whole truth.

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
it against a disposable fixture standing in for `$HOME` and the app root and asserts that it
refuses fail-closed without touching anything. Moving the block out from under these markers, or
editing a command inside it, is not a formatting change: that test extracts from these markers and
nowhere else, so it fails to find its anchor rather than silently testing stale text.

Set six values first. `APP_ROOT` is the deployment checkout; `PAIR_ID` and `INDEX_DIGEST` are what
the seal printed and you retained outside the pair; `SCHEMA_VERSION`, `SERVICE_GENERATION` and
`NODE_VERSION` are what that same pair was sealed for. The last three are not decoration: a
rollback that does not state which schema, generation and runtime it is restoring can be applied
to a deployment it was never for, and the pair has no way to object.

<!-- owner-actions:rollback-preflight:start -->

    set -eu
    # Nothing here selects anything. There is no backup to name, no bytes directory to pick and
    # no plist to choose: the pair id names one sealed generation and the retained digest proves
    # it is that one. Everything a rollback used to do by hand — stop the job, wait for the lock
    # fail-closed, check the artifacts, restore the database, put the runtime and launchd config
    # back — happens inside this one command, which refuses before it changes anything and puts
    # the previous generation back if any step after the stop fails.
    test -n "$APP_ROOT"
    test -n "$PAIR_ID"
    test -n "$INDEX_DIGEST"
    test -n "$SCHEMA_VERSION"
    test -n "$SERVICE_GENERATION"
    test -n "$NODE_VERSION"
    bash "$APP_ROOT/deploy/install-launchd.sh" rollback \
      --pair-id "$PAIR_ID" --expected-index-digest "$INDEX_DIGEST" \
      --expect-schema-version "$SCHEMA_VERSION" \
      --expect-service-generation "$SERVICE_GENERATION" \
      --expect-node-version "$NODE_VERSION"
    bash "$APP_ROOT/deploy/install-launchd.sh" status

<!-- owner-actions:rollback-preflight:end -->

**Why this is three lines and a command instead of a preflight.** The earlier version of this
block was a hand-built rollback: it named a database backup in one variable and a bytes directory
in another, checked each file it was about to consume, and then ran `rm -rf` against the live
`dist`. Every one of those checks was necessary *because the two halves were selected separately*
— nothing tied the database it restored to the bytes it copied, so the document had to re-derive
by hand what a pair now carries. It also had to be complete rather than representative: an earlier
revision checked three of the files it consumed and then used two more it had never looked at, so
`rm -rf dist` and half the restore ran before the failure and left the rollback stranded.

The sealed pair removes the class rather than the symptom. There is one artifact, its members are
verified against a digest retained outside it, they are copied into an owner-only stage and
re-verified before anything is installed, and a failure after the stop restores the previous
runtime, plist and launcher and starts the service again. A destructive command against the live
tree no longer appears in this document at all, which is why the test that guards this block now
asserts that none is present.

If the rollback refuses, it has changed nothing — not the database, not the bytes, not even the
directories it looked in. Read the refusal, fix what it names, and run it again. If it fails
*after* the stop, it has already put the previous generation back and started the service; that is
a failed rollback, not a half-applied one, and the deployment is where it was before you ran it.

**The recovery copy — present only after a failed put-back, and yours to clear.** Before the first
mutation, `applyRollbackPair` secures the runtime, plist, launcher and a WAL-complete database
image of the generation it is about to replace into a private directory beside `state.sqlite`,
named `.rollback-recovery-<pair id>-<pid>-<uuid>`. On an ordinary successful rollback this copy is
removed automatically before the command returns — the sealed pair for that generation still exists
under `rollback-pairs/`, so a second, unbounded copy next to the live database would be redundant
with it. It survives only when compensation *itself* fails after an error — full disk during the
runtime copy, a strict schema check refusing the database restore — at which point the copy is the
one remaining evidence the previous generation existed, and the failed rollback's own error message
names its path. Nothing removes it automatically in that case, on purpose: a rollback tool that
deletes the last copy of the previous generation while reporting its own failure is not an undo.
If you land in this state, read the copy back by hand (it is a plain directory: `runtime/`, `plist`,
`launcher`, and the database image under its own name) before removing it — there is no janitor for
it, and none is planned.

### The sealed rollback pair

A rollback is not "restore the database". It is putting back a **generation**: the database image,
the runtime closure that reads it, the Node executable that runs that closure, and the plist and
launcher that start it. Restoring one half and leaving the other is not a smaller rollback — it is
a combination that has never run anywhere, assembled at the moment the deployment is already
broken. This section spent several revisions guarding that by hand, with a database backup from
one command, bytes from another, and a receipt written afterwards to say they belonged together.
The sealed pair replaces that agreement between three things with one artifact.

One UUID names a directory holding a **WAL-complete database backup** taken through the supported
path, the **runtime closure** and the **Node executable** it is bound to, the **launchd generation
and config**, an **exact inventory**, and a **self-excluding `SHA256SUMS`** — self-excluding
because a checksum file that covers itself proves nothing about the file it sits in. After it is
sealed the pair depends on nothing outside its own root: not the source tree, not a registry, not
the machine that made it. The tree moving on does not invalidate it.

Seal one with the built module. It reads nothing from the host — every identity below is stated on
the command line, including the runtime version, so the same command seals the generation you are
leaving *and*, later, the one you are moving to as its return leg. A producer that could only seal
the generation it is running under would make a rollback a one-way door. Substitute your own
checkout path for `$APP_ROOT`:

    set -euo pipefail
    APP_ROOT=/absolute/path/to/agent-control-plane
    # The closure is what gets sealed, and it carries its own interpreter, native extension and
    # dependencies. A pair that named an external `node` (or an extension living outside `dist`)
    # would promise "restore these bytes and run them under whatever this machine has later",
    # which is the generation-mixing the pair exists to end. Since #774, `install-launchd.sh
    # install|upgrade` clones the interpreter into `$APP_ROOT/dist/bin/node` and `pnpm build`
    # places the native `fd-vfs` extension at `dist/native/...` — both already inside `dist`, so
    # this step only has to fold in `node_modules`. An existing deployment must have run
    # `install-launchd.sh upgrade` at least once since #774 before its first seal; see the
    # "Prerequisite for the first seal" paragraph earlier in this document.
    CLOSURE="$HOME/.agent-control-plane/closure-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$CLOSURE" && chmod 700 "$CLOSURE"
    cp -Rc "$APP_ROOT/dist/." "$CLOSURE/"
    # Not `cp -RcL "$APP_ROOT/node_modules"`: that copy dereferences pnpm's symlinks into real
    # directories at the top level, where a package's own dependencies (`@noble/hashes`, which
    # `nostr-tools` needs) are not, so the sealed `state-admin.js` cannot start and the rollback
    # fails at its database step. This installs the same lockfile's production dependencies as a
    # hoisted, symlink-free tree that resolves on its own; it needs `pnpm` on PATH. It installs
    # under the closure's own `bin/node` and loads better-sqlite3 and nostr-tools with it before
    # it succeeds, so an addon built for a different Node is refused here, not at rollback. On a
    # pnpm cache miss that addon is fetched by `prebuild-install` or built by `node-gyp`, and the
    # lockfile's integrity hashes do not cover it.
    chmod 755 "$CLOSURE/bin/node"
    "$APP_ROOT/deploy/closure-node-modules.sh" "$APP_ROOT" "$CLOSURE/node_modules" "$CLOSURE/bin/node"
    node "$APP_ROOT/dist/deploy/rollback-pair.js" seal \
      --pairs-root "$HOME/.agent-control-plane/rollback-pairs" \
      --database "$HOME/.agent-control-plane/state.sqlite" \
      --runtime-root "$CLOSURE" \
      --entrypoint daemon/agentcpd.js --state-admin db/state-admin.js \
      --node-executable bin/node --node-version "$(node --version)" \
      --install-runtime-root "$APP_ROOT/dist" \
      --install-plist "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist" \
      --install-launcher "$HOME/.agent-control-plane/agentcpd-launch.sh" \
      --working-directory "$APP_ROOT" \
      --service-label com.agentcontrolplane.agentcpd \
      --service-generation "$(git -C "$APP_ROOT" rev-parse HEAD)" \
      --plist "$HOME/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist" \
      --launcher "$HOME/.agent-control-plane/agentcpd-launch.sh"

It prints `ACP_PAIR_ID` and `ACP_PAIR_INDEX_DIGEST` and writes nothing else. Sealing is atomic: the
pair is built and validated inside an owner-only staging directory and renamed into place, so a
failure partway leaves **no** directory under the pair id rather than a half-built one under an
approved-looking name. Seal while the job is stopped — the backup path is WAL-coherent and leaves
the source and both sidecars untouched, but a recovery point is worth more when nothing is writing
to the file it is a point for.

`--runtime-root` is the closure, and it has to be able to run after everything outside it is gone:
the built tree, the `node_modules` it resolves, the native addons those load, and the Node
executable itself, with its execute bit. Sealing recursively inspects the dynamic linkage of every
Mach-O it carries and **refuses** if anything absolute is neither a macOS system library nor inside
the closure — macOS system libraries are the one platform boundary, because they live in the dyld
shared cache and are not copyable artifacts. `cp -Rc` asks APFS for clones, so carrying a 100MB
interpreter costs almost no disk.

**Retain two values, outside the pair: the pair id, and `SHA256(SHA256SUMS)`.** The second one is
the whole point. Every digest inside a pair can be rewritten by whoever rewrote a member — a
forgery is internally perfect by construction — so the index digest is deliberately kept where the
pair cannot reach it, and `rollback` refuses without it:

    bash "$APP_ROOT/deploy/install-launchd.sh" rollback \
      --pair-id <uuid> --expected-index-digest sha256:<64 hex>

That command refuses **before it creates or changes anything at all**, including the directories it
looks in. It checks the pair id (a UUID — `latest` and a timestamp are refused by name), the
retained index digest, the exact inventory with every digest and byte count, the declared schema,
runtime and service identity, that this pair is for *this* database, *this* service label and
*this* app root, that every member is a regular non-symlink file with no hard link outside the
pair, and that every member is still inside the pair root **after** its path is resolved.

It then takes its own verified copy of every member into an owner-only stage and installs only
from that copy, so a member swapped or rewritten through an alias between validation and install
cannot reach the running deployment. Only then does it stop the job, wait for the lock, and
install the whole generation — runtime closure, plist, launcher, and the database restored through
the **sealed** generation's own `state-admin` under the **sealed** Node. If any step fails, the
previous runtime, plist and launcher are put back from the copy taken before the first mutation
and the job is started again, so a failed rollback leaves the deployment whole rather than mixed
or stopped.

**Item 6 runs this and nothing else.** The split procedure it used to carry is gone, along with
the destructive command that made its preflight necessary.

Why the whole generation has to move together is worth keeping, because it is what the pair is
for. Replacing the bytes of a still-running daemon and then having the database restore refused by
the lock a moment later leaves a **partial rollback** — old bytes, new schema — the one
combination `applySchema` refuses outright and `KeepAlive` then retries forever. A sealed pair
cannot reach that state: it stops the job and waits for the lock fail-closed before it changes
anything, and if any step after the stop fails it puts the previous generation back and starts the
service again.

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

### Restore a stopped v60 database to v59 (single path, 60→59 only)

This is the one way to turn a schema v60 (#1464) database into a v59 one that keeps the data written
under v60. It produces and verifies a converted copy; installing that copy as the operational
database uses the replacement-database path at the end of this section. It is written for one source and one target and it refuses everything else; there is no flag to widen
it, and a second variant for another version pair is not a smaller version of this one — it is a
different procedure that needs its own rehearsal. It exists because the sealed pair above restores
the database image it sealed, and that image predates whatever the daemon wrote after it.

It is a procedure, not a command: nothing in `src/` runs it, and `state-admin` has no verb for it.
Every step is something an operator reads, runs and checks.

**What it applies to.** The source is a database at `user_version` 60 whose `schema_migrations`
holds the v60 row exactly — `version = 60`, `migration_id = 'v60-review-completion-bootstrap-only'`,
`checksum = 'sha256:65511a8e156217490cf3b92da02b673e13832007425b438a8cc76cefb15e1a68'` — and whose
triggers are exactly the v59 set plus `runs_review_completion_bootstrap_only` and
`runs_kind_immutable`. The target is the v59 build: main at `47451b33`, or the v59 build pinned in the
rollback pair, whichever the owner names. Nothing else — not v61, not a v60 database with a second
change, not a v59 database. A database *created* at v60 rather than migrated to it carries the ledger
row `bootstrap-v60`, not the one above, so the ledger guard refuses it; that is intended.

**Preconditions.** All of these hold, and each of 1 to 4 is checked again immediately before and
immediately after the copy is taken. If any differs at any of those points, the copy is discarded and
the procedure stops.

1. The daemon is stopped and `~/.agent-control-plane/agentcpd.lock` is free: the wait, with its
   `exit 1` and not a warning, in step 3 ("Stop the job, then rebuild the candidate…") of the section
   "4. Reconcile the deployed daemon with candidate main — blocks #512".
2. `state.sqlite-journal` does not exist.
3. `state.sqlite-wal` is absent or zero bytes.
4. The source main file's SHA-256 is the one recorded at the start.
5. Work only on a copy, in a directory made new for this run. The source is never opened for
   writing, never renamed and never repaired.

The copy is read through an immutable open, and an immutable open promises SQLite that nothing will
change the file, so SQLite skips both journal recovery and the WAL. A `state.sqlite-journal` left by a
stopped writer can leave pages in the main file from a transaction that never committed, which
recovery would roll back and the copy would keep: the copy captures uncommitted data. A non-empty
`state.sqlite-wal` holds committed pages that are not in the main file yet, and the copy would not
see them: the copy misses committed data. Neither failure is an error; the copy opens cleanly. A lock
that is not free, or a main file whose digest moves, says a writer is or was active, and either of
the other two may be appearing as the copy is taken. A journal or non-empty WAL on a stopped daemon is
a stop, not something to recover or checkpoint here.

Run this as one block, in one `bash` that you keep for the conversion step below, so the function and
the variables are the same ones:

    set -euo pipefail
    STATE="$HOME/.agent-control-plane"
    SRC="$STATE/state.sqlite"
    quiet() {
      [ ! -e "$STATE/agentcpd.lock" ] || { echo "the agentcpd lock is not free" >&2; return 1; }
      [ ! -e "$SRC-journal" ] || { echo "state.sqlite-journal exists" >&2; return 1; }
      [ ! -s "$SRC-wal" ] || { echo "state.sqlite-wal is not empty" >&2; return 1; }
      [ "$(stat -f %HT "$SRC")" = "Regular File" ] || { echo "the source is not a regular, non-symlink file" >&2; return 1; }
      [ "$(shasum -a 256 < "$SRC")" = "$SOURCE_SHA" ] || { echo "the source main file changed" >&2; return 1; }
    }
    SOURCE_SHA="$(shasum -a 256 < "$SRC")"
    # A new, unique path; mkdir without -p fails, and set -e stops, if anything already exists there.
    WORK="$STATE/downgrade-60-59-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen)"
    mkdir -m 700 "$WORK"
    echo "work directory: $WORK"
    COPY="$WORK/state.sqlite"
    printf '%s\n' "$SOURCE_SHA" > "$WORK/source.sha256.before"
    quiet || { rm -f "$COPY"; exit 1; }
    sqlite3 "file:$SRC?immutable=1" ".backup '$COPY'"
    quiet || { rm -f "$COPY"; exit 1; }
    chmod 600 "$COPY"   # .backup writes 644; the v59 build refuses a state file that is not 600
    check_copy() {
      [ "$(stat -f %HT "$COPY")" = "Regular File" ] || { echo "the copy is not a regular, non-symlink file" >&2; return 1; }
      [ "$(dirname "$(realpath "$COPY")")" = "$(realpath "$WORK")" ] || { echo "the copy is not inside the work directory" >&2; return 1; }
      [ "$(stat -f %d:%i "$COPY")" != "$(stat -f %d:%i "$SRC")" ] || { echo "the copy is the source" >&2; return 1; }
    }
    check_copy || { rm -f "$COPY"; exit 1; }
    shasum -a 256 < "$COPY" > "$WORK/copy.sha256.before-convert"

Verify the copy before using it: `PRAGMA integrity_check` returns `ok` on it, and its content
digest (defined under the post-checks) equals the same digest taken from the source opened the
same immutable way. A copy that cannot be proven equal to the source is not a starting point.

**The reference for the schema comparisons.** The only valid reference for comparing full
`(type, name, tbl_name, sql)` rows is the database image sealed in this database's own rollback pair,
taken before the v59→v60 migration: the pair's `database/state.sqlite`, which carries v59's
`sqlite_schema`. A migrated database keeps the whitespace each older release wrote for its own
objects, and a database created fresh by the v59 build spells some of them differently, so a fresh
image fails a valid source. If no such image exists, compare object `type`, `name` and `tbl_name`
only, against a database created fresh by the pinned v59 build. That is weaker: a changed definition
under an unchanged name is not caught. Say in the evidence which of the two was used.

The two v60 triggers are compared against the text a v60 migration stores, not against
`src/db/schema.sql` verbatim. SQLite drops `IF NOT EXISTS` from the stored text, so the literal
statement never matches. The stored text is the statement in `src/db/schema.sql` from
`CREATE TRIGGER IF NOT EXISTS <name>` through `END;`, with ` IF NOT EXISTS` removed and the final `;`
dropped, and no comment above it. A v60 database produced by migrating the reference image holds
exactly that.

**Guards, checked on the copy, before anything is changed.** Any one of these failing stops the
procedure. Nothing is repaired to make a guard pass.

- `PRAGMA user_version` is not `60`, or the v60 ledger row is absent, appears more than once, or
  carries a different `migration_id` or `checksum`, or `max(version)` in `schema_migrations` is not 60.
- The trigger set is not exactly the reference's set plus `runs_review_completion_bootstrap_only` and
  `runs_kind_immutable`. Compare `type`, `name` and `tbl_name` against the reference, and read the two
  v60 triggers back as `type='trigger' AND tbl_name='runs'`. A missing, extra or renamed trigger is a
  stop.
- `sqlite_schema` differs from v60's expected schema: the reference's rows plus the two triggers in the
  stored text above. With the sealed image as the reference, compare every `(type, name, tbl_name,
  sql)` row, not a count. With a fresh v59 image as the reference, compare `type`, `name` and
  `tbl_name` only, and compare the two triggers' `sql` to the stored text above.
- `PRAGMA integrity_check` is anything but `ok`.

**The steps.** One transaction, on the copy, in a `sqlite3` shell that supports `.dbconfig`. Write the
SQL below to `$WORK/convert.sql` first — with an editor, or with `cat > "$WORK/convert.sql"`, pasting
it and ending with Ctrl-D — and run it from that file. A shell heredoc needs a writable temporary
directory, which a sandboxed shell or a read-only `TMPDIR` may not have.

    .bail on
    .dbconfig enable_trigger off
    BEGIN IMMEDIATE;
    -- Each guard raises "integer overflow" when its condition holds; .bail on then stops the shell and the
    -- open transaction is rolled back when the connection closes.
    SELECT CASE WHEN (SELECT user_version FROM pragma_user_version) <> 60 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name='runs'
      AND name IN ('runs_review_completion_bootstrap_only','runs_kind_immutable')) <> 2 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM schema_migrations WHERE version=60
      AND migration_id='v60-review-completion-bootstrap-only'
      AND checksum='sha256:65511a8e156217490cf3b92da02b673e13832007425b438a8cc76cefb15e1a68') <> 1 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT max(version) FROM schema_migrations) <> 60 THEN abs(-9223372036854775807-1) END;
    DROP TRIGGER runs_review_completion_bootstrap_only;
    DROP TRIGGER runs_kind_immutable;
    DELETE FROM schema_migrations WHERE version = 60 AND migration_id = 'v60-review-completion-bootstrap-only';
    SELECT CASE WHEN changes() <> 1 THEN abs(-9223372036854775807-1) END;
    PRAGMA user_version = 59;
    SELECT CASE WHEN (SELECT max(version) FROM schema_migrations) <> 59 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema
      WHERE name IN ('runs_review_completion_bootstrap_only','runs_kind_immutable')) <> 0 THEN abs(-9223372036854775807-1) END;
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);
    SELECT 'user_version', user_version FROM pragma_user_version;

Then, in the same `bash` that took the copy, run it. This begins by running `quiet` and `check_copy`
again: the source's digest is re-checked before the conversion, not only at the end, and the SQL never
runs against a path that is not the verified copy.

    set -euo pipefail
    quiet && check_copy || { echo "stop: the source or the copy changed since the copy was taken" >&2; exit 1; }
    sqlite3 "$COPY" < "$WORK/convert.sql"

`.dbconfig enable_trigger off` is what makes the `DELETE` possible, and it is the only thing that
does. `schema_migrations_no_delete` refuses to delete a receipt row on purpose
(`SCHEMA_MIGRATION_RECEIPT_IMMUTABLE`), and the ledger is the one table this procedure has to remove
a row from. The setting is a property of this connection alone
(`SQLITE_DBCONFIG_ENABLE_TRIGGER = 0`): no trigger is dropped or rewritten to get past it, so
`sqlite_schema` keeps every other object byte for byte, and the next connection — the v59 build's —
has every trigger back. Do not replace it with `DROP TRIGGER schema_migrations_no_delete`, and do
not widen it into a general switch for other tables. The `DELETE` names the version and the id; a
different row cannot match it, and the `changes()` guard stops anything but exactly one.

**Post-checks on the copy.** All four must hold; none is optional.

1. Every table except `schema_migrations` has the same content digest as before the transaction. The
   digest is, per table, a SHA-256 over every row's column values, each typed (NULL, integer, real,
   text with its length, blob), rows in `rowid` order — primary-key order for a `WITHOUT ROWID` table
   — for every table in `sqlite_schema` that does not start with `sqlite_`, plus `sqlite_sequence`.
   Take it from the copy before the transaction and after it. A count of rows is not a digest.
2. `schema_migrations` differs from its pre-transaction state by the v60 row and nothing else: the
   same digest over the rows where `version <> 60` is equal, and the v60 row is gone.
3. `sqlite_schema` equals the reference, at the strength the reference allows: with the image sealed in
   this database's own rollback pair, every `(type, name, tbl_name, sql)` row; with only a fresh v59
   image, `type`, `name` and `tbl_name`, which is weaker and is reported as such.
4. `PRAGMA integrity_check` is `ok`, and `PRAGMA user_version` is `59`.

**Proving the converted copy in isolation.** Make a throwaway duplicate of the converted copy, record
the converted copy's `sha256`, and start the v59 build against the duplicate, in a throwaway home of
its own: no launchd job, no connection to the live socket, lock or `health.json`, and no network.

**This command line does not isolate the network.** `env -i HOME=… node …` changes which directory
the daemon uses and which variables it sees. It does not stop it opening a connection, and it does
not stop it reaching a credential held outside `HOME`, such as the login Keychain. So the start proof
runs with no network access at all: under a no-network sandbox profile, as below (on macOS,
`sandbox-exec` with `(deny network*)` and a local unix-socket allow for the duplicate's directory),
or on a host with networking disabled. Without one of those, do not run it.

The duplicate's state directory, `<throwaway home>/.agent-control-plane`, holds exactly this and
nothing else from the live one:

- the duplicate database as `state.sqlite`, mode 0600;
- a throwaway GitHub App credential in `credentials/`, which the start gate requires to exist. The
  gate (`judgeStartBeforeOpening`, `src/daemon/start-gate.ts`) asks the credential store whether the
  App env file and the private key it names are usable, before it opens any database. What it
  checks (`TrustedCredentialStore`, `src/github/credential-store.ts`) is shape and presence: both
  files are regular, non-symlink files owned by the daemon's user with mode 0600, the env file gives
  a numeric `GITHUB_APP_ID`, a numeric `GITHUB_APP_INSTALLATION_ID` and a `GITHUB_APP_PRIVATE_KEY_PATH`,
  and the key at that path parses as a private key. It makes no call to GitHub and does not check
  that the App exists. So the proof does not need the deployment's credential and must not have it:
  generate a key and made-up IDs for this run. Never copy the deployment's `github-app.env` or key,
  and never one that works against GitHub. The env file the deployment holds names an absolute key
  path in the live directory, which is one more reason not to copy it. A later start step that needs
  a working installation token cannot succeed here, by design; report it as a finding about the
  proof, not as a reason to use the real credential.

Make the throwaway home, the duplicate, the credential and the throwaway temp directory, in the
same shell as the copy block (it needs `$WORK` and `$COPY`). `mktemp` gives a fresh, short path: the
operator socket is `$DUP_HOME/.agent-control-plane/agentcpd.operator.sock`, and macOS caps a unix
socket path at 104 bytes, so a throwaway home inside `$WORK` is too long. The block saves the
variables to `$WORK/env`, so that if a later block stops and the shell closes, a new shell can
`. <work directory>/env` and carry on from the block that stopped:

    set -euo pipefail
    umask 077
    DUP_HOME="$(realpath "$(mktemp -d /tmp/acp-v59.XXXXXX)")"
    V59_ROOT=/absolute/path/to/the/v59/build
    DUP="$DUP_HOME/.agent-control-plane"
    mkdir -m 700 "$DUP"
    cp "$COPY" "$DUP/state.sqlite"; chmod 600 "$DUP/state.sqlite"
    cmp "$COPY" "$DUP/state.sqlite"
    shasum -a 256 < "$COPY" > "$WORK/converted.sha256"
    printf 'WORK=%q\nCOPY=%q\nDUP_HOME=%q\nV59_ROOT=%q\nDUP=%q\n' \
      "$WORK" "$COPY" "$DUP_HOME" "$V59_ROOT" "$DUP" > "$WORK/env"
    mkdir -p "$DUP/credentials" "$DUP_HOME/tmp"
    openssl genrsa -out "$DUP/credentials/github-app.pem" 2048
    printf '%s\n' 'GITHUB_APP_ID=1' 'GITHUB_APP_INSTALLATION_ID=1' \
      "GITHUB_APP_PRIVATE_KEY_PATH=$DUP/credentials/github-app.pem" > "$DUP/credentials/github-app.env"
    chmod 700 "$DUP" "$DUP/credentials" "$DUP_HOME/tmp"

A start without that credential is refused by the gate with `TRUSTED_GATE_CREDENTIAL_MISSING`. The
refusal happens before the database is opened and leaves a `crash-loop.json` backoff record in the
duplicate's state directory. A refusal before the open is a defect in the duplicate's setup, not a
data difference: the start block stops and closes the shell; in a new shell `. <work directory>/env`,
discard that duplicate and its `crash-loop.json`, fix the setup, rerun the block above to make a new
duplicate from the converted copy, and retry. It says nothing about the converted copy.

**Pointing the daemon at the duplicate.** The daemon finds its state directory through `HOME` and
nothing else: `agentcpd` takes `defaultConfig()`, and that is `homedir()/.agent-control-plane`
(`src/app/control-plane.ts`, `src/daemon/agentcpd.ts`). `ACP_STATE_DIR` has **no effect on the
daemon**; only `agentctl` reads it (`src/cli/agentctl.ts`). So the duplicate is started with
`HOME=<throwaway home>`, where `<throwaway home>/.agent-control-plane` **is** the duplicate directory
holding `state.sqlite` and `credentials/`. A daemon started without that `HOME` override opens the
live state directory — its lock, `crash-loop.json` and `health.json` — whatever else was set.

The start reads these, and `env -i` drops every one it is not given:

- `ACP_OPERATOR_TOKEN`, and a separate `ACP_MCP_TOKEN` that must not equal it
  (`src/daemon/agentcpd.ts`). Throwaway values generated for this run, kept in 0600 files in the work
  directory and never printed, never the deployment's.
- `ACP_OPERATOR_ACTOR`: the account name the daemon gives its operator peer (`cli:<name>`). It reads
  `ACP_OPERATOR_ACTOR` and, only if that is empty, `USER`, and refuses to start with "ACP_OPERATOR_ACTOR
  or USER is required to establish the operator peer identity" when neither is set — which is what
  `env -i` leaves. Use the operator's own account name (`id -un`). The name does not have to match
  anything else for this proof: `agentctl` presents only the token, and the daemon assigns the
  identity bound to it, so `agentctl daemon status` needs no actor and no `USER`.
- `TMPDIR`, as `<throwaway home>/tmp`, mode 0700, created beforehand. `env -i` drops it and
  `os.tmpdir()` falls back to the shared `/tmp`. The start gate copies the database into a private
  snapshot under the temp directory (`src/db/database-snapshot.ts`, `acp-db-snapshot-*`) before it
  opens it, and the daemon creates its runtime scratch there too
  (`src/continuity/continuity-kernel.ts`); both must stay inside the throwaway home, and a
  sandbox that denies `/tmp` otherwise refuses the start as `START_GATE_DATABASE_UNREADABLE`.
  `agentctl daemon status` does not use the temp directory and does not need it.
- `HOME` and `PATH`.

Everything else the daemon reads is optional or defaults to the duplicate's own state directory, and
is left unset on purpose: `ACP_GITHUB_APP_ENV_FILE` and `ACP_GITHUB_APP_PRIVATE_KEY_PATH` default to
`credentials/github-app.env` in the state directory (an inherited override would send the gate to
the live credential); the Buzz, Telegram and Hermes variables leave those routes unconfigured,
which the start reports and continues; `ACP_CLAUDE_BINARY` and `ACP_CODEX_BINARY` unset gives at
most a provider finding that does not block the start; `LANG`, `LC_ALL`, `SHELL`, `DEVELOPER_DIR`,
`GNUPGHOME`, `SSH_AUTH_SOCK` and the proxy variables are read only for optional behaviour or carry a
default; `ACP_DAEMON_SUPERVISOR` only changes the exit code of a refused start; `ACP_STATE_DIR` is
ignored by the daemon, as above. Nothing in `src/` reads an `XDG_*` variable.

Before the start, check what it would touch, and refuse on anything outside the throwaway home.
`V59_ROOT` is the v59 build, `DUP_HOME` the throwaway home, both set by the block above:

    set -euo pipefail
    LIVE="$HOME/.agent-control-plane"
    stop() { echo "stop: $1; variables are in $WORK/env" >&2; exit 1; }
    within() { case "$(realpath "$2")/" in "$(realpath "$1")"/*) return 0 ;; *) return 1 ;; esac; }
    ! within "$DUP_HOME" "$LIVE" || stop "the throwaway home contains the live state directory"
    ! within "$DUP_HOME" "$WORK" || stop "the throwaway home contains the work directory"
    ! within "$LIVE" "$DUP_HOME" || stop "the throwaway home is inside the live state directory"
    SOCK="$(realpath "$DUP")/agentcpd.operator.sock"
    [ "${#SOCK}" -lt 104 ] || stop "the operator socket path is ${#SOCK} bytes; macOS allows at most 103"
    cmp "$COPY" "$DUP/state.sqlite" || stop "the duplicate is not the converted copy"
    RESOLVED="$(env -i HOME="$DUP_HOME" PATH="$PATH" node --input-type=module -e \
      'const { defaultConfig } = await import(process.argv[1]); console.log(defaultConfig().databasePath)' \
      "$V59_ROOT/dist/app/control-plane.js")"
    echo "the daemon would open: $RESOLVED"
    [ "$(realpath "$(dirname "$RESOLVED")")" = "$(realpath "$DUP")" ] || stop "that is not the duplicate"
    [ "$(realpath "$(dirname "$RESOLVED")")" != "$(realpath "$LIVE")" ] || stop "that is the live state directory"
    within "$DUP_HOME" "$DUP_HOME/tmp" || stop "TMPDIR is outside the throwaway home"
    [ "$(stat -f %Lp "$DUP_HOME/tmp")" = 700 ] || stop "TMPDIR is not mode 700"
    ENV_FILE="$DUP/credentials/github-app.env"
    KEY_PATH="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?GITHUB_APP_PRIVATE_KEY_PATH=//p' "$ENV_FILE" \
      | tail -n 1 | sed -E "s/^[\"']//; s/[\"']\$//")"
    [ -n "$KEY_PATH" ] || stop "the env file names no private key path"
    for f in "$ENV_FILE" "$KEY_PATH" "$DUP"/credentials/*; do
      [ ! -L "$f" ] || stop "$f is a symbolic link"
      within "$DUP" "$f" || stop "$f is outside $DUP"
    done

That check resolves the key path the env file names and every file in `credentials/` and refuses
anything that lands outside the duplicate's own directory, which is what stops an env file copied
from the deployment from pointing the gate at the live key.

The no-network sandbox profile, for the duplicate's directory (macOS `sandbox-exec`; the profile also
fences writes to the throwaway home). Write it with `printf`, not a heredoc:

    DUP_HOME_REAL="$(realpath "$DUP_HOME")"
    printf '%s\n' '(version 1)' '(allow default)' '(deny network*)' \
      "(deny file-write* (require-not (require-any (subpath \"$DUP_HOME_REAL\") (literal \"/dev/null\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\"))))" \
      "(allow network-bind network-inbound network-outbound (local unix-socket (subpath \"$DUP_HOME_REAL\")))" \
      "(allow network-outbound (remote unix-socket (subpath \"$DUP_HOME_REAL\")))" > "$WORK/nonet.sb"

Then start the daemon in the background from this same shell, so that its pid and the token files are
at hand, and ask it with `agentctl` from the same shell. The tokens are read from the files and are
never printed:

    set -euo pipefail
    umask 077
    uuidgen > "$WORK/operator.token"; uuidgen > "$WORK/mcp.token"
    : > "$WORK/daemon.out"; : > "$WORK/daemon.err"
    sandbox-exec -f "$WORK/nonet.sb" env -i HOME="$DUP_HOME" PATH="$PATH" TMPDIR="$DUP_HOME/tmp" \
      ACP_OPERATOR_ACTOR="$(id -un)" ACP_OPERATOR_TOKEN="$(cat "$WORK/operator.token")" \
      ACP_MCP_TOKEN="$(cat "$WORK/mcp.token")" \
      node "$V59_ROOT/dist/daemon/agentcpd.js" > "$WORK/daemon.out" 2> "$WORK/daemon.err" < /dev/null &
    DAEMON_PID=$!
    echo "$DAEMON_PID" > "$WORK/daemon.pid"
    abort() { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true
      echo "stop: $1; see $WORK/daemon.err; variables are in $WORK/env" >&2; exit 1; }
    for i in $(seq 1 120); do
      kill -0 "$DAEMON_PID" 2>/dev/null || abort "the daemon exited"
      grep -q '"started"' "$WORK/daemon.out" && break
      sleep 1
    done
    grep -q '"started"' "$WORK/daemon.out" || abort "no started report after 120 seconds"
    sandbox-exec -f "$WORK/nonet.sb" env -i HOME="$DUP_HOME" PATH="$PATH" \
      ACP_STATE_DIR="$DUP_HOME/.agent-control-plane" ACP_OPERATOR_TOKEN="$(cat "$WORK/operator.token")" \
      node "$V59_ROOT/dist/cli/agentctl.js" daemon status > "$WORK/daemon-status.json" \
      || abort "agentctl daemon status failed"
    node -e 'const fs = require("node:fs"); const [status, health] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
      if (status.mode !== "NORMAL" || health.mode !== "NORMAL") { console.error(`not ready: daemon status mode ${status.mode}, health.json mode ${health.mode}`); process.exit(1); }
      console.log("ready: mode NORMAL")' "$WORK/daemon-status.json" "$DUP/health.json" || abort "not ready"
    # Stop it cleanly, then run the post-start check below on the duplicate.
    kill -TERM "$DAEMON_PID"; wait "$DAEMON_PID" || true

For `agentctl`, `ACP_STATE_DIR` must name the duplicate and `ACP_OPERATOR_SOCKET` must be unset: when
it is set it overrides `ACP_STATE_DIR` (`src/cli/agentctl.ts`) and the CLI would talk to whatever
socket it names, which on a deployed host is the live one. `env -i` leaves it unset. The token has to
be the daemon's: with a wrong or missing token `agentctl daemon status` does not fail. It falls back
to an offline reading of the lock file, exits 0, and carries no `mode` at all. That is why the token
comes from the file the daemon was started with, in the same shell, and why an offline reading is not
ready.

Ready is the product's own answer, all three of these together, and the block above requires them:

- the daemon's stdout carries the `{ "started": … }` report, which it prints only after the last
  startup step that can still refuse the start;
- `health.json` in the duplicate's state directory says `"mode": "NORMAL"`, not `BOOTSTRAP`;
- the operator socket answers `agentctl daemon status` and the answer reports `mode` `NORMAL`. An
  offline reading — no `mode`, `daemonStatus` carrying a refusal reason — is NOT ready.

A `health.json` with a new `pid` and `startedAt` is not enough on its own: the daemon writes both
before it decides whether to run, park in `BOOTSTRAP` or refuse. A start that
parks, refuses or exits is not ready, whatever `health.json` shows.

The duplicate is the one that starts, so the converted copy stays exactly the bytes the post-checks
were taken on. After the start, stop the duplicate cleanly and run the check below against it.

**Known benign differences, and the post-start check.** A v59 start and stop is not a read-only
act. It refreshes `repositories.last_observed_at` — normal observation, not a data change — and it
appends rows to `audit_events`, `capacity_snapshots` and `telemetry_metrics`, and it moves the
matching `sqlite_sequence` counters. The appended `audit_events` rows are whatever this start and
stop writes — runtime observed, capacity and role probes, the doctor report, the notification
attempt journal's start, started, stopped, drained, and others, which vary with the build and its
configuration. Those kinds are examples, not a list to check against: the rule is appends to the
table, not a set of event kinds. Compare the duplicate with the converted copy row by row, not by
table digest, because a table that was appended to no longer has the same digest. The check holds
only if all four of these do:

1. No row that exists in the converted copy is missing from the duplicate.
2. No row that exists in the converted copy has changed, except the `last_observed_at` column of
   `repositories`.
3. New rows appear only in `audit_events`, `capacity_snapshots` and `telemetry_metrics`, and the only
   `sqlite_sequence` changes are those tables' counters rising.
4. `sqlite_schema` is still equal, row for row, to the converted copy's, `user_version` is 59 and
   `integrity_check` is `ok`.

Anything else — a missing or changed row, a new row in any other table, another `repositories`
column changing, a counter for any other table moving — is a stop.

**Installing the converted copy.** After the conversion and the isolated start proof, the copy is
installed with the supported replacement-database path; `deploy/README.md` ("replacement database")
has the flags and the checks. In order:

1. Keep the daemon stopped until the rollback returns. The coordinator cannot hold `agentcpd.lock`
   across the restore, and a write to the live database after the conversion makes the rollback refuse.
2. The P59 pair must have been sealed before the migration, and the retired approval for the
   migration must still be kept; a missing approval refuses.
3. `state-admin backup --database <converted copy> --output IMAGE`.
4. `node dist/deploy/rollback-pair.js record-replacement <the validate identity flags, with
   --pair-id <P59>> --source <live db> --image IMAGE`. It requires the source to be quiescent and writes
   `IMAGE.source.json`.
5. `deploy/install-launchd.sh rollback --pair-id <P59> … --replacement-database IMAGE`, from a checkout
   built with the replacement check (`rollback-pair validate … --replacement-database IMAGE` first).

A database-only `state-admin restore` must not be used: it leaves a v59 database under a v60 runtime.
Record the source's `sha256` once more at the end; it must equal the value taken at the start. Keep
the verified converted copy, its `source.sha256.before` and `copy.sha256.before-convert`, the digests,
`IMAGE.source.json` and every output of the checks, and do not delete the evidence.

**Stopping rules.**

- Any unexpected schema or data difference — a guard, a post-check, or the start proof — means stop.
  Keep the copy, the digests and every output exactly as they are, and report them.
- Never delete or alter a row, a trigger or a ledger entry to make a check pass. A check that
  passes after being edited around has stopped being a check.
- Never run the SQL against the live file, and never against a copy that has been started or was not
  made by the `.backup` above.
- If any step fails midway, discard nothing: the source is untouched by construction, so the whole
  procedure can be run again from a new copy, and the failed copy is the evidence.

### Restore a stopped v61 database to v60 (single path, 61→60 only)

This is the one way to turn a schema v61 (repository rename) database into a v60 one that keeps the data
written under v61. It is the 60→59 procedure above applied to one other version pair, and it is its own
procedure, rehearsed on its own (`tests/unit/rollback-pair.test.ts`, "a v61 database returns to v60"). It
produces and verifies a converted copy; the copy is installed with the same replacement-database path, under
a P60 pair. Nothing in `src/` runs it.

**A recorded rename stops it.** v61 adds `repository_identity_renames`, and a row there is the only record
that links the receipts, verification results and allocation written under a repository's old name to the
name it holds now. Dropping the table would discard that record, so the conversion refuses, before it writes
anything, when the table holds any row. Once a rename has been applied, recovery is forward-only on v61:

1. Run the same `agentctl project rename-repository <project> <owner/name> --apply` again. It converges: the
   ACP record is already written (`ALREADY_RENAMED`), and it sets any local clone's `origin` that still names
   the old URL.
2. If the v61 state itself has to go back, restore a v61 image taken before the rename, under the v61
   build: a P61 pair sealed before the rename (`install-launchd.sh rollback --pair-id <P61> …`), or a
   `state-admin backup` taken at v61 before the rename, restored with the daemon stopped. Either discards
   everything written after it, and neither touches GitHub: the repository keeps its new name there, so the
   restored ACP holds the old name again and its GitHub calls fail until the rename is applied again. There
   is no combined GitHub-and-ACP rollback.

Before applying a rename, seal a P61 pair, so that the second way exists.

**What it applies to.** The source is a database at `user_version` 61 whose `schema_migrations` holds the v61
row exactly — `version = 61`, `migration_id = 'v61-repository-identity-rename'`,
`checksum = 'sha256:84bcf4d0932936943e591e35f7648a540112046afa5661ac3d07f9db545bde4c'` — with no rename
recorded. The target is the v60 build pinned in the P60 pair sealed before the 60→61 migration. A database
created at v61 rather than migrated to it carries `bootstrap-v61` and is refused; so is every other version
pair.

**Preconditions, and the copy.** Exactly as in the 60→59 section: the daemon stopped and the lock free, no
`state.sqlite-journal`, an empty or absent `state.sqlite-wal`, the source digest recorded at the start and
checked again around the copy, and an immutable `.backup` into a new work directory. Run that block as it
stands, with `downgrade-61-60` in place of `downgrade-60-59` in the work directory's name, and keep the same
`bash` for the steps below.

**The reference.** The P60 pair's sealed image, `<pairs root>/<P60>/database/state.sqlite`, taken before the
60→61 migration. It is also where the v60 manifest-pointer guard comes from: v61 replaced
`projects_active_manifest_moves_by_grant`, and the v60 text a database holds depends on how it reached v60,
so the conversion puts back the text the pair's own image holds and no other. Read it out, in the same `bash`:

<!-- owner-actions:v61-to-v60-guard-text:start -->
    set -euo pipefail
    PAIR_IMAGE="${PAIR_IMAGE:?name the P60 pair image: <pairs root>/<P60>/database/state.sqlite}"
    [ -f "$PAIR_IMAGE" ] && [ ! -L "$PAIR_IMAGE" ] || { echo "the pair image is not a regular, non-symlink file" >&2; exit 1; }
    [ "$(sqlite3 "file:$PAIR_IMAGE?immutable=1" 'PRAGMA user_version')" = 60 ] || { echo "the pair image is not at v60" >&2; exit 1; }
    sqlite3 "file:$PAIR_IMAGE?immutable=1" \
      "SELECT sql || ';' FROM sqlite_schema WHERE type = 'trigger' AND name = 'projects_active_manifest_moves_by_grant'" \
      > "$WORK/v60-pointer-guard.sql"
    [ "$(head -n 1 "$WORK/v60-pointer-guard.sql")" = "CREATE TRIGGER projects_active_manifest_moves_by_grant" ] \
      || { echo "the pair image holds no v60 manifest-pointer guard" >&2; exit 1; }
    ! grep -q 'repository_identity_renames' "$WORK/v60-pointer-guard.sql" \
      || { echo "the pair image's manifest-pointer guard is not v60's" >&2; exit 1; }
<!-- owner-actions:v61-to-v60-guard-text:end -->

**Guards, checked on the copy, before anything is changed.** Any one failing stops the procedure; nothing is
repaired to make one pass. The SQL below checks each of them first, inside its transaction, and `.bail on`
ends it there with the copy unchanged:

- `PRAGMA user_version` is not `61`; the v61 ledger row is absent, repeated, or carries another id or checksum;
  `max(version)` is not 61.
- `repository_identity_renames` holds any row — the refusal above.
- The v61 objects are not exactly the table and its four guards, or the manifest-pointer guard is not v61's.
- `PRAGMA integrity_check` is anything but `ok` (run it first, as in the 60→59 section).

**The steps.** One transaction, on the copy, from the work directory (the SQL reads `v60-pointer-guard.sql`
from there). Write it to `$WORK/convert.sql` as in the 60→59 section, then run
`quiet && check_copy && cd "$WORK" && sqlite3 "$COPY" < convert.sql`:

<!-- owner-actions:v61-to-v60-convert:start -->
    .bail on
    .dbconfig enable_trigger off
    BEGIN IMMEDIATE;
    -- Each guard raises "integer overflow" when its condition holds; .bail on then stops the shell and the
    -- open transaction is rolled back when the connection closes. Nothing is written before the last guard.
    SELECT CASE WHEN (SELECT user_version FROM pragma_user_version) <> 61 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM schema_migrations WHERE version = 61
      AND migration_id = 'v61-repository-identity-rename'
      AND checksum = 'sha256:84bcf4d0932936943e591e35f7648a540112046afa5661ac3d07f9db545bde4c') <> 1 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT max(version) FROM schema_migrations) <> 61 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'repository_identity_renames') <> 1
      THEN abs(-9223372036854775807-1) END;
    -- A recorded rename: dropping the table would discard it. Recovery is forward-only on v61.
    SELECT CASE WHEN (SELECT count(*) FROM repository_identity_renames) <> 0 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'repository_identity_renames'
      AND name IN ('repository_identity_renames_no_replace', 'repository_identity_renames_names_the_current_repository',
                   'repository_identity_renames_immutable', 'repository_identity_renames_no_delete')) <> 4
      OR (SELECT count(*) FROM sqlite_schema WHERE tbl_name = 'repository_identity_renames' AND name NOT LIKE 'sqlite_autoindex%') <> 5
      THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND name = 'projects_active_manifest_moves_by_grant'
      AND tbl_name = 'projects' AND sql LIKE '%repository_identity_renames%') <> 1 THEN abs(-9223372036854775807-1) END;
    DROP TRIGGER projects_active_manifest_moves_by_grant;
    .read v60-pointer-guard.sql
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND name = 'projects_active_manifest_moves_by_grant'
      AND tbl_name = 'projects' AND sql NOT LIKE '%repository_identity_renames%') <> 1 THEN abs(-9223372036854775807-1) END;
    DROP TRIGGER repository_identity_renames_no_replace;
    DROP TRIGGER repository_identity_renames_names_the_current_repository;
    DROP TRIGGER repository_identity_renames_immutable;
    DROP TRIGGER repository_identity_renames_no_delete;
    DROP TABLE repository_identity_renames;
    DELETE FROM schema_migrations WHERE version = 61 AND migration_id = 'v61-repository-identity-rename';
    SELECT CASE WHEN changes() <> 1 THEN abs(-9223372036854775807-1) END;
    PRAGMA user_version = 60;
    SELECT CASE WHEN (SELECT max(version) FROM schema_migrations) <> 60 THEN abs(-9223372036854775807-1) END;
    SELECT CASE WHEN (SELECT count(*) FROM sqlite_schema
      WHERE tbl_name = 'repository_identity_renames' OR sql LIKE '%repository_identity_renames%') <> 0 THEN abs(-9223372036854775807-1) END;
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);
    SELECT 'user_version', user_version FROM pragma_user_version;
<!-- owner-actions:v61-to-v60-convert:end -->

`.dbconfig enable_trigger off` is there for the one `DELETE` from `schema_migrations`, exactly as in the 60→59
section, and is a property of this connection only. The rename table's guards go with the table.

**Post-checks on the copy.** All must hold:

1. Every table except `schema_migrations` and the dropped `repository_identity_renames` has the content digest
   (defined in the 60→59 section) it had before the transaction.
2. `schema_migrations` differs from its pre-transaction state by the v61 row and nothing else.
3. `sqlite_schema` equals the P60 pair image's, every `(type, name, tbl_name, sql)` row. `record-replacement`
   below checks this again and refuses a copy that differs.
4. `PRAGMA integrity_check` is `ok`, and `PRAGMA user_version` is `60`.

**Proving the converted copy in isolation, and installing it.** As in the 60→59 section, with the v60 build
(`V60_ROOT`, the build pinned in the P60 pair) in place of the v59 build and a v60 duplicate in place of the v59
one; the ready rule and the post-start check are the same. Then install it with the replacement-database path,
the daemon kept stopped throughout:

1. `state-admin backup --database <converted copy> --output IMAGE`.
2. `node dist/deploy/rollback-pair.js record-replacement <the validate identity flags, with --pair-id <P60>>
   --source <live db> --image IMAGE`, from the v61 build. It replays the retired 60→61 approval on IMAGE and
   requires the result to equal the live v61 database: IMAGE must be exactly the live database minus v61.
3. `deploy/install-launchd.sh rollback --pair-id <P60> … --replacement-database IMAGE`, after
   `rollback-pair validate … --replacement-database IMAGE`.

The P60 pair must have been sealed before the 60→61 migration and the retired approval kept. The stopping
rules of the 60→59 section apply unchanged.

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
