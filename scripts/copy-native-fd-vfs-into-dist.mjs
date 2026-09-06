#!/usr/bin/env node
/**
 * Copies the already-built `native/fd-vfs` extension into `dist/native/fd-vfs/...`, as the last
 * step of `pnpm build`.
 *
 * The extension is built once, at `pnpm install` time (`scripts/build-native-fd-vfs.mjs`), into
 * `native/fd-vfs/build/Release/`, a sibling of `dist` at the checkout root. That location is
 * correct for a checkout running in place — `src/db/fd-vfs.ts`'s fallback candidate resolves
 * exactly there — but a sealed rollback pair's closure is `dist/.` plus `node_modules` plus the
 * interpreter (`src/deploy/rollback-pair.ts`): nothing outside `dist` travels with it. A rollback
 * that restores generation A's `dist` while a sibling `native/` is still whatever generation B left
 * there hands the restored process the wrong extension, which is the B2 defect this script exists
 * to close.
 *
 * So every `pnpm build` — not only a sealed one — copies the built extension inside `dist`, at
 * `dist/native/fd-vfs/build/Release/`, the path `src/db/fd-vfs.ts` now tries first. That makes
 * `dist` self-contained for this extension unconditionally: the closure a seal copies
 * (`copyPrivateTree(sources.runtimeRoot, ...)`, where a real deployment's `--runtime-root` is
 * `dist` itself) carries the dylib automatically, with no change to the seal step itself.
 *
 * No platform skip, matching `build-native-fd-vfs.mjs`: every runner is expected to have already
 * built this extension, so a missing source file here is a build order problem to report, not a
 * case to pass through silently.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_FILENAME = process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so";
const SOURCE = join(ROOT, "native", "fd-vfs", "build", "Release", EXTENSION_FILENAME);
const DESTINATION = join(ROOT, "dist", "native", "fd-vfs", "build", "Release", EXTENSION_FILENAME);

if (!existsSync(SOURCE)) {
  process.stderr.write(
    `copy-native-fd-vfs-into-dist: the built extension is missing at ${SOURCE} — ` +
      "run `pnpm install` (or `pnpm native:fd-vfs:build`) before `pnpm build`\n",
  );
  process.exit(1);
}

mkdirSync(dirname(DESTINATION), { recursive: true });
copyFileSync(SOURCE, DESTINATION);
process.exit(0);
