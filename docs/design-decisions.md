# Deliberate trade-offs

Each of these was a decision, not an oversight. They are written down so a later reviewer argues
with the reasoning rather than rediscovering the behaviour.

Moved here from the tracker (#247). A design record belongs beside the code it explains: an issue
is a thing to be closed, and these are not — they are the standing answer to "why is it like
this", and they change by being argued with rather than by being resolved.

Each carries a **revisit trigger**. A trade-off without one becomes permanent by default.

---

## 1. Sandbox read confinement is a named deny list, not a whitelist

A blanket `(deny file-read*)` plus allow-subpath profile SIGABRTs Node — `dyld` needs paths that
cannot be enumerated. So `readConfinement: "sensitive-paths"` denies specific secret locations
(`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.codex`, keychains, …) rather than claiming
full isolation.

**Revisit when** a container or VM per verification becomes available — **or when a provider CLI
needs something the deny list did not anticipate.** The second half was added after #489: codex's
in-process app-server needs the per-user temp directory writable, which the allow-default shape
turns into a decision rather than a given. That has now happened once, so it is a real trigger
and not a hypothetical.

## 2. A DEGRADED doctor does not block bootstrap activation

Blocking findings do, and any DEGRADED status forces the project's `availability` to DEGRADED so
the activation cannot claim health.

**Revisit when** a DEGRADED dimension turns out to invalidate activation facts.

## 3. A bootstrap run's CEO confirmation follows its activation

§26.3 says only the activation result completes the run, so the CEO gate requires a stored
activation result and the activation itself does not fabricate a confirmation.

**Revisit when** the PRD intends the reverse order.

## 4. Guard grants are consumed immediately before the side effect, not held across it

Consumption re-decides and requires a live claim whose lease is then extended, so a competing run
cannot take the same branch, worktree or path mid-write. A truly transactional fence around an
external API call is not possible in-process; the kernel's exact-head and payload-digest receipts
are the compensating control.

**Revisit when** the check-to-act window is shown to be exploitable in practice. Round-2 `guard#1`
argues it is still a defect and is tracked separately.

## 5. ~~Reviewer isolation is enforced by binding history and withheld inputs, not by process sandboxing~~

**Superseded.** This was accurate when written and is not now.

Reviewer isolation *is* process sandboxing today, and #360 closed on that basis:

| the trade-off said | what exists |
|---|---|
| no process sandboxing | a seatbelt profile per review, composed per run |
| — | `~/.claude` and `~/.codex` denied; the kernel refuses the read |
| "all tools disallowed" as a CLI setting | `(deny process-exec*)` plus a literal allowlist |
| — | `(deny network-outbound)` with one localhost egress port re-allowed |

The round-2 `review#8` this item pointed at — read-isolation from daemon state — is the thing that
got built rather than still argued.

What changed most is what the proof rests on. The trade-off's world was one where isolation was a
*claim in the packet*; the tests now assert what the kernel did:

```
mutation: remove the transcript roots from the profile's deny list
  → RED: "sandbox-exec allowed the read"
```

Kept rather than deleted, struck through. A superseded decision is evidence about how the system
moved, and removing it would leave the next reader wondering whether the question was ever asked.
