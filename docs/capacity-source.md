# Provider capacity source

Capacity is observed from each provider CLI's interactive `/usage` surface. It is not
an owner-maintained quota file. A reading becomes routable only when the collector has
captured a fresh provider response containing an explicit remaining-quota percentage.

## Collection contract

Each refresh starts a fresh pseudo-terminal session, enters the CLI, sends `/usage`, and
parses only stable quota-window statements. The raw terminal output is not persisted;
its SHA-256 digest is retained in the reading source for audit correlation.

| Provider | Collector | Normalised capabilities |
|---|---|---|
| Claude | `ClaudeUsageCollector` | `cto`, `ceo`, `blind-review`, `worker` |
| Codex/GPT | `CodexUsageCollector` | `ceo`, `blind-review`, `worker`, `luna-worker` |
| Grok | `GrokUsageCollector` | `adversarial-review` only |

Grok is optional diversity only. It never advertises a critical continuity capability and
its absence does not degrade a required-role coverage plan.

The collectors do not answer trust prompts, permission prompts, login prompts, or reset
redemption prompts. Any such prompt is a failed observation. This prevents a capacity
refresh from gaining authority merely to obtain a number.

The parser accepts an explicit shape such as:

```text
5-hour limit: 62% remaining — resets in 1h 15m
weekly limit: 41% left — resets at 2026-08-18T00:00:00Z
```

It normalises `observedAt`, `remainingPercent`, `resetAt`, and provider capabilities into
separate quota buckets. A token-activity chart, plan label, or bare percentage is not a
quota measurement and is rejected rather than guessed. A usable percentage with no
machine-readable reset keeps `resetAt: null`; the worker reserve then protects that window
until a real reset horizon is observed.

## Failure behaviour

If the PTY cannot launch, the CLI is unavailable, `/usage` needs human interaction, the
command times out, or parsing cannot find an explicit remaining-quota percentage, the
collector emits an `ERROR` reading with no buckets. The capacity monitor persists that
failure and suspends new allocation immediately. It never falls back to a prior reading or
to a local JSON value.

The daemon may mirror the most recent observation under its capacity directory for doctor
inspection. That mirror is an output, not an input: editing it cannot create routable
capacity.

## Deployment credential scopes

Normal provider usage may use each CLI's ordinary authentication. Packet-only blind review
has a stricter requirement: set `ACP_CODEX_REVIEWER_HOME` to a dedicated Codex home that
contains reviewer credentials but no producer session history. The reviewer process uses
that exact scope with a packet-local `HOME`; it never repurposes `~/.codex`.

`ACP_CLAUDE_REVIEWER_CONFIG_DIR` and `ACP_GROK_CREDENTIAL_DIR` are corresponding optional
deployment scopes. They are not capacity values and must not be written into manifests.

## Live limitations observed on this machine

Codex's current `/usage` command was reachable through a real PTY, but its available view
reported token activity rather than a remaining quota/reset window, so it correctly
produced no routable capacity. Claude and Grok stopped at their interactive trust prompts;
the collector refused to approve them. Those are failed observations, not reasons to reuse
a manually written file.

The collector path is real and will normalise a provider-reported quota view as soon as the
CLI exposes one in the accepted shape. Until then, capacity remains unknown and allocation
stays suspended by design.
