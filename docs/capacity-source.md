# Provider capacity source

Capacity is read from each provider's own account surface. A reading becomes routable only
when the collector has captured a fresh provider response containing an explicit
remaining-quota percentage.

No provider is read by driving a terminal any more. That mechanism reconstructed a rendered
frame, and four adversarial rounds on the parser produced fifteen defects, most of them
reporting *more* remaining quota than the screen stated — the direction that dispatches work
the subscription cannot pay for. Each provider is now asked for its own numbers.

Where a provider's surface cannot be reached — a credential that has expired, a CLI that
predates the command, a host that is offline — an authenticated operator may record what they
have just read themselves with `agentctl capacity observe`.
This is an expiring observation, not a return to an owner-maintained quota file: the daemon
records the authenticated actor, the fixed CLI surface name, the supplied observation time,
and the reading through the same capacity enrichment and persistence path as a collector.

## Collection contract

Each collector asks its provider once and refuses rather than guessing. Raw output is never
persisted; its SHA-256 digest is retained in the reading source for audit correlation.

| Provider | How it is read | Measured |
|---|---|---|
| Claude | `claude -p --output-format json --safe-mode --max-turns 1 "/usage"` | ~2s, `num_turns 0`, `total_cost_usd 0` |
| Codex/GPT | `codex app-server --stdio` → `account/rateLimits/read` | ~2–3s, no model turn |
| Grok | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | ~0.4s |

Two of the three are the CLI doing what it already does with the credential it already holds,
so nothing here handles a token. **Grok is the exception**, and deliberately so: `grok agent
stdio` answers `-32601` for billing and no subcommand exits with it, so there is no
CLI-mediated route. ACP borrows the subscription's bearer from the CLI's auth file for the
length of one request. It is never stored, printed or forwarded, and it does not appear in the
response body. That token expires — measured at six hours — and nothing here writes a refreshed
one back, because that file belongs to the CLI and a second writer to a credential store is a
worse problem than a stale reading. An expired credential is reported as exactly that.

The HTTP surfaces underneath the Claude and Codex commands were rejected even though they
return better-shaped data. Calling a vendor endpoint directly is the shape of metered access
whether or not it bills that way, and it would put this code in the business of refreshing
someone's subscription credential.

`Daemon.start()` bounds the whole refresh. A provider that cannot answer promptly is a
provider whose quota is unknown, which the doctor and the bootstrap park already handle —
failing to read a quota is not the same event as failing to start.

The pseudo-terminal path remains in the code, selectable by configuration, for a host whose
CLI predates these surfaces. Nothing selects it by default and nothing falls back to it on
failure: a fallback would hand a quota read to the source these replaced at exactly the moment
the safer one could not answer.

| Provider | Collector | Normalised capabilities |
|---|---|---|
| Claude (`claude`) | `ClaudeUsageCollector` | `cto`, `ceo`, `blind-review`, `worker` |
| Codex/GPT (`gpt`) | `CodexUsageCollector` | `ceo`, `blind-review`, `worker`, `luna-worker` |
| Grok (`grok`) | `GrokUsageCollector` | `adversarial-review` only |

The parenthesised value is the registered provider id, and it is what `<provider>` below
must be. `codex` is not a registered id and is refused with `CAPACITY_UNKNOWN_NOT_ROUTABLE`.

Grok is optional diversity only. It never advertises a critical continuity capability and
its absence does not degrade a required-role coverage plan.

The collectors do not answer trust prompts, permission prompts, login prompts, or reset
redemption prompts. Any such prompt is a failed observation. This prevents a capacity refresh
from gaining authority merely to obtain a number. That property is why none of these surfaces
takes a model turn: a read that can be made to think can be made to agree.

The parser accepts an explicit shape such as a named usage window plus an explicit
remaining percentage and reset horizon. A token-activity chart, plan label, or bare
percentage is not a quota measurement and is rejected rather than guessed. A usable
percentage with no machine-readable reset keeps `resetAt: null`; the worker reserve then
protects that window until a real reset horizon is observed.

