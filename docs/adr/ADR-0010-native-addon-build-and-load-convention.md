# ADR-0010 — Native addons in this repository are built with binding.gyp + node-addon-api, prebuilt on macos-15 CI

- **Status:** Accepted
- **Date:** 2026-08-29
- **Drivers:** #539, docs/CONTRIBUTING.md ("peer identity is registry-level, not kernel-level")

## Context

#539 needs a Darwin kernel peer-credential read (`getsockopt(SOL_LOCAL, LOCAL_PEERCRED, ...)`),
which is not reachable from JavaScript without a native addon. This repository had never built
one: no `binding.gyp`, no `native/`, no `node-gyp`/`node-addon-api`/`bindings`/`prebuildify` in
`package.json`, no `process.dlopen` or `.node` require anywhere in `src/`. Four discovery runs on
#539 (2026-08-16 through 2026-08-29) confirmed this repeatedly and each ended
`BLOCKED_NATIVE_BOUNDARY`: the ticket requires a convention to exist as a recorded decision before
any native code lands, and forbids inventing one inside a capability ticket.

A convention *does* exist elsewhere on this machine, in two directories under `~/.hermes/bridge/`:

- `same-session-acp/native/`
- `ssot/spike/native/` — that path segment is a directory name someone chose on the other side
  of the bridge. It names nothing this repository treats as authoritative: agent-control-plane
  is the single source of truth for its own state, and both directories above are Hermes legacy
  state regardless of what either is called on disk.

Both carry a built `peercred.c`/`peercred.node` with recorded provenance
(`task7-peercred-provenance-v1`). That provenance pins an exact Node version (`22.23.2`), compiler
and SDK hashes, and header digests, and re-derives the binary by recompiling at load time. #539
names that regime and forbids importing it wholesale — the pins are this machine's, not a build
this repository can reproduce or verify on its own CI runner, and compiling C at require time is
exactly the loader this repository's own docs already ruled out (`docs/CONTRIBUTING.md`: "writing
the C from scratch would be new native code wearing the word 'absorb'").

This ADR is the owner decision that unblocks #539: not adopting the existing regime, but
establishing this repository's own convention, forbidden neither by name nor by shape.

## Decision

This repository's native addons are built and consumed the way `better-sqlite3` already is:

- **`binding.gyp` per addon**, under `native/<addon>/`, built with `node-gyp` against
  **`node-addon-api`** (this repository's approved N-API binding layer — not raw N-API C, not
  NAN). `node-addon-api` and `node-gyp` are `devDependencies` at the repository root; there is no
  per-addon `package.json` and no npm publication — these are in-tree sources, not consumed
  packages.
- **No pinned toolchain.** `node-addon-api` builds against the N-API ABI, which is stable across
  Node versions by design — this is the property the legacy regime's exact-version pin exists to
  work around, and adopting `node-addon-api` is what makes the pin unnecessary rather than
  something to also carry forward.
- **`node-gyp` is pinned to `11.5.0`, not the latest major, because its own `engines` range must
  not become this repository's engine range by accident.** `package.json` declares
  `"node": ">=22"`. `node-gyp@12.0.0` and `@13.0.0` each narrowed that range as a deliberate,
  named breaking change ("align to npm 11 node engine range"; "bump to new node engine range") —
  13.0.2's is `^22.22.2 || ^24.15.0 || >=26.0.0`, which excludes Node 22.0–22.22.1, all of 23, and
  24.0–24.14, all inside `>=22`. `postinstall` (below) makes this the toolchain every declared-
  supported install runs, so that gap would be real, not theoretical, and CI's floating
  `node-version: 22` would not catch it (see the CI matrix change below). `node-gyp@11.5.0`'s
  range is `^18.17.0 || >=20.5.0` — a strict superset of `>=22` with no internal gap. Checked the
  changelog between 11.5.0 and 13.0.2 for anything besides the engine bumps: Windows/VS2026
  support and CI-only changes, plus one dependency bump relevant off Windows — `tar` to `7.5.4` in
  `12.2.0`, for `CVE-2026-23950` (a macOS-relevant Unicode-collision race in tar extraction).
  Pinning `node-gyp` to `11.5.0` does not reintroduce that: `node-gyp@11.5.0` depends on
  `tar: ^7.4.3`, and pnpm's resolver already picks `7.5.22` for it in this lockfile — checked with
  `grep -A11 "node-gyp@11.5.0(supports-color" pnpm-lock.yaml`. So this pin costs nothing found in
  the diff between the two versions that applies to this repository's build.
