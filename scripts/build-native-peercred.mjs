#!/usr/bin/env node
/**
 * Builds `native/peercred` via node-gyp, or does nothing.
 *
 * Darwin only, and that gate lives here rather than only in `binding.gyp`: the addon's C++
 * (`native/peercred/src/peercred.cc`) refuses to compile on a non-Darwin toolchain with a
 * `#error`, but this script exists so a Linux dev box or CI job never gets that far — `pnpm
 * install` and the CI verify job run this unconditionally, and every non-Darwin runner must see
 * a skip, not an attempted (and failing) native build.
 *
 * This is this repository's own convention (ADR-0010) — a `binding.gyp` + node-gyp /
 * node-addon-api build, modelled on how `better-sqlite3` is consumed — not the legacy
 * compile-on-load `/dev/fd` loader #539 forbade importing. CI produces the prebuilt `.node` on
 * `macos-15`; nothing here compiles at require time.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADDON_DIR = join(ROOT, "native", "peercred");

if (process.platform !== "darwin") {
  process.stdout.write(
    "build-native-peercred: skipping — peercred is Darwin-only and this runner is " +
      `${process.platform}\n`,
  );
  process.exit(0);
}

const nodeGyp = join(ROOT, "node_modules", ".bin", "node-gyp");
const result = spawnSync(nodeGyp, ["rebuild"], {
  cwd: ADDON_DIR,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`build-native-peercred: failed to run node-gyp: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
