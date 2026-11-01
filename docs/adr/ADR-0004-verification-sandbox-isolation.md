# ADR-0004 — Verification runs under macOS seatbelt, and fails closed when it cannot

- **Status:** Accepted; revised 2026-10-31 (open to every language)
- **Date:** 2026-08-12
- **Drivers:** PRD §17.4, §33.3, CP-HI-08, Integration §15

## Context

Candidate-supplied code decides whether a candidate passes. It must not be able to read or
write authority credentials, write outside its worktree, or outlive its timeout. v1 supports
only owner-trusted repositories, but §17.4 is explicit that secret stripping and worktree
isolation are not optional even so. An argv rule cannot provide that boundary: any declared
command can exec a shell after it starts.

**Revision 2026-10-31.** The owner directed the sandbox to allow every language, as open as
possible. The first version admitted only `node`, `npm`, `pnpm`, `npx`, `tsc`, `vitest`, `eslint`
and `git` as argv[0] (plus a per-project list, `verificationExecutables`, that shipped empty), gave
the command a scratch `HOME`, and denied the network, which also refused local IPC such as tsx's
socket. A Python, Rust, Go, Swift, JVM or Ruby suite could not be declared, so such a project
stopped at `VERIFICATION_GAP`. This revision opens the sandbox and keeps one guard: secret paths.

## Decision

Each command runs as: disposable git worktree, constructed (never inherited)
environment, `sandbox-exec` seatbelt profile, own process group, a candidate pid/start-time
rendezvous held before `exec`, wall-clock timeout with `SIGTERM`→`SIGKILL` on the group and the
captured candidate, RSS polling, and output byte cap.

**What runs stays bound.** argv[0] may be any executable: there is no executable allowlist.
Only the commands the run's pinned manifest declares run, each launched by the absolute path
resolved outside the sandbox (#1102), against its own frozen worktree; argument paths outside the
worktree are refused (`SANDBOX_PATH_OUTSIDE_WORKTREE`), and a project that declares no command
still stops at `VERIFICATION_GAP`. A declared argv[0] that leads to no executable file is refused.

**Environment.** It is built from an allowlist, never inherited: no token-bearing variable of
the daemon's (`GH_TOKEN`, `GITHUB_TOKEN`, provider API keys, `AWS_*`, ACP's own credentials,
`BUZZ_PRIVATE_KEY`) and no agent pointer (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `DOCKER_HOST`)
reaches a candidate, whatever its contract names. An allowlisted name whose value has a known
secret shape is dropped. `HOME` is the daemon's own home, so a toolchain finds what it installed
there (`~/.cargo`, `~/.rustup`, `~/.pyenv`, user site-packages); `TMPDIR` is the run's scratch.
git reads no global config, credential helper, ignore or attributes file, and npm no `~/.npmrc`.

**Profile.** Allow-default, so any toolchain starts and reads what it needs:

- reads are open across the filesystem, except the secret paths;
- writes reach the worktree, `TMPDIR` and the toolchain caches `SANDBOX_CACHE_HOME_PATHS` names
  (npm, pnpm, Yarn, pip, uv, cargo's registry and git checkouts, Go's module and build caches,
  Gradle's caches and wrapper distributions, Maven's repository, SwiftPM) — caches only, never a
  toolchain's bin directory, installed toolchain or configuration, where a write would run later
  outside the sandbox;
- for a command whose contract says `network: "allow"`, outbound network and local IPC are open, to
  look up and download dependencies during verification. This is not a publish or deploy right: no
  credential reaches the command to publish with. A command whose contract says `deny`, the default,
  has IP networking denied, inbound and outbound, and every unix socket outside its worktree and
  scratch, while binding and connecting its own socket there still works. So that it cannot bring
  an outside socket in, a deny command also cannot rename or link a socket, or rename or remove a
  directory, outside its worktree and scratch. That is a compatibility cost: toolchain caches are
  included, so a tool that moves directories into place in its cache (Gradle's offline transforms,
  for one) can fail under `deny`. A command that needs that is a contract decision of its own, not
  a quiet switch to `allow`.
  `network: "allowlist"` is still refused, because seatbelt cannot enforce destinations.

