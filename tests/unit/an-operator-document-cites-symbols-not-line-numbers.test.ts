import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #738. `docs/ops/` is the only place in this repository whose documents are *executed* — the
 * owner reads a procedure there during an incident and runs what it says. A `file.ts:412`
 * citation in that setting is a coordinate the reader cannot check and the repository cannot
 * keep: #747 added 185 lines to `src/db/database.ts` and silently moved six of this packet's
 * citations onto unrelated code, including the one naming the refusal an operator reaches for
 * when a rollback half-completes.
 *
 * `scripts/verify-stale-coordinate-literals.mjs` deliberately does not cover this — its own
 * header says so, because a *historical measurement* document is entitled to a line citation:
 * it is recording where something was on a given day. An operator procedure is the opposite
 * kind of document. It says where something is now, and it is read later.
 *
 * So this asks for the rule #597 already states — "loci are named by symbol, never by line
 * number" — over the documents the owner executes. A symbol that gets renamed makes the search
 * return nothing, which is visible; a line number that moves points confidently at the wrong
 * code, which is not.
 */
const opsDirectory = fileURLToPath(new URL("../../docs/ops", import.meta.url));

/** Extensions whose files move whenever anything above them in the file is edited. */
const trackedExtensions = "ts|tsx|mts|js|mjs|cjs|sh|template|sql|yml|yaml|py";

/**
 * A repository path followed by a line coordinate. Deliberately anchored on the leading
 * directory names this repository actually has: an unanchored `\S+\.ts:\d+` also matches prose
 * about a URL, an npm scope, or a timestamp, and a check that reports those gets turned off.
 */
const lineCitation = new RegExp(
  String.raw`(?:src|tests|scripts|deploy|docs)/[A-Za-z0-9._/-]+\.(?:${trackedExtensions}):\d+(?:-\d+)?`,
  "g",
);

const operatorDocuments = (): string[] =>
  readdirSync(opsDirectory)
    .filter((entry) => entry.endsWith(".md"))
    .sort();

describe("operator documents", () => {
  it("reads the documents it claims to cover", () => {
    // Without this the whole check passes by finding nothing — a renamed directory, a changed
    // extension, or a glob that quietly matches zero files reports the same clean result as a
    // repository with no stale citations in it.
    const documents = operatorDocuments();
    expect(documents.length).toBeGreaterThan(0);
    expect(documents).toContain("owner-actions.md");
    for (const document of documents) {
      expect(readFileSync(join(opsDirectory, document), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("cites code by symbol rather than by a line number that moves under it", () => {
    const found = operatorDocuments().flatMap((document) => {
      const text = readFileSync(join(opsDirectory, document), "utf8");
      return text.split("\n").flatMap((line, index) =>
        [...line.matchAll(lineCitation)].map(
          (match) => `docs/ops/${document}:${index + 1} cites ${match[0]}`,
        ),
      );
    });
    // Named rather than counted: the failure has to say which coordinate to replace, because the
    // fix is to name the function or the test title at that spot, not to re-point the number.
    expect(found).toEqual([]);
  });
});
