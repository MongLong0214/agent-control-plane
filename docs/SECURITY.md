# Security posture and reporting

Agent Control Plane is not production-ready. Do not rely on this repository as a complete
security boundary for untrusted repositories, unattended deployment, or provider-only
reviewer egress. Current security-relevant blockers and residuals are visible in the
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
