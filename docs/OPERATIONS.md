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

The status command reports the local daemon lock and configured database path. It does not
prove the daemon is healthy, the external integrations are connected, or that a deployment
has satisfied acceptance.

## Foreground daemon experiment

`agentcpd` needs an MCP token before it exposes its local authenticated sockets. For a
disposable local experiment:

```bash
export ACP_MCP_TOKEN="$(openssl rand -hex 32)"
node dist/daemon/agentcpd.js
```

The default local state root is `~/.agent-control-plane`, including the SQLite state,
worktrees, capacity records, and secrets directory. Treat it as sensitive local state; do
not place it in a project checkout or commit it.

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
