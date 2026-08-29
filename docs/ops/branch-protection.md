# Branch protection — Wave 0 of the v1.0 closeout

Wave 0 of `docs/review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md` requires
that the repository protect itself before any later wave's "green" means anything:

- `main` cannot take an unsafe direct push
- a fresh pull request must have every required CI check green
- force-push and branch deletion are refused
- there are **no bypass actors** — the review is explicit that this count is zero

The CI workflow is `project-ci` (`.github/workflows/ci.yml`), and **`verify` is the required
status check context** — that is the name GitHub reports, not `project-ci`. It used to be true
because the workflow's one job had that id; it is no longer, and stating it that way would be
exactly the kind of stale claim this repository keeps finding elsewhere. As of #539's CI-matrix
fix, the workflow has two jobs: `verify-matrix` (`node-version: ["22.18.0", "22"]`, running
`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm trace`, `node scripts/ssot-report.mjs`
and the rest of the step list) and `verify-gate`, which needs it and runs unconditionally
(`if: always()`) to fail closed on anything but a fully successful matrix. Both jobs carry
`name: verify`; GitHub appends the matrix value to a matrixed job's check name regardless of that
field, so `verify-matrix`'s checks read `verify (22.18.0)` / `verify (22)`, and `verify-gate` —
unmatrixed — is what produces the bare `verify` check this section's required-status-check
configuration actually matches. The required context string itself did not change, so nothing in
this document's `gh api` commands or `app_id`/`integration_id` pins needs updating for this.

Applying this is an owner action: it changes repository settings.

## Apply (repository ruleset — preferred)

```bash
cd /Users/isaac/projects/agent-control-plane

cat > /tmp/acp-ruleset.json <<'JSON'
{
  "name": "protected-trunk",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "verify", "integration_id": 15368 }
        ]
      }
    }
  ]
}
JSON

gh api -X POST repos/MongLong0214/agent-control-plane/rulesets --input /tmp/acp-ruleset.json
```

`strict_required_status_checks_policy: true` is "branch must be up to date before merging", which is
what makes the base a proven base rather than a stale one.

`required_approving_review_count` is `0` because this repository currently has one human. Raise it to
`1` the moment there is a second, and the review's intent is satisfied either way — the gate that
matters here is the CI check, not a human rubber stamp.

## Verify

```bash
gh api repos/MongLong0214/agent-control-plane/rulesets --jq '.[] | [.id, .name, .enforcement] | @tsv'
gh api repos/MongLong0214/agent-control-plane/rules/branches/main --jq '.[].type'
```

The second command lists the rules that actually apply to `main` and is the honest check — a ruleset
can exist and still not match a branch.

Then prove the exit condition the review asks for:

```bash
git switch -c ci/protection-proof && git commit --allow-empty -m "prove required checks" \
  && git push -u origin ci/protection-proof && gh pr create --fill
# the PR must show `verify` as required, and a direct push to main must be refused:
git switch main && git commit --allow-empty -m "should be refused" && git push origin main
```

The last push is expected to fail. If it succeeds, the ruleset is not matching `main`.

## Alternative (classic branch protection)

Only if rulesets are unavailable.

`checks` with an `app_id`, not `contexts`. The two are not interchangeable: `contexts` names a
check and accepts it from whatever reported it, which is the exact hole the section below
describes — and this is the block someone copies. It read `"contexts": ["verify"]` until
2026-08-18, so a deployment set up from the fallback path was protected by a name while the
ruleset path next to it was pinned to an app.

```bash
cat > /tmp/acp-protection.json <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [{ "context": "verify", "app_id": 15368 }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": false
}
JSON

gh api -X PUT repos/MongLong0214/agent-control-plane/branches/main/protection --input /tmp/acp-protection.json
```

`enforce_admins: true` is the classic equivalent of zero bypass actors.

## One consequence worth knowing before you apply it

Integration currently lands verified work by merging locally and pushing to `main`. Once this is
active that stops working by design, and every subsequent merge goes through a pull request whose
`verify` check must pass — roughly one CI run per merge on a `macos-15` runner.

That is the contract the closeout asks for, and it is also the exit evidence Wave 0 wants ("fresh PR
에서 모든 required CI green"). It is worth applying **after** the in-flight CI token fix lands, because
`node scripts/ssot-report.mjs` needs `GH_TOKEN` in Actions and fails without it — a required check
that cannot pass blocks every merge, including the one that would fix it.

## Pinning the check to its App, and why `verify` goes first

A required check named only by its context can be satisfied by **any** integration that reports
that name. `integration_id` pins the source, and without it the protection is a name match rather
than a provenance check:

| context | source | App id |
| --- | --- | --- |
| `verify` | GitHub Actions | `15368` |
| `acp-production-gate` | ACP production gate App | `4586878` |

ACP's own `verifyGate()` already refuses a same-named check from an untrusted creator — that is
proven, and a forged gate was rejected live. But that verifier only runs on ACP's merge path. The
whole point of branch protection is the *other* paths: a human merge in the GitHub UI, another
automation with write access, a direct push. Those never reach `verifyGate()`, so the pinning has
to be GitHub's.

## Still outstanding for Wave 0 / P0-14

The App half is no longer outstanding. `acp-production-gate` (App `4586878`) is installed
(installation `153553922`) with `checks/contents/pull_requests/statuses/issues/merge_queues` write
and `metadata` read, and a live gate → merge → post-merge sequence is captured in
`evidence/p0-14-live-gate-merge-postmerge.json`, with the forged/missing/stale refusals in
`evidence/p0-14-live-gate-refusals.json`. #242 is closed.

**Register the two required checks in order, not together.**

1. `verify` first, as soon as `main` CI is green. This is safe immediately: every push already
   produces it.
2. `acp-production-gate` **only once the daemon finalizer publishes a gate as a matter of course.**
   Requiring it before then blocks every merge that is not a completed ACP run — including the
   merge that would fix whatever stopped the daemon publishing. That is the same trap the section
   above describes for a check that cannot pass.

The residual after both are registered is recorded on #247: GitHub's merge API fences the head but
accepts no expected base, so an out-of-order base is detected after the merge rather than prevented.

Two repository-scope items remain owner actions, because an installation's repository set can only
be changed with a user-to-server token:

- `acp-production-gate` is installed on **one** repository (`repository_selection: selected`,
  `total_count: 1`). #240's ordered two-repository merge cannot run until a second is added.
- `dev` no longer exists. It was deleted on 2026-08-19 with zero commits unique to it, and the
  CI triggers that named it were removed in #593, so this repository is trunk-only. Earlier
  revisions of this page protected two refs; the ruleset above names `main` alone because that
  is now the only long-lived branch here. Repositories this control plane *generates* keep the
  `main`/`dev` pair — that contract is theirs, not this one's.