- **No compile-on-load.** The addon is built by an explicit step
  (`scripts/build-native-peercred.mjs`, `node-gyp rebuild`), wired as this package's own
  `postinstall` script — so `pnpm install` builds it on a fresh developer checkout, in CI, and
  in a deploy checkout, without any of those flows having to remember a separate step.
  `.github/workflows/ci.yml`'s `verify` job — the only runner it uses is `macos-15` — also calls
  it explicitly, the same reason `pnpm rebuild better-sqlite3` sits next to it there rather than
  trusting only that dependency's own install script. Loading a `.node` file at `require()` time
  never triggers a compile; a missing build fails closed (`getPeerCredentials` returns `null`,
  mirroring `processStartedAt`'s #505 contract) rather than compiling on the spot.
- **Platform-gated at three layers**, each independent so no single one has to be perfect: the
  `.cc` source `#error`s outside `__APPLE__`; `scripts/build-native-peercred.mjs` skips the
  `node-gyp` invocation entirely when `process.platform !== "darwin"`; and
  `src/core/peercred.ts` never attempts to load the addon off Darwin. A Linux checkout or CI
  runner never compiles or requires anything under `native/`.
- **The addon does not become a live call site by existing.** Landing `native/peercred` and
  `src/core/peercred.ts` is #539's whole deliverable; wiring a caller is explicitly out of scope
  and enforced by `scripts/verify-peercred-is-unreachable.mjs`, which fails on any reference to
  `getPeerCredentials`/`PeerCredentials` outside `src/core/peercred.ts`.

This convention is scoped to addons this repository writes, builds, and owns the source of. It
does not authorize consuming a third-party native package beyond what `better-sqlite3` already
established, and it does not authorize an FFI path (`koffi` and similar) as an alternative — that
was the other option discovery raised and it is not the one this ADR approves.

## Alternatives rejected

- **Import the `~/.hermes/bridge/.../peercred.c` regime.** Forbidden by name in #539: exact Node
  pin, compiler/SDK hashes, `/dev/fd` `dlopen`, runtime compilation. It also encodes provenance
  about a machine, not this repository — a fresh clone or a different CI runner has no way to
  satisfy it.
- **FFI via `koffi` or similar, avoiding compilation entirely.** Raised and explicitly declined in
  discovery: it is a new kind of native dependency this repository has neither used nor approved,
  decided unilaterally inside the same ticket it would unblock — the "invent a route to justify
  the primitive" #539 forbids, just with a different mechanism.
- **Compile at require time, keeping the addon a plain `.ts` import with no build step.** Re-adds
  the legacy loader's central defect (arbitrary compilation on the code path that answers "is
  this connection who it claims to be") under a different toolchain.
- **Narrow this repository's declared `engines.node` to match `node-gyp@13`'s real range instead
  of pinning `node-gyp`.** Considered and rejected: `^22.22.2 || ^24.15.0 || >=26.0.0` is a
  discontinuous range built for `node-gyp`'s own support policy, not a range this application has
  any reason to hold — it would drop support for most of the currently-declared `22.x` line and
  all of `23.x`, is a user-visible support change with nothing to do with peer credentials, and
  would need to be called out as its own decision rather than follow from a build-tool version
  bump. Pinning the build tool keeps the declared contract unchanged and costs nothing measured
  above; this is the option to revisit only if a future `node-gyp` fix this repository actually
  needs is gated behind a narrower range than `>=22` can absorb.

## Consequences

`native/peercred` is buildable and loadable on Darwin, built at install time on every checkout —
a developer's, a deploy checkout's, or CI's `macos-15` runner — rather than left for someone to
remember as a separate step. Any future native addon in this repository follows the same shape:
`binding.gyp` + `node-addon-api` under `native/<name>/`, wired as (or alongside) `postinstall`,
and a platform gate that fails closed rather than compiling on demand. Adopting this convention
does not, by itself, wire `getPeerCredentials` into anything — that remains a separately
authorized ticket, per #539's acceptance.

Making the native build mandatory at install time means its toolchain's `engines.node` range is
now something this repository must track, not just `node-gyp`'s own concern — a build tool
version bump can silently narrow what `pnpm install` will do on a declared-supported Node version.
`.github/workflows/ci.yml`'s `node-version: 22` is a moving alias that resolves to whatever the
latest `22.x` is on the day the job runs, so it cannot catch a regression at the *edges* of the
declared range — it never runs the boundary that would fail. The CI matrix now also pins the
declared range's floor (`22.0.0`) alongside the moving alias, so a future `node-gyp` bump (or
any other change that narrows what this repository can build on) fails at the version this
repository actually promises to support, not only on whatever Node happens to be newest.
