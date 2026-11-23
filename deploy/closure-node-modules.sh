#!/bin/sh
# Materialize this checkout's production dependencies as a symlink-free tree that resolves on its
# own, for a rollback pair's closure:
#
#   closure-node-modules.sh <app-root> <destination> <closure-node>
#   closure-node-modules.sh --verify <node_modules> <closure-node>
#
# <closure-node> is the Node executable the closure will carry (`$CLOSURE/bin/node`), a file named
# `node`. The install runs under it and the result is loaded with it before this exits 0, because
# better-sqlite3 is a native addon bound to one Node ABI: built under whatever `node` happens to be
# on PATH it loads there and fails in the sealed generation, and the seal never starts the closure,
# so the first anyone would learn of it is a rollback that fails at its database step.
# `--verify` runs only that load check, on a tree that already exists.
#
# Why not `cp -RcL "$APP_ROOT/node_modules"`: pnpm's `node_modules/<pkg>` is a symlink into
# `.pnpm/<pkg>@<v>/node_modules/<pkg>`, and the package's own dependencies are its siblings
# there. Node resolves a symlinked package from its real path, so the deployed app finds them.
# `-L` replaces the symlink with a real directory at the top level, where those siblings are not,
# and `@noble/hashes` (a dependency of `nostr-tools`) is no longer found. A pair holds regular
# files only and refuses a symlink, so preserving the links is not an option.
#
# A hoisted install is the layout that needs no symlinks: every package is a real directory and
# its dependencies sit in the `node_modules` directories above it, exactly where Node looks. It
# is installed from the same lockfile, production dependencies only, so the versions are the ones
# the app runs. The only links left are `.bin` shims, which `cp -L` turns into files.
#
# Known limits:
# - The native addon is not byte-for-byte the one the daemon runs. On a pnpm side-effects cache hit
#   it is the cached build; on a miss (a new store, or a Node major the store has not built for)
#   it comes from `prebuild-install`, a prebuilt binary fetched from the package's GitHub release,
#   or from `node-gyp`. The lockfile's integrity hashes cover the package tarball, not that binary.
#   This script proves only that the binary loads under <closure-node>, not where it came from.
# - It needs `pnpm` on PATH, and the registry or a warm store.
set -eu

usage="usage: closure-node-modules.sh <app-root> <destination> <closure-node> | --verify <node_modules> <closure-node>"

# Loads what the closure runs, with the closure's own Node: the native addon, and `nostr-tools`'
# ES module graph, whose dependency `@noble/hashes` is what a bad layout loses.
verify() {
  _tree=$1
  _node=$2
  "$_node" --input-type=module -e '
    import { createRequire } from "node:module";
    import { join, resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const root = resolve(process.argv[1]);
    const require = createRequire(join(root, "probe.cjs"));
    new (require("better-sqlite3"))(":memory:").close();
    await import(pathToFileURL(join(root, "nostr-tools", "lib", "esm", "nip19.js")).href);
  ' "$_tree" || {
    echo "closure-node-modules: $_tree does not load under $_node (better-sqlite3 or nostr-tools)" >&2
    return 1
  }
}

require_node() {
  [ -f "$1" ] && [ -x "$1" ] && [ "$(basename "$1")" = node ] || {
    echo "closure-node-modules: $1 is not an executable file named node" >&2
    exit 1
  }
}

# Node finds a package's dependencies in a directory *named* `node_modules`, so a tree under any
# other name cannot resolve itself and would fail the load check for a reason unrelated to the layout.
require_named_node_modules() {
  [ "$(basename "$1")" = node_modules ] || {
    echo "closure-node-modules: $1 must be a directory named node_modules" >&2
    exit 1
  }
}

if [ "${1:-}" = "--verify" ]; then
  tree=${2:?$usage}
  closure_node=${3:?$usage}
  require_node "$closure_node"
  require_named_node_modules "$tree"
  [ -d "$tree" ] || { echo "closure-node-modules: $tree is not a directory" >&2; exit 1; }
  verify "$tree" "$closure_node"
  exit
fi

app_root=${1:?$usage}
destination=${2:?$usage}
closure_node=${3:?$usage}
require_node "$closure_node"
require_named_node_modules "$destination"
[ -f "$app_root/package.json" ] && [ -f "$app_root/pnpm-lock.yaml" ] || {
  echo "closure-node-modules: $app_root has no package.json and pnpm-lock.yaml" >&2
  exit 1
}
[ ! -e "$destination" ] || {
  echo "closure-node-modules: $destination already exists" >&2
  exit 1
}

# Every tool below, pnpm and the addon's own build included, finds the closure's Node first.
closure_node_dir=$(cd "$(dirname "$closure_node")" && pwd -P)
closure_node=$closure_node_dir/node
PATH=$closure_node_dir:$PATH
export PATH

stage=$(mktemp -d "${TMPDIR:-/tmp}/closure-node-modules.XXXXXX")
trap 'rm -rf "$stage"' EXIT

cp "$app_root/pnpm-lock.yaml" "$stage/"
[ ! -f "$app_root/pnpm-workspace.yaml" ] || cp "$app_root/pnpm-workspace.yaml" "$stage/"
# The package's own lifecycle scripts build this repository's native addons and need its sources;
# a dependency's scripts (better-sqlite3) still run, which is why this is not --ignore-scripts.
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete manifest.scripts;
  fs.writeFileSync(process.argv[2], JSON.stringify(manifest));
' "$app_root/package.json" "$stage/package.json"

pnpm --dir "$stage" install --prod --frozen-lockfile --prefer-offline --node-linker=hoisted
# pnpm's bookkeeping records the stage's absolute paths; it is not a dependency.
rm -rf "$stage/node_modules/.pnpm" "$stage/node_modules/.modules.yaml" \
  "$stage/node_modules/.pnpm-workspace-state-v1.json"
cp -RcL "$stage/node_modules" "$destination"
# The copy is what gets sealed, so the copy is what is loaded. A failure leaves nothing behind.
verify "$destination" "$closure_node" || { rm -rf "$destination"; exit 1; }
