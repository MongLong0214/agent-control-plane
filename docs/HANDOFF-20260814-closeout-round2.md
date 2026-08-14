# Handoff — 2026-08-14, second closeout round

Written while everything below is still verified rather than remembered. Four lane branches
carry finished work that **must not be merged as-is**: every one of them came back
`DO NOT MERGE` from a blind review, and the findings were reproduced, not taken on trust.

**`main` = `8819c56`** · CI **red** on that commit (see §6, it is the trace step, not the
suite) · previous commit `effe657` was green.

Authority: `docs/review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md`
plus the owner-supplied `ACP_PRODUCTION_GATE_FINAL_A_TO_Z_REVIEW_20260814`, whose findings
are folded in below.

---

## 1. The two mistakes that shaped this round

**A local green suite proved nothing.** This machine runs `umask 077`; GitHub runners run
`umask 022`. Fixtures that created SQLite files without an explicit mode got `0600` here by
accident and `0644` there, and production correctly refuses to open those. `main` CI had
failed **five consecutive runs** while four separate local suites reported 721–738 passing.
Fixed in `effe657` by setting the mode in the fixture — never by relaxing the production
check. **Always run `(umask 022 && npx vitest run)` or read `gh run list` before claiming a
suite passes.**

**`git diff HEAD` silently dropped every untracked file.** Lanes were reconstructed from
`git diff HEAD`, which does not see new files. `tests/unit/handoff-p1-boundaries.test.ts`
(633 lines) and five telegram files vanished. This produced a false conclusion — that three
documents cited a test file that had never existed — and a doc rewrite that had to be
reverted. **Use `git status --porcelain` and copy `??` entries explicitly.**

---

## 2. Lane branches — all green locally, none mergeable

| branch | SHA | tests (`umask 022`) | verdict |
|---|---|---|---|
| `terra10/buzzcli` | `24bdb92` | 740 | blockers fixed, wants a confirming round |
| `terra10/capacityobs` | `ac32f16` | 728 | **2 BLOCKERs open** |
| `terra10/verifysec` | `2b1d709` | 745 | 2 MAJORs open |
| `terra10/telegram` | `b94f573` | 768 | **2 BLOCKERs open** |

`terra10/telegram` is stacked on `terra10/verifysec`; merging telegram carries both. Its
migration is **v17** (written against v14; v15 and v16 landed while it sat unmerged).

---

## 3. Open findings, by lane

### capacityobs — do not merge

1. **BLOCKER — the fix does not fix #424's premise.** `RunEngine.dispatch` refuses
   `SURVIVAL` at `run-engine.ts:261`, and only reaches capacity at `:311`. On this host
   continuity enters SURVIVAL after a `capacity_sensor` tick because CEO coverage is
   missing, so an operator observation makes capacity `OPEN` and the run still cannot
   dispatch. **Verified by reading the ordering.** #424 has two independent causes and only
   the capacity one is addressed — consider splitting the issue.
2. **BLOCKER — live runtime health is discarded.** `observationOutlivingError` treats every
   collector ERROR as "no quota information", but an ERROR reading also carries
   `runtimeHealth`. A runtime that has become UNAVAILABLE is dropped and allocation proceeds
   against the observation's frozen `HEALTHY`.
3. **Regression introduced this round.** The older-than-newest refusal added to stop
   `observe` succeeding while changing nothing now rejects the *documented* input:
   `docs/capacity-source.md` tells the operator to submit the provider-reported `observedAt`,
   which is necessarily in the past, while collectors stamp ERROR every four minutes. The
   honest workflow fails with `CAPACITY_UNKNOWN_NOT_ROUTABLE` — the code #424 was filed
   under. Needs a different mechanism (receipt time distinct from observed time, or
   selection that is not purely `MAX(observed_at)`).
4. MAJOR — operator JSON may attach any capability to any provider; `observe` never
   intersects with the adapter's real capability map.
5. MAJOR — `supersededCollectorError` exists only on the in-memory `refresh()` return.
   `current()` / `all()` / `capacity show` rehydrate the observation as HEALTHY, so the
   CP-HI-08 claim holds for the doctor and not for the operator-visible surfaces.
6. `docs/capacity-source.md:65-66` still describes the dispatch-time skip that was removed.

