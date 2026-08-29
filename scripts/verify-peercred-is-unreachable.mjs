#!/usr/bin/env node
/**
 * `src/core/peercred.ts` must stay unreachable from every live surface.
 *
 * #539's acceptance is unusual on purpose: it lands a kernel peer-credential primitive that
 * *nothing calls*, and that nothing calls it is the property under test — a rebind or an
 * externally supplied actor-attachment call site needs a separately authorized ticket, not this
 * one. So the gate is not "does the primitive work", it is "does production code reach it".
 *
 * Scans every `.ts` file under `src/` except the primitive's own file for:
 *   - an import whose specifier resolves to `src/core/peercred.ts`
 *   - the identifiers `getPeerCredentials` or `PeerCredentials` (word-boundary matched, so the
 *     unrelated `PeerCredential` — singular, the session-handshake type in `src/daemon/agentcpd.ts`
 *     — is not a false hit)
 *
 * A hit means a live call site exists and this must fail. Empty means the boundary holds.
 *
 * What this does NOT do: run anything, or notice a re-export under a different name. It is a
 * textual census, in the shape of `verify-acceptance-adapter-source.mjs` and
 * `verify-refusal-operands-are-watched.mjs` — narrow, dependency-free, and closed to interpretation
 * about what counts as "reachable".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const OWNED_FILE = join(SRC, "core", "peercred.ts");

/** Every `.ts` file under `src/`, depth-first, in the shape the other census scripts use. */
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

const IMPORT_PATTERN = /from\s+["'][^"']*core\/peercred(?:\.ts)?["']/;
const IDENTIFIER_PATTERN = /\bgetPeerCredentials\b|\bPeerCredentials\b/;

const hits = [];
for (const file of walk(SRC)) {
  if (file === OWNED_FILE) continue;
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (IMPORT_PATTERN.test(line) || IDENTIFIER_PATTERN.test(line)) {
      hits.push({ file: relative(ROOT, file), line: index + 1, text: line.trim() });
    }
  });
}

if (hits.length > 0) {
  process.stdout.write("verify-peercred-is-unreachable: found a live reference to the peercred primitive\n\n");
  for (const { file, line, text } of hits) {
    process.stdout.write(`  ${file}:${line}\n    ${text}\n`);
  }
  process.stdout.write(
    "\n#539 lands this primitive unreachable on purpose — a live call site (including a\n" +
      "`ControlPlane` field or export) needs a separately authorized ticket, not this one.\n" +
      `RESULT: FAIL — ${hits.length} reference(s) outside src/core/peercred.ts.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "RESULT: PASS — no reference to getPeerCredentials/PeerCredentials outside src/core/peercred.ts\n",
);