**The guard.** `SANDBOX_SECRET_PATHS` — SSH and GPG keys and their agents, the keychain, GitHub,
cloud and package-registry credentials, ACP's state root, Hermes, Claude, Codex and Buzz
identities and keys, and container-engine sockets — together with the caller's `denyReadPaths`
(ACP's database, secrets, capacity and runtime roots, and every other checkout) can be neither
read nor written, and no unix socket below them can be connected to. The launchd SSH agent
listener and the keychain services are denied as well. The worktree, the scratch and the pinned
runtime are carved back out, since production lays them under the state root.

**Best-effort, not leak-proof.** The guard covers the named locations only: a credential kept
anywhere else is as readable as any other file. A shared cache the command writes can be poisoned
for a later build outside the sandbox. A process the command asks launchd or LaunchServices to
start (`open`, `osascript`, `launchctl`) runs outside the sandbox. Toolchain configuration that
sits on the list is unreadable, so Maven with a `~/.m2/settings.xml` or Gradle with a
`~/.gradle/gradle.properties` can fail, and a Node installed under `~/.hermes` cannot run `npm`
from there.

**Evidence.** The result records what was in force: `networkPolicy` is the command's declared
`deny` or `allow`, with `networkEnforced: true` only for a `deny` command whose profile was applied,
`readConfinement: "sensitive-paths"`, and `writeConfinement: true` meaning writes are confined to
the worktree, `TMPDIR` and the named caches. `networkEnforced: true` means the command's own process
tree was denied the network; it does not cover a process started through `open`, `osascript` or
`launchctl`, which runs outside the sandbox (the limit above). No evidence mode treats
a network denial as part of what it means: `TRUSTED_CI` reads CI's result, and `LOCAL_COMMAND` and
`BOTH_REQUIRED` read this record.

The process group is not the complete containment proof: a candidate can call `setsid()` without
forking. The resource wrapper stops its candidate before `exec` and writes the pid to scratch;
the outer supervisor captures `ps` start time, releases the candidate, and later signals/reaps
that exact identity even if the candidate leaves the original group or kills the wrapper. Any
missing identity or cleanup proof is recorded as `childContainmentEnforced: false` with an
explicit `childContainmentReason` and cannot accompany a contained pass.

**Fail closed:** if the confinement mechanism is unavailable, the command is not executed. The
result is `ERROR` with `SANDBOX_NETWORK_DENIED`, never a pass. CP-HI-08 forbids reporting a weaker
execution as a successful one.

## Alternatives rejected

- **Docker / Linux namespaces** — not the deployment target; adds a daemon dependency to
  a service designed to have none.
- **Running unconfined because the repo is owner-trusted** — makes the isolation claim in
  the production-ready packet false, and CP-S27 unfalsifiable.
- **`ulimit` via a candidate shell wrapper** — `RLIMIT_AS` is unreliable on macOS, and making
  a shell the contract boundary would reopen the interpolation surface §12 closes. The
  trusted resource wrapper may still exec candidate code, including a shell, because seatbelt
  and process-group cleanup—not argv inspection—provide the confinement boundary.
- **A per-language executable list** (2026-10-31) — every new language would need a policy
  change, and the list never was the boundary: an admitted interpreter can exec anything.
- **Opening whole toolchain roots for writing** (`~/.cargo`, `~/.rustup`, `~/.gradle`, `~/go`) —
  they hold the binaries and configuration the owner's next build runs outside the sandbox.

## Consequences

Strong isolation for untrusted repositories (full VM/container) stays in the backlog
(§43). What ships is enforced, tested (CP-S27, CP-S28, write-confinement, the secret guard in
`tests/unit/the-verification-sandbox-opens-to-every-language.test.ts`) and honest about its
boundary.
