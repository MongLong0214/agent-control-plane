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
node scripts/ssot-report.mjs
```

## Feature verification map

Where a feature's acceptance is actually executed and what shows it. This maps existing tests and
contract fields; it adds no schema, gate or recipe, and it grants nothing: the authority stays with the
approved `TaskContract.acceptance` (read by the reviewer verbatim), the pinned manifest's
`verificationCommands` and the official verification output (read by the reviewer under "Untrusted
execution evidence"). In an ordinary candidate review, `PLAN.verificationIntent` and a task's `spec` are
not read, so a claim that matters has to be an assertion the official command prints. Bootstrap-plan
review (with the task's `spec.completionCriteria`) and contract-change review do receive the PLAN's
verification intent, as what the author says it intends, never as execution evidence.

The pattern a project's command follows, shown end to end in
[`i1422-feature-verification-pilot.test.ts`](../tests/unit/i1422-feature-verification-pilot.test.ts):
exercise the feature through its usage path, **read the state back through a separate read** (not the
call's own answer, an HTTP 200 or exit 0), print each assertion with its expected and actual values,
and name where it stopped. A candidate whose `save` answers `ok` and persists nothing passes the
call-answer check and fails the read-back, with `expected ["hello"], actual []`; the owner is handed that
output and no reviewer is invoked. The fixed candidate's output, bound to its own snapshot and contract
digests, and the command's source reach the reviewer, and the producer's claim and the earlier failure do
not. Provenance there is local sandbox execution (`source: "local"`) with a scripted reviewer.

| Feature | Acceptance to observe | Executed by (existing) | What fails it / what shows it | Limits, owner |
|---|---|---|---|---|
| Task execution and artifact submission | Worker result and receipt match the task's intent | `tasks.finishExecution` plus the receipt link; `review-receipts-and-tasks-reach-the-reviewer.test.ts` | A receipt that disagrees with its execution is reported in its row, a unit reference no task answers is listed, never mapped by title | An edit-requiring task that changed only its imports is **not** covered here: #1418. #1413 for work-unit keys |
| Candidate submission and review | The same candidate's verification reaches review; a reason review could not start is not a product verdict | the pilot above; `candidate-review-execution-evidence.test.ts`; `a-reviewer-sees-the-whole-test-run.test.ts` | `VERIFICATION_FAILED` carries the failing assertion to the owner and calls no reviewer; output is bound to snapshot, contract and head | Oversized private evidence and its attempt accounting: #1421. Images and screenshots are not retained (the disposable worktree is gone before the result is built) |
| Resubmission after correction | The correction relation and acceptance hold; earlier failures stay readable | `a-correction-supersedes-a-succeeded-task.test.ts` (#1400), `a-correction-settles-a-failed-task.test.ts` | A superseded task stays SUCCEEDED/FAILED and readable; the freeze holds the terminal alone; unrelated paths still conflict | A run with no approved work units cannot register a correction |
| Recovery during continuity | The successor takes over, a stale generation is refused, added review evidence does not pin the hold | `continuity-hold-release.test.ts` (#1420), `a-continuity-held-run-follows-its-cto-successor.test.ts` | A stale binding or a not-READY owner is refused and the hold is kept; the live run releases once | Same-host fixture runs, not a live restart |
| Approval, merge and post-merge verification | Exact candidate and merge receipt; complete only after the required post-merge checks | `tests/scenarios/finalizer.test.ts`, `approved-run-merge-failures.test.ts` | A failing post-merge check blocks the run (`BLOCKED_POST_MERGE`) with a compensation plan and no further merge; a stale base returns the run for revision | Candidate-mismatch approval refusal and generic post-merge recovery: #1181 |

What an ordinary verification command may do is set by its sandbox: child processes run under a
supervised budget, and `network=deny` blocks loopback too, so an HTTP-server-plus-browser check needs an
authorized `network=allow` contract, authorized CI or the host live probe. A host live probe is
supplementary evidence; it does not replace a pinned `LOCAL_COMMAND` or `BOTH_REQUIRED` obligation. A
command that cannot run (no driver, isolation failed, no output) is a failure or a verification gap and
is never read as PASS.

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

### Reading why a run's review repeated

`agentctl run show <runId>` (operator token, same socket) ends with `reviewRounds`, a read-only
projection of records the run already left: per candidate freeze, whether the candidate's source
changed (`SOURCE_CHANGE`), only its identity did (`CANDIDATE_IDENTITY_CHANGE`), the same judged
candidate was submitted again (`SAME_CANDIDATE_RESUBMISSION`), or nothing had judged it and it was
retried (`INFRASTRUCTURE_RETRY`). It writes nothing and no gate, reviewer packet or CEO decision reads
it. `totals.reviewerInvocations` is only the calls the records confirm and attribute to a round: a
review whose call count is unrecorded adds 0, so read it with `reviewsWithUnrecordedInvocations`,
`reviewUnavailable`, `noOutcomeRecorded`, `unattributedEvents` and `unattributedDeliveries`. It is not
a count of provider calls or tokens, and not a cost. If the projection cannot be read it says
`unavailable` and the rest of the run is still shown.

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
   `plan.requestDigest` identifies the RF compile request, independently of ACP's
   run `contractDigest`. The full manifest, inline genesis, operation id and
   repository operations must name the intended
   project and repository. The body limit is 131,072 bytes (128 KiB).
2. The CEO reviews the complete final body and computes `sha256:<lowercase hex>`
   over its exact UTF-8 bytes, including whitespace and trailing newlines. Never
   attach a temporary draft before this review.
3. On the current CEO's authenticated Hermes **owner or delegated peer turn**, call:

   ```text
   bootstrap_plan_attach({
     idempotencyKey, runId, planBody, expectedSha256,
     contractDigest, bootstrapOperationId, projectId, repositoryIdentity
   })
   ```

   Binding identifiers reject C0 control characters and DEL before any artifact,
   audit event or wake is written; this does not restrict newlines in the body.
   `planBody` is a string carrying the original file contents. MCP JSON escaping
   preserves that string; ACP never reserializes its JSON to determine the hash.
   The `contractDigest` argument must match the current run. The other binding
   arguments must match the body: `runId`, `bootstrapOperationId`, manifest project
   id, and the single manifest repository remote / GitHub operation target.
   `repositoryIdentity` is `github:<owner>/<repo>`.
   If the CEO cannot transport the body, a current PRIMARY_CTO may first call
   `bootstrap_plan_stage` with the same binding arguments and original `planBody`.
   This is a **non-authoritative candidate upload**: no provenance links that CTO
   to the project-less run, and upload grants no run authority, PLAN, approval,
   execution permission or wake. The server derives `stagedBy` from the authenticated
   current PRIMARY_CTO binding and returns `{ digest, stagedBy }`; arguments cannot
   choose another stager's identity. Candidates are immutable and append-only, with at
   most one unattached candidate per stager per run. Different bytes may be staged as
   a replacement only when a current attachment exists and every earlier candidate
   of that stager was CEO-attached (current or superseded). Replacement staging uses
   the same current-run, frozen and binding checks as replacement attach. Identical
   bytes are idempotent; a stager cannot overwrite or read another stager's candidates.

   The CEO's attach is the selection for the target run. Omit `planBody` and pass
   **`stagedBy: "PRIMARY_CTO:<projectId>"`**, all binding arguments and `expectedSha256`.
   ACP selects exactly `(runId, stagedBy, expectedSha256)` with no latest, cross-slot
   or cross-run fallback. The CEO may explicitly select any stager's valid upload.
   Candidate bytes bind to run, contract, operation, project, repository and stager,
   without an owner pin. Attach validates the **current** run owner just like inline
   attach, so a same-session owner generation renewal does not invalidate the upload.

   Peer calls require the same bound Hermes session and lineage, `cron: false`,
   `delegation_depth: 0`, and a well-formed `peer_grant`, recorded with the attachment.
   `owner_decision_submit` and `cto_suspend` remain owner-only.
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
(`acp.bootstrap-plan-input.v1`, or `acp.bootstrap-plan-candidate.v1` for inert staging)
in the existing `run_artifacts` table. Base64
preserves exact UTF-8 bytes despite canonical JSON newline normalization;
activation handoff readers exclude this subtype. No schema migration, separate
store or delivery system is added. Genesis secret screening remains at RF compile
and ACP normalization. Runs without attachments keep the existing body-based
contract/`plan_submit` flow.

The adopted CEO tool server emits one `notifications/tools/list_changed` per
connection after the client's `notifications/initialized`; `agentctl attach adopted-ceo`
forwards it to Hermes unchanged. SDK acceptance tests prove ACP's notification and
client re-list. After a deploy, Hermes's own refresh is verified from its `agent.log`
("tools changed dynamically") and the CEO's next-turn tool list.