### telegram — do not merge

1. **BLOCKER — owner authority does not stick.** `assertConsumedApproval` calls
   `assertApproval` first, which requires the `inbound_messages` replay row. That row is a
   24h TTL cache pruned on the next successful admit. So a correctly admitted **and
   consumed** approval stops satisfying the human gate once any later Telegram message
   arrives after the TTL — and GitHub merge re-reads that gate. The durable
   `OWNER_APPROVAL_CONSUMED` audit row is thrown away by the check that should be trusting
   it.
2. **BLOCKER — one undeliverable prompt wedges the owner channel.** `pollOnce` delivers
   owner-gate prompts before `getUpdates`, and a denied `sendOwnerPromptIfNeeded` or a
   `TelegramDeliveryError` throws, skipping the inbound batch entirely. A single parked run
   whose prompt cannot be sent stops all inbound owner commands.
3. MAJOR — `isForwarded` checks only `forward_origin` and `forward_from`. A forward carrying
   `forward_from_chat`, `forward_sender_name`, or `forward_date` alone is treated as a
   first-party owner command, so a forwarded `/managed …` executes.
4. MAJOR — upgrade is not fail-closed for in-flight decisions. `isOwnerApprovalReceipt` now
   requires `candidateSnapshotDigest`; pre-change `OWNER_DECISION` artifacts omit it, so
   after upgrade an already-satisfied gate silently becomes unsatisfied.
5. MAJOR — no live Telegram evidence. Every test injects a fake transport; P0-10's acceptance
   needs a real Bot API round trip (owner-blocked on the bot token).

### verifysec — 2 MAJORs open

Fixed this round and mutation-checked: the **P1-15 naming bypass** (a symlink named `node`
resolving to `/bin/sh` was accepted, because the allowlist matched `basename(argv[0])` while
the permitted-root check was satisfied by the target — the allowlist now decides on the
resolved binary), and a **sandbox PATH weakening the lane itself introduced** (the candidate
had begun inheriting `process.env.PATH`; restored to the fixed system list).

Still open:

1. MAJOR — P1-06 is not enforced. `CtoLifecycle.spawn` persists `handle.workdir ??
   managedRuntimeRoot`, so whatever the adapter returns wins with no containment check, and
   Hermes still *spawns* the CEO process with `cwd: process.cwd()` (only the recorded
   workdir was corrected). The workdir trigger is `BEFORE UPDATE`, so an INSERT writes a
   permanent routing fact.
2. MAJOR — the P1-14 lock is a source grep for `from "node:child_process"`. A single-quoted
   import, a dynamic import, or an absolute `/usr/bin/gh` defeats it, and an empty `PATH`
   does not hide an absolute path.
