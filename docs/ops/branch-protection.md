# Branch protection — Wave 0 of the v1.0 closeout

Wave 0 of `docs/review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md` requires
that the repository protect itself before any later wave's "green" means anything:

- `main` and `dev` cannot take an unsafe direct push
- a fresh pull request must have every required CI check green
- force-push and branch deletion are refused
- there are **no bypass actors** — the review is explicit that this count is zero

The CI workflow is `project-ci` (`.github/workflows/ci.yml`) and its single job is `verify`, so
**`verify` is the required status check context** — that is the name GitHub reports, not
`project-ci`. It runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm trace` and
`node scripts/ssot-report.mjs`.

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
    "ref_name": { "include": ["refs/heads/main", "refs/heads/dev"], "exclude": [] }
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
        "required_status_checks": [{ "context": "verify" }]
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

Only if rulesets are unavailable. Repeat for `dev`.

```bash
cat > /tmp/acp-protection.json <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
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

## Still outstanding for Wave 0 / P0-14

Branch protection is necessary but not sufficient for the trusted GitHub gate. The review's P0-14
also requires the production gate check to come from a GitHub **App** with `checks:write`, its
creator identity pinned, and `acp-production-gate` added alongside `verify` as a required check. That
is tracked as #242 and needs the App installed first — this document covers only the protection half.
