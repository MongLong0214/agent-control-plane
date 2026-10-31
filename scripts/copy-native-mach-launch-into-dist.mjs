#!/usr/bin/env node
/**
 * Copies the already-built `native/mach-launch` addon into `dist/native/mach-launch/...`, as a step
 * of `pnpm build`, for the reason `copy-native-fd-vfs-into-dist.mjs` gives: a sealed generation's
 * closure is `dist/.` plus `node_modules` plus the interpreter, so an addon left only in a sibling
 * `native/` would not travel with the generation that loads it.
 *
 * The relay loads this file from inside `dist`, under the turn's sandbox, which re-opens exactly the
 * files the turn names; the copy has to be inside the generation for that path to be the right one.
 *
 * Darwin only, matching `build-native-mach-launch.mjs`. On Darwin a missing source file is a build
 * order problem to report, not a case to pass through.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "native", "mach-launch", "build", "Release", "mach_launch.node");
const DESTINATION = join(ROOT, "dist", "native", "mach-launch", "build", "Release", "mach_launch.node");

if (!existsSync(SOURCE)) {
  process.stderr.write(
    `copy-native-mach-launch-into-dist: the built addon is missing at ${SOURCE} — ` +
      "run `pnpm install` (or `node scripts/build-native-mach-launch.mjs`) before `pnpm build`\n",
  );
  process.exit(1);
}

mkdirSync(dirname(DESTINATION), { recursive: true });
copyFileSync(SOURCE, DESTINATION);
process.exit(0);
