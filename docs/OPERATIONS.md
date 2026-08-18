# Local development and operations

This guide explains the repository's current local interfaces. It is not a statement that
the system is ready for unattended deployment; see [current status](STATUS.md) first.

## Build and verify

Install the Node version declared by [package metadata](../package.json), then run:

```bash
pnpm install
pnpm rebuild better-sqlite3
pnpm build
pnpm test
pnpm trace
node scripts/ssot-report.mjs
```

`pnpm trace` writes generated evidence under `evidence/`. Do not edit that evidence to make
a report look complete; rerun the command after changing tests or PRD mappings.

## Inspect without a project mutation

After `pnpm build`, these commands are the safest local starting point:

```bash
node dist/cli/agentctl.js help
node dist/cli/agentctl.js daemon status
```

The status command asks the daemon for its mode and health over the operator socket, which
needs `ACP_OPERATOR_TOKEN`, and falls back to the local lock file and configured database
path when the daemon does not answer — including when no token was provided to ask with. The
example above has no token, so it takes that fallback: it reports the lock and a `reasonCode`,
never `mode`. The launcher provisions the operator token for `agentcpd`, not for an operator
shell, so export it deliberately when you need to ask the daemon anything.

A lock read is weaker evidence than a socket answer in two ways: it does not check that its
pid is alive, and a parked daemon holds its lock exactly like a dispatching one. A daemon
reporting `mode: "BOOTSTRAP"` is parked and serving only the capacity door; see
[provider capacity source](capacity-source.md). `~/.agent-control-plane/health.json` carries
the same `mode` without needing the token.

None of these prove the external integrations are connected or that a deployment has
satisfied acceptance.

## Foreground daemon experiment

`agentcpd` needs an MCP token and a distinct operator credential before it exposes its local
authenticated sockets; it refuses to start without either, and refuses to start if they are
the same value. For a disposable local experiment:

```bash
export ACP_MCP_TOKEN="$(openssl rand -hex 32)"
export ACP_OPERATOR_TOKEN="$(openssl rand -hex 32)"
node dist/daemon/agentcpd.js
```

The default local state root is `~/.agent-control-plane`, including the SQLite state,
worktrees, capacity records, and secrets directory. Treat it as sensitive local state; do
not place it in a project checkout or commit it.

Packet-only blind review additionally needs the owner-provided Seatbelt profile and CONNECT
proxy under `~/.agent-control-plane/egress/`. The daemon generates a separate allowlist and
JSONL log for each reviewer invocation; it refuses blind review if that infrastructure cannot
be measured. See [reviewer egress](reviewer-egress.md) for the required files, endpoint
ownership, lifetime, and evidence record.

The intended authority model is that `agentcpd` is the only authoritative writer. The
current direct `agentctl` composition root is still tracked as an authority-boundary P0, so
do not use CLI mutation commands as a production substitute for daemon RPC. Read
[the issue](https://github.com/MongLong0214/agent-control-plane/issues/393) before using
commands beyond the inspection examples above.

## Deployment prerequisites that are not satisfied here

The checked-in launchd plist is a template, not a deployable artifact. It contains values a
deployment owner must supply, and no live installation has been accepted. Do not copy it into
`~/Library/LaunchAgents` as though it were ready; follow [the deployment work](https://github.com/MongLong0214/agent-control-plane/issues/400).

The daemon also refuses to fabricate the following configuration:

- an owner identity and owner-only decision route;
- an MCP token;
- live Buzz credentials and authenticated actor ingress configuration;
- a working Telegram ingress and owner route;
- a GitHub App credential with the required gate authority; and
- fresh provider-capacity input.

Each absent input should be treated as a non-passing operating condition, not filled with a
placeholder or a guessed default. The current tracker links are collected in [STATUS.md](STATUS.md).
