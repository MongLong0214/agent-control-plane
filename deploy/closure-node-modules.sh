#!/bin/sh
# Materialize this checkout's production dependencies as a symlink-free tree that resolves on its
# own, for a rollback pair's closure:   closure-node-modules.sh <app-root> <destination>
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
set -eu

app_root=${1:?usage: closure-node-modules.sh <app-root> <destination>}
destination=${2:?usage: closure-node-modules.sh <app-root> <destination>}
[ -f "$app_root/package.json" ] && [ -f "$app_root/pnpm-lock.yaml" ] || {
  echo "closure-node-modules: $app_root has no package.json and pnpm-lock.yaml" >&2
  exit 1
}
[ ! -e "$destination" ] || {
  echo "closure-node-modules: $destination already exists" >&2
  exit 1
}

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
