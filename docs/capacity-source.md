# Provider capacity source

PRD §14.2 lets a provider adapter choose the most reliable usage source available, in
this order:

1. a structured local interface
2. an official CLI or status interface
3. `/usage` parsing
4. an explicitly approved stable source

## What is actually available today

Neither shipped CLI exposes a quota interface. `claude` has no `usage` subcommand, and
`codex` has no usage or limits command. There is no local file either CLI maintains that
carries remaining-quota-per-window.

Rather than invent a parser for output that does not exist, the adapters implement
option 1: a **structured local capacity file** that the owner (or a future provider CLI,
or a small collector script) maintains. This is the honest position — §14.3 states plainly
that routing has no `UNKNOWN` quota, so a sensor that cannot read must suspend new
allocation instead of guessing.

## File location and shape

```
~/.agent-control-plane/capacity/<provider>.json
```

```json
{
  "observedAt": "2026-08-12T07:40:00.000Z",
  "runtimeHealth": "HEALTHY",
  "buckets": [
    {
      "id": "rolling-5h",
      "remainingPercent": 62,
      "resetAt": "2026-08-12T12:00:00.000Z",
      "capabilities": ["ceo", "blind-review", "luna-worker"]
    },
    {
      "id": "weekly",
      "remainingPercent": 41,
      "resetAt": "2026-08-18T00:00:00.000Z",
      "capabilities": ["luna-worker"]
    }
  ]
}
```

Write it with the CLI so the timestamp is filled in for you:

```
agentctl capacity set gpt '{"buckets":[{"id":"rolling-5h","remainingPercent":62,"capabilities":["ceo","blind-review","luna-worker"]}]}'
agentctl capacity show
```

`capabilities` is what the continuity kernel routes on. The names the kernel looks for
are `ceo`, `cto`, `blind-review`, `worker` and `luna-worker`.

## How the three signals are derived

| Signal | Source |
|---|---|
| `sensorHealth` | `HEALTHY` when the file parses and is fresh; `STALE` past the freshness window; `ERROR` when absent, unparsable, or carrying no buckets |
| `runtimeHealth` | the file's `runtimeHealth`, or a live `--version` probe of the CLI when the sensor failed |
| `allocationAdmission` | derived: `SUSPENDED` on sensor error, unavailable runtime, or a stale reading past the grace window; `CONSERVE` when the lowest bucket is at or under 25%; otherwise `OPEN` |

A stale reading remains usable inside a grace window (15 minutes by default) and suspends
new allocation past it. A failed probe suspends new allocation immediately while existing
critical sessions get their own runtime health probe — §14.3 keeps those two questions
separate on purpose.

## Adding a real usage interface later

When a provider ships one, the change is local to that adapter: add the new source ahead
of the file source in its `probeCapacity`, and add a parser fixture test (PRD §36 requires
one). Nothing above the adapter changes, because the adapter's job is exactly to hide
collection differences (§40 Maintainability).
