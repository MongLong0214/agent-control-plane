#!/usr/bin/env node
/**
 * Builds `native/fd-vfs` via node-gyp, or fails loudly.
 *
 * Wired as part of this package's `postinstall` (see `package.json`) and exposed as
 * `pnpm native:fd-vfs:build`, the same shape as `build-native-peercred.mjs` and for the same
 * reason: the build happens at install time, on whatever machine that is, and never at require
 * time. ADR-0010 forbids compiling on the code path that answers a security question, and this
 * addon answers one — which file a migration is actually writing.
 *
 * Unlike peercred there is no platform skip. Descriptor binding was measured working on Darwin
 * (arm64, and cross-compiling for x64) and on Linux (aarch64 and x86_64), so every runner is
 * expected to build it; a runner that cannot is a failure to report, not a case to skip.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADDON_DIR = join(ROOT, "native", "fd-vfs");

const nodeGyp = join(ROOT, "node_modules", ".bin", "node-gyp");
const result = spawnSync(nodeGyp, ["rebuild"], { cwd: ADDON_DIR, stdio: "inherit" });

if (result.error) {
  process.stderr.write(`build-native-fd-vfs: failed to run node-gyp: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
