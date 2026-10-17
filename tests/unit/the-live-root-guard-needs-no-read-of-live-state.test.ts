import { afterAll, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  canonical,
  isWithin,
  type Links,
  LIVE_STATE_ROOT,
  type Realpath,
  resolvesToLiveState,
} from "../helpers/live-state-root.ts";

afterAll(cleanupTempDirs);

/**
 * #1093, review R2 — the guard that keeps test runs out of the live state answers without reading
 * it, and still sees through a symlinked spelling wherever the path can be resolved.
 *
 * `realpath` is handed in, so the protected host is reproduced here rather than required: a root
 * the resolver may not read throws EPERM at, below, or through it, the way that host's sandbox does.
 * Most cases use a synthetic root in a temporary directory, so nothing reads the operator's home.
 */
const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

const eperm = (path: string): Error =>
  Object.assign(new Error(`EPERM: operation not permitted, lstat '${path}'`), { code: "EPERM", syscall: "lstat", path });

/** A realpath that refuses anything at, below or resolving into `root`. */
const protecting = (root: string): Realpath => {
  const real = realpathSync(root);
  return (path) => {
    if (under(resolve(path), root) || under(resolve(path), real)) throw eperm(path);
    const resolved = realpathSync(path);
    if (under(resolved, real)) throw eperm(path);
    return resolved;
  };
};

const syntheticHome = (): { home: string; root: string } => {
  const home = join(tempDir("acp-live-root-guard-"), "home");
  const root = join(home, ".agent-control-plane");
  mkdirSync(join(root, "scratch"), { recursive: true });
  return { home, root };
};

describe("the live-root guard needs no read of live state (#1093, R2)", () => {
  it("answers for a protected root, lexically below the part it cannot read", () => {
    const { home, root } = syntheticHome();
    const realpath = protecting(root);
    expect(() => realpath(root), "the protection under test is not in place").toThrow(/EPERM/);
    expect(canonical(join(root, "scratch"), realpath)).toBe(join(realpathSync(home), ".agent-control-plane", "scratch"));
    expect(isWithin(join(root, "scratch", "acp-x"), root, realpath)).toBe(true);
    expect(isWithin(root, root, realpath)).toBe(true);
    expect(isWithin(join(home, ".agent-control-plane-other"), root, realpath)).toBe(false);
    expect(isWithin(tempDir("acp-live-root-elsewhere-"), root, realpath)).toBe(false);
  });

  it("still rejects a symlinked spelling of a protected root", () => {
    const { home, root } = syntheticHome();
    const alias = join(tempDir("acp-live-root-alias-"), "alias");
    symlinkSync(home, alias);
    expect(isWithin(join(alias, ".agent-control-plane", "scratch"), root, protecting(root))).toBe(true);
  });

  it("answers for the operator's own live root without resolving it", () => {
    const denied: string[] = [];
    const deny = (path: string): void => {
      if (under(resolve(path), LIVE_STATE_ROOT)) {
        denied.push(path);
        throw eperm(path);
      }
    };
    const realpath: Realpath = (path) => {
      deny(path);
      return realpathSync(path);
    };
    // Nor inspecting it: the operator's live root is never read, metadata included.
    const links: Links = {
      lstat: (path) => {
        deny(path);
        return lstatSync(path);
      },
      readlink: (path) => {
        deny(path);
        return readlinkSync(path);
      },
    };
    expect(resolvesToLiveState(join(LIVE_STATE_ROOT, "scratch"), realpath, links)).toBe(true);
    expect(resolvesToLiveState(tempDir("acp-live-root-private-"), realpath, links)).toBe(false);
    expect(denied.length, "the live root was never asked about, so nothing was measured").toBeGreaterThan(0);
  });

  it("does not treat an error it cannot account for as an answer", () => {
    const failing: Realpath = () => {
      throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
    };
    expect(() => canonical("/any/path", failing)).toThrow(/ELOOP/);
  });
});

/**
 * Review r2, R3 — the reviewer's direct-alias replay, unchanged but for its paths. Round 2 resolved
 * the deepest readable ancestor and appended the rest as written, so an alias straight to the
 * protected root, or to its scratch directory, lost its identity the moment resolving it failed
 * with EPERM, and read as outside the root: a HOME holding one passed setup and allocated into live
 * scratch. A link's own target is read with readlink, which needs nothing from the protected side.
 */
