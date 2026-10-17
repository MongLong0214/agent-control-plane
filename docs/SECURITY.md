# Security posture and reporting

Agent Control Plane is not production-ready. Do not rely on this repository as a complete
security boundary for untrusted repositories or unattended deployment. Packet-only blind
reviewer egress has a measured, fail-closed provider-proxy boundary; its scope and remaining
deployment evidence requirement are documented in [reviewer egress](reviewer-egress.md).
Current security-relevant blockers and residuals are visible in the
[open P0 tracker](https://github.com/MongLong0214/agent-control-plane/issues?q=is%3Aissue%20state%3Aopen%20label%3AP0)
and [status page](STATUS.md).

Do not post credentials, private repository material, live exploit instructions, or a
reproduction that reaches another person's system in a public issue. Use GitHub's private
security reporting flow if the repository enables it; otherwise request a private reporting
channel from [the repository owner](https://github.com/MongLong0214) before disclosing the
details.

Reports should include the affected revision, the local or external boundary involved, a
minimal safe reproduction, impact, and whether the finding can cause an unsafe PASS or
authoritative write. Do not claim a fix is complete without a regression test and an
independent review appropriate to the boundary.

## Stated residuals

### The database write guards assume cooperating processes

The schema's write-time guard triggers refuse a write that did not come through its owning
operation. They do so by calling SQLite functions the daemon registers on its own connection, the
`acp_*_authorized` family in `src/db/database.ts`. Both halves live in the database file and on the
connection, so they hold only against processes that cooperate. A code-executing process running
as the same OS user can open the state database, drop the guard triggers, or define its own
functions under the same `acp_*_authorized` names so that they always answer yes, and then write.
This is the stated residual for a privileged same-uid writer, not a remote hole: the database
files are mode 0600, which keeps other users out, and nothing inside SQLite keeps the owning user
out (#1095).

### External work-session links in published commit history

Commit messages on `main` dated 2026-08-12 to 2026-10-04 contain links to pages of an external
work-session service: 123 commits at `51e586fd`, some on a labelled trailer line and some bare at
the end of a squash body copied from a pull-request description. No later commit carries one, and
the links were removed from the affected pull-request descriptions. History is not rewritten, so
the links stay readable in those published commits; whether one reveals anything depends on that
service's access control, not on this repository.

Those links are not part of this project's record. Decisions, evidence and review live in this
repository, its issues and its pull requests, and nothing is to be read from or cited through such
a link. New commit messages must not carry one, and a check refuses them: the `commit-msg` hook
and the CI range check (`pnpm trailers`) both run `scripts/verify-trailers-are-parsable.mjs`, which
rejects a session link, bare, labelled or embedded, and a session metadata line such as
`Claude-Session:`. It reads only the message or range it is given, so the published commits keep
their links (#1107).
