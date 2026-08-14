# Owner actions — prepared up to the line

Three items need the owner. Each is prepared as far as it can be without them; what remains is
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

Nowhere — as of `9e970f2` the launcher derives it:

    export ACP_CLAUDE_REVIEWER_CONFIG_DIR="${ACP_CLAUDE_REVIEWER_CONFIG_DIR:-$ACP_STATE_DIR/reviewer/claude}"

So authenticating into the path above is sufficient; the daemon already looks there. An
explicit `ACP_CLAUDE_REVIEWER_CONFIG_DIR` in the launchd environment still wins if the scope
must live elsewhere.

Before `9e970f2` the launcher exported neither variable, so setting it in a shell had no
effect. If the daemon is running from an older launcher, reinstall it first:

    bash deploy/install-launchd.sh install --app-root "$PWD" --node "$(command -v node)"

### Verification — exits 0 when done

    test -s "$HOME/.agent-control-plane/reviewer/claude/.credentials.json" \
      && grep -q 'ACP_CLAUDE_REVIEWER_CONFIG_DIR' "$HOME/.agent-control-plane/agentcpd-launch.sh" \
      && echo "reviewer credential scope ready"

The real proof is a lifecycle that gets past the reviewer. That is longer and can be run once
the above passes:

    ACP_COMPONENT_INTEGRATION=1 pnpm test:e2e

It currently stops at `EVIDENCE_MISSING`; success is any stage beyond it.

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
