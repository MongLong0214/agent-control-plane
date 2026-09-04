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

/*
 * Variables that reach the compiler as flags. node-gyp's Make generator appends `CFLAGS` and
 * `CPPFLAGS` to every compile command, so inheriting them lets any caller add a define to the
 * shipping build — measured: `CFLAGS=-DACP_FD_VFS_TESTING pnpm native:fd-vfs:build` exited 0 and
 * produced a library containing the test seam. The `#error` in the C source is the hard stop;
 * dropping these keeps a legitimate build working instead of failing on someone's ambient flags.
 */
const FLAG_CARRYING = ["CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS", "GYP_DEFINES", "MAKEFLAGS"];

const buildEnv = { ...process.env };
for (const name of FLAG_CARRYING) delete buildEnv[name];

/*
 * Anything left that still names the test macro is a route this list does not know about. Refuse
 * rather than guess, and name only the variable — its value is the caller's, and a build log is
 * not the place for it.
 */
const smuggled = Object.entries(buildEnv)
  .filter(([, value]) => typeof value === "string" && value.includes("ACP_FD_VFS_TESTING"))
  .map(([name]) => name);
if (smuggled.length > 0) {
  process.stderr.write(
    `build-native-fd-vfs: refusing to build; ${smuggled.sort().join(", ")} names the test macro, ` +
      "which must never reach the shipping artifact\n",
  );
  process.exit(1);
}

const nodeGyp = join(ROOT, "node_modules", ".bin", "node-gyp");
const result = spawnSync(nodeGyp, ["rebuild"], { cwd: ADDON_DIR, stdio: "inherit", env: buildEnv });

if (result.error) {
  process.stderr.write(`build-native-fd-vfs: failed to run node-gyp: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
