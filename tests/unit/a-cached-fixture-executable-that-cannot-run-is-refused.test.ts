import type * as FsModule from "node:fs";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stableFixtureBinDir, stableFixtureExecutable } from "../helpers/stable-fixture-executable.ts";

/**
 * `linkSync` is the publication step, wrapped so a case can have another writer publish first —
 * the window between the helper finding nothing at the target and its own `link` landing.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});
const actualFs = await vi.importActual<typeof FsModule>("node:fs");

/**
 * A cached shim is reused only while it can still run. The helper keys an entry by its content and
 * reuses whatever is at that path, and it checked type and content but never the mode: a shim
 * whose execute permission had been removed was handed back as if it were the shim. The caller
 * puts its directory first on PATH, the shell skips a file it cannot execute, and the lookup falls
 * through to the real command — so a test written to observe its own shim passes against the host
 * instead, with nothing saying so.
 *
 * Every case runs against a cache root it owns, never the shared one other tests execute from, and
 * every entry these cases publish is only ever stat'd and read, never executed.
 */
describe("a cached fixture executable that can no longer run is refused, not reused", () => {
  const SCRIPT = "#!/bin/sh\n# a cached fixture executable that must still be able to run\nexit 0\n";
  const SIBLING = "#!/bin/sh\n# its neighbour in a directory entry\nexit 0\n";

  const roots: string[] = [];
  const freshRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "acp-fixture-bin-tamper-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    vi.mocked(linkSync).mockReset();
    vi.mocked(linkSync).mockImplementation(actualFs.linkSync);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const observe = (path: string) => {
    const stat = lstatSync(path);
    return { ino: stat.ino, mode: stat.mode & 0o7777, content: readFileSync(path, "utf8") };
  };
  const leftovers = (directory: string): string[] => readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));

  it("reuses an untouched entry at the same path and inode, through both APIs", () => {
    // The control: without it, a helper that refused everything would pass every case below.
    const root = freshRoot();
    const single = stableFixtureExecutable("shim", SCRIPT, root);
    expect(observe(single).mode).toBe(0o700);
    expect(stableFixtureExecutable("shim", SCRIPT, root)).toBe(single);
    expect(observe(single).ino).toBe(lstatSync(stableFixtureExecutable("shim", SCRIPT, root)).ino);

    const directory = stableFixtureBinDir({ shim: SCRIPT, sibling: SIBLING }, root);
    const before = observe(join(directory, "shim"));
    expect(stableFixtureBinDir({ shim: SCRIPT, sibling: SIBLING }, root)).toBe(directory);
    expect(observe(join(directory, "shim"))).toEqual(before);
  });

  it("refuses a single-file entry whose execute permission was removed, and leaves it as it was", () => {
    const root = freshRoot();
    const target = stableFixtureExecutable("shim", SCRIPT, root);
    chmodSync(target, 0o600);
    const tampered = observe(target);

    expect(() => stableFixtureExecutable("shim", SCRIPT, root)).toThrowError(/mode 600, not the 700/);
    expect(observe(target), "the refused entry was modified").toEqual(tampered);
    expect(leftovers(dirname(target))).toEqual([]);
  });

  it("refuses a directory entry whose execute permission was removed, and leaves it as it was", () => {
    const root = freshRoot();
    const directory = stableFixtureBinDir({ shim: SCRIPT, sibling: SIBLING }, root);
    const target = join(directory, "sibling");
    chmodSync(target, 0o600);
    const tampered = observe(target);

    expect(() => stableFixtureBinDir({ shim: SCRIPT, sibling: SIBLING }, root)).toThrowError(
      /sibling has mode 600, not the 700/,
    );
    expect(observe(target), "the refused entry was modified").toEqual(tampered);
    expect(leftovers(directory)).toEqual([]);
  });

  /** Another writer lands a non-executable copy of the same content between the probe and the link. */
  const publishFirstWithoutExecute = (content: string): void => {
    vi.mocked(linkSync).mockImplementationOnce((existing, published) => {
      actualFs.writeFileSync(published, content, { mode: 0o600 });
      actualFs.chmodSync(published, 0o600);
      actualFs.linkSync(existing, published);
    });
  };

  it("refuses a non-executable entry a concurrent writer published first, through stableFixtureExecutable", () => {
    const root = freshRoot();
    publishFirstWithoutExecute(SCRIPT);

    expect(() => stableFixtureExecutable("shim", SCRIPT, root)).toThrowError(/mode 600, not the 700/);
    const directory = join(root, readdirSync(root)[0] as string);
    expect(observe(join(directory, "shim")).mode, "the concurrent writer's entry was modified").toBe(0o600);
    expect(observe(join(directory, "shim")).content).toBe(SCRIPT);
    expect(leftovers(directory)).toEqual([]);
    expect(vi.mocked(linkSync), "the publication race was never reached").toHaveBeenCalledTimes(1);
  });

  it("refuses a non-executable entry a concurrent writer published first, through stableFixtureBinDir", () => {
    const root = freshRoot();
    // Names are published in sorted order, so `shim` is the first `link` and the one raced.
    publishFirstWithoutExecute(SCRIPT);

    expect(() => stableFixtureBinDir({ shim: SCRIPT, zz: SIBLING }, root)).toThrowError(/shim has mode 600, not the 700/);
    const directory = join(root, readdirSync(root)[0] as string);
    expect(observe(join(directory, "shim")).mode, "the concurrent writer's entry was modified").toBe(0o600);
    expect(observe(join(directory, "shim")).content).toBe(SCRIPT);
    expect(leftovers(directory)).toEqual([]);
    expect(vi.mocked(linkSync), "the publication race was never reached").toHaveBeenCalledTimes(1);
  });
});
