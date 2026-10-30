/**
 * Review lane-e-fs-r6 P1 (#1232) — the patch the freeze digests and the blind reviewer reads shows text
 * as text whatever the candidate's `.gitattributes` say. A `-diff` rule used to turn a text file into a
 * compressed base85 binary patch the reviewer has no tool to decode. The file pairs git paired as a
 * rename, and a file replaced by a symlink (which git writes as two sections), keep the shape git gives
 * them; binary content keeps its binary patch, and a patch with no text behind a binary patch is git's
 * own bytes.
 */
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffPatch, git } from "../../src/git/git.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { INERT_MARKER } from "../helpers/import-fixtures.ts";

afterEach(cleanupTempDirs);

const MARKER = INERT_MARKER.toString("ascii");
const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join("");
/** Git's own patch, read with exactly the options `diffPatch` passes. */
const gitPatch = async (repo: string, base: string, head: string): Promise<string> =>
  (await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--full-index", "--binary", `${base}..${head}`])).stdout;
const sections = (patch: string): string[] => patch.split(/(?=^diff --git )/m).filter(Boolean);

describe("review lane-e-fs-r6 P1: the review patch shows text as text", () => {
  it("W12c a renamed text file and a text file replaced by a symlink under `-diff` read as text; binary content stays a binary patch and the rest is git's bytes", async () => {
    const repo = makeRepo({
      ".gitattributes": "*.js -diff\n*.bin -diff\nsrc/kept -diff\n",
      "src/old-name.js": lines(40),
      "src/kept": "kept text\n",
      "src/plain.txt": "plain one\n",
    });
    const base = gitSync(repo, ["rev-parse", "HEAD"]);
    renameSync(join(repo, "src/old-name.js"), join(repo, "src/new-name.js"));
    writeFiles(repo, { "src/new-name.js": `${lines(40)}${MARKER} renamed\n`, "src/plain.txt": "plain two\n" });
    unlinkSync(join(repo, "src/kept"));
    symlinkSync("elsewhere", join(repo, "src/kept"));
    // Inert binary content: the marker and NUL bytes.
    writeFiles(repo, { "src/data.bin": `${MARKER}\0\0\0\0` });
    const head = commitAll(repo, "rename, retarget, add data");

    const patch = await diffPatch(repo, base, head);
    const raw = await gitPatch(repo, base, head);

    // The rename stays the pair git made, now with its lines.
    expect(patch).toContain("rename from src/old-name.js\nrename to src/new-name.js\n");
    expect(patch).toContain(`+${MARKER} renamed\n`);
    // The replaced file's text and the link's target, as git's two sections.
    expect(patch).toContain("deleted file mode 100644\n");
    expect(patch).toContain("-kept text\n");
    expect(patch).toContain("new file mode 120000\n");
    // Only the binary content is a binary patch, and it and the unattributed text are git's own bytes.
    const binary = sections(patch).filter((section) => /^GIT binary patch$/m.test(section));
    expect(binary.map((section) => section.split("\n")[0])).toEqual(["diff --git a/src/data.bin b/src/data.bin"]);
    for (const section of sections(raw).filter((each) => /src\/(data\.bin|plain\.txt)/.test(each.split("\n")[0]!))) expect(patch).toContain(section);

    // A patch with no text behind a binary patch is git's own, byte for byte.
    writeFiles(repo, { "src/plain.txt": "plain three\n", "src/data.bin": `${MARKER}\0\0\0\0\0` });
    const next = commitAll(repo, "edit plain text and data");
    expect(await diffPatch(repo, head, next)).toBe(await gitPatch(repo, head, next));
  }, 60_000);

  it("W12d text git pairs with binary content (a copy, a rename, a modification) follows that pair's binary patch whole and readable (review lane-e-fs-r7 E5)", async () => {
    // Inert content only: numbered lines, the marker and one NUL byte that makes a base file binary.
    const numbered = (label: string, count: number): string => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}\n`).join("");
    const repo = makeRepo({
      "src/old.dat": `\0${numbered("copy", 100)}`,
      "src/moved.dat": `\0${numbered("move", 60)}`,
      "src/flip.js": `\0${numbered("flip", 40)}`,
    });
    gitSync(repo, ["config", "diff.renames", "copies"]);
    const base = gitSync(repo, ["rev-parse", "HEAD"]);
    renameSync(join(repo, "src/moved.dat"), join(repo, "src/moved.js"));
    const added = {
      "src/imported.js": `${numbered("copy", 100)}${MARKER} copied\n`,
      "src/moved.js": `${numbered("move", 60)}${MARKER} moved\n`,
      "src/flip.js": `${numbered("flip", 40)}${MARKER} flipped\n`,
    };
    writeFiles(repo, { ...added, "src/old.dat": `\0${numbered("copy", 100)}one more\n` });
    const head = commitAll(repo, "copy, rename and flip binary to text");

    const patch = await diffPatch(repo, base, head);
    const raw = await gitPatch(repo, base, head);

    // Git paired each text file with binary content: the reviewer's repro is the copy.
    expect(raw).toContain("copy from src/old.dat\ncopy to src/imported.js\n");
    expect(raw).toContain("rename from src/moved.dat\nrename to src/moved.js\n");
    // Every section git wrote is kept, so each binary side is still its binary patch.
    for (const section of sections(raw)) expect(patch).toContain(section);
    // Each text file follows, whole, as git shows that file added: every line readable.
    for (const [path, text] of Object.entries(added)) {
      const shown = sections(patch).filter((section) => section.startsWith(`diff --git a/${path} b/${path}\nnew file mode 100644\n`));
      expect(shown, path).toHaveLength(1);
      expect(shown[0], path).not.toMatch(/^GIT binary patch$/m);
      expect(shown[0], path).toContain(text.split("\n").filter(Boolean).map((line) => `+${line}\n`).join(""));
    }
  }, 60_000);
});
