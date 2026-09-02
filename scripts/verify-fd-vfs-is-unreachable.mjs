#!/usr/bin/env node
/**
 * Unit 1 ships the descriptor-binding primitive and its evidence, and nothing else.
 *
 * "No product wiring" is a claim, and a claim nothing checks is the failure mode this repository
 * keeps meeting. So it is checked: no module under `src/` may import `fd-vfs` except itself. Unit
 * 3 is where `migrate-approved-copy` starts using it, and that unit deletes this gate in the same
 * change that adds the call site — which is the point at which someone is deciding, rather than
 * discovering, that the primitive went live.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const SELF = join(SRC, "db", "fd-vfs.ts");

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const offenders = walk(SRC)
  .filter((file) => file.endsWith(".ts") && file !== SELF)
  .filter((file) => /["'][^"']*fd-vfs(\.ts)?["']/.test(readFileSync(file, "utf8")))
  .map((file) => relative(ROOT, file));

if (offenders.length > 0) {
  process.stderr.write(
    "verify-fd-vfs-is-unreachable: fd-vfs is imported by " +
      `${offenders.join(", ")}. Unit 1 carries the primitive with no product wiring; ` +
      "wiring it is unit 3, which removes this gate alongside the call site.\n",
  );
  process.exit(1);
}
process.stdout.write("verify-fd-vfs-is-unreachable: PASS — no module under src/ imports fd-vfs.\n");
