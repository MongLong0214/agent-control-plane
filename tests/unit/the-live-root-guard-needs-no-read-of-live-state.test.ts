import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { canonical, isWithin, LIVE_STATE_ROOT, type Realpath, resolvesToLiveState } from "../helpers/live-state-root.ts";

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
    const realpath: Realpath = (path) => {
      if (under(resolve(path), LIVE_STATE_ROOT)) {
        denied.push(path);
        throw eperm(path);
      }
      return realpathSync(path);
    };
    expect(resolvesToLiveState(join(LIVE_STATE_ROOT, "scratch"), realpath)).toBe(true);
    expect(resolvesToLiveState(tempDir("acp-live-root-private-"), realpath)).toBe(false);
    expect(denied.length, "the live root was never asked about, so nothing was measured").toBeGreaterThan(0);
  });

  it("does not treat an error it cannot account for as an answer", () => {
    const failing: Realpath = () => {
      throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
    };
    expect(() => canonical("/any/path", failing)).toThrow(/ELOOP/);
  });
});