## Operator observation contract

Use the daemon-owned command only after reading the provider's own usage surface:

```text
export ACP_OPERATOR_TOKEN="<the daemon's operator credential>"
agentctl capacity observe <provider> '<observation-json>'
```

`agentctl` is a socket client with no database fallback, so the command needs the daemon's
`ACP_OPERATOR_TOKEN`. Without it the request is refused with `OPERATOR_UNAUTHENTICATED`
before it opens a connection. This is the operator credential, not `ACP_MCP_TOKEN`, which
identifies no peer and is rejected here.

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
reading rather than asking the provider again — once the daemon is dispatching. A
parked daemon (below) allocates nothing, because it has not started its timers and its
continuity coordinator is deliberately uninstalled.

A later collector refresh that **succeeds** is authoritative and replaces the observation,
including when its quota is lower — a measurement beats a recollection. A collector
**`ERROR`** does not, while the observation is still inside its stale grace. That
distinction is the whole point: an `ERROR` is the absence of a reading, not a reading, and on
a host whose provider cannot be reached it is the answer every time. The
daemon refreshes collectors every four minutes (`Daemon.refreshCapacitySensors`, and again
through `ContinuityKernel.evaluate` once it is dispatching), so an observation an `ERROR`
could overwrite would be
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

## When the daemon has not started yet

The host this fallback exists for is usually the host where the daemon cannot start: with no
routable reading, every required role is uncovered, the startup doctor blocks on
`ROLE_COVERAGE_NO_VALID_COVERAGE`, and dispatch does not resume. `agentctl` reaches the
daemon only over its operator socket, so the remedy has to be reachable before the daemon is
fully up.

It is. On that block the daemon **parks** rather than exiting: it keeps its single-instance
lock, leaves its timers and continuity coordinator off, and serves a restricted socket:

```text
admitted while parked    capacity.observe   daemon.status
refused while parked     every other daemon method, with reasonCode DAEMON_BOOTSTRAP_MODE
never served here        bootstrap.hermes, refused by the socket before the daemon sees it
```

Each observation that lands re-runs the doctor. When it passes, the daemon promotes itself
in place and opens its ordinary listeners — no restart, and no crash-loop increment for the
capacity block itself.

**A successful `capacity observe` is not evidence that dispatch resumed.** The daemon derives
`runtimeHealth` from the adapter's liveness probe, so a reading can persist and still leave
the role unroutable. Ask the daemon — which, like `capacity observe`, needs the operator token:

```text
export ACP_OPERATOR_TOKEN="<the daemon's operator credential>"
agentctl daemon status
```

While parked that reports `mode: "BOOTSTRAP"`, the admitted method list, and the blocking
findings that remain. When it reports `mode: "NORMAL"` the daemon is dispatching.

Without the token the command still answers, but only from the local lock file, and it says
why under `daemonStatus`. **That answer cannot tell you whether the daemon is parked**: a
parked daemon holds its lock exactly like a running one, and the lock is read from a file
whose pid is never checked, so it can also outlive the process it names. The same fallback
appears for a wrong token — where the daemon did answer, with a refusal — and for a socket
that genuinely cannot be reached. Read the `reasonCode` beside the lock rather than the lock.

If you cannot get the token, `~/.agent-control-plane/health.json` carries the same `mode` and
`blockingFindings` the socket reports, and the daemon rewrites it on every parked re-check.

Two limits worth knowing before relying on this:

- **The park only opens for a block an observation could clear.** If any blocking finding is
  something else — a missing GitHub App credential raises `TRUSTED_GATE_CREDENTIAL_MISSING`,
  which is also blocking — the daemon takes the ordinary release-and-exit path instead. Fix
  that finding first; the capacity door would not have helped.
- **A parked daemon still re-reads its own sensors** on the capacity refresh interval, so a
  collector that recovers on its own promotes the daemon without anyone running a command.
