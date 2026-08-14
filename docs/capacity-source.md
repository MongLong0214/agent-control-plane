# Provider capacity source

Capacity is normally observed from each provider CLI's interactive `/usage` surface. A
reading becomes routable only when the collector has captured a fresh provider response
containing an explicit remaining-quota percentage.

On hosts where that surface cannot expose quota non-interactively, an authenticated
operator may record what they have just read themselves with `agentctl capacity observe`.
This is an expiring observation, not a return to an owner-maintained quota file: the daemon
records the authenticated actor, the fixed CLI surface name, the supplied observation time,
and the reading through the same capacity enrichment and persistence path as a collector.

## Collection contract

Each collector refresh starts a fresh pseudo-terminal session, enters the CLI, sends
`/usage`, and parses only stable quota-window statements. The raw terminal output is not
persisted; its SHA-256 digest is retained in the reading source for audit correlation.

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

The parser accepts an explicit shape such as a named usage window plus an explicit
remaining percentage and reset horizon. A token-activity chart, plan label, or bare
percentage is not a quota measurement and is rejected rather than guessed. A usable
percentage with no machine-readable reset keeps `resetAt: null`; the worker reserve then
protects that window until a real reset horizon is observed.

## Operator observation contract

Use the daemon-owned command only after reading the provider's own usage surface:

```text
agentctl capacity observe <provider> '<observation-json>'
```

The JSON must contain the provider-reported `observedAt` and non-empty `buckets`. Each
bucket needs its provider window `id`, the reported `remainingPercent`, `resetAt` (or
`null` when the provider did not expose one), and the capabilities constrained by that
window. The daemon derives, rather than accepts from JSON:

- `actor` from the authenticated operator socket binding;
- `source` as `agentctl capacity observe`;
- `runtimeHealth` from the registered adapter's liveness probe.

The value is refused without both actor and source provenance, or with malformed timestamps
or buckets. A runtime found unavailable is recorded as non-routable rather than treated as
quota proof. A structurally valid observation uses a `HEALTHY` sensor reading; admission
still applies the ordinary remaining-quota, capability, runtime-health, reserve, and
staleness checks.

An operator observation is labelled `STALE` after the configured freshness interval
(five minutes by default) and becomes non-routable once it is older than the existing
stale-grace limit (fifteen minutes by default). It is never renewed by reading a file.

While a current operator observation is the newest reading, allocation uses that durable
reading rather than launching another `/usage` session.

A later collector refresh that **succeeds** is authoritative and replaces the observation,
including when its quota is lower — a measurement beats a recollection. A collector
**`ERROR`** does not, while the observation is still inside its stale grace. That
distinction is the whole point: an `ERROR` is the absence of a reading, not a reading, and
on a host whose `/usage` surface needs human interaction it is the answer every time. The
daemon refreshes collectors every four minutes (`Daemon.refreshCapacitySensors`, and again
through `ContinuityKernel.evaluate`), so an observation an `ERROR` could overwrite would be
erased minutes after it was recorded and nothing would ever dispatch — which is the state
#424 was filed about.

Nothing about this makes an expired observation routable. Past the stale grace the
observation suspends on its own, the `ERROR` takes over as the current reading, and the
refusal an operator sees names the collector failure rather than a stale human reading.
Each preserved refresh still records the collector's failure to telemetry and the audit log
(`collector_error_over_observation`), so a permanently broken sensor stays visible instead
of being masked by a habit of re-observing.

`agentctl capacity set` has been removed. It formerly wrote a local JSON file that live
adapters do not read, creating the appearance of a successful change with no admission
effect. Files under the daemon capacity directory are collector mirrors for doctor
inspection only; editing the old `claude.json` on this host cannot create routable capacity.

## Failure behaviour

If the PTY cannot launch, the CLI is unavailable, `/usage` needs human interaction, the
command times out, or parsing cannot find an explicit remaining-quota percentage, the
collector emits an `ERROR` reading with no buckets. The capacity monitor persists that
failure and suspends new allocation immediately. It never falls back to a prior reading or
to a local JSON value.

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
the collector refused to approve them. No installed CLI exposes remaining quota and reset
non-interactively on this host. That is a platform residual: use a provenance-bearing,
short-lived operator observation until a provider exposes an accepted machine-readable
quota surface.
