#!/usr/bin/env node
/**
 * `src/core/peercred.ts` must stay unreachable from every live surface except an exact allowlist.
 *
 * #539's acceptance was unusual on purpose: it landed a kernel peer-credential primitive that
 * *nothing calls*, and that nothing called it was the property under test. #760 round 3 is the
 * "separately authorized ticket" that section always said a live call site would need — narrowly,
 * for exactly one production Unix-socket handler that must derive its connecting peer's identity
 * from the kernel rather than from anything the connection itself asserts. `ALLOWED_FILES` below
 * is that one exception; the gate still fails on every other reference, anywhere else in `src/`.
 *
 * Scans every `.ts` file under `src/` except the primitive's own file (and the one allowlisted
 * exception) for two independent things:
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

/**
 * The exact, narrow exception #760 authorizes: the production `actor.claimCanonicalCto`
 * Unix-socket listener, and nowhere else. Adding a file here is itself the authorization event —
 * there is no other gate standing between "listed here" and "reachable in production", so this
 * list is deliberately not a pattern or a directory: one path, spelled out, reviewed as a diff.
 *
 * Round 3 through round 5 named `canonical-self-claim-operator.ts` here: that file derived the
 * connecting peer's kernel credentials itself, from the raw `Socket` the (then-shared) operator
 * socket handed it. Round 6's ruling on the mint/claim separation ("a process may prove who it
 * is, but it cannot approve itself" — separate the sockets, not the credentials) moved the claim
 * off the bearer-token-authenticated operator socket entirely, onto its own dedicated, token-less
 * listener (`canonical-self-claim-listener.ts`). The kernel-credential authentication moved with
 * it: that listener now derives and checks the peer identity *before* handing an already-verified
 * `{ peerPid, uid }` tuple to the claim orchestration, which imports nothing from
 * `../core/peercred.ts` any more. The old file's exemption would have outlived its reason had it
 * stayed — a listed file that no longer touches the primitive reads as authorized when it is not,
 * which is a hole in the opposite direction from an unauthorized reference.
 */
const ALLOWED_FILES = new Set([
  join(SRC, "daemon", "canonical-self-claim-listener.ts"),
]);

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
  if (file === OWNED_FILE || ALLOWED_FILES.has(file)) continue;
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
    "\nOnly `src/daemon/canonical-self-claim-listener.ts` (#760 round 6) may reference this\n" +
      "primitive. A live call site anywhere else (including a `ControlPlane` field or export, or a\n" +
      "re-export under a different name) needs its own separately authorized ticket, not this one.\n" +
      `RESULT: FAIL — ${hits.length} reference(s) outside the allowlist.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "RESULT: PASS — no reference to getPeerCredentials/PeerCredentials, and no import/export/require\n" +
    "specifier resolving to core/peercred.ts, outside src/core/peercred.ts and the one allowlisted\n" +
    "listener (src/daemon/canonical-self-claim-listener.ts)\n",
);
