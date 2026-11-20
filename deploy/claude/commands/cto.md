---
description: List, add, relaunch, refresh or retire an ACP project CTO with agentctl cto (a dry run unless --apply)
argument-hint: list | add <project> [--repo <owner/name>] [--canonical] | relaunch <project> | refresh <project> | retire <project> --reason <text> [--delete-repo --yes-delete-repo <owner/name>] [--apply]
allowed-tools: Bash
---
Operator only: install this where the operator works, never where a project CTO runs.
ACP has no operator MCP surface, so this command file calls the CLI instead of an MCP tool.

Run this one command with Bash, exactly once, and show the owner its JSON lines as they are. Add no steps of your own,
and never print the token.

```sh
ACP_OPERATOR_TOKEN="$(security find-generic-password -s com.agentcontrolplane.agentcpd -a ACP_OPERATOR_TOKEN -w)" \
  "$HOME/.agent-control-plane/current/dist/bin/node" "$HOME/.agent-control-plane/current/dist/cli/agentctl.js" cto $ARGUMENTS
```

Without `--apply` it prints the plan and changes nothing. Pass `--apply` only when the owner asked for it. A run that
stops prints the step it stopped at and the command that continues it. `agentctl cto help` lists the arguments.
