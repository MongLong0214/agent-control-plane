import { afterAll, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  canonical,
  type Created,
  createPrivateDirectory,
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
    // A root that cannot be inspected vouches only for a directory this process created (review r3, R3).
    const created: Created = new Map();
    const home = createPrivateDirectory(join(realpathSync(tempDir("acp-live-root-private-")), "home"), created);
    expect(resolvesToLiveState(join(home, ".agent-control-plane", "scratch"), realpath, links, created)).toBe(false);
    expect(resolvesToLiveState(tempDir("acp-live-root-private-"), realpath, links, created)).toBe(true);
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
    // The same link, readable, is followed to where it points and passes, where the root can be inspected.
    expect(isWithin(join(elsewhere, ".agent-control-plane", "scratch"), live, realpath)).toBe(false);
    // Where the root cannot, nothing but a directory this process created vouches for it (review r3, R3).
    expect(isWithin(join(elsewhere, ".agent-control-plane", "scratch"), live, realpath, uninspectable(live))).toBe(true);
  });

  it("still passes a private HOME under the same protection", () => {
    const { dir, live } = aliasFixture();
    const realpath = protectedRealpath(live);
    const absent = join(dir, "private-home", ".agent-control-plane", "scratch");
    const present = join(dir, "present-home", ".agent-control-plane", "scratch");
    mkdirSync(present, { recursive: true });
    // A root that resolves, or is at least inspected, is compared as before: any private HOME passes.
    expect(isWithin(absent, live, realpath)).toBe(false);
    expect(isWithin(present, live, realpath)).toBe(false);
    // A root that cannot even be inspected passes the HOME this process created, and only that.
    const links = uninspectable(live);
    const created: Created = new Map();
    const home = createPrivateDirectory(join(dir, "created-home"), created);
    expect(isWithin(join(home, ".agent-control-plane", "scratch"), live, realpath, links, created)).toBe(false);
    mkdirSync(join(home, ".agent-control-plane", "scratch"), { recursive: true });
    expect(isWithin(join(home, ".agent-control-plane", "scratch"), live, realpath, links, created)).toBe(false);
    expect(isWithin(absent, live, realpath, links, created)).toBe(true);
    expect(isWithin(present, live, realpath, links, created)).toBe(true);
    expect(isWithin(live, live, realpath, links, created)).toBe(true);
  });
});

/**
 * Review r3, R3 — the live root is itself a link, and the host refuses to resolve, inspect or read
 * anything at or below it (the reviewer's injected EPERM, on a synthetic root). The root's identity
 * is then unknown, and round 3 compared against its own spelling anyway: an alias to the link's
 * physical target read as outside live state, and setup allocated into it. Unknown must mean refused,
 * except inside a directory this process created and can still prove is the one it created.
 */
describe("a live root that is itself an uninspectable link (#1093, review r3 R3)", () => {
  const fixture = () => {
    const dir = realpathSync(tempDir("acp-live-root-symlink-"));
    const account = join(dir, "home");
    const physical = join(dir, "physical-state");
    const live = join(account, ".agent-control-plane");
    mkdirSync(account);
    mkdirSync(join(physical, "scratch"), { recursive: true });
    symlinkSync(physical, live);
    const aliasHome = join(dir, "alias-home");
    mkdirSync(aliasHome);
    symlinkSync(physical, join(aliasHome, ".agent-control-plane"));
    // The reviewer's preload: realpath, lstat and readlink refused at or below the live root's spelling.
    const deny = (path: string): void => {
      if (under(resolve(path), live)) throw eperm(path);
    };
    const realpath: Realpath = (path) => {
      deny(path);
      return realpathSync(path);
    };
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
    return { dir, live, physical, aliasHome, realpath, links };
  };

  it("refuses an alias to the link's physical target, and its scratch", () => {
    const { live, physical, aliasHome, realpath, links } = fixture();
    expect(() => links.lstat(live), "the protection under test is not in place").toThrow(/EPERM/);
    const created: Created = new Map();
    for (const path of [
      join(aliasHome, ".agent-control-plane", "scratch"),
      join(aliasHome, ".agent-control-plane"),
      join(physical, "scratch"),
      physical,
      join(live, "scratch"),
    ]) {
      expect({ path, within: isWithin(path, live, realpath, links, created) }).toEqual({ path, within: true });
    }
  });

  it("passes the private HOME this process created, and nothing it cannot prove is that directory", () => {
    const { dir, live, physical, realpath, links } = fixture();
    const created: Created = new Map();
    const home = createPrivateDirectory(join(dir, "private-home"), created);
    const scratch = join(home, ".agent-control-plane", "scratch");
    expect(isWithin(scratch, live, realpath, links, created)).toBe(false);
    expect(isWithin(home, live, realpath, links, created)).toBe(false);

    // Spelled through `..` past a link, or through a link below it, it is no longer provably inside:
    // `home/link/..` reads as `home` but is the link target's parent, here the live state itself.
    symlinkSync(join(physical, "scratch"), join(home, "link"));
    expect(isWithin(`${home}${sep}link${sep}..`, live, realpath, links, created)).toBe(true);
    symlinkSync(physical, join(home, ".agent-control-plane"));
    expect(isWithin(scratch, live, realpath, links, created)).toBe(true);

    // Gone, it vouches for nothing below it that exists; replaced, the new directory is not the one created.
    const gone = createPrivateDirectory(join(dir, "gone-home"), created);
    renameSync(gone, join(dir, "moved-home"));
    expect(isWithin(join(gone, ".agent-control-plane", "scratch"), live, realpath, links, created)).toBe(false);
    mkdirSync(gone);
    expect(isWithin(join(gone, ".agent-control-plane", "scratch"), live, realpath, links, created)).toBe(true);

    // Reached through a link, a created directory is not recorded at all.
    const linkedParent = join(dir, "linked-parent");
    symlinkSync(realpathSync(tempDir("acp-live-root-linked-")), linkedParent);
    const viaLink = createPrivateDirectory(join(linkedParent, "home"), created);
    expect(created.has(viaLink)).toBe(false);
    expect(isWithin(join(viaLink, ".agent-control-plane", "scratch"), live, realpath, links, created)).toBe(true);

    // Exclusive: an existing directory is never adopted as created.
    expect(() => createPrivateDirectory(home, created)).toThrow(/EEXIST/);
  });

  it("keeps the current answer where the root resolves", () => {
    const { live, physical, aliasHome } = fixture();
    expect(isWithin(join(aliasHome, ".agent-control-plane", "scratch"), live)).toBe(true);
    expect(isWithin(join(physical, "scratch"), live)).toBe(true);
    expect(isWithin(tempDir("acp-live-root-elsewhere-"), live)).toBe(false);
  });
});
