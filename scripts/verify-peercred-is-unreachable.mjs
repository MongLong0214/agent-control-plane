#!/usr/bin/env node
/**
 * `src/core/peercred.ts` must stay unreachable from every live surface.
 *
 * #539's acceptance is unusual on purpose: it lands a kernel peer-credential primitive that
 * *nothing calls*, and that nothing calls it is the property under test — a rebind or an
 * externally supplied actor-attachment call site needs a separately authorized ticket, not this
 * one. So the gate is not "does the primitive work", it is "does production code reach it".
 *
 * Scans every `.ts` file under `src/` except the primitive's own file for two independent things:
 *
 *   1. A `from "<specifier>"` clause (static import/export, including `export * from` and
 *      `export * as X from`) or a string-literal dynamic `import("<specifier>")`/`require(
 *      "<specifier>")` whose specifier *resolves* — following relative paths and this project's
 *      `@/` → `src/` alias the way Node/TS module resolution actually would, not by matching a
 *      literal path substring — to `src/core/peercred.ts`.
 *
 *      This is what closed the hole an earlier version of this script's own docstring admitted:
 *      that version matched a specifier only if it *textually contained* `core/peercred`, which
 *      is true from anywhere outside `src/core/` but false for a reference written from inside
 *      it (`./peercred.ts`, or `../peercred.ts` from a subdirectory) — a namespace re-export
 *      (`export * as PC from "./peercred.ts"`) living in `src/core/` passed silently: no
 *      `core/peercred` substring, and no literal `getPeerCredentials`/`PeerCredentials` text on
 *      that line either, since a namespace export names nothing. Verified empirically before
 *      this fix landed: that exact file made the previous version print PASS.
 *
 *   2. The identifiers `getPeerCredentials` or `PeerCredentials` appearing literally in a file
 *      (word-boundary matched, so the unrelated `PeerCredential` — singular, the
 *      session-handshake type in `src/daemon/agentcpd.ts` — is not a false hit). This still
 *      catches a named re-export or a call site even when check 1 above does not apply to that
 *      exact line (e.g. a consumer importing a re-exporting module and then writing
 *      `mod.getPeerCredentials(fd)`).
 *
 * A hit from either check means a live reference exists and this must fail. Empty means the
 * boundary holds.
 *
 * What this still does NOT do, stated rather than implied: resolve a specifier assembled at
 * runtime (string concatenation, a computed property access built from parts, a bare dynamic
 * `import(someVariable)`), and it does not run anything or type-check. Those would need an actual
 * module graph (TypeScript's compiler API or a bundler) to resolve, which this dependency-free
 * census — in the shape of `verify-acceptance-adapter-source.mjs` and
 * `verify-refusal-operands-are-watched.mjs` — deliberately does not carry. Nothing in this
 * repository writes an import that way today; if that ever changes, this gate needs to change
 * with it rather than being trusted past what it actually inspects.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const OWNED_FILE = join(SRC, "core", "peercred.ts");
/** `OWNED_FILE` with any of the extensions a resolved specifier might carry stripped, once. */
const OWNED_FILE_STEM = OWNED_FILE.replace(/\.(?:ts|js)$/u, "");

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

const IDENTIFIER_PATTERN = /\bgetPeerCredentials\b|\bPeerCredentials\b/;

/**
 * Every `from "<specifier>"`, `import("<specifier>")`, or `require("<specifier>")` in `source`,
 * scanned across the whole file rather than line by line — a brace-list import/export spans
 * multiple lines, and the specifier is what identifies the target regardless of which line the
 * keyword landed on.
 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gu;

const extractSpecifiers = (source) => {
  const hits = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const line = source.slice(0, match.index).split("\n").length;
    hits.push({ specifier: match[1], line });
  }
  return hits;
};

/**
 * Resolves an import specifier written in `fromFile` to an absolute path, following relative
 * specifiers and this project's `@/` → `src/` alias (`tsconfig.json`'s `paths`). Returns `null`
 * for a bare package specifier (`vitest`, `node:fs`, …), which cannot resolve to a local file.
 */
const resolveSpecifier = (specifier, fromFile) => {
  if (specifier.startsWith("@/")) return resolvePath(SRC, specifier.slice(2));
  if (specifier.startsWith(".")) return resolvePath(dirname(fromFile), specifier);
  return null;
};

const hits = [];
for (const file of walk(SRC)) {
  if (file === OWNED_FILE) continue;
  const source = readFileSync(file, "utf8");

  for (const { specifier, line } of extractSpecifiers(source)) {
    const resolved = resolveSpecifier(specifier, file);
    if (resolved === null) continue;
    if (resolved.replace(/\.(?:ts|js)$/u, "") === OWNED_FILE_STEM) {
      hits.push({ file: relative(ROOT, file), line, text: `specifier "${specifier}" resolves to core/peercred.ts` });
    }
  }

  const lines = source.split("\n");
  lines.forEach((text, index) => {
    if (IDENTIFIER_PATTERN.test(text)) {
      hits.push({ file: relative(ROOT, file), line: index + 1, text: text.trim() });
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
      "`ControlPlane` field or export, or a re-export under a different name) needs a separately\n" +
      "authorized ticket, not this one.\n" +
      `RESULT: FAIL — ${hits.length} reference(s) outside src/core/peercred.ts.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "RESULT: PASS — no reference to getPeerCredentials/PeerCredentials, and no import/export/require\n" +
    "specifier resolving to core/peercred.ts, outside src/core/peercred.ts\n",
);
