# Contributing

This repository is not a production-ready service and has no published license grant. Ask
the repository owner before relying on contribution or reuse terms.

Before proposing a change, read the normative [PRDs](prd/), the
[closeout review](review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md),
and [current status](STATUS.md). Keep a change tied to a tracked finding or documented
requirement, and state what live evidence it does not create.

Run the repository gates relevant to the change:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm trace
node scripts/ssot-report.mjs
```

Do not hand-edit generated traceability evidence or status counts. A document that names a
changing number must derive it from a command, query, or generated artifact. A test that
passes after its enforcement is removed is not adequate regression evidence; say which
assertion fails when you check that negative control.

Do not represent a local test, fixture, modelled adapter, or template as live GitHub, Buzz,
Telegram, launchd, provider, or owner evidence. Those claims require the live evidence and
owner-controlled configuration described in [STATUS.md](STATUS.md).

### Find the enforcement, not the line number

An issue body is a fact about the moment it was written. Its line numbers, and its statement
that something is still broken, were true then. The code has moved since.

So when working a tracked finding, locate each item by **the enforcement it names**, not by its
recorded path and line. Whether it is still broken then comes out of the code rather than out of
the issue.

This is not a small correction. The #443 2급 sweep found that five of six recorded items had
already been repaired, and every line number in the list had drifted. Working the list literally
would have produced five fixes to things that were already fixed, and a green run to go with
them. The sixth — a genuine gap, now #498 — was found because the sweep went looking for the
enforcement rather than the line.

The same rule explains a disagreement worth recording: a test named as the top priority was read
from the issue by one reviewer and from `main` by another, and only the second saw that it had
been fixed. When an issue and the code disagree, the code is the fact.