3. MINOR — `writeTargetForRun` filters expired `HELD` rows without expiring them, so the
   unique index can still hold the slot (#358's class, on the GitHub branch path).

### buzzcli — fixed, wants a confirming round

Fixed and mutation-checked: the **#243 acknowledgement was theatre** (the capture supplied
its own `isAllowedActor` and bound the actor directly, so "a different actor is refused" was
true for any input — it now runs `IngressGuard.admit` → `BuzzActorIngress.bindActor` and the
refusal carries `INGRESS_ACTOR_NOT_ALLOWLISTED`); the **launchd PATH could never reach the
CLI** (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` vs `~/.local/bin/buzz`, so the daemon
had no transport while a hand-run capture worked); and a **cast instead of a check** on the
CLI payload, where a row matching by name without `channel_id` produced an undefined address
`available()` called usable.

`evidence/p0-09-buzz-live-delivery.json` records `result: PARTIAL` and **#243 as not
closed** — its done-when requires a HEALTHY doctor and this deployment reports BLOCKED for
unrelated reasons.

---

## 4. Verification protocol — corrected this round

**grok is headless or it is nothing.** `--prompt-file` runs the interactive TUI and dies
without a TTY. Every round before this one came back `stop=cancelled` with partial text
formatted exactly like a finished review — one confidently citing `buzz channels list
--json` at `buzz-adapter.ts:49`, code that had already been deleted. Acting on it would have
meant "fixing" something that did not exist.

Use `scratchpad/grok-blind2.sh`: `grok -p "$(cat prompt)"` with `--json-schema`, so a verdict
must arrive as valid JSON and a truncated run fails to parse instead of producing prose.

Two further traps, both hit:

- **The model emits one schema object per turn.** The early ones are placeholders written
  before it has read anything. Take the **last** object with findings —
  `scratchpad/verdict.py` does this. Taking the first produced `DO NOT MERGE` with zero
  findings and a "reason" that was a statement of intent to start reading.
- **Run one lane at a time.** Concurrency was wrongly blamed for the cancellations, but
  serialisation is still correct and cheap.

Then reproduce every verdict by mutation before acting. That is how the P1-15 symlink bypass
was confirmed (an empirical probe, not a reading) and how a confinement test written this
round was caught passing vacuously — `RLIMIT_NPROC` meant its shell never started, so all
three assertions were trivially true.

---

## 5. Owner-blocked

- **#240** — `acp-production-gate` is installed on **one** repository
  (`repository_selection: selected`, `total_count: 1`, probed directly). The ordered
  two-repository merge cannot run until a second is added, and only a user-to-server token
  can change an installation's repository set.
- **P0-10 live acceptance** — needs the Telegram bot token.
- **#241** — elapsed operating time; nothing to code.

---

## 6. `main` CI is red on `8819c56`

Not the suite — `pnpm trace`. It spawns a **second** full Vitest run with a JSON reporter to
`evidence/local/traceability-vitest-<pid>.json`, and throws when that file is absent; the
"details" in the error are captured stdout, which is why the message looks like a run record.
`effe657` passed the same step, so it is load- or ordering-sensitive rather than caused by
the docs commit between them. Worth making the trace step reuse the first run's results
instead of running the suite twice.

---

## 6b. The one CI failure left on `terra10/verifysec`

`#348/#349` and `P1-15 records the observed RSS breach` fail **only on the GitHub runner**,
and only in which refusal they report — the run is refused either way.

On Darwin there is no enforceable hard RSS limit, so the sandbox *samples* `groupRssMb` and
declares a breach when a sample exceeds the cap (`src/verify/sandbox.ts:572-596`). On a
loaded runner the deliberately memory-abusive child exits before any sample lands, so:

- `memoryLimitExceeded` stays false — nothing observed the peak
- the candidate identity is never captured, so `childCleanupUnavailable` is true
- the reported reason becomes `SANDBOX_CHILD_CLEANUP_FAILED` instead of
  `SANDBOX_RESOURCE_LIMIT_EXCEEDED`

The precedence was already corrected this round so an *exceeded* limit outranks an
unobservable child (`isolationLost` still outranks both). That is not enough here, because on
the runner the limit is never observed as exceeded in the first place.

**The fix is in sampling, not in the reason codes or the test.** The sampler needs at least
one prompt sample after spawn and one final read before the child is reaped, so a
fast-dying child still yields a peak. Do not make the test accept either reason — that
would turn a measurement gap into a passing claim, and the point of this test is that the
breach was *observed*.

Everything else on that lane passes on CI; this is the only remaining failure.

## 7. Next actions, in order

0. **`main` is green** — [run 31769735438](https://github.com/MongLong0214/agent-control-plane/actions/runs/31769735438). The
   crash was `pool: "threads"` running a native addon beside sandboxed children; it is
   `pool: "forks"` now, and the suite runs once with `trace` consuming its JSON.
2. **capacityobs**: decide whether #424 splits. The capacity half is done; the SURVIVAL half
   is untouched and is what actually blocks dispatch on this host. Then the runtime-health
   and older-than-newest defects.
3. **telegram**: the two blockers are both product-breaking and independent of each other.
4. **verifysec**: constrain the persisted workdir to the runtime root, fix the Hermes spawn
   `cwd`, and replace the P1-14 source grep with something a rename cannot defeat.
5. **buzzcli**: one confirming blind round, then merge first — it is the least entangled.
6. Only then branch protection (`verify` pinned to App `15368` first; `acp-production-gate`
   only once the daemon publishes gates routinely — see `docs/ops/branch-protection.md`).

Do not tag `v1.0.0`. Beyond the open P0s, the A–Z review's central point stands and is
unaddressed: ACP's own gate is sound, and nothing yet proves the *repository* admits only
ACP's path.
