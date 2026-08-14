# Blind-review provider egress

This is the provider-only network boundary for a packet-only blind reviewer. It is not a
general manifest `network: "allowlist"` implementation. A reviewer without a working,
measured egress lease is refused with `ISOLATION_LOST`.

## Ownership and configuration

The daemon's endpoint policy lives in
[`src/runtime/provider.ts`](../src/runtime/provider.ts) as `REVIEWER_PROVIDER_ENDPOINTS`:

| Provider | Default reviewer endpoint |
| --- | --- |
| `gpt` | `api.openai.com` |
| `claude` | `api.anthropic.com` |
| `grok` | `api.x.ai` |

`ReviewerEgressConfig.providerEndpoints` can replace that map for a deployment. It must
name every provider the deployment permits to review; a missing provider does not inherit a
different provider's hosts. The daemon writes a fresh, private `allowlist.txt` containing
only the selected provider's endpoints for every isolated invocation. It never uses the
owner's static `allowlist.txt` as policy. An `ALLOW` is valid only for an exact generated
endpoint; a proxy must not expand an endpoint into a registrable-domain or subdomain policy.

`defaultConfig()` points to the owner-provided infrastructure below the daemon root
(normally `~/.agent-control-plane`):

```text
egress/reviewer.sb
egress/allowlist-proxy.py
egress/runs/
```

The profile's loopback exception and `ReviewerEgressConfig.port` must match (default
`18443`). Missing or unreadable configuration fails closed with one of:

```text
REVIEWER_EGRESS_CONFIG_MISSING
REVIEWER_EGRESS_PROFILE_MISSING | REVIEWER_EGRESS_PROFILE_UNREADABLE | REVIEWER_EGRESS_PROFILE_INVALID
REVIEWER_EGRESS_PROXY_MISSING   | REVIEWER_EGRESS_PROXY_UNREADABLE
REVIEWER_EGRESS_RUNTIME_DIR_UNAVAILABLE
REVIEWER_EGRESS_PROVIDER_ENDPOINTS_MISSING | REVIEWER_EGRESS_PROVIDER_ENDPOINTS_INVALID
REVIEWER_EGRESS_PROXY_UNREACHABLE | REVIEWER_EGRESS_PROXY_DIED
REVIEWER_EGRESS_ALLOWLIST_UNBOUND
```

## Wrapper and measurement

For every isolated reviewer the runtime makes a per-invocation composed Seatbelt profile:
the verified owner `reviewer.sb` bytes plus the generated packet's transcript, credential,
no-shell, and no-write rules. macOS rejects nested `sandbox-exec` profiles, so composition
keeps both rule sets in one profile rather than dropping either. The launched command shape
is exactly:

```text
sandbox-exec -f <private/composed-reviewer.sb> \
  env HTTPS_PROXY=http://127.0.0.1:<port> <provider-cli> ...
```

The constructed child environment retains `HOME` and `USER` for provider authentication,
passes Claude's owned `--settings` file, removes alternate `HTTP(S)_PROXY`, `ALL_PROXY`, and
`NO_PROXY` values, and retains the existing transcript/no-shell/no-write denials. The
Seatbelt profile denies remote TCP and UDP and permits only the loopback proxy port (and
local Unix sockets); changing or unsetting `HTTPS_PROXY` therefore cannot create a direct
socket route.

Before the provider CLI is permitted to attest, short-lived children run under that exact
same composed profile and prove all of the following on that invocation:

1. `CONNECT` to the selected provider endpoint receives `200` through the proxy.
2. `CONNECT` to a real public endpoint outside that invocation's allowlist (normally another
   provider API) receives `403` and a proxy `DENY`. A `.invalid` name is not attestation
   evidence because DNS can reject it without the proxy applying the generated policy.
3. Raw direct sockets to the provider endpoint fail with `EPERM` or `EACCES` both after
   removing `HTTPS_PROXY` and after overriding it.

Transcript, shell, and write probes run before these egress probes. Any unavailable profile,
proxy, log, probe, or expected denial produces `ISOLATION_LOST`; `isolationAttested` is not
set from configuration, a cached health result, or a successful profile parse.

## Proxy lifetime

The daemon process serializes leases for the fixed loopback port. A lease creates a private
`runs/reviewer-egress-*` directory, writes a mode-0600 generated allowlist and JSONL target,
and computes `sha256:<hex>` over the exact allowlist bytes. It starts the owner proxy in its
own process group and requires its `START` JSONL record to include that same value as
`allowlistDigest`, calculated by reading the allowlist path passed on the command line. A
missing or mismatched digest is `REVIEWER_EGRESS_ALLOWLIST_UNBOUND`, hence
`ISOLATION_LOST`; a proxy using a static or another invocation's list cannot attest.

The proxy protocol is therefore:

```json
{"t": 0, "verdict": "START", "port": 18443, "pid": 123, "allowlistDigest": "sha256:<64 lowercase hex>"}
```

The proxy is stopped after the reviewer exits (SIGTERM, then SIGKILL if necessary); the
allowlist, composed profile, log source, and lease directory are removed after the log is
copied.

The reviewer process subscribes to proxy death. If the proxy exits mid-review, the daemon
kills that reviewer's process group and returns `ISOLATION_LOST`; it never lets the answer
continue after the boundary has disappeared.

## Evidence and export

After the proxy stops, its JSONL bytes are copied verbatim into
`ReviewPacket.egressEvidence` with the provider, generated endpoints, allowlist digest, port,
phase, and the three measured probe records. The runtime and `BlindReviewGate` both reject an
`ALLOW` for any host outside the generated allowlist. The gate also compares that allowlist to
the daemon-owned provider policy, verifies the reconstructed digest and matching `START`
record, requires a controlled real-host `DENY`, and verifies both direct-socket modes. Audit
rows retain only counts and provider names, not the raw log.

The record is inside the `BLIND_REVIEW` artifact content. Its digest is the normal
snapshot-bound evidence digest:

```text
sha256(canonicalJson({ candidateSnapshotDigest, content }))
```

so changing the JSONL changes the artifact digest. Both the runtime before copying and the
artifact store before persistence reject credential-shaped content rather than redact it;
the run-evidence exporter consequently includes it only when the whole artifact remains safe
to export.
