# ADR-0009 — The owner's channel enters through the control plane, not through the CEO

- **Status:** Accepted
- **Date:** 2026-08-19
- **Drivers:** CP-HI-07 (non-delegable owner authority), §21 owner identities, §6.1 Telegram DIRECT

## Context

The deployment runs one Hermes. It is both the owner's personal assistant — technical
reading, web research, writing — and the CEO of the factory. Only the CEO half rides the
belt: assistant work is ordinary work Hermes does with its own tools, and no `RunKind`
models it (`STANDARD_WORK`, `PROJECT_BOOTSTRAP`, `CONTRACT_CHANGE` are all code work).

The owner talks to Hermes in Telegram. Today Hermes long-polls its own bot, so the control
plane never sees that conversation. That arrangement cannot carry an owner decision, and the
code says so rather than merely lacking a path:

```
owner_decision_submit → deny(OWNER_AUTHORITY_NOT_DELEGABLE,
                             "Hermes MCP cannot assert an owner decision")
repair_execute(authorizedBy: "OWNER") → the same denial
```

`admitOwnerApproval` has exactly two production call sites — `ingress/telegram.ts` and
`daemon/daemon.ts` (`admitCliOwnerApproval`). `buzz` is a channel the `IngressGuard` knows
but no owner-approval path reaches. So an owner who approves by telling Hermes has not
approved anything; the approval has to be re-entered at a terminal.

That is not a gap to be closed by trusting Hermes more. CP-HI-07 exists because an
allowlisted `{channel, actor}` pair is still caller-controlled data, and a role holder
asserting "the owner said yes" is precisely the delegation the invariant forbids.

## Decision

**The control plane owns the owner's Telegram channel. Hermes receives it from the control
plane rather than from Telegram.**

- `agentcpd` runs the long-poll listener with the deployment's existing bot token. Hermes
  stops polling. Telegram admits one `getUpdates` consumer per bot, so this is an exchange,
  not an addition — no second bot is issued.
- Commands and owner decisions are admitted by `IngressGuard` against the declared
  `telegram:` owner identity and become runs or receipts as they already do.
- Ordinary conversation (§6.1 `DIRECT`) is handed to Hermes and its reply is returned to the
  chat. The `directHandler` seam already exists and is deliberately narrow — "not a mutation
  capability" — and stays that way.
- The hand-off uses MCP **sampling** (`createMessage`) over the existing CEO socket. The
  connection is already server→client in that direction: Hermes is the MCP client and
  `agentcpd` the server, so no new transport, port, or credential is introduced. Hermes
  declares the `sampling` capability during its handshake.

## Consequences

The owner's experience is unchanged — same bot, same chat, same counterpart. What changes is
who collects the messages.

**Approval becomes possible in the chat**, because the receipt is minted by the ingress that
authenticated the update, not asserted by the role holder that read it.

**The conversation becomes control-plane state.** Both of the owner's channels now terminate
in the control plane, which is what makes one context across channels a property of the
system rather than of whichever process happened to be listening.

**#510 becomes reachable.** It asks for a live Telegram round trip through the daemon's
long-poll listener; under this decision that is the only listener there is. It was previously
unclosable without either issuing a second bot or splitting the owner's messages between two
pollers.

**Hermes gains a dependency on the control plane being up** for its Telegram surface. This is
accepted: the CEO role already requires the daemon, and a Hermes that can chat but cannot act
is not a state worth preserving separately. Buzz remains a direct path to Hermes.

**Rejected — leaving Hermes on the bot and approving over CLI.** It keeps one bot but pushes
every approval to a terminal, and leaves the conversation outside the control plane, so
neither the SSOT property nor #510 is obtained.

**Rejected — a second bot for the control plane.** It avoids the poller exchange but splits
the owner's single counterpart into two chats, which is the thing the deployment is trying
not to have.
