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

### Reading the doctor's findings

`agentctl doctor` asks the running daemon over the operator socket, and against a *live* daemon
that request does not currently complete: the client gives it 5 s (`cli/agentctl.ts`) and a pass
that runs the capacity sensors takes longer, so it comes back `OPERATOR_UNAUTHENTICATED` or
`DAEMON_LOCK_LOST` (#609). Both name something real — a handshake, a lock — which is what makes
the refusal misleading: a healthy `DEGRADED` daemon with no blocking findings reads as an unwell
one.

The daemon writes each pass to the audit log, so read it there instead:

```bash
sqlite3 ~/.agent-control-plane/state.sqlite \
  "select at, evidence_json from audit_events where kind='DOCTOR_REPORT' order by at desc limit 1;"
```

That returns the same report the daemon just computed — `status`, and each finding with its
`severity` and whether it is `blocking`. Copy `state.sqlite-wal` alongside the database if you
move it anywhere, or the most recent writes are not in what you read.

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

### Starting a client that can receive wakes

Start the Claude Code client with `--messaging-socket-path` pointing to a unique socket
directly inside the daemon's owner-only state directory, the same directory as
`cto.mcp.sock`. For the default state root, add
`--messaging-socket-path "$HOME/.agent-control-plane/cto-client.sock"` to the client launch
command; choose a distinct filename for each client. Use the directory named by the
registration refusal if this deployment uses a different state root. ACP does not choose
the client's messaging socket path.

A socket at `/tmp/cc-socks/<pid>.sock` cannot register as a wake endpoint. The directory
must remain owner-only (0700), and the endpoint must be a normalized absolute path directly
in it; symlinks and paths owned by another uid are refused. The client must also satisfy
the qualified version requirement.

The doctor currently checks role bindings and session liveness, but cannot detect this
socket-directory mismatch before registration: session records contain no messaging socket
path. The path first reaches ACP through `role_wake_endpoint_register`, and only accepted
endpoints are retained. A healthy doctor report therefore does not establish that a bound
client can receive wakes. Check the client launch command and the registration response;
the Hermes bootstrap socket is a separate channel and already lives inside the state directory.

## Deployment prerequisites that are not satisfied here

The file checked in at `deploy/com.agentcontrolplane.agentcpd.plist.template` is a template, not
a deployable artifact by itself: it contains placeholder values (`__ACP_WORKING_DIRECTORY__` and
similar) that `deploy/render-launchd-plist.mjs` fills in per host, driven by
`deploy/install-launchd.sh`. Do not copy the template file directly into
`~/Library/LaunchAgents`; render it through that script.

This is no longer a statement that no live installation exists. As of this writing, a launchd
job *is* registered at `~/Library/LaunchAgents/com.agentcontrolplane.agentcpd.plist` and a daemon
has been running from it for several days, started from a checkout of this repository that is not
current `main`. Verify the actual state of any given host directly —
`launchctl print gui/$(id -u)/com.agentcontrolplane.agentcpd`, or
`deploy/install-launchd.sh status` — rather than assuming, from this document alone, that no
reconciliation is needed. Reconciling a running deployment with a newer `main` is a distinct,
higher-stakes operation from a first install: see [Owner actions §4](ops/owner-actions.md) for
the prepared-up-to-the-line packet, including why the running daemon's database and binary
identity cannot currently be read back from anything the daemon itself exposes. The original
first-install tracker is [issue #400](https://github.com/MongLong0214/agent-control-plane/issues/400).

The daemon also refuses to fabricate the following configuration:

- an owner identity and owner-only decision route;
- an MCP token;
- live Buzz credentials and authenticated actor ingress configuration;
- a working Telegram ingress and owner route;
- a GitHub App credential with the required gate authority; and
- fresh provider-capacity input.

Each absent input should be treated as a non-passing operating condition, not filled with a
placeholder or a guessed default. The current tracker links are collected in [STATUS.md](STATUS.md).

## Supplying a compiled bootstrap PLAN

This is input delivery through the existing Hermes/CTO MCP authentication and
`run_artifacts` storage. It creates no owner approval, CONFIRM, application
reservation or permission to execute an external write.

1. Create the run, then have RF compile the final submission with that run id:
   UTF-8 JSON `{ "runId": "run_...", "plan": { ... }, "tasks": [ ... ] }`.
   Keep the resulting bytes; do not parse and reserialize the file for transport.
   `plan.requestDigest` must equal the run's `contractDigest`. The full manifest,
   inline genesis, operation id and repository operations must name the intended
   project and repository. The body limit is 131,072 bytes (128 KiB).
2. The CEO reviews the complete final body and computes `sha256:<lowercase hex>`
   over its exact UTF-8 bytes, including whitespace and trailing newlines. Never
   attach a temporary draft before this review.
3. On the current CEO's authenticated Hermes **owner turn**, call:

   ```text
   bootstrap_plan_attach({
     idempotencyKey, runId, planBody, expectedSha256,
     contractDigest, bootstrapOperationId, projectId, repositoryIdentity
   })
   ```

   `planBody` is a string carrying the original file contents. MCP JSON escaping
   preserves that string; ACP never reserializes its JSON to determine the hash.
   The binding arguments must match the run and the body: `requestDigest`,
   `bootstrapOperationId`, manifest project id, and the single manifest repository
   remote / GitHub operation target. `repositoryIdentity` is `github:<owner>/<repo>`.
4. The bound BOOTSTRAP_CTO reads `bootstrap_plan_get({ runId })`, which returns
   `{ digest, planBody }`. `digest` is the exact-byte SHA-256, and `planBody`
   decodes to the original bytes. `contract_get` also advertises this digest.
   Submit with `plan_submit({ idempotencyKey, runId, bootstrapPlanDigest: digest })`,
   omitting `plan` and `tasks`; ACP resolves both from the stored bytes.

At attach ACP compares `expectedSha256` with the exact bytes and binds them to
the run, contract, operation and target. At read it checks the immutable artifact
row's canonical digest, its attachment audit receipt, the exact bytes' SHA-256,
and the current binding context. At submit it repeats these checks and compares
`bootstrapPlanDigest` with the current input's exact-byte hash, including on a
cached mutation retry. It then uses the existing manifest/genesis normalization
and semantic digest checks. The response's `digest` is the input SHA-256;
`planDigest` is the separate canonical digest of the normalized PLAN, including
its `bootstrapPlanDigest` source binding. Neither digest is an execution approval.

Initial attachment is accepted before any PLAN exists while the run is `QUEUED`,
`ACTIVE` or `BLOCKED`. A queued run may have no owner yet; otherwise the run's
owner pin must separately match the current binding generation and incarnation.
An identical retry is idempotent, with one artifact/audit/wake. Different bytes
are refused unless replacement is explicit. Cancelled/terminal runs and stale
owners are refused, including cached attach and submit retries. Use the same
idempotency key for identical retries under the existing MCP fingerprint rules.

For a later final correction, the CEO reviews/hashes the new bytes and calls the
same attach tool with a new idempotency key and
`replacesSha256: <current input's exact-byte digest>`. Its run/contract/operation/
project/repository binding must stay the same. ACP invokes existing candidate
invalidation and artifact supersession atomically: previous input and PLAN stay
immutable but superseded; earlier candidate-bound review/approval evidence is
withdrawn. Old references and submit receipts cannot authorize the replacement.
The owner must submit the new digest and obtain fresh review and CONFIRM. A
`REVISION_REQUIRED` run still needs the ordinary CEO redispatch before submit.
Reserved/confirmed applications remain frozen under the existing guard; a
superseded input cannot be resurrected. No implicit overwrite or retarget exists.

Attaching enqueues a digest-only `RUN_DISPATCH` using the existing in-band outbox
and wake. It does not resolve an escalation. For blocked
`run_284fdfe39d4a405b9b763b10`, after deployment: inspect `run_get` for its current
owner, contract digest and open escalation; compile/review/attach as above; then
resolve that **current** escalation with a short read/submit instruction. Do not
assume historical escalation 142936 or 143182 remains open. The run must be
`ACTIVE` to submit. Independent blind review, owner approval, CEO CONFIRM, genesis
PR and exact-head CI gates continue unchanged.

Input uses a versioned `ArtifactKind.HANDOFF` envelope
(`acp.bootstrap-plan-input.v1`) in the existing `run_artifacts` table. Base64
preserves exact UTF-8 bytes despite canonical JSON newline normalization;
activation handoff readers exclude this subtype. No schema migration, separate
store or delivery system is added. Genesis secret screening remains at RF compile
and ACP normalization. Runs without attachments keep the existing body-based
contract/`plan_submit` flow.