describe("a direct alias to a protected root is still the root (#1093, review r2 R3)", () => {
  type AliasPaths = { literal: string; homeAlias: string; rootAlias: string; scratchAlias: string };
  const aliasFixture = (): { dir: string; live: string; paths: AliasPaths } => {
    const dir = realpathSync(tempDir("acp-live-root-direct-alias-"));
    const home = join(dir, "home");
    const live = join(home, ".agent-control-plane");
    mkdirSync(join(live, "scratch"), { recursive: true });
    for (const [name, target] of [
      ["home-alias", home],
      ["root-alias", live],
      ["scratch-alias", join(live, "scratch")],
    ] as const) {
      symlinkSync(target, join(dir, name));
    }
    const paths = {
      literal: join(live, "scratch"),
      homeAlias: join(dir, "home-alias", ".agent-control-plane", "scratch"),
      rootAlias: join(dir, "root-alias", "scratch"),
      scratchAlias: join(dir, "scratch-alias"),
    };
    return { dir, live, paths };
  };

  /** The reviewer's resolver: it resolves, then refuses whatever resolved into the root. */
  const protectedRealpath =
    (live: string, also: (path: string) => boolean = () => false): Realpath =>
    (path) => {
      if (also(path)) throw eperm(path);
      const resolved = realpathSync(path);
      if (under(resolved, live)) throw eperm(path);
      return resolved;
    };

  /** A stricter host: lstat and readlink are refused at and below the root as well. */
  const uninspectable = (
    live: string,
    also: { lstat?: (path: string) => boolean; readlink?: (path: string) => boolean } = {},
  ): Links => ({
    lstat: (path) => {
      if (under(resolve(path), live) || also.lstat?.(path) === true) throw eperm(path);
      return lstatSync(path);
    },
    readlink: (path) => {
      if (under(resolve(path), live) || also.readlink?.(path) === true) throw eperm(path);
      return readlinkSync(path);
    },
  });

  it("sees the literal path and every alias as the root, readable or under injected EPERM", () => {
    const { live, paths } = aliasFixture();
    const realpath = protectedRealpath(live);
    expect(() => realpath(paths.rootAlias), "the protection under test is not in place").toThrow(/EPERM/);
    for (const [name, path] of Object.entries(paths)) {
      expect({ name, readable: isWithin(path, live), protected: isWithin(path, live, realpath) }).toEqual({
        name,
        readable: true,
        protected: true,
      });
    }
  });

  it("rejects them where nothing at or below the root can even be inspected", () => {
    const { live, paths } = aliasFixture();
    const realpath = protectedRealpath(live);
    const links = uninspectable(live);
    for (const [name, path] of Object.entries(paths)) {
      expect({ name, within: isWithin(path, live, realpath, links) }).toEqual({ name, within: true });
    }
  });

  it("fails closed on a link it cannot inspect or whose target it cannot read, wherever it points", () => {
    const { dir, live, paths } = aliasFixture();
    const elsewhere = join(dir, "elsewhere-alias");
    symlinkSync(tempDir("acp-live-root-elsewhere-"), elsewhere);
    const viaAlias = (path: string): boolean => resolve(path).split(sep).some((name) => name.endsWith("-alias"));
    const isAlias = (path: string): boolean => resolve(path).endsWith("-alias");
    const realpath = protectedRealpath(live, viaAlias);
    for (const links of [uninspectable(live, { readlink: isAlias }), uninspectable(live, { lstat: isAlias })]) {
      expect(isWithin(paths.rootAlias, live, realpath, links)).toBe(true);
      expect(isWithin(join(elsewhere, ".agent-control-plane", "scratch"), live, realpath, links)).toBe(true);
    }
    // The same link, readable, is followed to where it points and passes.
    expect(isWithin(join(elsewhere, ".agent-control-plane", "scratch"), live, realpath, uninspectable(live))).toBe(false);
  });

  it("still passes a private HOME under the same protection", () => {
    const { dir, live } = aliasFixture();
    const realpath = protectedRealpath(live);
    const links = uninspectable(live);
    const absent = join(dir, "private-home", ".agent-control-plane", "scratch");
    expect(isWithin(absent, live, realpath, links)).toBe(false);
    const present = join(dir, "present-home", ".agent-control-plane", "scratch");
    mkdirSync(present, { recursive: true });
    expect(isWithin(present, live, realpath, links)).toBe(false);
    expect(isWithin(live, live, realpath, links)).toBe(true);
  });
});
