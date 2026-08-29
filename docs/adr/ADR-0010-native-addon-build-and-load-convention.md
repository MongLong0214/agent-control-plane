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

A convention *does* exist elsewhere on this machine — `~/.hermes/bridge/same-session-acp/native/`
and `~/.hermes/bridge/ssot/spike/native/` both carry a built `peercred.c`/`peercred.node` with
recorded provenance (`task7-peercred-provenance-v1`). That provenance pins an exact Node version
(`22.23.2`), compiler and SDK hashes, and header digests, and re-derives the binary by recompiling
at load time. #539 names that regime and forbids importing it wholesale — the pins are this
machine's, not a build this repository can reproduce or verify on its own CI runner, and
compiling C at require time is exactly the loader this repository's own docs already ruled out
(`docs/CONTRIBUTING.md`: "writing the C from scratch would be new native code wearing the word
'absorb'").

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
- **No compile-on-load.** The addon is built by an explicit step
  (`scripts/build-native-peercred.mjs`, `node-gyp rebuild`) that runs during CI on
  `macos-15` — the only runner `.github/workflows/ci.yml`'s `verify` job uses, so this repository
  always has a macOS builder producing the prebuild. Loading a `.node` file at `require()` time
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

## Consequences

`native/peercred` is buildable and loadable on Darwin, with CI on `macos-15` as the standing
producer of its prebuild. Any future native addon in this repository follows the same shape:
`binding.gyp` + `node-addon-api` under `native/<name>/`, an explicit build script, and a
platform gate that fails closed rather than compiling on demand. Adopting this convention does
not, by itself, wire `getPeerCredentials` into anything — that remains a separately authorized
ticket, per #539's acceptance.
