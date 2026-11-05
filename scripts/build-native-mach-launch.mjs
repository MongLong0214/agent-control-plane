#!/usr/bin/env node
/**
 * Builds `native/mach-launch` via node-gyp, or does nothing.
 *
 * Same shape and same reason as `build-native-peercred.mjs`: the build happens at install time, on
 * whatever machine that is, and never at require time (ADR-0010). The addon carries a driven turn's
 * launch hand-over over raw Mach: the daemon checks in a launchd-declared service name and reads the
 * kernel's audit token on every request; the relay looks the name up and sends one request with a
 * send-once reply right.
 *
 * Darwin only, and the gate lives here as well as in the C source's `#error`, so a non-Darwin runner
 * sees a skip rather than an attempted build. On such a runner there is no Mach launch channel at
 * all, and a driven turn is refused by name rather than carried some other way.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADDON_DIR = join(ROOT, "native", "mach-launch");

if (process.platform !== "darwin") {
  process.stdout.write(
    "build-native-mach-launch: skipping — mach-launch is Darwin-only and this runner is " +
      `${process.platform}\n`,
  );
  process.exit(0);
}

const nodeGyp = join(ROOT, "node_modules", ".bin", "node-gyp");
const result = spawnSync(nodeGyp, ["rebuild"], { cwd: ADDON_DIR, stdio: "inherit" });

if (result.error) {
  process.stderr.write(`build-native-mach-launch: failed to run node-gyp: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
